import { describe, test } from 'node:test';
import { strict as assert } from 'node:assert';
import { z } from 'zod';
import { ToolModel, ToolRegistry } from '../../agent/agent-library.ts';
import { inheritToolsFromParent } from './registry-helpers.ts';

function makeTool(name: string, audience?: 'model' | 'visitor'): ToolModel {
  return new ToolModel({
    toolType: 'function',
    name,
    description: `${name} test tool`,
    parametersSchema: z.object({}),
    ...(audience ? { audience } : {}),
  });
}

describe('inheritToolsFromParent', () => {
  test('excludes visitor-audience tools and the Subagent tool; keeps model-audience tools', () => {
    const parent = new ToolRegistry([
      makeTool('RenderTable', 'visitor'),
      makeTool('manageRecords'),
      makeTool('Subagent'),
      makeTool('grep'),
    ]);

    const child = inheritToolsFromParent(parent);
    const names = child.getAllTools().map((tool) => tool.getName());

    assert.deepEqual(names.sort(), ['grep', 'manageRecords']);
  });

  test('a whitelist cannot reintroduce a visitor-audience tool', () => {
    const parent = new ToolRegistry([makeTool('RenderTable', 'visitor'), makeTool('grep')]);

    const child = inheritToolsFromParent(parent, {
      includeOnlyNames: ['RenderTable', 'grep'],
    });
    const names = child.getAllTools().map((tool) => tool.getName());

    assert.deepEqual(names, ['grep']);
  });
});
