/**
 * Business-record types for the agent records plane.
 *
 * Generic, platform-agnostic shapes shared between the platform server
 * (`AgentRecordsService`), the agent VM (`RecordsClient`), and the dashboard.
 * Records live at `/data/records/{collection}/{id}` on the state tree.
 * Collections are declared in agent config (`state.mounts[]`, owned by the
 * platform's shared types) — the declaration set is the allow-list; this module
 * carries only the record-level machinery (envelope, filters, schema checks).
 */

/** Who performed a mutation, recorded in each audit entry. */
export type AuditActor = 'agent' | 'user' | 'owner' | 'admin-role' | 'system';

export interface AuditEntry {
  at: string;
  actor: AuditActor;
  change: string;
}

/**
 * A stored business record. The service owns `id`, `createdAt`, `updatedAt`,
 * `version`, `sessionId`, and `audit` — callers cannot set or overwrite them.
 * Domain fields sit at the top level alongside the envelope.
 */
export interface AgentRecord {
  id: string;
  createdAt: string;
  updatedAt: string;
  /** Monotonic per-record revision: 1 on create, +1 per update. */
  version: number;
  status?: string;
  endUserId?: string | null;
  /**
   * Visitor session that created the record. Stamped server-side for
   * per-visitor collections; the access guard scopes reads/updates to it.
   */
  sessionId?: string | null;
  externalRefs?: Record<string, string>;
  audit: AuditEntry[];
  [domainField: string]: unknown;
}

/**
 * Dashboard/API projection of a declared collection: identity + the
 * declaration's JSON Schema (drives Library tables and forms) + display
 * columns (a convenience projection of the schema) + live record count.
 */
export interface CollectionSummary {
  name: string;
  /** Owner-facing display name from the declaration; UIs fall back to `name` when absent. */
  title?: string;
  description?: string;
  access?: 'catalog' | 'log' | 'per-visitor';
  schema?: Record<string, unknown>;
  columns?: string[];
  recordCount?: number;
}

/** Record operation the agent may invoke on a collection. */
export type RecordOp = 'create' | 'get' | 'query' | 'update';

/** Which rows an operation sees: every row, or only the calling session's. */
export type RecordScope = 'all' | 'session';

/**
 * Agent-facing projection of a declared collection: identity, the rules the
 * platform enforces on it, and the JSON Schema its writes are validated
 * against. Deliberately narrower than {@link CollectionSummary} — record
 * counts, undeclared collections, and owner-loop policy never cross to the VM.
 */
export interface CollectionDeclaration {
  name: string;
  title?: string;
  description?: string;
  ops: RecordOp[];
  scope: RecordScope;
  schema?: Record<string, unknown>;
}

export type FilterOp = 'eq' | 'neq' | 'contains' | 'gt' | 'gte' | 'lt' | 'lte' | 'exists';

export interface FilterClause {
  /** Top-level field only; dot-paths are out of scope. */
  field: string;
  op: FilterOp;
  value?: string | number | boolean;
}

export interface RecordQuery {
  /** Clauses are AND-ed. */
  filter?: FilterClause[];
  sort?: { field: string; dir: 'asc' | 'desc' };
  /** Default 50, max 200. */
  limit?: number;
  /** Opaque cursor: base64 of the last-returned id. */
  cursor?: string;
}

export interface RecordPage {
  records: AgentRecord[];
  nextCursor?: string;
}
