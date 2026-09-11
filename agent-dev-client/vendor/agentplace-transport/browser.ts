/**
 * Browser-specific exports
 * Use: import { ... } from 'agentplace-transport/browser'
 */

// Re-export everything from core
export * from './index.ts';

// Browser-specific adapters (require DOM)
// `WebSocketAdapter` on this entry point is the browser-aware subclass — it
// understands tab visibility and doesn't get confused by setInterval throttling
// in backgrounded tabs. Code that wants the base class explicitly should
// import from '/node' or from the adapter file directly.
export {
  BrowserWebSocketAdapter,
  BrowserWebSocketAdapter as WebSocketAdapter,
} from './adapters/BrowserWebSocketAdapter.ts';
export type { WebSocketAdapterOptions } from './adapters/WebSocketAdapter.ts';
export { IframeParentAdapter, IframeChildAdapter } from './adapters/IframeAdapter.ts';
