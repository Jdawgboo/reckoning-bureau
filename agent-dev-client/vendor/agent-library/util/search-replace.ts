import {
  SR_MARKER_MID,
  SR_MARKER_REPLACE,
  SR_MARKER_SEARCH,
  srIsMidMarker,
  srIsReplaceEnd,
  srIsSearchStart,
} from './search-replace-format.ts';
/**
 * Production-grade search/replace applier (string-in/string-out).
 *
 * Supports model outputs in the format (marker strings centralized in `search-replace-format.ts`):
 *   <file path line>
 *   ```lang?
 *   <SEARCH_MARKER>
 *   ...
 *   <MID_MARKER>
 *   ...
 *   <REPLACE_MARKER>
 *   ```
 *
 * Notes:
 * - Parses fenced blocks and extracts SEARCH/REPLACE pairs.
 * - Applies edits sequentially per file; default replaces FIRST occurrence.
 * - Matching strategy (in order): exact → line-trimmed → block-anchor.
 * - Newline-safe (LF/CRLF).
 * - Returns structured diagnostics and helpful hints.
 */

export type ParseError = {
  code: 'PARSE_ERROR';
  message: string;
  offset?: number; // index into model output
};

export type ApplyErrorCode =
  | 'PARSE_ERROR'
  | 'SEARCH_NOT_FOUND'
  | 'AMBIGUOUS_MATCH'
  | 'NO_EDITS_FOR_FILE'
  | 'MAX_LIMIT_EXCEEDED';

export type EditBlock = {
  filePath: string;
  search: string;
  replace: string;
  modelOffsetStart?: number;
  modelOffsetEnd?: number;
};

export type AppliedChange = {
  filePath: string;
  editIndexInFile: number;
  occurrenceIndex: number; // 0-based within a single edit block when replaceAll=true; otherwise always 0
  searchLength: number;
  replaceLength: number;
  previewBefore: string;
  previewAfter: string;
};

export type Failure = {
  filePath: string;
  editIndexInFile: number;
  code: ApplyErrorCode;
  message: string;
  hint?: string;
  modelOffsetStart?: number;
  modelOffsetEnd?: number;
};

export type ApplyReport = {
  filePath: string;
  totalEditsApplied: number;
  changes: AppliedChange[];
  failures: Failure[];
  newContent: string;
  /** Normalized block representing the edits we attempted to apply. */
  normalizedDiff: string;
};

export type ApplyOptions = {
  /** Maximum edits applied to a single file. */
  maxTotalEdits?: number;

  /** If true, fenced blocks must include a file path header (previous line or in the opening fence). */
  isFilePathRequired?: boolean;

  /** If true, fail when SEARCH occurs more than once (exact match). */
  requireUniqueMatch?: boolean;

  /** If true, also try a whitespace-insensitive match when exact match fails (still replaces verbatim span). */
  whitespaceInsensitive?: boolean;

  /** Ignore trailing whitespace differences per line for matching. */
  trimLineEnds?: boolean;

  /** Replace all occurrences instead of first. */
  replaceAll?: boolean;

  /** Preview window size for AppliedChange before/after. */
  previewChars?: number;
};

const DEFAULTS: Required<
  Pick<
    ApplyOptions,
    | 'maxTotalEdits'
    | 'requireUniqueMatch'
    | 'whitespaceInsensitive'
    | 'trimLineEnds'
    | 'replaceAll'
    | 'previewChars'
  >
> = {
  maxTotalEdits: 200,
  // Safety default: avoid accidental edits when SEARCH snippet is ambiguous.
  // The caller can still override to "first match wins" behavior if needed.
  requireUniqueMatch: true,
  whitespaceInsensitive: false,
  trimLineEnds: false,
  replaceAll: false,
  previewChars: 180,
};

type Occurrence = { start: number; end: number };

function normalizeFilePath(p: string): string {
  return p.trim().replace(/^[.][/]/, '');
}

/**
 * Parses SEARCH/REPLACE edits from a model output.
 */
