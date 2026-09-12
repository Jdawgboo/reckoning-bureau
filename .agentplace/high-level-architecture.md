# Agent High-Level Architecture

This project is a full-stack TypeScript agent with a React client (`agent-dev-client`) and Node.js
server (`agent-dev-server`). An LLM orchestrates each turn: it answers in natural language, calls
tools, and renders interactive screens. Vendored Agentplace libraries provide the shared agent loop,
transport, UI protocol, sessions, and channel utilities.

This document is the stable map for understanding and extending the agent. Read the matching Builder
skill and current source for detailed APIs; do not turn this file into an inventory of classes,
methods, tools, or implementation constants.

## System context

The same agent can be reached through several surfaces:

| Surface | Path | Delivery model |
|---|---|---|
| Browser | WebSocket `/ws` | Streaming text, tools, screens, actions, and tRPC over one `RpcPeer` |
| MCP client | Streamable HTTP `/mcp` | Same messaging pipeline, with reasoning removed and screens projected to text |
| HTTP caller | `POST /api/send-message` | Fire-and-forget message into an agent session |
| Messaging channel | Agent-owned adapter | Channel input enters the same messaging service; output is rendered for that channel |
| Trigger or schedule | Durable inbox/handler | Code handles the event directly or passes a bounded request to the LLM |

Preview and Published run the same agent source in separate environments. The platform gateway owns
authentication and routes authorized traffic to the agent VM.

## Ownership boundary

Builder extends the agent through explicit agent-owned seams. Platform code can be read to understand
behavior but is not edited as part of an agent build.

### Agent-owned

- `agent-dev-server/src/instruction.md` — generated agent role and behavior.
- `agent-dev-server/src/config.ts` — model and voice configuration anchor.
- `agent-dev-server/src/surfaces/**` — authored screen contracts.
- `agent-dev-server/src/bl/tools/impl/**` — custom backend tools.
- `agent-dev-server/src/trpc/routers/**` — deterministic data procedures.
- `agent-dev-server/src/bl/messaging/subagents/**` — generated-agent subagents.
- `agent-dev-client/src/app/agent/**` — authored screen components, renderers, site configuration,
  custom header, and brand accent.
- `.agent/skills/**` — generated-agent knowledge and workflows.
- `.agentplace/**` — project description, specification, and maintained architecture notes.

### Platform-owned

- Client `src/app/lib/**` — stage shell, transport, state stores, built-in UI, and shared components.
- Server `src/ws/**`, `src/http/**`, `src/services/**`, the core messaging pipeline, built-in catalog,
  generated surface tools, and `bl/config-bridge.ts`.
- Vendored libraries and protocol implementations.

Use the sanctioned agent anchors rather than importing agent configuration or surfaces directly into
platform code. Existing boundary checks reject unsupported platform-to-agent imports.

## Project map

```text
.agent/
├── mcp.json                       external MCP connections
└── skills/<name>/SKILL.md         generated-agent skills, created per use case

.agentplace/
├── high-level-architecture.md     this maintained system map
├── project-description.md         product purpose and current capabilities
└── specification.md               implementation requirements and decisions

agent-dev-client/src/app/
├── agent/                         Builder-editable UI anchors
│   ├── surfaces/                  authored React screen components
│   ├── renderers.ts               inline tool-card renderers
│   ├── site-config.ts             brand, navigation, appearance, site/chat mode
│   └── theme.css                  per-agent accent
└── lib/                           platform stage, state, transport, and built-ins

agent-dev-server/src/
├── instruction.md                 generated-agent system instruction
├── config.ts                      model and voice anchor
├── surfaces/                      authored screen contracts
├── bl/tools/impl/                 custom backend tools
├── bl/messaging/subagents/        generated-agent subagents
├── trpc/routers/                  deterministic data procedures
├── bl/messaging/                  platform messaging pipeline
├── ws/                            platform browser/session transport
└── http/                          platform HTTP and MCP routes
```

## Turn and session flow

1. A browser, MCP caller, channel, trigger, or schedule supplies a request.
2. The server resolves the session and creates a messaging service for the turn.
3. The system prompt combines `instruction.md`, applicable `.agent/skills`, channel context, and
   relevant session state.
4. A fresh tool registry combines platform tools, generated `Render<Component>` screen tools,
   generated-agent custom tools, MCP tools, and subagents.
5. The agent loop streams text, reasoning, tool calls, and screen events.
6. Session state and conversation messages are persisted; connected browser clients receive the live
   stream and can reconstruct completed content after reconnect.
7. Browser actions dispatch a new turn carrying the screen action and its context.

Only one message runs at a time in a session. A bounded queue may hold one additional message. The
browser can reconnect and resume completed content; do not use in-memory objects as durable business
state.

On a fresh browser session, the platform sends `[user opened the agent]` through this same pipeline.
The generated agent's response to that turn is its initial customer arrival. It is not a separate
React route or hardcoded landing page.

## Screen architecture

An authored screen has two entries keyed by the same `component` name:

1. a `ComponentContract` in `agent-dev-server/src/surfaces/`; and
2. a React component in `agent-dev-client/src/app/agent/surfaces/`.

The platform generates one `Render<Component>` tool from each contract. The LLM calls that tool; the
server emits surface events and the client resolves the matching component. Reusing a `surfaceId`
updates the existing screen in place. A new id creates a new screen position in the turn history.

Contracts declare the props the model may provide and, when needed:

- `actions` for events that start a new turn;
- `publishes` for values a screen writes to its data model;
- `fallbackTemplate` for MCP and channels that cannot render React; and
- validation or composition hooks for non-trivial contracts.

