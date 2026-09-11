import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert';
import type { LanguageModelV3Prompt } from '@ai-sdk/provider';

import { ModelProviderService } from './model-provider.service.ts';

const SCREENSHOT_JPEG_BASE64 = `/9j/4AAQSkZJRgABAQAAAQABAAD${'QUJDRUZH'.repeat(15_000)}`;

/** Shape a screenshot-returning tool produces inside the agent runtime. */
function screenshotToolResultPrompt(): LanguageModelV3Prompt {
  return [
    { role: 'user', content: [{ type: 'text', text: 'check the page' }] },
    {
      role: 'assistant',
      content: [
        { type: 'tool-call', toolCallId: 'call_1', toolName: 'Screenshot', input: { path: '/' } },
      ],
    },
    {
      role: 'tool',
      content: [
        {
          type: 'tool-result',
          toolCallId: 'call_1',
          toolName: 'Screenshot',
          output: {
            type: 'content',
            value: [{ type: 'image-data', data: SCREENSHOT_JPEG_BASE64, mediaType: 'image/jpeg' }],
          },
        },
      ],
    },
  ];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Tool-result payloads as the provider receives them, for both wire protocols. */
function toolResultPayloads(body: Record<string, unknown>): unknown[] {
  const payloads: unknown[] = [];

  if (Array.isArray(body.messages)) {
    for (const message of body.messages) {
      if (isRecord(message) && message.role === 'tool') {
        payloads.push(message.content);
      }
    }
  }
  if (Array.isArray(body.input)) {
    for (const item of body.input) {
      if (isRecord(item) && item.type === 'function_call_output') {
        payloads.push(item.output);
      }
    }
  }

  return payloads;
}

describe('ModelProviderService — image tool results on the wire', () => {
  const realFetch = globalThis.fetch;
  let capturedBody: Record<string, unknown> | null = null;

  beforeEach(() => {
    capturedBody = null;
    globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
      if (typeof init?.body === 'string') {
        capturedBody = JSON.parse(init.body);
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('grok: image tool-result is not flattened to base64 text', async () => {
    const service = new ModelProviderService({
      baseUrl: 'https://gateway.test/gateway',
      accessKey: 'test-key',
    });
    const model = await service.getModel('grok-4.5');

    try {
      await model.doGenerate({ prompt: screenshotToolResultPrompt() });
    } catch {
      // The wire payload is asserted below; SDK response parsing is unrelated.
    }

    assert.ok(capturedBody, 'no request reached the provider');
    const payloads = toolResultPayloads(capturedBody);
    assert.equal(payloads.length, 1, 'expected exactly one tool result on the wire');

    const payload = payloads[0];
    const flattenedToText = typeof payload === 'string' && payload.includes(SCREENSHOT_JPEG_BASE64);
    assert.ok(
      !flattenedToText,
      `image payload was serialized into the tool result as text (${
        typeof payload === 'string' ? payload.length : 0
      } chars) — the provider tokenizes it as text and the prompt overshoots the model limit`,
    );
  });
});