export function parseSearchReplaceEdits(
  modelOutput: string,
  options?: { isFilePathRequired?: boolean },
): {
  edits: EditBlock[];
  errors: ParseError[];
} {
  const errors: ParseError[] = [];
  const edits: EditBlock[] = [];
  const isFilePathRequired = options?.isFilePathRequired ?? true;

  const lines = splitLinesWithOffsets(modelOutput);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].text;
    if (isFenceStart(line)) {
      // File path can be either:
      // 1) The previous non-empty line (preferred), OR
      // 2) Embedded in the opening fence line, like: ```tsx path/to/file.tsx
      const fileHeaderIdx = findPreviousNonEmptyLine(lines, i - 1);
      const filePathFromPrev = fileHeaderIdx !== -1 ? lines[fileHeaderIdx].text.trim() : '';
      const filePathFromFence = parseFenceHeaderFilePath(line) ?? '';
      const filePathLine = filePathFromPrev || filePathFromFence;

      if (!filePathLine && isFilePathRequired) {
        errors.push({
          code: 'PARSE_ERROR',
          message:
            'Found a fenced block without a file path. Provide the file path on the line immediately before the fence, or after the fence language (e.g. ```tsx path/to/file.tsx).',
          offset: lines[i].startOffset,
        });
      }
      const fenceEnd = findFenceEnd(lines, i + 1);
      if (fenceEnd === -1) {
        errors.push({
          code: 'PARSE_ERROR',
          message: 'Unterminated fenced block (missing closing ```).',
          offset: lines[i].startOffset,
        });
        break;
      }

      const bodyStartIdx = i + 1;
      const bodyEndIdx = fenceEnd - 1;
      const fenceBody = joinLines(lines, bodyStartIdx, bodyEndIdx);

      const inner = parseMarkerBlocks(fenceBody, lines[i].startOffset);
      for (const mk of inner.edits) {
        edits.push({
          filePath: filePathLine,
          search: mk.search,
          replace: mk.replace,
          modelOffsetStart: mk.modelOffsetStart,
          modelOffsetEnd: mk.modelOffsetEnd,
        });
      }
      errors.push(...inner.errors);
      i = fenceEnd;
    }
  }

  return { edits, errors };
}

/**
 * Applies SEARCH/REPLACE edits to a single file content (no IO).
 * - `targetFilePath` is used to select blocks for that file.
 * - If the diff contains marker blocks but no file header, we fall back to
 *   treating the entire `modelOutput` as a single marker-body for that file.
 */
