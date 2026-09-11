import { z } from 'zod';
import { TRPCError } from '@trpc/server';
import { createRouter, publicProcedure } from '../init';
import type { DependencyContainer } from '../../container';
import type { WsSessionManager } from '../../ws/session-manager';
import { getJWTPayload } from '../../util/jwt';

type PlatformRouterDeps = {
  container: DependencyContainer;
  sessionManager: WsSessionManager;
};

export function createPlatformRouter(deps: PlatformRouterDeps) {
  const { container, sessionManager } = deps;
  const messagingService = container.createMessagingService();
  const modelAccessKey = container.settings.getSecret('MODEL_ACCESS_KEY');

  return createRouter({
    health: publicProcedure.query(() => {
      const wsStats = sessionManager.getStats();
      return { status: 'ok', websocket: wsStats };
    }),

    instruction: publicProcedure.query(() => {
      try {
        const instructionService = container.createInstructionService();
        const instruction = instructionService.getInstruction();
        return { instruction };
      } catch (error) {
        console.error('[Platform] Error reading instruction:', error);
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message: 'Failed to read instruction file',
        });
      }
    }),

    conversationHistory: publicProcedure.query(async () => {
      const sessionKey = sessionManager.getCurrentSessionKey();
      if (!sessionKey) {
        return { sessionKey: null, conversationHistory: [] };
      }
      const agentSessionManager = container.getSessionManager();
      const conversationHistory = agentSessionManager
        ? (await agentSessionManager.loadConversation(sessionKey)).map(
            (m: { data: unknown }) => m.data,
          )
        : [];
      return { sessionKey, conversationHistory };
    }),

    settings: publicProcedure.query(() => {
      const { agentId } = getJWTPayload<{ agentId: string }>(modelAccessKey);
      if (!agentId) {
        throw new TRPCError({
          code: 'INTERNAL_SERVER_ERROR',
          message:
            'Agent ID is missing. Provide a valid MODEL_ACCESS_KEY (JWT payload must include {agentId}).',
        });
      }
      return { agentId };
    }),

    transcribe: publicProcedure
      .input(z.object({ data: z.string() }))
      .mutation(async ({ input }) => {
        const result = await messagingService.voiceToText({ data: input.data });
        return result;
      }),

    textToVoice: publicProcedure
      .input(z.object({ text: z.string() }))
      .mutation(async ({ input }) => {
        return messagingService.textToVoiceBase64({ text: input.text });
      }),
  });
}
