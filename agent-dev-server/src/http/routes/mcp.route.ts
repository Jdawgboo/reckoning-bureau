/**
 * MCP Server Route — exposes the agent as an MCP server.
 *
 * Handles POST/GET/DELETE on /mcp using the Streamable HTTP transport.
 * Registers 4 tools: askAgent, getConversationHistory, getAgentInfo, createSession.
 */

import type { IncomingMessage, ServerResponse } from 'node:http';
import { randomUUID } from 'node:crypto';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

import type { WsSessionManager } from '../../ws/session-manager';
import type { DependencyContainer } from '../../container';
import type { Route } from './route';
import { getConfigId } from '../../util/config';
import { consumeAguiStream } from '../../util/consume-agui-stream';
import {
  ContentType,
  isComponentDone,
  type AgentContent,
  type AgentStreamEvent,
  type TextContent,
  type ToolContent,
  type ComponentContent,
} from '../../bl/agent/agent-library';

const logger = console;

/** Channel truth, authored by this adapter — rides the `presentation`
 *  parameter (the same seam the web client uses), never the instruction. */
/** Superseded by the per-turn `<turn_situation>` block, which states the same fact
 *  (no live screen) for every channel in one place. Kept only until this route's
 *  callers are verified against it. */
const MCP_CHANNEL_PRESENTATION = [
  '<presentation>',
  'You are answering an MCP (Model Context Protocol) caller — a programmatic client, not a browser. There is no live screen: any screen you render reaches the caller as its markdown fallback appended to your reply. Prefer direct, concise, well-structured text; render a screen only when its structured content is the best answer, and make its fallbackMarkdown a complete standalone answer.',
  '</presentation>',
].join('\n');

/** The surface position anchor's surfaceId, when this component is one. */
function surfaceIdOfAnchor(content: ComponentContent): string | null {
  if (content.componentName !== 'Surface') {
    return null;
  }
  const surfaceId = content.props['surfaceId'];
  return typeof surfaceId === 'string' ? surfaceId : null;
}

/**
 * Serialize a ComponentContent to a readable text description.
 * MCP clients cannot render React components, so we produce a text fallback.
 */
function serializeComponent(content: ComponentContent): string {
  const name = content.componentName;
  const props = content.props;
  const streaming = content.streaming;

  let text = `[Component: ${name}]`;
  if (Object.keys(props).length > 0) {
    text += `\n${JSON.stringify(props, null, 2)}`;
  }
  if (streaming?.state === 'output-error' && streaming.error) {
    text += `\nError: ${streaming.error}`;
  }
  return text;
}

type McpRouteDeps = {
  sessionManager: WsSessionManager;
  container: DependencyContainer;
};

const MCP_METHODS = new Set(['POST', 'GET', 'DELETE']);

