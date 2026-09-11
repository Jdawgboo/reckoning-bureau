import { describe, it } from 'node:test';
import assert from 'node:assert';
import {
  formatContractProblem,
  reportContractProblems,
  reportSurfaceContractProblems,
} from './contract-diagnostics.ts';

function makeSink() {
  const errors: string[] = [];
  const warnings: string[] = [];
  return {
    sink: {
      error: (line: string) => errors.push(line),
      warn: (line: string) => warnings.push(line),
    },
    errors,
    warnings,
  };
}

const AGENT_PROBLEM = {
  contract: 'FlightBooking',
  path: 'placement',
  message: 'unknown field "placement" — not part of ComponentContract',
  severity: 'warning' as const,
};

const BROKEN_SCHEMA_PROBLEM = {
  contract: 'WorldClocks',
  path: 'props.worldClocks.items',
  message: 'carries a JSON-Schema "properties" key',
  severity: 'error' as const,
};

const BUILTIN_PROBLEM = {
  contract: 'Form',
  path: 'props.fields',
  message: 'array without items',
  severity: 'warning' as const,
};

describe('contract diagnostics', () => {
  it('formats a problem with its contract and path', () => {
    assert.strictEqual(
      formatContractProblem(AGENT_PROBLEM),
      '[Contracts] FlightBooking placement: unknown field "placement" — not part of ComponentContract',
    );
  });

  it('sends a behaviour-changing problem to error, the level the builder greps', () => {
    const { sink, errors, warnings } = makeSink();

    reportContractProblems({ agent: [BROKEN_SCHEMA_PROBLEM], builtin: [] }, sink);

    assert.strictEqual(errors.length, 1);
    assert.match(errors[0], /WorldClocks props.worldClocks.items/);
    assert.deepStrictEqual(warnings, []);
  });

  it('keeps an untidy-but-harmless contract out of error, so a working agent stays unflagged', () => {
    const { sink, errors, warnings } = makeSink();

    reportContractProblems({ agent: [AGENT_PROBLEM], builtin: [] }, sink);

    assert.deepStrictEqual(errors, []);
    assert.strictEqual(warnings.length, 1);
    assert.ok(warnings[0].startsWith('[WARN] '));
  });

  it('keeps platform-catalog problems out of error, so the builder is never sent to fix our code', () => {
    const { sink, errors, warnings } = makeSink();

    reportContractProblems({ agent: [], builtin: [BUILTIN_PROBLEM] }, sink);

    assert.deepStrictEqual(errors, []);
    assert.strictEqual(warnings.length, 1);
    assert.match(warnings[0], /platform catalog, not agent code/);
  });

  it('prefixes a platform problem so the stderr classifier files it as a warning', () => {
    const { sink, warnings } = makeSink();

    reportContractProblems({ agent: [], builtin: [BUILTIN_PROBLEM] }, sink);

    assert.ok(
      warnings[0].startsWith('[WARN] '),
      'console.warn lands on stderr, where an unprefixed line is classified as an error',
    );
  });

  it('leaves the consequence to the message, which states it', () => {
    assert.strictEqual(
      formatContractProblem({
        contract: 'Bare',
        path: 'props',
        message: 'missing "props" — building this contract\'s tool will throw',
        severity: 'error',
      }),
      '[Contracts] Bare props: missing "props" — building this contract\'s tool will throw',
    );
  });

  it('says nothing about a healthy catalog', () => {
    const { sink, errors, warnings } = makeSink();

    reportSurfaceContractProblems(sink);

    assert.deepStrictEqual(errors, []);
    assert.deepStrictEqual(warnings, []);
  });
});
