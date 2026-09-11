/**
 * Tool Output Types
 *
 * Types for tool execution results. Separated from tool-model.ts to allow
 * browser-safe imports in content.ts without pulling in Node.js dependencies.
 */

/**
 * Binary output type for returning images to the LLM.
 * Used when tools need to return image data that the LLM can "see" and process.
 *
 * `description`: an optional short textual acknowledgement that's prepended to
 * the tool result alongside the image bytes. Some providers (notably Bedrock
 * Converse) appear to drop tool results that contain only an `image-data`
 * block when several parallel tool calls return images — adding a short text
 * acknowledgement keeps the tool result legible for the provider and gives
 * the model a non-binary anchor to refer back to. Recommended; omit only if
 * the caller is certain image-only output is fine.
 */
export type ToolOutputImage = {
  type: 'image';
  image: {
    data: Uint8Array;
    mediaType: string;
    filename?: string;
  };
  description?: string;
};

/**
 * Binary output type for returning files to the LLM.
 * Used when tools need to return file data for LLM processing.
 *
 * `description`: same role as on `ToolOutputImage` — short acknowledgement
 * surfaced as a leading text block in the tool result, alongside the file
 * bytes. Recommended.
 */
export type ToolOutputFileContent = {
  type: 'file';
  file: {
    data: Uint8Array;
    mediaType: string;
    filename: string;
  };
  description?: string;
};

/**
 * Batch image output — multiple images returned in a single tool result.
 *
 * The provider sees one tool_result whose content array is
 * `[{ text: description }, { image-data }, { image-data }, ...]`. This is the
 * preferred shape over emitting N parallel single-image tool calls, especially
 * on Bedrock (which has shown brittle behavior with parallel image-only tool
 * results).
 *
 * `description`: a leading text block summarizing what was fetched, including
 * any per-URL failures. Required in practice — the model needs a non-binary
 * anchor explaining the result, especially when only a subset succeeded.
 */
export type ToolOutputImages = {
  type: 'images';
  images: Array<{
    data: Uint8Array;
    mediaType: string;
    filename?: string;
  }>;
  description?: string;
};

/**
 * Heterogeneous tool result — mix of text/image/file parts in one tool_result.
 * Prefer the simpler variants (string, ToolOutputImage, ToolOutputImages,
 * ToolOutputFileContent) when the output is homogeneous. `kind: 'file'` parts
 * become `file-data` blocks, which some providers reject in tool_result
 * (notably Bedrock Converse) — fall back to `kind: 'text'` there.
 */
export type ToolOutputMultiContent = {
  type: 'multi-content';
  /** Optional leading text that prefixes the result (status summary, failures, etc.). */
  description?: string;
  parts: Array<
    | { kind: 'text'; text: string }
    | { kind: 'image'; image: { data: Uint8Array; mediaType: string; filename?: string } }
    | { kind: 'file'; file: { data: Uint8Array; mediaType: string; filename: string } }
  >;
};

/**
 * Union type for all possible tool outputs that can be returned to the LLM.
 * - string: Text output
 * - ToolOutputImage: Binary image data (single)
 * - ToolOutputImages: Binary image data (batch — multiple images)
 * - ToolOutputFileContent: Binary file data
 * - ToolOutputMultiContent: Heterogeneous mix of text/image/file parts in one tool_result
 */
export type ToolOutput =
  | string
  | ToolOutputImage
  | ToolOutputImages
  | ToolOutputFileContent
  | ToolOutputMultiContent;
