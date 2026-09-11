/**
 * Split text into chunks that fit within a platform's message limit.
 * Prefers splitting at newlines, then spaces, and only hard-cuts as a last resort.
 */
export function chunkText(text: string, limit: number): string[] {
  if (text.length <= limit) {
    return [text];
  }
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > limit) {
    let splitAt = rest.lastIndexOf('\n', limit);
    if (splitAt < limit * 0.5) {
      splitAt = rest.lastIndexOf(' ', limit);
    }
    if (splitAt < limit * 0.5) {
      splitAt = limit;
    }
    chunks.push(rest.slice(0, splitAt));
    rest = rest.slice(splitAt).replace(/^\s+/, '');
  }
  if (rest.length > 0) {
    chunks.push(rest);
  }
  return chunks;
}
