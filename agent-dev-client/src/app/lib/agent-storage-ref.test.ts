import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { classifyImageRef, classifyDownloadRef } from './agent-storage-ref.ts';

test('classifyImageRef: agent-storage: ref strips to a branch-qualified storage path', () => {
  assert.deepStrictEqual(classifyImageRef('agent-storage:private/chart.png'), {
    kind: 'storage',
    path: 'private/chart.png',
  });
  assert.deepStrictEqual(classifyImageRef('agent-storage:common/chart.png'), {
    kind: 'storage',
    path: 'common/chart.png',
  });
});

test('classifyImageRef: a bare name is a storage path (not rendered as-is)', () => {
  assert.deepStrictEqual(classifyImageRef('chart.png'), { kind: 'storage', path: 'chart.png' });
});

test('classifyImageRef: http(s)/data/blob pass through as URLs', () => {
  assert.deepStrictEqual(classifyImageRef('https://cdn.example/x.png'), {
    kind: 'url',
    url: 'https://cdn.example/x.png',
  });
  assert.deepStrictEqual(classifyImageRef('data:image/png;base64,AAAA'), {
    kind: 'url',
    url: 'data:image/png;base64,AAAA',
  });
  assert.deepStrictEqual(classifyImageRef('blob:https://app/abc'), {
    kind: 'url',
    url: 'blob:https://app/abc',
  });
});

test('classifyImageRef: cache key is the full branch-qualified path, not the basename', () => {
  const common = classifyImageRef('agent-storage:common/x.png');
  const bare = classifyImageRef('x.png');
  assert.notStrictEqual(
    (common as { path: string }).path,
    (bare as { path: string }).path,
    'common/x.png and bare x.png must classify to distinct paths',
  );
});

test('classifyDownloadRef: agent-storage: ref strips to a storage path', () => {
  assert.deepStrictEqual(classifyDownloadRef('agent-storage:private/report.pdf'), {
    kind: 'storage',
    path: 'private/report.pdf',
  });
  assert.deepStrictEqual(classifyDownloadRef('agent-storage:common/report.pdf'), {
    kind: 'storage',
    path: 'common/report.pdf',
  });
});

test('classifyDownloadRef: a bare name is a storage path', () => {
  assert.deepStrictEqual(classifyDownloadRef('report.pdf'), {
    kind: 'storage',
    path: 'report.pdf',
  });
});

test('classifyDownloadRef: http(s) downloads directly, no presigned lookup', () => {
  assert.deepStrictEqual(classifyDownloadRef('https://cdn.example/x.pdf'), {
    kind: 'url',
    url: 'https://cdn.example/x.pdf',
  });
});

test('classifyDownloadRef: data: is NOT a direct URL (treated as storage path)', () => {
  assert.deepStrictEqual(classifyDownloadRef('data:application/pdf;base64,AAAA'), {
    kind: 'storage',
    path: 'data:application/pdf;base64,AAAA',
  });
});