export function applySearchReplaceEditsToContent(
  targetFilePath: string,
  originalContent: string,
  modelOutput: string,
  options: ApplyOptions = {},
): ApplyReport {
  const opts = { ...DEFAULTS, ...options };
  const isFilePathRequired = options.isFilePathRequired ?? false;
  const normalizedTarget = normalizeFilePath(targetFilePath);
  const newlineStyle = detectNewlineStyle(originalContent);

  const parsed = parseSearchReplaceEdits(modelOutput, { isFilePathRequired });

  const failures: Failure[] = parsed.errors.map((e) => ({
    filePath: targetFilePath,
    editIndexInFile: -1,
    code: e.code,
    message: e.message,
    modelOffsetStart: e.offset,
  }));

  let blocks = parsed.edits.filter((e) => normalizeFilePath(e.filePath) === normalizedTarget);
  const headerlessFencedBlocks = parsed.edits.filter((e) => e.filePath.trim() === '');

  // Fallback only when we couldn't parse any file-scoped edits at all (eg: marker blocks without a file header/fence).
  // If the diff contains fenced edits for a different file, we should NOT apply them to this file.
  const hasSearchMarker = modelOutput.includes(SR_MARKER_SEARCH);
  const hasReplaceMarker = modelOutput.includes(SR_MARKER_REPLACE);
  if (blocks.length === 0 && parsed.edits.length === 0 && hasSearchMarker && hasReplaceMarker) {
    const inner = parseMarkerBlocks(modelOutput, 0);
    blocks = inner.edits.map((b) => ({
      filePath: targetFilePath,
      search: b.search,
      replace: b.replace,
      modelOffsetStart: b.modelOffsetStart,
      modelOffsetEnd: b.modelOffsetEnd,
    }));
    failures.push(
      ...inner.errors.map((e) => ({
        filePath: targetFilePath,
        editIndexInFile: -1,
        code: e.code,
        message: e.message,
        modelOffsetStart: e.offset,
      })),
    );
  }

  // If the caller allows headerless fenced blocks, treat them as targeting `targetFilePath`.
  if (!isFilePathRequired && blocks.length === 0 && headerlessFencedBlocks.length > 0) {
    blocks = headerlessFencedBlocks.map((b) => ({
      ...b,
      filePath: targetFilePath,
    }));
  }

  const normalizedDiff = buildNormalizedDiff(targetFilePath, blocks);

  if (blocks.length === 0) {
    failures.push({
      filePath: targetFilePath,
      editIndexInFile: -1,
      code: 'NO_EDITS_FOR_FILE',
      message: `No SEARCH/REPLACE blocks found for file: ${targetFilePath}`,
      hint: 'Include the file header line immediately above the fenced block, or pass marker blocks that match this file.',
    });
    return {
      filePath: targetFilePath,
      totalEditsApplied: 0,
      changes: [],
      failures,
      newContent: originalContent,
      normalizedDiff,
    };
  }

  let working = originalContent;
  const changes: AppliedChange[] = [];
  let totalEditsApplied = 0;

  for (let j = 0; j < blocks.length; j++) {
    if (totalEditsApplied >= opts.maxTotalEdits) {
      failures.push({
        filePath: targetFilePath,
        editIndexInFile: j,
        code: 'MAX_LIMIT_EXCEEDED',
        message: `Max total edits exceeded (${opts.maxTotalEdits}).`,
        modelOffsetStart: blocks[j].modelOffsetStart,
        modelOffsetEnd: blocks[j].modelOffsetEnd,
      });
      break;
    }

    const b = blocks[j];
    const res = applyOneEdit(working, b.search, b.replace, {
      requireUniqueMatch: opts.requireUniqueMatch,
      whitespaceInsensitive: opts.whitespaceInsensitive,
      trimLineEnds: opts.trimLineEnds,
      replaceAll: opts.replaceAll,
      previewChars: opts.previewChars,
    });

    if (res.ok === false) {
      failures.push({
        filePath: targetFilePath,
        editIndexInFile: j,
        code: res.code,
        message: res.message,
        hint: res.hint,
        modelOffsetStart: b.modelOffsetStart,
        modelOffsetEnd: b.modelOffsetEnd,
      });
      continue;
    }

    working = res.updatedText;
    for (const c of res.changes) {
      changes.push({
        filePath: targetFilePath,
        editIndexInFile: j,
        occurrenceIndex: c.occurrenceIndex,
        searchLength: b.search.length,
        replaceLength: b.replace.length,
        previewBefore: c.previewBefore,
        previewAfter: c.previewAfter,
      });
      totalEditsApplied += 1;
    }
  }

  return {
    filePath: targetFilePath,
    totalEditsApplied,
    changes,
    failures,
    newContent: normalizeNewlinesForWrite(working, newlineStyle),
    normalizedDiff,
  };
}

function buildNormalizedDiff(filePath: string, blocks: EditBlock[]): string {
  if (!blocks.length) {
    return `${filePath}\n\`\`\`\n\`\`\``;
  }
  const parts = blocks
    .map(
      (b) =>
        `${SR_MARKER_SEARCH}\n${b.search}\n${SR_MARKER_MID}\n${b.replace}\n${SR_MARKER_REPLACE}`,
    )
    .join('\n');
  return `${filePath}\n\`\`\`\n${parts}\n\`\`\``;
}

// ------------------------
// Newline handling (preserve original style)
// ------------------------

function detectNewlineStyle(text: string): 'LF' | 'CRLF' {
  return text.includes('\r\n') ? 'CRLF' : 'LF';
}

function normalizeNewlinesForWrite(text: string, style: 'LF' | 'CRLF'): string {
  const lf = text.replace(/\r\n/g, '\n');
  return style === 'CRLF' ? lf.replace(/\n/g, '\r\n') : lf;
}

// ------------------------
// Core edit application
// ------------------------

type OneEditOptions = {
  requireUniqueMatch: boolean;
  whitespaceInsensitive: boolean;
  trimLineEnds: boolean;
  replaceAll: boolean;
  previewChars: number;
};

