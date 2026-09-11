import { createRouter } from './init';
import { createCasesRouter } from './routers/cases.router';
import type { createPlatformRouter } from './routers/platform.router';

export function createAppRouter(platformRouter: ReturnType<typeof createPlatformRouter>) {
  return createRouter({
    platform: platformRouter,
    cases: createCasesRouter(),
  });
}

export type AppRouter = ReturnType<typeof createAppRouter>;
