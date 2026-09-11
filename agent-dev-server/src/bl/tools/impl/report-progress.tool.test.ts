import { describe, it } from 'node:test';
import assert from 'node:assert';
import { ReportProgressTool } from './report-progress.tool.ts';
import type { ToolExecuteContext } from '../../agent/agent-library.ts';

function ctx(): ToolExecuteContext {
  return { runner: { state: undefined }, toolCallId: 'call-1' };
}

describe('ReportProgressTool', () => {
  it('publishes what the agent said as a progress fact on the ordinary stream', async () => {
    const tool = new ReportProgressTool();

    const result = await tool.execute(
      { progress: 'Checked four of the six branches for a free slot.' },
      ctx(),
    );

    assert.deepStrictEqual(result.progress, {
      text: 'Checked four of the six branches for a free slot.',
    });
    assert.strictEqual(
      result.uiProps,
      undefined,
      'speaking to a listener must not put anything on a screen',
    );
  });

  it('publishes nothing for an empty report rather than an empty utterance', async () => {
    const tool = new ReportProgressTool();

    const result = await tool.execute({ progress: '   ' }, ctx());

    assert.strictEqual(result.progress, undefined);
  });

  it('bounds one report to a single spoken sentence', async () => {
    const tool = new ReportProgressTool();

    const result = await tool.execute({ progress: 'x'.repeat(500) }, ctx());

    assert.strictEqual(result.progress?.text.length, 200);
  });

  it('refuses a report longer than the schema allows', () => {
    const schema = new ReportProgressTool().parametersSchema;
    assert.ok('safeParse' in schema && typeof schema.safeParse === 'function');

    assert.strictEqual(schema.safeParse({ progress: 'x'.repeat(201) }).success, false);
    assert.strictEqual(schema.safeParse({ progress: '' }).success, false);
  });
});
