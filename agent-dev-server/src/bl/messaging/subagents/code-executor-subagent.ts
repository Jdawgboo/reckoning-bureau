import type { LanguageModelV3 } from '@ai-sdk/provider';
import type { ProviderOptions } from '@ai-sdk/provider-utils';
import { forwardAnthropicContainerIdFromLastStep } from '@ai-sdk/anthropic';
import type { IToolRegistry, SubagentConfig } from '../../agent/agent-library.ts';
import { AnthropicCodeExecutionTool } from '../../tools/impl/anthropic-code-execution.tool.ts';
import {
  UploadGeneratedFilesTool,
  type UploadGeneratedFilesToolConfig,
} from '../../tools/impl/upload-generated-files.tool.ts';
import { PendingFilesRegistry } from '../../tools/impl/pending-files-registry.ts';
import { CODE_EXECUTOR_SYSTEM_PROMPT } from './code-executor-prompt.ts';
import { inheritToolsFromParent } from './registry-helpers.ts';

// Higher than general-purpose: the self-check workflow adds a `filesystem` view
// round-trip + 1-2 fix-and-rerender iterations per attempt.
const MAX_MODEL_CALLS = 20;
const MODEL_SHORT_NAME = 'code-executor-sonnet';

// Lifted from the parent registry: `filesystem` (hand off long task specs by path; read back
// generated artifacts), `getCurrentTime`, and `web_search` (the sandbox has no internet).
const INHERITED_PARENT_TOOLS = ['filesystem', 'getCurrentTime', 'web_search'];

export function createCodeExecutorSubagent(args: {
  /** Resolved direct-Anthropic Sonnet 5 model (NOT Bedrock-routed). */
  directAnthropicSonnet: LanguageModelV3;
  /** Provider options resolved from MODEL_CONFIG['code-executor-sonnet']. */
  modelSettings: { maxOutputTokens: number; providerOptions: ProviderOptions };
  /**
   * Wired into both `AnthropicCodeExecutionTool` (registers file_ids in
   * `toModelOutput`) and `UploadGeneratedFilesTool` (drains the registry,
   * downloads + writes + deletes). The registry lives for this single
   * subagent run; both tools receive the same instance below.
   */
  uploadConfig: Omit<UploadGeneratedFilesToolConfig, 'registry'>;
  /** Parent's tool registry — we whitelist a few read-oriented tools (see `INHERITED_PARENT_TOOLS`). */
  parentRegistry: IToolRegistry;
  agentId?: string;
}): SubagentConfig {
  const toolRegistry = inheritToolsFromParent(args.parentRegistry, {
    includeOnlyNames: INHERITED_PARENT_TOOLS,
  });

  // One registry per subagent run, shared by the two tools.
  const filesRegistry = new PendingFilesRegistry();
  toolRegistry.registerTool(new AnthropicCodeExecutionTool({ registry: filesRegistry }));
  toolRegistry.registerTool(
    new UploadGeneratedFilesTool({
      registry: filesRegistry,
      storageFactory: args.uploadConfig.storageFactory,
      gatewayBaseUrl: args.uploadConfig.gatewayBaseUrl,
      accessKey: args.uploadConfig.accessKey,
    }),
  );

  return {
    type: 'code-executor',
    description:
      'Run Python in a sandbox and/or generate office documents (DOCX, XLSX, PPTX, PDF). ' +
      `Pass a high-level TASK description (not code) and model: '${MODEL_SHORT_NAME}'. ` +
      'Generated files are saved to agent storage; the final answer lists each as ' +
      '`<filename> (path: <path>, mediaType: <mediaType>)`, reachable as `agent-storage:private/<filename>`. ' +
      'For long/structured tasks (e.g. specs), write the text to storage first and pass the path in `task` instead of inlining it.',
    systemPrompt: CODE_EXECUTOR_SYSTEM_PROMPT,
    toolRegistry,
    model: args.directAnthropicSonnet,
    maxModelCalls: MAX_MODEL_CALLS,
    modelSettings: args.modelSettings,
    // Without this, AI SDK never sends `container.id` on follow-up requests,
    // so Anthropic spins up a FRESH container for every `code_execution`
    // call. Python REPL state / `/tmp` / installed packages / OUTPUT_DIR all
    // reset between calls — observed in the wild as the model rebuilding the
    // same artifact 3x while trying to figure out why files vanished. The
    // helper reads `providerMetadata.anthropic.container.id` from the most
    // recent completed step and threads it back via `providerOptions`. AI
    // SDK deep-merges this with our static `container.skills` so both
    // survive. The `?? []` keeps TypeScript happy on the first step when
    // there are no previous steps yet (helper is a no-op in that case). The
    // factory returns a fresh closure per subagent invocation (see
    // `SubagentConfig.prepareStep`'s factory shape).
    prepareStep:
      () =>
      ({ steps }) =>
        forwardAnthropicContainerIdFromLastStep({ steps: steps ?? [] }),
    allowedModelOverrides: [MODEL_SHORT_NAME],
    traceName: `CodeExecutor: ${args.agentId ?? 'unknown'}`,
  };
}