type OneEditResult =
  | {
      ok: true;
      updatedText: string;
      changes: Array<{ occurrenceIndex: number; previewBefore: string; previewAfter: string }>;
    }
  | { ok: false; code: 'SEARCH_NOT_FOUND' | 'AMBIGUOUS_MATCH'; message: string; hint?: string };

function applyOneEdit(
  text: string,
  search: string,
  replace: string,
  opts: OneEditOptions,
): OneEditResult {
  if (search.length === 0) {
    return { ok: false, code: 'SEARCH_NOT_FOUND', message: 'Empty SEARCH block is not allowed.' };
  }

  const { normText, indexMap } = normalizeToLFWithIndexMap(text, opts.trimLineEnds);
  const normSearch = normalizeSnippet(search, opts.trimLineEnds);
  const exactMatches = findAllOccurrences(normText, normSearch);

  if (opts.requireUniqueMatch && exactMatches.length > 1) {
    return {
      ok: false,
      code: 'AMBIGUOUS_MATCH',
      message: `SEARCH snippet appears ${exactMatches.length} times; requireUniqueMatch=true.`,
      hint: buildAmbiguityHint(normText, exactMatches, normSearch),
    };
  }

  const applyOccurrences = (spans: Occurrence[]): OneEditResult => {
    const occurrencesToReplace = opts.replaceAll ? spans : [spans[0]!];

    // Apply from end to start to keep indices stable
    const sortedDesc = [...occurrencesToReplace].sort((a, b) => b.start - a.start);
    let updated = text;
    for (const sp of sortedDesc) {
      updated = updated.slice(0, sp.start) + replace + updated.slice(sp.end);
    }

    // Build previews with stable indices by tracking cumulative shift in ascending order
    const sortedAsc = [...occurrencesToReplace].sort((a, b) => a.start - b.start);
    let delta = 0;
    const changes: Array<{ occurrenceIndex: number; previewBefore: string; previewAfter: string }> =
      [];
    for (let i = 0; i < sortedAsc.length; i++) {
      const sp = sortedAsc[i]!;
      const before = snippetPreview(text, sp.start, sp.end, opts.previewChars);

      const updatedStart = sp.start + delta;
      const updatedEnd = updatedStart + replace.length;
      const after = snippetPreview(updated, updatedStart, updatedEnd, opts.previewChars);

      changes.push({ occurrenceIndex: i, previewBefore: before, previewAfter: after });
      delta += replace.length - (sp.end - sp.start);
    }

    return { ok: true, updatedText: updated, changes };
  };

  const buildAmbiguityHintFromSpans = (spans: Occurrence[], label: string): string => {
    const previews = spans.slice(0, 5).map((m, i) => {
      const prev = snippetPreview(text, m.start, m.end, 140);
      return `#${i + 1} @${m.start}: ${JSON.stringify(prev)}`;
    });
    const extra = spans.length > 5 ? `\n…and ${spans.length - 5} more.` : '';
    return `${label} match is not unique. Add more context.\n${previews.join('\n')}${extra}`;
  };

  // Helper to apply a single match and return result
  const applyMatch = (
    match: Occurrence,
    useIndexMap: boolean,
  ): {
    ok: true;
    updatedText: string;
    changes: Array<{ occurrenceIndex: number; previewBefore: string; previewAfter: string }>;
  } => {
    const spanOrig = useIndexMap
      ? { start: indexMap[match.start], end: indexMap[match.end] }
      : match;
    const updated = text.slice(0, spanOrig.start) + replace + text.slice(spanOrig.end);
    return {
      ok: true,
      updatedText: updated,
      changes: [
        {
          occurrenceIndex: 0,
          previewBefore: snippetPreview(text, spanOrig.start, spanOrig.end, opts.previewChars),
          previewAfter: snippetPreview(
            updated,
            spanOrig.start,
            spanOrig.start + replace.length,
            opts.previewChars,
          ),
        },
      ],
    };
  };

  // 1. Exact match
  if (exactMatches.length > 0) {
    const occurrencesToReplace = opts.replaceAll ? exactMatches : [exactMatches[0]];
    const changes: Array<{ occurrenceIndex: number; previewBefore: string; previewAfter: string }> =
      [];

    const spansOriginal = occurrencesToReplace.map((m) => ({
      start: indexMap[m.start],
      end: indexMap[m.end],
    }));

    let updatedOriginal = text;
    const sortedSpans = spansOriginal.sort((a, b) => b.start - a.start);
    for (const sp of sortedSpans) {
      updatedOriginal =
        updatedOriginal.slice(0, sp.start) + replace + updatedOriginal.slice(sp.end);
    }

    const normReplace = normalizeSnippet(replace, opts.trimLineEnds);
    const chosen = occurrencesToReplace
      .map((m, idx) => ({ ...m, occurrenceIndex: idx }))
      .sort((a, b) => a.start - b.start);
    for (const m of chosen) {
      changes.push({
        occurrenceIndex: m.occurrenceIndex,
        previewBefore: snippetPreview(normText, m.start, m.end, opts.previewChars),
        previewAfter: snippetPreview(
          normText.slice(0, m.start) + normReplace + normText.slice(m.end),
          m.start,
          m.start + normReplace.length,
          opts.previewChars,
        ),
      });
    }

    return { ok: true, updatedText: updatedOriginal, changes };
  }

  // 2. Line-trimmed fallback (always attempted before other fallbacks)
  {
    const matches = lineTrimmedFallbackMatchAll(text, search, 0);
    if (opts.requireUniqueMatch && matches.length > 1) {
      return {
        ok: false,
        code: 'AMBIGUOUS_MATCH',
        message: `SEARCH snippet matches ${matches.length} times after line-trimmed comparison; requireUniqueMatch=true.`,
        hint: buildAmbiguityHintFromSpans(matches, 'Line-trimmed'),
      };
    }
    if (matches.length > 0) {
      return applyOccurrences(matches);
    }
  }

  // 3. Block anchor fallback (for 3+ line blocks)
  {
    const matches = blockAnchorFallbackMatchAll(text, search, 0);
    if (opts.requireUniqueMatch && matches.length > 1) {
      return {
        ok: false,
        code: 'AMBIGUOUS_MATCH',
        message: `SEARCH snippet matches ${matches.length} times after block-anchor comparison; requireUniqueMatch=true.`,
        hint: buildAmbiguityHintFromSpans(matches, 'Block-anchor'),
      };
    }
    if (matches.length > 0) {
      return applyOccurrences(matches);
    }
  }

  // 4. Whitespace-insensitive fallback (optional)
  if (opts.whitespaceInsensitive) {
    const wi = whitespaceInsensitiveFind(normText, normSearch);
    if (wi) {
      return applyMatch(wi, true);
    }
  }

  return {
    ok: false,
    code: 'SEARCH_NOT_FOUND',
    message: 'SEARCH block not found in the target content.',
    hint: buildNotFoundHint(normText, normSearch),
  };
}

