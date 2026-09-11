import type { LanguageModelV3 } from '@ai-sdk/provider';
import { wrapLanguageModel, type LanguageModelMiddleware } from 'ai';
import { ToolCallIdNormalizationMiddleware } from '../../defaults/middlewares/tool-call-id-normalization.middleware.ts';
import type { KernelModelMiddleware, KernelModelMiddlewareContext } from './types.ts';

/**
 * Wraps a model with the consumer's kernel middlewares plus the tool-call id
 * normalization middleware (AGE-378), which is appended HERE — never at
 * consumer call sites — so it is innermost (closest to the provider) by
 * construction: `wrapLanguageModel` applies the LAST array element innermost.
 * Anything placed after it would observe internal `_ap_` ids on what it
 * believes is the outgoing prompt.
 */
export function wrapModelWithKernelMiddlewares(params: {
  model: LanguageModelV3;
  ctx: KernelModelMiddlewareContext;
  middlewares: KernelModelMiddleware[];
}): LanguageModelV3 {
  const collected: LanguageModelMiddleware[] = [];
  for (const mw of params.middlewares) {
    const created = mw.create(params.ctx);
    if (!created) {
      continue;
    }
    if (Array.isArray(created)) {
      collected.push(...created);
    } else {
      collected.push(created);
    }
  }

  collected.push(new ToolCallIdNormalizationMiddleware(params.model.provider).create(params.ctx));

  if (collected.length === 1) {
    return wrapLanguageModel({ model: params.model, middleware: collected[0] });
  }
  return wrapLanguageModel({ model: params.model, middleware: collected });
}
