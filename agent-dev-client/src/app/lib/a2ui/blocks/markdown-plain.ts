/**
 * Inline-markdown stripper for PLAIN-TEXT slots (titles, subtitles, previews).
 * Headings are typography, not markdown hosts — deriving a title from a
 * markdown answer must not print `**` literally, and rendering nested markup
 * inside a hero title is equally wrong. Pragmatic inline-level strip only;
 * body text goes through the real Markdown renderer (MarkdownText block).
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