function lineTrimmedFallbackMatchAll(
  originalContent: string,
  searchContent: string,
  startIndex: number,
): Occurrence[] {
  const out: Occurrence[] = [];
  const originalLines = originalContent.split('\n');
  const searchLines = searchContent.split('\n');

  if (searchLines.length > 0 && searchLines[searchLines.length - 1] === '') {
    searchLines.pop();
  }
  if (searchLines.length === 0) {
    return out;
  }

  // Find the line number where startIndex falls
  let startLineNum = 0;
  let currentIndex = 0;
  while (currentIndex < startIndex && startLineNum < originalLines.length) {
    currentIndex += originalLines[startLineNum].length + 1;
    startLineNum++;
  }

  for (let i = startLineNum; i <= originalLines.length - searchLines.length; i++) {
    let matches = true;
    for (let j = 0; j < searchLines.length; j++) {
      if (originalLines[i + j]!.trim() !== searchLines[j]!.trim()) {
        matches = false;
        break;
      }
    }
    if (!matches) {
      continue;
    }

    let matchStartIndex = 0;
    for (let k = 0; k < i; k++) {
      matchStartIndex += originalLines[k]!.length + 1;
    }

    let matchEndIndex = matchStartIndex;
    for (let k = 0; k < searchLines.length; k++) {
      matchEndIndex += originalLines[i + k]!.length;
      if (k < searchLines.length - 1) {
        matchEndIndex += 1;
      }
    }

    out.push({ start: matchStartIndex, end: matchEndIndex });
  }

  return out;
}