export function createMcpRoute(deps: McpRouteDeps): Route {
  const { sessionManager, container } = deps;
  const configId = getConfigId(container);
  const mcpServerName = container.settings.getSecret('AGENT_NAME') || configId;

  // Transport map: MCP session ID → transport
  const transports = new Map<string, StreamableHTTPServerTransport>();

  function createServer(agentDepth: number = 0): McpServer {
    const mcpServer = new McpServer(
      { name: mcpServerName, version: '1.0.0' },
      { capabilities: { tools: {} } },
    );

    registerTools(mcpServer, agentDepth);
    return mcpServer;
  }

  function registerTools(mcpServer: McpServer, agentDepth: number) {
    // 1. askAgent — send a message to the agent and get a response
    mcpServer.tool(
      'askAgent',
      'Send a message to the agent and get a response',
      {
        message: z.string().describe('The message to send to the agent'),
        sessionId: z
          .string()
          .optional()
          .describe(
            'Session ID for conversation continuity. Omit it and each call gets its own fresh session; pass the same value to continue one.',
          ),
      },
      async ({ message, sessionId }) => {
        // A shared default key put every caller that omitted `sessionId` into
        // one session — shared history, and shared per-visitor records now that
        // the agent can query them.
        const sessionKey = sessionId ?? randomUUID();
        const session = await sessionManager.getOrCreate(sessionKey, {
          userId: 'mcp-user',
          configId,
        });

        const messagingService = container.createMessagingService();
        const instruction = container.createInstructionService().getInstruction();

        const result = await messagingService.sendMessage({
          configId,
          message: { type: 'TXT', content: message },
          instruction,
          presentation: MCP_CHANNEL_PRESENTATION,
          sessionKey,
          sessionType: 'api',
          metadata: { channel: 'mcp', ...(agentDepth > 0 ? { agentDepth } : {}) },
        });

        let responseText = '';
        const finishedComponents: ComponentContent[] = [];
        const toolResults: Array<{ toolCallId?: string; toolName: string; output: unknown }> = [];
        // Final projection per surfaceId; Map.set keeps first-render order.
        const surfaceProjections = new Map<string, string>();
        const surfaceToolCallIds = new Set<string>();

        // Keeps session reductions/seals consistent for co-viewing clients.
        const aguiDone = consumeAguiStream(session, result.agui, result.id);

        const eventsDone = (async () => {
          for await (const event of result.events as AsyncIterable<AgentStreamEvent>) {
            if (event.type === 'tool-result') {
              toolResults.push({
                toolCallId: event.toolCallId,
                toolName: event.toolName,
                output: event.output,
              });
            }
          }
        })();

        for await (const content of result.stream as AsyncIterable<AgentContent>) {
          if (!content) continue;

          // Accumulate text content — skip reasoning (chain-of-thought)
          if (content.type === ContentType.Text) {
            const textContent = content as TextContent;
            if (textContent.isReasoning) {
              session.pushContent(content);
              continue;
            }
            if (textContent.content) {
              responseText += textContent.content;
            }
          }

          if (
            content.type === ContentType.Component &&
            isComponentDone(content as ComponentContent)
          ) {
            const component = content as ComponentContent;
            const surfaceId = surfaceIdOfAnchor(component);
            if (surfaceId) {
              if (component.fallbackMarkdown) {
                surfaceProjections.set(surfaceId, component.fallbackMarkdown);
              }
              const toolCallId = component.streaming?.toolCallId;
              if (toolCallId) {
                surfaceToolCallIds.add(toolCallId);
              }
            } else {
              // Non-surface components — only used as fallback if agent produces no text
              finishedComponents.push(component);
            }
          }

          // Store non-StateUpdate content
          session.pushContent(content);
        }

        await Promise.all([eventsDone, aguiDone]);

        if (!responseText && finishedComponents.length > 0) {
          responseText = finishedComponents.map(serializeComponent).join('\n');
        }

        const content: Array<{ type: 'text'; text: string }> = [];
        content.push({ type: 'text' as const, text: responseText || '(no response)' });
        if (!sessionId) {
          content.push({
            type: 'text' as const,
            text: `[Session: ${sessionKey}] Pass this as sessionId to continue this conversation.`,
          });
        }

        for (const markdown of surfaceProjections.values()) {
          content.push({ type: 'text' as const, text: markdown });
        }

        for (const { toolCallId, toolName, output } of toolResults) {
          // Their content was already delivered as markdown above.
          if (toolCallId && surfaceToolCallIds.has(toolCallId)) {
            continue;
          }
          const serialized = typeof output === 'string' ? output : JSON.stringify(output);
          content.push({
            type: 'text' as const,
            text: `[Tool Result: ${toolName}]\n${serialized}`,
          });
        }

        return { content };
      },
    );

    // 2. getConversationHistory — retrieve conversation history
    mcpServer.tool(
      'getConversationHistory',
      'Get conversation history from a session',
      {
        sessionId: z
          .string()
          .describe('Session ID — the one askAgent returned or was given for this conversation.'),
        limit: z.number().optional().describe('Max number of history entries to return'),
      },
      async ({ sessionId, limit }) => {
        const session = sessionManager.get(sessionId);
        if (!session) {
          return {
            content: [
              {
                type: 'text' as const,
                text: JSON.stringify({ history: [], message: 'No session found' }),
              },
            ],
          };
        }

        // Load from persistent SessionManager
        const agentSessionManager = container.getSessionManager();
        const history = agentSessionManager
          ? (await agentSessionManager.loadConversation(session.sessionKey)).map(
              (m: { data: unknown }) => m.data,
            )
          : [];
        const sliced = history.slice(-(limit ?? 50));

        return {
          content: [
            {
              type: 'text' as const,
              text: JSON.stringify({ history: sliced, total: history.length }),
            },
          ],
        };
      },
    );

    // 3. getAgentInfo — get agent configuration info
    mcpServer.tool('getAgentInfo', 'Get information about this agent', {}, async () => {
      const instruction = container.createInstructionService().getInstruction();

      return {
        content: [
          {
            type: 'text' as const,
            text: JSON.stringify({
              configId,
              hasInstruction: !!instruction,
              instructionPreview: instruction ? instruction.slice(0, 200) : null,
            }),
          },
        ],
      };
    });

    // 4. createSession — create a new conversation session
    mcpServer.tool('createSession', 'Create a new conversation session', {}, async () => {
      const newSessionId = randomUUID();
      await sessionManager.getOrCreate(newSessionId, {
        userId: 'mcp-user',
        configId,
      });

      return {
        content: [{ type: 'text' as const, text: JSON.stringify({ sessionId: newSessionId }) }],
      };
    });
  }

  return {
    matches: (method, url) => url === '/mcp' && MCP_METHODS.has(method),
    handler: async (req: IncomingMessage, res: ServerResponse) => {
      const sessionId = (req.headers['mcp-session-id'] as string) ?? undefined;

      // DELETE — terminate session
      if (req.method === 'DELETE') {
        if (sessionId && transports.has(sessionId)) {
          const transport = transports.get(sessionId)!;
          await transport.close();
          transports.delete(sessionId);
        }
        res.writeHead(200);
        res.end();
        return;
      }

      // Reuse existing transport for known session
      if (sessionId && transports.has(sessionId)) {
        const transport = transports.get(sessionId)!;
        await transport.handleRequest(req, res);
        return;
      }

      // New session — create transport + server
      const agentDepth = parseInt((req.headers['x-agent-depth'] as string) || '0', 10);

      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => randomUUID(),
      });

      transport.onclose = () => {
        const sid = transport.sessionId;
        if (sid) {
          transports.delete(sid);
          logger.info(`[MCP] Transport closed for session: ${sid}`);
        }
      };

      const server = createServer(agentDepth);
      await server.connect(transport);

      // Store transport by its generated session ID after connection
      await transport.handleRequest(req, res);

      const sid = transport.sessionId;
      if (sid) {
        transports.set(sid, transport);
        logger.info(`[MCP] New session created: ${sid}`);
      }
    },
  };
}
