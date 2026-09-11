/**
 * A2UI v0.9 wire payload types (a2ui.org/specification/v0.9-a2ui), as carried
 * inside AG-UI CUSTOM events. Per-type prop validation belongs to the catalog
 * schema, so component props stay loose here.
 */

/** One node of the flat adjacency-list tree. */
export interface A2uiComponentNode {
  id: string;
  component: string;
  children?: string[];
  child?: string;
  [prop: string]: unknown;
}

export interface CreateSurfacePayload {
  surfaceId: string;
  catalogId: string;
  theme?: Record<string, unknown>;
  sendDataModel?: boolean;
  /** Carried opaque; not validated. */
  version?: string;
  /** Non-web channel projection — every surface instance carries an
   *  agent-authored markdown fallback for channels without an A2UI emitter. */
  fallbackMarkdown?: string;
}

export interface UpdateComponentsPayload {
  surfaceId: string;
  components: A2uiComponentNode[];
  version?: string;
}

export interface DeleteSurfacePayload {
  surfaceId: string;
  version?: string;
}

/** Client-side surface record (store shape; components keyed by node id). */
export interface A2uiSurface {
  surfaceId: string;
  catalogId: string;
  theme?: Record<string, unknown>;
  components: ReadonlyMap<string, A2uiComponentNode>;
}
