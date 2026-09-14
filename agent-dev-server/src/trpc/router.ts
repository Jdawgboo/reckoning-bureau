import { createRouter } from './init';
import { createCasesRouter } from './routers/cases.router';
import { createIntakeDraftsRouter } from './routers/intake-drafts.router';
import { createPaymentsRouter } from './routers/payments.router';
import type { createPlatformRouter } from './routers/platform.router';

export function createAppRouter(platformRouter: ReturnType<typeof createPlatformRouter>) {
  return createRouter({
    platform: platformRouter,
    cases: createCasesRouter(),
    intakeDrafts: createIntakeDraftsRouter(),
    payments: createPaymentsRouter(),
  });
}

export type AppRouter = ReturnType<typeof createAppRouter>;