`RenderSectionStack` composes multiple contract-backed sections into one screen. Prefer it when
several sections must appear together; do not create a second page-frame component inside the stage.

The stage shell owns viewport layout, scrolling, input, navigation rail, and optional site header.
`SITE_CONFIG.mode` selects a transcript-like chat view or a site view where the latest screen becomes
the page. Authored screens are natural-height content inside the stage column; they do not own the
viewport, root scrolling, dock, or global navigation.

## Backend extension seams

Choose the smallest seam that matches the behavior:

| Need | Extension seam |
|---|---|
| Deterministic reads or mutations used by React | tRPC router |
| An action the LLM must decide to call | Custom backend tool |
| External service operation | Existing MCP tool, or a custom tool when MCP cannot express it |
| External event | Registered trigger handler |
| Work at a future time or cadence | Registered schedule handler |
| Independent LLM specialization inside a turn | Generated-agent subagent |

tRPC calls travel over the existing WebSocket `RpcPeer`; there is no separate browser tRPC HTTP
endpoint. Mutations built with `loggedProcedure` write an owner/customer-visible action summary and
invalidate live-query topics. Components subscribed through `useLiveQuery` refetch after invalidation
and after reconnect.

Custom tools return model-facing output and may expose an inline UI component. Screens are not custom
tool classes: their tools are generated from contracts.

## Data and lifecycle

Use storage according to the lifetime and audience of the data:

- **Records** — durable business entities such as bookings, orders, catalog items, or per-visitor
  data, with an explicit access class.
- **AgentStorage** — durable files and generated-agent resources. The Bureau's
  ordinary case files live under `common/cases/<docket>.json`; confidential
  settlement stores are separate encrypted files and are never part of a normal
  docket read.
- **State tree** — live workflow and screen state that must synchronize with the current session.
- **Session history** — conversation messages and recoverable tool/component results.
- **External service** — data whose authority remains outside Agentplace.

The VM can suspend when idle. In-memory state, `setTimeout`, and `setInterval` do not survive that
lifecycle. Use durable state plus schedules or triggers for work that must happen later. Handlers must
be safe to retry because inbox delivery and restarts can repeat work.

Environment values are supplied through `.env.runtime`; a change restarts the development server.
Provider credentials are relayed by the platform and must not be written into source, prompts,
conversation history, or logs. The Bureau's `SETTLEMENT_ENCRYPTION_KEY` is an agent-runtime secret:
it encrypts bid values server-side and must never be rendered, logged, or committed.

## Instruction, skills, and configuration

- `instruction.md` defines stable generated-agent behavior, persona, grounding, and tool/screen use.
- `.agent/skills/<name>/SKILL.md` contains domain knowledge and workflows. Autoloaded skills enter
  every generated-agent turn; other skills expose routing metadata and are read on demand.
- `src/config.ts` selects model and voice behavior.
- `site-config.ts` selects brand name, navigation, appearance, optional header, and site/chat mode.
- `theme.css` is the lightweight per-agent brand-accent seam.

Keep knowledge out of `instruction.md` when it belongs in a skill. Keep implementation mechanics out
of both when the tool schema or code is the authority.

## External surfaces

Every published agent exposes MCP operations through `/mcp`. MCP uses the same agent behavior but
projects screens to text and removes reasoning from the result. The Bureau's Stripe connection is
kept out of the orchestrator tool catalogue: the narrow `payments` tRPC router invokes only hosted
Checkout creation and session retrieval server-side. `PaymentGate` is the sole browser entry point;
it initiates checkout on an explicit press and verifies the return before it emits `paymentVerified`.

Messaging-channel adapters use the shared channel runner for streaming, placeholder updates, text
chunking, attachment policy, and durable channel-to-session mapping. Each adapter adds only its
platform-specific inbound gate, renderer, and delivery calls.

Triggers enter through the durable inbox and dispatch to named handlers. Schedules invoke registered
handlers. Unhandled events may fall back to the LLM, but production flows should prefer explicit,
idempotent handlers when behavior must be deterministic.

## Build and observability

The server is Node.js ESM and the client is React/Tailwind. Use ESM-compatible dependencies and the
existing package/build scripts. Platform-specific channel SDKs may require the runtime-import pattern
documented by the channel skills.

Build status is available separately from durable server and browser runtime logs. Execution traces
explain generated-agent model decisions. A clean build, empty error search, screenshot, or successful
tool call proves only what that evidence directly observes.

## Critical invariants

1. A screen contract and React component use the same `component` key; the generated render tool is
   derived from that contract.
2. Contract props cannot collide with shared render parameters such as `surfaceId`, `dataModel`,
   `fallbackMarkdown`, `chips`, `nav`, or `voiceSummary`.
3. Authored screens live inside the stage frame and never create another viewport, root scroll area,
   global input, or app navigation shell.
4. A tool produces inline component content only when it declares a component name; plain tools rely
   on their output and the agent's narrative.
5. Session ids start with a letter or digit, stay within 128 characters, and use only letters,
   digits, `_`, `.`, `:`, or `-`; path separators are invalid.
6. One session processes one message at a time; design actions and handlers for that ordering.
7. Live data mutations must invalidate the topics their UI reads.
8. Important state survives VM sleep only when stored durably.
9. Screens that accept sensitive values must use supported field contracts so platform withholding
   and voice projection can recognize them.
10. Channel output requires a truthful text fallback when its customer cannot see the web screen.
