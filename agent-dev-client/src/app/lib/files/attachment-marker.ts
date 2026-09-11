/**
 * The attachment-marker convention: attached filenames ride inline in the
 * user message text (`[Attached: a.png, b.pdf]`) because files themselves are
 * not persisted in the transcript — the marker is what survives history
 * rehydration (and tells the model the filenames). Display layers STRIP the
 * marker and render chips/thumbnails instead; only the wire text carries it.
 */

const MARKER_RE = /\s*\[Attached: ([^\]]+)\]\s*$/;

export function decorateWithAttachments(text: string, filenames: string[]): string {
  if (filenames.length === 0) {
    return text;
  }
  return `${text}${text ? '\n\n' : ''}[Attached: ${filenames.join(', ')}]`;
}

export interface SplitRequest {
  /** The request with the marker removed. */
  text: string;
  /** Filenames parsed from the marker; empty when none. */
  filenames: string[];
}

export function splitAttachmentMarker(raw: string): SplitRequest {
  const match = raw.match(MARKER_RE);
  if (!match || match.index === undefined) {
    return { text: raw, filenames: [] };
  }
  return {
    text: raw.slice(0, match.index).trimEnd(),
    filenames: match[1]
      .split(',')
      .map((name) => name.trim())
      .filter((name) => name.length > 0),
  };
}
