/**
 * manageRecords — the deployed agent's tool for its own business records
 * (bookings, reviews, patients, admin_requests, …) on the durable records
 * plane. Backed by {@link RecordsClient} over the platform's guarded
 * `records:*` RPC verbs, so every call is authorized server-side against the
 * collection's declared access class (catalog / log / per-visitor).
 *
 * The declarations the platform will judge a call against are rendered into
 * this tool's description at registry-build time — see
 * {@link formatCollectionDeclarations}. Without them the agent learns its own
 * required fields and enum values from rejected writes.
 */

import { z } from 'zod';
import {
  ToolModel,
  type ToolExecuteContext,
  type ToolExecuteResult,
} from '../../agent/agent-library.ts';
import { RecordsClientError, type RecordsClient } from '../../records/records-client.ts';
import { parseRecordQuery } from '../../../../vendor/agent-library/records/record-input.ts';
import type { CollectionDeclaration } from '../../../../vendor/agent-library/records/types.ts';
import { formatCollectionDeclarations } from './records-declarations.format.ts';

const filterClauseSchema = z.object({
  field: z.string(),
  op: z.enum(['eq', 'neq', 'contains', 'gt', 'gte', 'lt', 'lte', 'exists']),
  value: z.union([z.string(), z.number(), z.boolean()]).optional(),
});

const querySchema = z.object({
  filter: z.array(filterClauseSchema).optional(),
  sort: z.object({ field: z.string(), dir: z.enum(['asc', 'desc']) }).optional(),
  limit: z.number().int().optional(),
  cursor: z.string().optional(),
});

const schema = z.object({
  command: z
    .enum(['query', 'get', 'create', 'update'])
    .describe('Which operation to run on the business records.'),
  collection: z.string().describe('Collection name (plural snake_case).'),
  id: z.string().optional().describe('Record id (required for get/update; optional for create).'),
  value: z.record(z.unknown()).optional().describe('Domain fields for create.'),
  patch: z.record(z.unknown()).optional().describe('Fields to shallow-merge for update.'),
  changeNote: z.string().optional().describe('Short note recorded in the audit entry on update.'),
  query: querySchema.optional().describe('Filter/sort/limit/cursor for query.'),
});

type Args = z.infer<typeof schema>;

const DESCRIPTION = `Store and manage this business's records — the durable system of record (bookings, reviews, patients, orders, admin_requests, …). Every business fact an administrator might later need to correct MUST live here, not only in the conversation.

Records vs files: anything you would look up, count, or correct as an entry is a record — NEVER a file. Files (photos, PDFs, generated documents) belong in agent storage; when one relates to a record, store its storage path on the record, never the file's content.

The collections you may touch, the operations allowed on each, and the fields they require are listed below. The platform enforces them server-side: a "denied" or "not available" error means that operation is not part of your role — do not retry it.

Discipline:
- A create or update that comes back with an error did NOT save anything. Correct the input and retry before you answer the user; never report an outcome you failed to record.
- When you create or change something in an external system (calendar event, payment), store its id in the record's externalRefs so it can be administered later.
- Do NOT perform privileged changes on a user's request (change a rating, cancel with a penalty, edit another person's record, refund). Instead create an admin_requests record describing the request, and tell the user it was escalated to the administrator.

Commands: query, get, create, update.`;

const WRITE_COMMANDS: ReadonlySet<Args['command']> = new Set(['create', 'update']);

export class ManageRecordsTool extends ToolModel<Args> {
  #records: RecordsClient;

  constructor(records: RecordsClient, declarations: CollectionDeclaration[] = []) {
    const block = formatCollectionDeclarations(declarations);
    super({
      name: 'manageRecords',
      description: block.length > 0 ? `${DESCRIPTION}\n\n${block}` : DESCRIPTION,
      parametersSchema: schema,
      toolType: 'function',
    });
    this.#records = records;
  }

  async execute(input: Args, _ctx: ToolExecuteContext): Promise<ToolExecuteResult> {
    try {
      switch (input.command) {
        case 'query': {
          const page = await this.#records.query(input.collection, parseRecordQuery(input.query));
          return this.#ok({
            count: page.records.length,
            records: page.records,
            nextCursor: page.nextCursor,
          });
        }
        case 'get': {
          if (!input.id) {
            return this.#err(input, 'get requires "id".');
          }
          const record = await this.#records.get(input.collection, input.id);
          return record
            ? this.#ok({ record })
            : this.#err(input, `Record ${input.collection}/${input.id} not found.`);
        }
        case 'create': {
          const record = await this.#records.create(input.collection, input.id, input.value ?? {});
          return this.#ok({ created: record.id, record });
        }
        case 'update': {
          if (!input.id) {
            return this.#err(input, 'update requires "id".');
          }
          const record = await this.#records.update(
            input.collection,
            input.id,
            input.patch ?? {},
            input.changeNote,
          );
          return this.#ok({ updated: record.id, record });
        }
        default:
          return this.#err(input, `Unknown command: ${input.command}`);
      }
    } catch (err) {
      // A domain verdict (bad input, denied, not found) is the model's to act
      // on. Anything else means the request never reached the records plane —
      // that is an infrastructure fault, and swallowing it into a result-shaped
      // payload is how a failed write reads as a successful one.
      if (err instanceof RecordsClientError && err.code !== 'unavailable') {
        return this.#err(input, err.message, err.code);
      }
      // Rethrown errors surface on the visitor's screen as an error component,
      // and the platform wraps transport faults around raw backend text (state
      // paths, table names). Replace the message, keep the cause.
      throw new Error(this.#transportFailureMessage(input), { cause: err });
    }
  }

  #ok(payload: Record<string, unknown>): ToolExecuteResult {
    return { output: JSON.stringify(payload) };
  }

  /**
   * A request that never got an answer says nothing about what happened on the
   * other side: a timeout can land after the record was committed. Claiming
   * "not saved" on a write is the one instruction that produces a duplicate
   * booking, so a write reports an unknown outcome and a read reports neither.
   */
  #transportFailureMessage(input: Args): string {
    const target = `${input.command} on "${input.collection}"`;
    if (!WRITE_COMMANDS.has(input.command)) {
      return `The records service did not answer the ${target}.`;
    }
    return `The records service did not confirm the ${target}, so it may or may not have been saved. Read the record back before telling the user anything about it.`;
  }

  /**
   * `saved: false` on a write is the load-bearing part: the previous payload
   * was shaped exactly like a success, and a model that skimmed it reported an
   * appointment it had never recorded.
   */
  #err(input: Args, error: string, code?: string): ToolExecuteResult {
    return {
      output: JSON.stringify({
        error,
        ...(code !== undefined && { code }),
        ...(WRITE_COMMANDS.has(input.command) && { saved: false }),
      }),
    };
  }
}

export function createRecordsTools(
  records: RecordsClient,
  declarations: CollectionDeclaration[] = [],
): ToolModel[] {
  return [new ManageRecordsTool(records, declarations)];
}
