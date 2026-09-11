import { describe, test } from 'node:test';
import { strict as assert } from 'node:assert';
import { AnthropicCodeExecutionTool } from './anthropic-code-execution.tool.ts';
import { PendingFilesRegistry } from './pending-files-registry.ts';

type ToModelOutputArgs = { toolCallId: string; input: unknown; output: unknown };
type ToModelOutputResult = { type: string; value?: unknown };
type ToModelOutputFn = (args: ToModelOutputArgs) => unknown;

function getHook(tool: AnthropicCodeExecutionTool): ToModelOutputFn {
  const aiSdkTool = tool.getAiSdkTool() as { toModelOutput?: ToModelOutputFn } | null;
  assert.ok(aiSdkTool, 'tool should expose AI SDK tool');
  assert.ok(aiSdkTool.toModelOutput, 'AI SDK tool should expose toModelOutput hook');
  return aiSdkTool.toModelOutput;
}

async function callHook(
  hook: ToModelOutputFn,
  args: ToModelOutputArgs,
): Promise<ToModelOutputResult> {
  return (await hook(args)) as ToModelOutputResult;
}

// `fetch` is NOT touched by the hook anymore — verify that. We replace
// globalThis.fetch with a throwing stub for the duration of these tests.
function installNoNetwork(): void {
  globalThis.fetch = (async () => {
    throw new Error('fetch must not be called from the toModelOutput hook');
  }) as typeof fetch;
}

describe('AnthropicCodeExecutionTool', () => {
  test('hook registers every file_id from a bash_code_execution_result and passes output through unchanged', async () => {
    installNoNetwork();
    const registry = new PendingFilesRegistry();
    const tool = new AnthropicCodeExecutionTool({ registry });
    const hook = getHook(tool);

    const output = {
      type: 'bash_code_execution_result',
      content: [
        { type: 'bash_code_execution_output', file_id: 'file_A' },
        { type: 'bash_code_execution_output', file_id: 'file_B' },
      ],
      stdout: 'ok',
      stderr: '',
      return_code: 0,
    };

    const result = await callHook(hook, { toolCallId: 'srv-1', input: {}, output });

    // Output unchanged — required so `convertToAnthropicMessagesPrompt`
    // re-validates the stored output against the discriminated-union schema
    // (which requires `file_id: string` on content[]).
    assert.deepStrictEqual(result, { type: 'json', value: output });

    // Registry side-effect: ids pending, ready for UploadGeneratedFilesTool.
    assert.deepStrictEqual(registry.listPending(), ['file_A', 'file_B']);
  });

  test('hook is a pure registration step — no network calls, no storage writes', async () => {
    let fetched = false;
    globalThis.fetch = (async () => {
      fetched = true;
      throw new Error('not called');
    }) as typeof fetch;

    const registry = new PendingFilesRegistry();
    const tool = new AnthropicCodeExecutionTool({ registry });
    const hook = getHook(tool);

    await callHook(hook, {
      toolCallId: 'srv-1',
      input: {},
      output: {
        type: 'bash_code_execution_result',
        content: [{ type: 'bash_code_execution_output', file_id: 'file_A' }],
        stdout: '',
        stderr: '',
        return_code: 0,
      },
    });

    assert.equal(fetched, false, 'hook must not perform network IO');
    assert.deepStrictEqual(registry.listPending(), ['file_A']);
  });

  test('variants without file_id pass through unchanged and do not touch the registry', async () => {
    installNoNetwork();
    const registry = new PendingFilesRegistry();
    const tool = new AnthropicCodeExecutionTool({ registry });
    const hook = getHook(tool);

    const errorOutput = {
      type: 'bash_code_execution_tool_result_error',
      error_code: 'execution_time_exceeded',
    };
    const result = await callHook(hook, { toolCallId: 'srv-1', input: {}, output: errorOutput });
    assert.deepStrictEqual(result, { type: 'json', value: errorOutput });
    assert.deepStrictEqual(registry.listPending(), []);
  });

  test('hook accumulates ids across multiple code_execution turns into the same registry', async () => {
    installNoNetwork();
    const registry = new PendingFilesRegistry();
    const tool = new AnthropicCodeExecutionTool({ registry });
    const hook = getHook(tool);

    await callHook(hook, {
      toolCallId: 'srv-1',
      input: {},
      output: {
        type: 'bash_code_execution_result',
        content: [{ type: 'bash_code_execution_output', file_id: 'file_A' }],
        stdout: '',
        stderr: '',
        return_code: 0,
      },
    });
    await callHook(hook, {
      toolCallId: 'srv-2',
      input: {},
      output: {
        type: 'bash_code_execution_result',
        content: [{ type: 'bash_code_execution_output', file_id: 'file_B' }],
        stdout: '',
        stderr: '',
        return_code: 0,
      },
    });

    assert.deepStrictEqual(registry.listPending(), ['file_A', 'file_B']);
  });

  test('hook registers every variant that carries file_ids (code/encrypted/bash)', async () => {
    installNoNetwork();
    const registry = new PendingFilesRegistry();
    const tool = new AnthropicCodeExecutionTool({ registry });
    const hook = getHook(tool);

    await callHook(hook, {
      toolCallId: 'srv-1',
      input: {},
      output: {
        type: 'code_execution_result',
        content: [{ type: 'code_execution_output', file_id: 'file_PLAIN' }],
        stdout: '',
        stderr: '',
        return_code: 0,
      },
    });
    await callHook(hook, {
      toolCallId: 'srv-2',
      input: {},
      output: {
        type: 'encrypted_code_execution_result',
        content: [{ type: 'code_execution_output', file_id: 'file_ENCRYPTED' }],
        encrypted_stdout: '...',
        stderr: '',
        return_code: 0,
      },
    });

    assert.deepStrictEqual(registry.listPending().sort(), ['file_ENCRYPTED', 'file_PLAIN']);
  });
});
