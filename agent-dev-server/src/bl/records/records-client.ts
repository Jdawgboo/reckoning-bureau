/**
 * VM-side client for the agent's business records — a thin RPC proxy over the
 * platform's guarded `records:*` verbs (state WebSocket). All authorization,
 * schema validation, and envelope stamping happen SERVER-SIDE in the
 * AgentRecordsGate/AgentRecordsService pair; this client only ships requests
 * and surfaces `{ error, code }` payloads as typed errors.
 *
 * What the agent may do per collection is declared in the agent config
 * (`state.mounts[]`, access classes catalog/log/per-visitor) — undeclared
 * collections and unlisted verbs come back as `denied`. `sessionId` scopes
 * per-visitor collections to the current visitor session.
 */

import type {
  AgentRecord,
  CollectionDeclaration,
  RecordOp,
  RecordPage,
  RecordQuery,
  RecordScope,
} from '../../../vendor/agent-library/records/types.ts';
import { isRecord } from '../../util/type-guards.ts';

/**
 * Domain codes mirror the platform's `AgentRecordsError`; `unavailable` is
 * client-side only and means the request never got an answer (no state
 * connection, malformed reply) — callers treat it as infrastructure, not as a
 * verdict on their input.
 */
export type RecordsClientErrorCode =
  | 'invalid'
  | 'not_found'
  | 'conflict'
  | 'too_large'
  | 'denied'
  | 'unavailable';

export class RecordsClientError extends Error {
  readonly code: RecordsClientErrorCode;
  constructor(code: RecordsClientErrorCode, message: string) {
    super(message);
    this.name = 'RecordsClientError';
    this.code = code;
  }
}

/**
 * The RPC channel records requests ride — satisfied by `StateConnection.transport`.
 * `retry: false` marks a request volatile: the transport rejects it immediately
 * while offline instead of buffering it until the socket returns.
 */
export interface RecordsTransport {
  ask<T = unknown>(payload: unknown, options?: { timeout?: number; retry?: boolean }): Promise<T>;
}

const RPC_TIMEOUT_MS = 15_000;

/**
 * Declarations are fetched once per turn, before the first model call, on every
 * path — including turns that never touch records. Short timeout AND volatile:
 * the transport buffers a retryable request with no timer at all while offline,
 * so without `retry: false` a closed socket would hold every turn open
 * indefinitely rather than for the timeout.
 */
const DECLARATIONS_TIMEOUT_MS = 2_000;

const ERROR_CODES: ReadonlySet<string> = new Set([
  'invalid',
  'not_found',
  'conflict',
  'too_large',
  'denied',
  'unavailable',
]);

const RECORD_OPS: ReadonlySet<string> = new Set(['create', 'get', 'query', 'update']);

function isRecordOp(value: unknown): value is RecordOp {
  return typeof value === 'string' && RECORD_OPS.has(value);
}

function toDeclaration(value: unknown): CollectionDeclaration | null {
  if (!isRecord(value) || typeof value['name'] !== 'string') {
    return null;
  }
  const ops = Array.isArray(value['ops']) ? value['ops'].filter(isRecordOp) : [];
  const scope: RecordScope = value['scope'] === 'session' ? 'session' : 'all';
  return {
    name: value['name'],
    ...(typeof value['title'] === 'string' && { title: value['title'] }),
    ...(typeof value['description'] === 'string' && { description: value['description'] }),
    ops,
    scope,
    ...(isRecord(value['schema']) && { schema: value['schema'] }),
  };
}

function isErrorCode(value: unknown): value is RecordsClientErrorCode {
  return typeof value === 'string' && ERROR_CODES.has(value);
}

function toErrorCode(value: unknown): RecordsClientErrorCode {
  return isErrorCode(value) ? value : 'invalid';
}

export class RecordsClient {
  #transport: RecordsTransport | null;
  #sessionId: string | null;

  constructor(transport: RecordsTransport | null, options?: { sessionId?: string }) {
    this.#transport = transport;
    this.#sessionId = options?.sessionId ?? null;
  }

  /**
   * The collections this agent may touch, with the ops, row scope, and JSON
   * Schema the platform enforces. Read-only metadata — the platform renders it
   * into the records tool so the agent does not learn its own schema by
   * failing a write.
   */
  async listDeclarations(): Promise<CollectionDeclaration[]> {
    const result = await this.#ask(
      { type: 'records:declarations' },
      { timeout: DECLARATIONS_TIMEOUT_MS, retry: false },
    );
    // An unrecognized shape must NOT read as "this agent has no collections":
    // callers keep the last good answer, and returning [] would let one garbled
    // reply strip the collection contract for the rest of the process.
    if (!isRecord(result) || !Array.isArray(result['collections'])) {
      throw new RecordsClientError('unavailable', 'Malformed declarations response.');
    }
    return result['collections'].map(toDeclaration).filter((d): d is CollectionDeclaration => !!d);
  }

  async query(collection: string, query: RecordQuery = {}): Promise<RecordPage> {
    const result = await this.#ask({ type: 'records:query', collection, query });
    if (isRecord(result) && Array.isArray(result['records'])) {
      return {
        records: result['records'].filter(isAgentRecord),
        ...(typeof result['nextCursor'] === 'string' && { nextCursor: result['nextCursor'] }),
      };
    }
    return { records: [] };
  }

  async get(collection: string, id: string): Promise<AgentRecord | null> {
    const result = await this.#ask({ type: 'records:get', collection, id });
    if (isRecord(result) && isAgentRecord(result['record'])) {
      return result['record'];
    }
    return null;
  }

  async create(
    collection: string,
    id: string | undefined,
    value: Record<string, unknown>,
  ): Promise<AgentRecord> {
    const result = await this.#ask({
      type: 'records:create',
      collection,
      ...(id !== undefined && { id }),
      value,
    });
    return this.#requireRecord(result);
  }

  async update(
    collection: string,
    id: string,
    patch: Record<string, unknown>,
    changeNote?: string,
  ): Promise<AgentRecord> {
    const result = await this.#ask({
      type: 'records:update',
      collection,
      id,
      patch,
      ...(changeNote !== undefined && { changeNote }),
    });
    return this.#requireRecord(result);
  }

  // -- internals --

  async #ask(
    payload: Record<string, unknown>,
    options?: { timeout?: number; retry?: boolean },
  ): Promise<unknown> {
    if (!this.#transport) {
      throw new RecordsClientError(
        'unavailable',
        'Records are not available: no state connection.',
      );
    }
    const request = this.#sessionId ? { ...payload, sessionId: this.#sessionId } : payload;
    const result = await this.#transport.ask<unknown>(request, {
      timeout: options?.timeout ?? RPC_TIMEOUT_MS,
      ...(options?.retry !== undefined && { retry: options.retry }),
    });
    if (isRecord(result) && typeof result['error'] === 'string') {
      throw new RecordsClientError(toErrorCode(result['code']), result['error']);
    }
    return result;
  }

  #requireRecord(result: unknown): AgentRecord {
    if (isRecord(result) && isAgentRecord(result['record'])) {
      return result['record'];
    }
    throw new RecordsClientError('unavailable', 'Malformed records response from the platform.');
  }
}

function isAgentRecord(value: unknown): value is AgentRecord {
  return isRecord(value) && typeof value['id'] === 'string' && Array.isArray(value['audit']);
}
