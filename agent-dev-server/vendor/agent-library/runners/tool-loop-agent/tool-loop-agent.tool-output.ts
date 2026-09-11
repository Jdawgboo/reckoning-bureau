import type { ToolResultOutput } from '@ai-sdk/provider-utils';
import type {
  ToolOutput,
  ToolOutputFileContent,
  ToolOutputImage,
  ToolOutputImages,
  ToolOutputMultiContent,
} from '../../tools/tool-model.ts';

function uint8ArrayToBase64(data: Uint8Array): string {
  if (typeof Buffer !== 'undefined') {
    return Buffer.from(data).toString('base64');
  }
  let binary = '';
  for (let i = 0; i < data.length; i++) {
    binary += String.fromCharCode(data[i]);
  }
  return btoa(binary);
}

function isToolOutputImage(output: unknown): output is ToolOutputImage {
  return (
    typeof output === 'object' &&
    output !== null &&
    'type' in output &&
    output.type === 'image' &&
    'image' in output
  );
}

function isToolOutputImages(output: unknown): output is ToolOutputImages {
  return (
    typeof output === 'object' &&
    output !== null &&
    'type' in output &&
    output.type === 'images' &&
    'images' in output &&
    Array.isArray((output as { images: unknown }).images)
  );
}

function isToolOutputFileContent(output: unknown): output is ToolOutputFileContent {
  return (
    typeof output === 'object' &&
    output !== null &&
    'type' in output &&
    output.type === 'file' &&
    'file' in output
  );
}

function isToolOutputMultiContent(output: unknown): output is ToolOutputMultiContent {
  return (
    typeof output === 'object' &&
    output !== null &&
    'type' in output &&
    output.type === 'multi-content' &&
    'parts' in output &&
    Array.isArray((output as { parts: unknown }).parts)
  );
}

export function isBinaryToolOutput(
  output: unknown,
): output is ToolOutputImage | ToolOutputImages | ToolOutputFileContent | ToolOutputMultiContent {
  return (
    isToolOutputImage(output) ||
    isToolOutputImages(output) ||
    isToolOutputFileContent(output) ||
    isToolOutputMultiContent(output)
  );
}

export function convertToolOutputToModelOutput(output: ToolOutput): ToolResultOutput {
  if (typeof output === 'string') {
    return { type: 'text', value: output };
  }

  if (isToolOutputImage(output)) {
    const base64Data = uint8ArrayToBase64(output.image.data);
    const value: Array<
      { type: 'text'; text: string } | { type: 'image-data'; data: string; mediaType: string }
    > = [];
    if (output.description) {
      value.push({ type: 'text', text: output.description });
    }
    value.push({ type: 'image-data', data: base64Data, mediaType: output.image.mediaType });
    return { type: 'content', value };
  }

  if (isToolOutputImages(output)) {
    const value: Array<
      { type: 'text'; text: string } | { type: 'image-data'; data: string; mediaType: string }
    > = [];
    if (output.description) {
      value.push({ type: 'text', text: output.description });
    }
    for (const img of output.images) {
      value.push({
        type: 'image-data',
        data: uint8ArrayToBase64(img.data),
        mediaType: img.mediaType,
      });
    }
    return { type: 'content', value };
  }

  if (isToolOutputFileContent(output)) {
    const base64Data = uint8ArrayToBase64(output.file.data);
    const isImage = output.file.mediaType.startsWith('image/');
    const binaryPart = isImage
      ? ({ type: 'image-data', data: base64Data, mediaType: output.file.mediaType } as const)
      : ({
          type: 'file-data',
          data: base64Data,
          mediaType: output.file.mediaType,
          filename: output.file.filename,
        } as const);
    const value: Array<
      | { type: 'text'; text: string }
      | { type: 'image-data'; data: string; mediaType: string }
      | { type: 'file-data'; data: string; mediaType: string; filename: string }
    > = [];
    if (output.description) {
      value.push({ type: 'text', text: output.description });
    }
    value.push(binaryPart);
    return { type: 'content', value };
  }

  if (isToolOutputMultiContent(output)) {
    const value: Array<
      | { type: 'text'; text: string }
      | { type: 'image-data'; data: string; mediaType: string }
      | { type: 'file-data'; data: string; mediaType: string; filename: string }
    > = [];
    if (output.description) {
      value.push({ type: 'text', text: output.description });
    }
    for (const part of output.parts) {
      if (part.kind === 'text') {
        value.push({ type: 'text', text: part.text });
      } else if (part.kind === 'image') {
        value.push({
          type: 'image-data',
          data: uint8ArrayToBase64(part.image.data),
          mediaType: part.image.mediaType,
        });
      } else {
        value.push({
          type: 'file-data',
          data: uint8ArrayToBase64(part.file.data),
          mediaType: part.file.mediaType,
          filename: part.file.filename,
        });
      }
    }
    return { type: 'content', value };
  }

  return {
    type: 'json',
    value: JSON.parse(JSON.stringify(output ?? null)),
  };
}
