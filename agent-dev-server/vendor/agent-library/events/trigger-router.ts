/**
 * TriggerRouter — registry for typed trigger handlers.
 *
 * Extends the generic EventRouter with trigger-specific type aliases
 * for backward compatibility.
 *
 * Handler names are case-insensitive — both registration and lookup
 * normalize to lowercase, so 'HUBSPOT_DEAL_STAGE_UPDATED_TRIGGER'
 * and 'hubspot_deal_stage_updated_trigger' match the same handler.
 *
 * @example
 * ```typescript
 * const router = new TriggerRouter();
 * router.register('github_issue_created', async (event, ctx) => {
 *   await ctx.state.set(`/data/issues/${event.payload.issue.number}`, event.payload);
 * });
 * ```
 */

import { EventRouter } from './event-router.ts';
import type { TriggerHandler, TriggerRegistrationOptions } from './types.ts';

export class TriggerRouter extends EventRouter<TriggerHandler, TriggerRegistrationOptions> {}
