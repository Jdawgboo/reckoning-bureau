/**
 * Message Grouper
 *
 * Groups messages into user request + agent responses pairs.
 * This is useful for UI rendering where each exchange is displayed together.
 */

import type { AgentContent } from '../types/content.ts';
import type { Group, GroupableItem, MessageGroup } from './types.ts';

/**
 * Determine if a message is a user message.
 *
 * Convention: User messages have type 'TXT' and content is a string,
 * or have a role property set to 'user'.
 * Agent messages are everything else.
 */
function isUserMessage(content: AgentContent): boolean {
  // Check for explicit role if present (from UI message format)
  if ('role' in content && (content as { role?: string }).role === 'user') {
    return true;
  }
  return false;
}

/**
 * Determine whether an incoming (non-user) message belongs to the currently
 * open group, per the turn-boundary rule: a group owns the first non-empty
 * `responseId` it observes, and an item with no `responseId` always joins
 * whatever group is open (this is what keeps a live optimistic user message
 * from being split from its run's content once the run's `responseId`
 * arrives — see spec §4).
 */
function joinsCurrentGroup<T>(
  currentGroup: Group<T> | null,
  responseId: string | undefined,
): currentGroup is Group<T> {
  if (!currentGroup) {
    return false;
  }
  if (currentGroup.responseId === undefined || responseId === undefined) {
    return true;
  }
  return currentGroup.responseId === responseId;
}

/**
 * The turn-boundary rule, over any item type.
 *
 * One implementation, so the builder chat (MobX `MessageModel`) and the agent
 * surfaces (`AgentContent`) cannot drift — the duplication
 * `docs/superpowers/specs/2026-07-24-turn-model-unification.md` set out to
 * eliminate. Callers supply `read` to expose the three facts the rule needs;
 * item ordering is the caller's concern, not this function's.
 */
export function computeGroups<T>(items: T[], read: (item: T) => GroupableItem): Group<T>[] {
  const groups: Group<T>[] = [];
  let currentGroup: Group<T> | null = null;
  let groupId = 0;

  for (const item of items) {
    const { isUserMessage: isUser, responseId: rawResponseId, hidden } = read(item);
    const responseId = rawResponseId || undefined;

    if (isUser) {
      if (currentGroup && responseId !== undefined && currentGroup.responseId === responseId) {
        currentGroup.responses.push(item);
        continue;
      }

      currentGroup = {
        id: `group-${++groupId}`,
        request: item,
        responses: [],
        responseId,
        kind: hidden ? 'home' : 'user',
      };
      groups.push(currentGroup);
      continue;
    }

    if (joinsCurrentGroup(currentGroup, responseId)) {
      if (currentGroup.responseId === undefined && responseId !== undefined) {
        currentGroup.responseId = responseId;
      }
      currentGroup.responses.push(item);
      continue;
    }

    const isFirstGroup = groups.length === 0;
    currentGroup = {
      id: `group-${++groupId}`,
      request: null,
      responses: [item],
      responseId,
      kind: isFirstGroup ? 'home' : 'agent',
    };
    groups.push(currentGroup);
  }

  return groups;
}

/**
 * Compute message groups (turns) from a flat list of messages.
 *
 * A turn is a run: it opens when a user message arrives, or when an item
 * carries a new non-empty `responseId` that the current turn does not
 * already own (see spec `docs/superpowers/specs/2026-07-24-turn-model-unification.md`
 * §4). The turn adopts the first `responseId` it observes, from either the
 * user echo or assistant content; an item with no `responseId` always joins
 * the currently open turn rather than splitting it.
 *
 * @example
 * ```typescript
 * const groups = computeMessageGroups(messages);
 * // [
 * //   { id: '1', request: userMsg1, responses: [agentMsg1, agentMsg2], kind: 'user' },
 * //   { id: '2', request: userMsg2, responses: [agentMsg3], kind: 'user' },
 * // ]
 * ```
 */
export function computeMessageGroups(messages: AgentContent[]): MessageGroup[] {
  return computeGroups(messages, (message) => ({
    isUserMessage: isUserMessage(message),
    responseId: message.responseId,
    hidden: message.hidden,
  }));
}

/**
 * Get the last message group from a list of messages.
 *
 * Convenience helper that computes groups and returns the most recent one.
 * Useful for accessing the latest user request and its responses.
 *
 * @param messages - Flat array of agent content messages
 * @returns The last message group, or undefined if no messages
 *
 * @example
 * ```typescript
 * const lastGroup = getLastGroup(conversation.messages);
 * if (lastGroup?.request) {
 *   console.log('Last user message:', lastGroup.request.content);
 *   console.log('Agent responses:', lastGroup.responses.length);
 * }
 * ```
 */
export function getLastGroup(messages: AgentContent[]): MessageGroup | undefined {
  const groups = computeMessageGroups(messages);
  return groups[groups.length - 1];
}

/**
 * Get all agent responses from the most recent exchange.
 *
 * Convenience helper that returns only the responses from the last group,
 * without the user request. Returns empty array if no messages.
 *
 * @param messages - Flat array of agent content messages
 * @returns Array of agent responses from the last exchange
 *
 * @example
 * ```typescript
 * const responses = getLastResponses(conversation.messages);
 * const textResponses = responses.filter(r => r.type === ContentType.Text);
 * ```
 */
export function getLastResponses(messages: AgentContent[]): AgentContent[] {
  const lastGroup = getLastGroup(messages);
  return lastGroup?.responses || [];
}
