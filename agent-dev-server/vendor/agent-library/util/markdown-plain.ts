/**
 * Inline-markdown stripper for PLAIN-TEXT projections (`fallbackText` derived
 * from a tool's `fallbackMarkdown`). Channels with no renderer AND no markdown
 * support (SMS, voice transcripts) must not print `**` or `[label](url)`
 * literally. Pragmatic inline-level strip only; markdown-aware consumers use
 * the `fallbackMarkdown` itself. Mirrors the client-side stripper
 * (`agent-dev-client` `a2ui/blocks/markdown-plain.ts`).
 */

const IMAGE_RE = /!\[([^\]]*)\]\([^)]*\)/g;
const LINK_RE = /\[([^\]]+)\]\([^)]*\)/g;
const BOLD_RE = /(\*\*|__)(.+?)\1/g;
const EMPHASIS_RE = /(\*|_)([^*_]+)\1/g;
const CODE_RE = /`([^`]+)`/g;
const LINE_PREFIX_RE = /^\s{0,3}(#{1,6}\s+|>\s?|[-*+]\s+|\d+\.\s+)/;

export function plainTextFromMarkdown(text: string): string {
  return text
    .split('\n')
    .map((line) => line.replace(LINE_PREFIX_RE, ''))
    .join('\n')
    .replace(IMAGE_RE, '$1')
    .replace(LINK_RE, '$1')
    .replace(BOLD_RE, '$2')
    .replace(EMPHASIS_RE, '$2')
    .replace(CODE_RE, '$1');
}