function blockAnchorFallbackMatchAll(
  originalContent: string,
  searchContent: string,
  startIndex: number,
): Occurrence[] {
  const out: Occurrence[] = [];
  const originalLines = originalContent.split('\n');
  const searchLines = searchContent.split('\n');

  if (searchLines.length > 0 && searchLines[searchLines.length - 1] === '') {
    searchLines.pop();
  }
  if (searchLines.length < 3) {
    return out;
  }

  const firstLineSearch = searchLines[0]!.trim();
  const lastLineSearch = searchLines[searchLines.length - 1]!.trim();
  const searchBlockSize = searchLines.length;

  // Find the line number where startIndex falls
  let startLineNum = 0;
  let currentIndex = 0;
  while (currentIndex < startIndex && startLineNum < originalLines.length) {
    currentIndex += originalLines[startLineNum]!.length + 1;
    startLineNum++;
  }

  for (let i = startLineNum; i <= originalLines.length - searchBlockSize; i++) {
    if (originalLines[i]!.trim() !== firstLineSearch) {
      continue;
    }
    if (originalLines[i + searchBlockSize - 1]!.trim() !== lastLineSearch) {
      continue;
    }

    let matchStartIndex = 0;
    for (let k = 0; k < i; k++) {
      matchStartIndex += originalLines[k]!.length + 1;
    }

    let matchEndIndex = matchStartIndex;
    for (let k = 0; k < searchBlockSize; k++) {
      matchEndIndex += originalLines[i + k]!.length;
      if (k < searchBlockSize - 1) {
        matchEndIndex += 1;
      }
    }

    out.push({ start: matchStartIndex, end: matchEndIndex });
  }

  return out;
}

// ------------------------
// Parsing helpers
// ------------------------

type LineInfo = { text: string; startOffset: number; endOffset: number };

function splitLinesWithOffsets(s: string): LineInfo[] {
  const out: LineInfo[] = [];
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\n') {
      const end = i + 1;
      out.push({ text: s.slice(start, i).replace(/\r$/, ''), startOffset: start, endOffset: end });
      start = end;
    }
  }
  if (start <= s.length) {
    out.push({ text: s.slice(start).replace(/\r$/, ''), startOffset: start, endOffset: s.length });
  }
  return out;
}

function joinLines(lines: LineInfo[], startIdx: number, endIdx: number): string {
  if (endIdx < startIdx) {
    return '';
  }
  return lines
    .slice(startIdx, endIdx + 1)
    .map((l) => l.text)
    .join('\n');
}

function isFenceStart(line: string): boolean {
  return line.trimStart().startsWith('```');
}

function isFenceEnd(line: string): boolean {
  return line.trim() === '```';
}

/**
 * Extract a file path from the opening fence line.
 *
 * Supported:
 * - ```path/to/file.ts
 * - ```tsx path/to/file.tsx
 * - ```ts ./path/to/file.ts
 *
 * Note: This intentionally does not attempt to support paths with spaces inside the fence header.
 */
function parseFenceHeaderFilePath(line: string): string | null {
  const trimmed = line.trimStart();
  if (!trimmed.startsWith('```')) {
    return null;
  }

  const after = trimmed.slice(3).trim();
  if (!after) {
    return null;
  }

  // If there's whitespace, treat the first token as language and the remainder as the path.
  const firstWs = after.search(/\s/);
  if (firstWs !== -1) {
    const candidate = after.slice(firstWs).trim();
    if (looksLikePath(candidate)) {
      return candidate;
    }
    return null;
  }

  // Otherwise, the remainder may be a path (no language provided).
  return looksLikePath(after) ? after : null;
}

function looksLikePath(s: string): boolean {
  // Heuristics: contains a path separator, starts with ./ or ../, or looks like it has an extension.
  return s.includes('/') || s.startsWith('./') || s.startsWith('../') || /\.[a-z0-9]+$/i.test(s);
}

function findFenceEnd(lines: LineInfo[], startIdx: number): number {
  for (let i = startIdx; i < lines.length; i++) {
    if (isFenceEnd(lines[i].text)) {
      return i;
    }
  }
  return -1;
}

function findPreviousNonEmptyLine(lines: LineInfo[], startIdx: number): number {
  for (let i = startIdx; i >= 0; i--) {
    if (lines[i].text.trim().length > 0) {
      return i;
    }
  }
  return -1;
}

