export type {
  ChannelRenderer,
  RendererMap,
  RenderOptions,
  StreamingMode,
} from './renderer.ts';
export { render, shouldRender } from './renderer.ts';
export {
  withTypingIndicator,
  handleChannelStream,
  type ChannelStreamAdapter,
  type ChannelStreamWording,
  type MessageHandle,
} from './runner.ts';
export { chunkText } from './chunk-text.ts';
export {
  createChannelSessionStore,
  type ChannelSessionStore,
  type ChannelSessionStoreOptions,
  type StateTreeLike,
} from './channel-session-store.ts';
// Note: `Attachment` is intentionally NOT re-exported from here — it would
// collide with the canonical `Attachment` exported from `core/interfaces.ts`
// at the top-level agent-library/index. The two shapes are structurally
// identical, so consumers use the canonical type and pass values across freely.
export {
  downloadAttachments,
  defaultAllowType,
  formatRejectedSummary,
  type IncomingAttachmentRef,
  type DownloadOptions,
  type DownloadResult,
} from './attachment-downloader.ts';
