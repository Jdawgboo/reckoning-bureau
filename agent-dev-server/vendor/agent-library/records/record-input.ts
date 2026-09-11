/**
 * Cast-free parsers that narrow untrusted / loosely-typed input (HTTP bodies,
 * Zod-inferred tool args) into the canonical record types. Shared by the
 * platform server (REST controller, ManageAgentData tool) and the agent VM
 * (records tool) so every surface validates identically. Pure — no platform
 * imports.
 */

import { isRecord } from '../util/type-guards.ts';
import type { FilterClause, FilterOp, RecordQuery } from './types.ts';

const FILTER_OPS: ReadonlySet<string> = new Set([
  'eq',
  'neq',
  'contains',
  'gt',
  'gte',
  'lt',
  'lte',
  'exists',
]);

function isFilterOp(value: unknown): value is FilterOp {
  return typeof value === 'string' && FILTER_OPS.has(value);
}

function isPresent<T>(value: T | null): value is T {
  return value !== null;
}

function parseFilterClause(value: unknown): FilterClause | null {
  if (!isRecord(value) || typeof value['field'] !== 'string' || !isFilterOp(value['op'])) {
    return null;
  }
  const clause: FilterClause = { field: value['field'], op: value['op'] };
  const raw = value['value'];
  if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') {
    clause.value = raw;
  }
  return clause;
}

export function parseRecordQuery(value: unknown): RecordQuery {
  if (!isRecord(value)) {
    return {};
  }
  const query: RecordQuery = {};
  if (Array.isArray(value['filter'])) {
    query.filter = value['filter'].map(parseFilterClause).filter(isPresent);
  }
  const sort = value['sort'];
  if (isRecord(sort) && typeof sort['field'] === 'string') {
    query.sort = { field: sort['field'], dir: sort['dir'] === 'desc' ? 'desc' : 'asc' };
  }
  if (typeof value['limit'] === 'number') {
    query.limit = value['limit'];
  }
  if (typeof value['cursor'] === 'string') {
    query.cursor = value['cursor'];
  }
  return query;
}
