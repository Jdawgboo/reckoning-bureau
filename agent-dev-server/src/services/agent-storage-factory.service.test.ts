import { describe, it } from 'node:test';
import assert from 'node:assert';
import { AgentStorageFactoryService } from './agent-storage-factory.service.ts';

describe('AgentStorageFactoryService tool-results branch', () => {
  const factory = new AgentStorageFactoryService({
    apiBaseUrl: 'https://api.test',
    modelAccessToken: 'tok',
  });
  factory.setInfraConfig([{ name: 'source', basePath: '/tmp/source' }], {
    'source/': 'source',
    'tool-results/': 'tool-results',
    'private/': 'private',
  });

  it('session storage exposes a tool-results adapter', () => {
    const storage = factory.createStorage('session-abc');
    assert.ok(storage.hasAdapter('tool-results'));
  });

  it('storage without a session has no tool-results adapter', () => {
    const storage = factory.createStorage();
    assert.strictEqual(storage.hasAdapter('tool-results'), false);
  });
});