function parseMarkerBlocks(
  body: string,
  modelOffsetBase: number,
): {
  edits: Array<{
    search: string;
    replace: string;
    modelOffsetStart: number;
    modelOffsetEnd: number;
  }>;
  errors: ParseError[];
} {
  const edits: Array<{
    search: string;
    replace: string;
    modelOffsetStart: number;
    modelOffsetEnd: number;
  }> = [];
  const errors: ParseError[] = [];

  const lines = body.split('\n');
  let i = 0;

  while (i < lines.length) {
    // Find next SEARCH start
    if (!srIsSearchStart(lines[i])) {
      i++;
      continue;
    }

    const searchStartLine = i;
    const searchStartOffset = lines.slice(0, i).join('\n').length + (i > 0 ? 1 : 0);
    i++;

    // Collect SEARCH content until we find =======
    const searchLines: string[] = [];
    while (i < lines.length && !srIsMidMarker(lines[i])) {
      searchLines.push(lines[i]);
      i++;
    }

    if (i >= lines.length) {
      errors.push({
        code: 'PARSE_ERROR',
        message: 'Missing ======= delimiter in block.',
        offset: modelOffsetBase + searchStartOffset,
      });
      break;
    }

    i++; // Skip the ======= line

    // Collect REPLACE content until we find the end marker
    const replaceLines: string[] = [];
    while (i < lines.length && !srIsReplaceEnd(lines[i])) {
      replaceLines.push(lines[i]);
      i++;
    }

    if (i >= lines.length) {
      errors.push({
        code: 'PARSE_ERROR',
        message: `Missing ${SR_MARKER_REPLACE} delimiter in block.`,
        offset: modelOffsetBase + searchStartOffset,
      });
      break;
    }

    const endOffset = lines.slice(0, i + 1).join('\n').length;
    i++; // Skip the REPLACE end line

    edits.push({
      search: searchLines.join('\n'),
      replace: replaceLines.join('\n'),
      modelOffsetStart: modelOffsetBase + searchStartOffset,
      modelOffsetEnd: modelOffsetBase + endOffset,
    });
  }

  // Check for malformed markers
  if ((body.includes(SR_MARKER_SEARCH) || body.includes(SR_MARKER_REPLACE)) && edits.length === 0) {
    errors.push({
      code: 'PARSE_ERROR',
      message: 'Contains SEARCH/REPLACE-like markers but no valid blocks were parsed.',
      offset: modelOffsetBase,
    });
  }

  return { edits, errors };
}

// ------------------------
// Newline + matching helpers
// ------------------------

function normalizeSnippet(s: string, trimLineEnds: boolean): string {
  let out = s.replace(/\r\n/g, '\n');
  if (trimLineEnds) {
    out = out
      .split('\n')
      .map((l) => l.replace(/[ \t]+$/g, ''))
      .join('\n');
  }
  return out;
}

function normalizeToLFWithIndexMap(
  original: string,
  trimLineEnds: boolean,
): { normText: string; indexMap: number[] } {
  const indexMap: number[] = [];
  let norm = '';
  let i = 0;
  while (i < original.length) {
    const ch = original[i];
    if (ch === '\r' && original[i + 1] === '\n') {
      indexMap.push(i);
      norm += '\n';
      i += 2;
      continue;
    }
    indexMap.push(i);
    norm += ch;
    i += 1;
  }
  indexMap.push(original.length);

  if (!trimLineEnds) {
    return { normText: norm, indexMap };
  }

  const rebuilt: number[] = [];
  let rebuiltText = '';
  let lineStart = 0;
  for (let p = 0; p <= norm.length; p++) {
    if (p === norm.length || norm[p] === '\n') {
      const line = norm.slice(lineStart, p);
      const trimmedLen = line.replace(/[ \t]+$/g, '').length;

      for (let k = 0; k < trimmedLen; k++) {
        rebuilt.push(indexMap[lineStart + k]);
        rebuiltText += line[k];
      }

      if (p < norm.length) {
        rebuilt.push(indexMap[p]);
        rebuiltText += '\n';
      }
      lineStart = p + 1;
    }
  }
  rebuilt.push(original.length);
  return { normText: rebuiltText, indexMap: rebuilt };
}

