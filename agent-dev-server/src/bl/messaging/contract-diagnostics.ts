import type { ContractProblem } from '../../../vendor/agentplace-a2ui/contract-schema.ts';
import { ToolRegistryFactory } from './tool-registry.factory.ts';

export type ContractProblemSink = {
  error: (line: string) => void;
  warn: (line: string) => void;
};

export type SurfaceContractProblems = {
  agent: ContractProblem[];
  builtin: ContractProblem[];
};

export function formatContractProblem(problem: ContractProblem): string {
  const location = problem.path ? ` ${problem.path}` : '';
  return `[Contracts] ${problem.contract}${location}: ${problem.message}`;
}

/**
 * Only a problem that changes how the agent behaves is worth `error`: that level
 * is what the builder greps and what lights the dashboard's Fix-errors button.
 * Everything else — and anything in the platform catalog, which the user cannot
 * edit — is prefixed `[WARN]`, because `console.warn` writes to stderr, where an
 * unprefixed line is classified as an error.
 */
export function reportContractProblems(
  problems: SurfaceContractProblems,
  sink: ContractProblemSink,
): void {
  for (const problem of problems.agent) {
    const line = formatContractProblem(problem);
    if (problem.severity === 'error') {
      sink.error(line);
    } else {
      sink.warn(`[WARN] ${line}`);
    }
  }
  for (const problem of problems.builtin) {
    sink.warn(`[WARN] ${formatContractProblem(problem)} (platform catalog, not agent code)`);
  }
}

/** Diagnostics must never be the reason an agent fails to boot. */
export function reportSurfaceContractProblems(sink: ContractProblemSink = console): void {
  try {
    reportContractProblems(ToolRegistryFactory.getSurfaceContractProblems(), sink);
  } catch (error) {
    sink.error(
      `[Contracts] contract check failed: ${error instanceof Error ? error.message : error}`,
    );
  }
}
