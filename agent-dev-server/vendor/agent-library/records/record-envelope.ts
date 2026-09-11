/**
 * Pure record-envelope helpers shared by the platform server
 * (`AgentRecordsService`) and the agent VM (`RecordsClient`) so both stamp,
 * audit, filter, and paginate identically. No platform, identity, or
 * authorization logic lives here — enforcement belongs to the consumers.
 */

import type { AgentRecord, AuditActor, FilterClause, RecordPage, RecordQuery } from './types.ts';

/** Soft cap on a serialized record; keeps blobs out and stays far under the 5 MB state node cap. */
export const MAX_RECORD_BYTES = 256 * 1024;
export const MAX_AUDIT_ENTRIES = 20;
export const DEFAULT_QUERY_LIMIT = 50;
export const MAX_QUERY_LIMIT = 200;

export const COLLECTION_NAME_RE = /^[a-z][a-z0-9_]{1,40}$/;
export const RECORD_ID_RE = /^[a-zA-Z0-9_-]{1,64}$/;

/** Envelope fields the service owns; callers cannot set or overwrite them. */
const RESERVED_FIELDS = new Set(['id', 'createdAt', 'updatedAt', 'version', 'sessionId', 'audit']);

function nowISO(): string {
  return new Date().toISOString();
}

export function generateRecordId(collection: string): string {
  const prefix = collection.slice(0, 3);
  return `${prefix}_${crypto.randomUUID().slice(0, 8)}`;
}

/** Bytes of the record when serialized (UTF-8). */
export function serializedRecordBytes(record: AgentRecord): number {
  return Buffer.byteLength(JSON.stringify(record), 'utf8');
}

/**
 * Build a new record: stamp `id`/`createdAt`/`updatedAt`/`version`, seed
 * `audit`, and copy domain fields from `value` (reserved fields in `value` are
 * ignored). `sessionId` scopes the record to a visitor session — pass it only
 * for per-visitor collections.
 */
export function applyCreateEnvelope(
  id: string,
  value: Record<string, unknown>,
  actor: AuditActor,
  options?: { change?: string; sessionId?: string },
): AgentRecord {
  const at = nowISO();
  const record: AgentRecord = {
    id,
    createdAt: at,
    updatedAt: at,
    version: 1,
    audit: [{ at, actor, change: options?.change ?? 'created' }],
  };
  if (options?.sessionId !== undefined) {
    record.sessionId = options.sessionId;
  }
  for (const [key, fieldValue] of Object.entries(value)) {
    if (RESERVED_FIELDS.has(key)) {
      continue;
    }
    record[key] = fieldValue;
  }
  return record;
}

/**
 * Apply a shallow patch over an existing record: merge domain fields, refresh
 * `updatedAt`, and append a capped audit entry. Reserved fields in `patch` are
 * ignored; `id`/`createdAt` are preserved.
 */
export function applyUpdateEnvelope(
  existing: AgentRecord,
  patch: Record<string, unknown>,
  actor: AuditActor,
  changeNote?: string,
): AgentRecord {
  const at = nowISO();
  const record: AgentRecord = { ...existing };
  const changedKeys: string[] = [];
  for (const [key, fieldValue] of Object.entries(patch)) {
    if (RESERVED_FIELDS.has(key)) {
      continue;
    }
    if (record[key] !== fieldValue) {
      changedKeys.push(key);
    }
    record[key] = fieldValue;
  }
  const change =
    changeNote ?? (changedKeys.length ? `updated ${changedKeys.join(', ')}` : 'updated');
  record.updatedAt = at;
  record.version = (typeof existing.version === 'number' ? existing.version : 0) + 1;
  record.audit = [...existing.audit, { at, actor, change }].slice(-MAX_AUDIT_ENTRIES);
  return record;
}

/** Deterministic comparator: numeric when both are numbers, else string compare. */
export function compareValues(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') {
    return a - b;
  }
  const as = String(a);
  const bs = String(b);
  if (as < bs) {
    return -1;
  }
  if (as > bs) {
    return 1;
  }
  return 0;
}

function matchesClause(record: AgentRecord, clause: FilterClause): boolean {
  const fieldValue = record[clause.field];
  switch (clause.op) {
    case 'exists':
      return fieldValue !== undefined && fieldValue !== null;
    case 'eq':
      return fieldValue === clause.value;
    case 'neq':
      return fieldValue !== clause.value;
    case 'contains':
      return (
        typeof fieldValue === 'string' &&
        typeof clause.value === 'string' &&
        fieldValue.includes(clause.value)
      );
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      if (fieldValue === undefined || fieldValue === null || clause.value === undefined) {
        return false;
      }
      const cmp = compareValues(fieldValue, clause.value);
      if (clause.op === 'gt') {
        return cmp > 0;
      }
      if (clause.op === 'gte') {
        return cmp >= 0;
      }
      if (clause.op === 'lt') {
        return cmp < 0;
      }
      return cmp <= 0;
    }
    default:
      return false;
  }
}

/** True when the record satisfies every clause (AND). */
export function matchesFilter(record: AgentRecord, clauses: FilterClause[] | undefined): boolean {
  if (!clauses || clauses.length === 0) {
    return true;
  }
  return clauses.every((clause) => matchesClause(record, clause));
}

function encodeCursor(id: string): string {
  return Buffer.from(id, 'utf8').toString('base64');
}

function decodeCursor(cursor: string): string {
  return Buffer.from(cursor, 'base64').toString('utf8');
}

/**
 * Sort (with `id` as a stable tiebreaker for cursor stability), then paginate.
 * The cursor is the last-returned record's id; the next page resumes after it
 * in the deterministic order.
 */
export function sortAndPaginate(records: AgentRecord[], query: RecordQuery): RecordPage {
  const sorted = [...records];
  const sortField = query.sort?.field;
  const dir = query.sort?.dir === 'desc' ? -1 : 1;
  sorted.sort((a, b) => {
    if (sortField) {
      const primary = compareValues(a[sortField], b[sortField]) * dir;
      if (primary !== 0) {
        return primary;
      }
    }
    return compareValues(a.id, b.id);
  });

  const limit = Math.min(Math.max(query.limit ?? DEFAULT_QUERY_LIMIT, 1), MAX_QUERY_LIMIT);
  let startIndex = 0;
  if (query.cursor) {
    const lastId = decodeCursor(query.cursor);
    const foundIndex = sorted.findIndex((record) => record.id === lastId);
    startIndex = foundIndex >= 0 ? foundIndex + 1 : 0;
  }

  const page = sorted.slice(startIndex, startIndex + limit);
  const hasMore = startIndex + limit < sorted.length;
  const nextCursor =
    hasMore && page.length > 0 ? encodeCursor(page[page.length - 1].id) : undefined;
  return { records: page, nextCursor };
}