function findAllOccurrences(haystack: string, needle: string): Occurrence[] {
  const out: Occurrence[] = [];
  let idx = 0;
  while (idx <= haystack.length) {
    const at = haystack.indexOf(needle, idx);
    if (at === -1) {
      break;
    }
    out.push({ start: at, end: at + needle.length });
    idx = at + Math.max(needle.length, 1);
  }
  return out;
}

function snippetPreview(text: string, start: number, end: number, maxChars: number): string {
  const s = Math.max(0, start - Math.floor(maxChars / 2));
  const e = Math.min(text.length, end + Math.floor(maxChars / 2));
  const prefix = s > 0 ? '…' : '';
  const suffix = e < text.length ? '…' : '';
  return prefix + text.slice(s, e) + suffix;
}

function buildAmbiguityHint(normText: string, matches: Occurrence[], normSearch: string): string {
  const previews = matches.slice(0, 5).map((m, i) => {
    const prev = snippetPreview(normText, m.start, m.end, 140);
    return `#${i + 1} @${m.start}: ${JSON.stringify(prev)}`;
  });
  const extra = matches.length > 5 ? `\n…and ${matches.length - 5} more.` : '';
  return `SEARCH snippet is not unique. Add more context.\n${previews.join('\n')}${extra}\nSEARCH (first 120 chars): ${JSON.stringify(
    normSearch.slice(0, 120),
  )}`;
}

function buildNotFoundHint(normText: string, normSearch: string): string {
  const lines = normText.split('\n');
  const needleLines = normSearch.split('\n').filter((l) => l.trim().length > 0);
  const needle = (needleLines[0] ?? '').trim();
  if (!needle) {
    return 'SEARCH snippet begins with empty/whitespace-only content. Include more context.';
  }

  let best: { lineIdx: number; score: number } | null = null;
  for (let i = 0; i < lines.length; i++) {
    const score = tokenOverlapScore(lines[i], needle);
    if (!best || score > best.score) {
      best = { lineIdx: i, score };
    }
  }

  if (!best || best.score <= 0) {
    return 'No similar line found. Ensure SEARCH snippet matches the file exactly.';
  }

  const windowStart = Math.max(0, best.lineIdx - 2);
  const windowEnd = Math.min(lines.length, best.lineIdx + 3);
  const window = lines.slice(windowStart, windowEnd).join('\n');
  return `Closest line match at line ${best.lineIdx + 1} (score=${best.score.toFixed(2)}). Nearby context:\n---\n${window}\n---\nTip: Copy a larger exact chunk from the file into SEARCH.`;
}

function tokenOverlapScore(a: string, b: string): number {
  const ta = new Set(
    a
      .toLowerCase()
      .split(/[^a-z0-9_]+/g)
      .filter(Boolean),
  );
  const tb = new Set(
    b
      .toLowerCase()
      .split(/[^a-z0-9_]+/g)
      .filter(Boolean),
  );
  if (ta.size === 0 || tb.size === 0) {
    return 0;
  }
  let inter = 0;
  for (const t of tb) {
    if (ta.has(t)) {
      inter++;
    }
  }
  return inter / Math.sqrt(ta.size * tb.size);
}

function whitespaceInsensitiveFind(normText: string, normSearch: string): Occurrence | null {
  const { compact: tC, map: tMap } = compactWhitespaceWithMap(normText);
  const { compact: sC } = compactWhitespaceWithMap(normSearch);
  const at = tC.indexOf(sC);
  if (at === -1) {
    return null;
  }
  const start = tMap[at] ?? 0;
  const end = tMap[at + sC.length] ?? normText.length;
  return { start, end };
}

function compactWhitespaceWithMap(s: string): { compact: string; map: number[] } {
  const map: number[] = [];
  let compact = '';
  let i = 0;
  let inWs = false;
  while (i < s.length) {
    const ch = s[i];
    const isWs = ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
    if (isWs) {
      if (!inWs) {
        map.push(i);
        compact += ' ';
        inWs = true;
      }
      i++;
      continue;
    }
    inWs = false;
    map.push(i);
    compact += ch;
    i++;
  }
  map.push(s.length);
  return { compact, map };
}
