/**
 * NanoBanana Tool - Gemini 3.1 Flash Image (Nano Banana 2) generation tool
 *
 * This tool uses Google's Gemini 3.1 Flash Image model to generate images from
 * text prompts. Routes through Google Vertex AI.
 */
import { z } from 'zod';
import { generateText } from 'ai';
import {
  ToolModel,
  type ToolExecuteContext,
  type ToolExecuteResult,
} from '../../agent/agent-library.ts';
import type { ModelProvider } from '../../agent/interfaces';
import type { PublicCdnUploadService } from '../../../services/public-cdn-upload.service';

// Vertex `imageConfig.imageSize` values. "512" ≈ 0.25MP (cheapest), "1K" ≈ 1MP.
const IMAGE_SIZES = ['512', '1K', '2K', '4K'] as const;
const DEFAULT_IMAGE_SIZE = '1K';
// Vertex `imageConfig.aspectRatio` enum — the provider rejects values outside it.
const ASPECT_RATIOS = [
  '1:1',
  '2:3',
  '3:2',
  '3:4',
  '4:3',
  '4:5',
  '5:4',
  '9:16',
  '16:9',
  '21:9',
  '1:4',
  '4:1',
] as const;
const DEFAULT_ASPECT_RATIO = '1:1';

const NanoBananaSchema = z.object({
  prompt: z
    .string()
    .describe(
      'Detailed text prompt describing the image to generate. ' +
        'Be specific about style, composition, lighting, colors, and subject matter. ' +
        'Example: "A photorealistic sunset over mountains with vibrant orange and purple clouds, 8k quality"',
    ),
  imageSize: z
    .enum(IMAGE_SIZES)
    .default(DEFAULT_IMAGE_SIZE)
    .describe(
      'Output resolution. "1K" (~1MP, default); "512" is the cheapest (~0.25MP); ' +
        '"2K" and "4K" are higher resolution and cost proportionally more.',
    ),
  aspectRatio: z
    .enum(ASPECT_RATIOS)
    .default(DEFAULT_ASPECT_RATIO)
    .describe('Aspect ratio, e.g. "1:1" (default, square), "16:9", "9:16", "4:3".'),
});

type NanoBananaInput = z.infer<typeof NanoBananaSchema>;

const TOOL_NAME = 'nanobanana';
const IMAGE_MODEL = 'gemini-3.1-flash-image';

type NanoBananaParams = {
  modelProvider: ModelProvider;
  cdnUploadService: PublicCdnUploadService;
};

export default class NanoBananaToolModel extends ToolModel<NanoBananaInput> {
  private modelProvider: ModelProvider;
  private cdnUploadService: PublicCdnUploadService;

  constructor(params: NanoBananaParams) {
    super({
      toolType: 'function',
      name: TOOL_NAME,
      description:
        'Generate images from text prompts using Gemini 3.1 Flash Image (NanoBanana). ' +
        'Returns a public CDN URL. ' +
        'Supports various aspect ratios (1:1, 16:9, 9:16, etc.). ' +
        'Use this tool when you need to create visual content from descriptions.',
      parametersSchema: NanoBananaSchema,
      isStreaming: false,
      isStrict: false,
    });
    this.modelProvider = params.modelProvider;
    this.cdnUploadService = params.cdnUploadService;
  }

  async execute(input: NanoBananaInput, ctx: ToolExecuteContext): Promise<ToolExecuteResult> {
    try {
      console.log('Generating image for prompt:', input.prompt);
      const imageResult = await this.generateImage(
        input.prompt,
        input.imageSize,
        input.aspectRatio,
      );
      console.log('Image generation result:', imageResult);
      if (!imageResult) {
        return {
          output: 'No image generated in response',
        };
      }

      console.log('Uploading image to CDN');
      const extension = imageResult.mediaType.split('/')[1] || 'png';
      const filename = `nanobanana-${Date.now()}.${extension}`;
      const cdnUrl = await this.cdnUploadService.upload(
        imageResult.buffer,
        imageResult.mediaType,
        filename,
      );

      return {
        output: cdnUrl,
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error occurred';
      console.error(`[NanoBanana Tool] Error:`, errorMessage);
      throw new Error(`Error generating image: ${errorMessage}`);
    }
  }

  /**
   * Generates an image using Gemini 3.1 Flash Image via Vertex. Resolution and
   * aspect ratio are passed through `providerOptions.google.imageConfig`;
   * resolution drives cost (image output tokens), which the gateway prices from
   * the `LLM_RATES` `google-vertex` entry.
   */
  private async generateImage(
    prompt: string,
    imageSize: string,
    aspectRatio: string,
  ): Promise<{ buffer: Buffer; mediaType: string } | null> {
    const model = await this.modelProvider.getModel(IMAGE_MODEL);

    const result = await generateText({
      model,
      prompt,
      providerOptions: {
        google: {
          responseModalities: ['IMAGE', 'TEXT'],
          imageConfig: { aspectRatio, imageSize },
        },
      },
    });

    const content = result.steps[0]?.content;
    if (!content) {
      return null;
    }

    const output = content?.find((content) => content.type === 'file');
    if (!output?.file) {
      return null;
    }

    const base64 = output.file.base64;
    if (!base64) {
      return null;
    }

    const match = base64.match(/^data:([^;]+);base64,(.+)$/);
    if (match) {
      return {
        buffer: Buffer.from(match[2], 'base64'),
        mediaType: match[1],
      };
    }

    return {
      buffer: Buffer.from(base64, 'base64'),
      mediaType: output.file.mediaType,
    };
  }
}
