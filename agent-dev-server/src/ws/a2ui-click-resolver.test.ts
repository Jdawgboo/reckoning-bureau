/**
 * Fixtures pair a recorded node with the contract behind it. The real builtin contracts are
 * used, because the point is parity with what the browser sends.
 */

import assert from 'node:assert';
import { describe, it } from 'node:test';
import { resolveClick, type SurfaceContractCatalog } from './a2ui-click-resolver.ts';
import type { A2uiComponentNode } from '../../vendor/agentplace-a2ui/types.ts';
import type { ReducedSurface } from '../../vendor/agentplace-a2ui/surface-reduction.ts';
import type { ComponentContract } from '../../vendor/agentplace-a2ui/contract-schema.ts';
import { FORM } from '../bl/builtin-catalog/form.ts';
import { SUMMARY } from '../bl/builtin-catalog/summary.ts';
import { OPTION_GRID } from '../bl/builtin-catalog/option-grid.ts';
import { CHOICE_BOARD } from '../bl/builtin-catalog/choice-board.ts';
import { LIST } from '../bl/builtin-catalog/list.ts';
import { TEXT_BLOCK } from '../bl/builtin-catalog/text-block.ts';

const SURFACE_ID = 'booking';

const BUILTINS: SurfaceContractCatalog = {
  Form: FORM,
  Summary: SUMMARY,
  OptionGrid: OPTION_GRID,
  ChoiceBoard: CHOICE_BOARD,
  List: LIST,
  TextBlock: TEXT_BLOCK,
};

/** Agent-authored: action names declared, captions and context unknowable. */
const FLIGHT_BOOKING: ComponentContract = {
  component: 'FlightBooking',
  purpose: 'Booking screen for one flight.',
  props: { flightId: { type: 'string', required: true, description: 'Flight id' } },
  publishes: { '/email': { valueType: 'string' } },
  actions: {
    confirmBooking: {
      context: {
        email: { type: 'string', required: true, description: 'Visitor email' },
        flight: { type: 'string', required: true, description: 'Flight id' },
      },
    },
    confirmCancellation: {
      context: {
        email: { type: 'string', required: true, description: 'Visitor email' },
        flight: { type: 'string', required: true, description: 'Flight id' },
      },
    },
  },
};

function surface(nodes: A2uiComponentNode[]): ReducedSurface {
  return {
    surfaceId: SURFACE_ID,
    catalogId: 'test',
    components: new Map(nodes.map((node) => [node.id, node])),
  };
}

function single(node: { component: string } & Record<string, unknown>): ReducedSurface {
  return surface([{ ...node, id: 'root' }]);
}

function uiStateWith(values: Record<string, unknown>): Record<string, unknown> {
  return { surfaces: { [SURFACE_ID]: values } };
}

function press(
  requested: string,
  opts: {
    surface: ReducedSurface;
    catalog?: SurfaceContractCatalog;
    uiState?: Record<string, unknown> | null;
    context?: Record<string, unknown>;
  },
) {
  return resolveClick({
    surfaceId: SURFACE_ID,
    surface: opts.surface,
    uiState: opts.uiState ?? uiStateWith({}),
    requested,
    catalog: opts.catalog ?? BUILTINS,
    suppliedContext: opts.context,
  });
}

describe('resolveClick — builtin controls', () => {
  it("presses a form by its submit caption and sends the action's own name as the text", () => {
    const result = press('Book it', {
      surface: single({
        component: 'Form',
        fields: [{ id: 'email', label: 'Email', kind: 'email' }],
        submitLabel: 'Book it',
      }),
    });

    assert.strictEqual(result.outcome, 'resolved');
    if (result.outcome !== 'resolved') return;
    assert.strictEqual(result.action, 'submitForm');
    assert.deepStrictEqual(result.context, {});
    assert.strictEqual(result.message, 'submitForm');
  });

  it('presses a summary by its commit caption', () => {
    const result = press('Confirm and pay', {
      surface: single({
        component: 'Summary',
        lines: [{ key: 'time', label: 'Time', value: '18:00' }],
        commitLabel: 'Confirm and pay',
      }),
    });

    assert.strictEqual(result.outcome, 'resolved');
    if (result.outcome !== 'resolved') return;
    assert.strictEqual(result.action, 'commit');
  });

  it('refuses a summary already confirmed, which renders no CTA', () => {
    const result = press('Confirm and pay', {
      surface: single({
        component: 'Summary',
        lines: [{ key: 'time', label: 'Time', value: '18:00' }],
        commitLabel: 'Confirm and pay',
        status: 'confirmed',
      }),
    });

    assert.strictEqual(result.outcome, 'unavailable');
    if (result.outcome !== 'unavailable') return;
    assert.strictEqual(result.reason, 'already confirmed');
  });

  it('reproduces the per-item context an option card sends', () => {
    const result = press('Deep clean', {
      surface: single({
        component: 'OptionGrid',
        options: [
          { id: 'basic', name: 'Basic clean' },
          { id: 'deep', name: 'Deep clean' },
        ],
      }),
    });

    assert.strictEqual(result.outcome, 'resolved');
    if (result.outcome !== 'resolved') return;
    assert.strictEqual(result.action, 'selectOption');
    assert.deepStrictEqual(result.context, { id: 'deep', name: 'Deep clean' });
  });

  it('finds a choice nested in a column and carries its id', () => {
    const result = press('18:00', {
      surface: single({
        component: 'ChoiceBoard',
        columns: [
          { heading: 'Thu', items: [{ id: 'thu-18', label: '18:00' }] },
          { heading: 'Fri', items: [{ id: 'fri-19', label: '19:00' }] },
        ],
      }),
    });

    assert.strictEqual(result.outcome, 'resolved');
    if (result.outcome !== 'resolved') return;
    assert.deepStrictEqual(result.context, { id: 'thu-18', label: '18:00' });
  });

  it('refuses a disabled choice, as the component does', () => {
    const result = press('18:00', {
      surface: single({
        component: 'ChoiceBoard',
        columns: [{ heading: 'Thu', items: [{ id: 'thu-18', label: '18:00', disabled: true }] }],
      }),
    });

    assert.strictEqual(result.outcome, 'unavailable');
    if (result.outcome !== 'unavailable') return;
    assert.strictEqual(result.reason, 'disabled');
  });

  it('offers no list rows unless the list is selectable', () => {
    const inert = press('Margherita', {
      surface: single({ component: 'List', items: [{ title: 'Margherita' }] }),
    });
    assert.strictEqual(inert.outcome, 'not_found');
    if (inert.outcome !== 'not_found') return;
    assert.deepStrictEqual(inert.available, []);
  });

  it('falls back to the row index for a row with no id, as the component does', () => {
    const result = press('Margherita', {
      surface: single({
        component: 'List',
        selectable: true,
        items: [{ title: 'Focaccia' }, { title: 'Margherita' }],
      }),
    });

    assert.strictEqual(result.outcome, 'resolved');
    if (result.outcome !== 'resolved') return;
    assert.deepStrictEqual(result.context, { id: '1', title: 'Margherita' });
  });

  it('presses a text block button as a plain message, since it declares no action', () => {
    const result = press('Book a visit', {
      surface: single({
        component: 'TextBlock',
        body: 'We are open until six.',
        blocks: [{ type: 'button', label: 'Book a visit', intent: 'I want to book a visit' }],
      }),
    });

    assert.strictEqual(result.outcome, 'resolved');
    if (result.outcome !== 'resolved') return;
    assert.strictEqual(result.action, null);
    assert.strictEqual(result.message, 'I want to book a visit');
  });
});

describe('resolveClick — agent-authored components', () => {
  const flightSurface = single({ component: 'FlightBooking', flightId: 'BK-001' });
  const catalog: SurfaceContractCatalog = { ...BUILTINS, FlightBooking: FLIGHT_BOOKING };

  it('matches a declared action by its humanized name, which is the caption an agent writes', () => {
    const result = press('Confirm booking', {
      surface: flightSurface,
      catalog,
      context: { email: 'a@b.c', flight: 'BK-001' },
    });

    assert.strictEqual(result.outcome, 'resolved');
    if (result.outcome !== 'resolved') return;
    assert.strictEqual(result.action, 'confirmBooking');
    assert.deepStrictEqual(result.context, { email: 'a@b.c', flight: 'BK-001' });
  });

  it('matches the action name itself, case-insensitively', () => {
    const result = press('confirmcancellation', {
      surface: flightSurface,
      catalog,
      context: { email: 'a@b.c', flight: 'BK-001' },
    });

    assert.strictEqual(result.outcome, 'resolved');
    if (result.outcome !== 'resolved') return;
    assert.strictEqual(result.action, 'confirmCancellation');
  });

  it('reads a context value the screen published rather than asking for it', () => {
    const result = press('Confirm booking', {
      surface: flightSurface,
      catalog,
      uiState: uiStateWith({ email: 'seeded@b.c' }),
      context: { flight: 'BK-001' },
    });

    assert.strictEqual(result.outcome, 'resolved');
    if (result.outcome !== 'resolved') return;
    assert.strictEqual(result.context.email, 'seeded@b.c');
  });

  it('prefers a supplied value over the published one', () => {
    const result = press('Confirm booking', {
      surface: flightSurface,
      catalog,
      uiState: uiStateWith({ email: 'seeded@b.c' }),
      context: { email: 'typed@b.c', flight: 'BK-001' },
    });

    assert.strictEqual(result.outcome, 'resolved');
    if (result.outcome !== 'resolved') return;
    assert.strictEqual(result.context.email, 'typed@b.c');
  });

  it('names the required values it cannot know instead of pressing with them missing', () => {
    const result = press('Confirm booking', { surface: flightSurface, catalog });

    assert.strictEqual(result.outcome, 'context_required');
    if (result.outcome !== 'context_required') return;
    assert.deepStrictEqual(result.missing, ['email', 'flight']);
    assert.strictEqual(result.action, 'confirmBooking');
  });

  it('lists both declared actions when nothing matches', () => {
    const result = press('Pay now', { surface: flightSurface, catalog });

    assert.strictEqual(result.outcome, 'not_found');
    if (result.outcome !== 'not_found') return;
    assert.deepStrictEqual(result.available, ['confirm booking', 'confirm cancellation']);
  });

  it('reports ambiguity rather than guessing between two confirmations', () => {
    const result = press('Confirm', { surface: flightSurface, catalog });

    assert.strictEqual(result.outcome, 'ambiguous');
    if (result.outcome !== 'ambiguous') return;
    assert.deepStrictEqual(result.matches, ['confirm booking', 'confirm cancellation']);
  });

  it('ignores the builtin projection when an agent authored a component under that name', () => {
    const shadowing: ComponentContract = {
      component: 'Form',
      purpose: "The agent's own form.",
      props: {},
      publishes: {},
      actions: { sendEnquiry: { context: {} } },
    };
    const result = press('Send', {
      surface: single({ component: 'Form', fields: [{ id: 'a' }], submitLabel: 'Send' }),
      catalog: { Form: shadowing },
    });

    // The builtin projection would have matched the caption exactly and sent `submitForm`.
    assert.strictEqual(result.outcome, 'resolved');
    if (result.outcome !== 'resolved') return;
    assert.strictEqual(result.action, 'sendEnquiry');
  });

  it('finds nothing for a component with no contract in the catalog', () => {
    const result = press('Confirm booking', { surface: flightSurface, catalog: BUILTINS });

    assert.strictEqual(result.outcome, 'not_found');
    if (result.outcome !== 'not_found') return;
    assert.deepStrictEqual(result.available, []);
  });

  it('finds no controls for a display contract that omits actions', () => {
    const displayOnly: ComponentContract = {
      component: 'DisplayOnly',
      purpose: 'Shows read-only information.',
      props: {},
    };
    const result = press('Continue', {
      surface: single({ component: 'DisplayOnly', title: 'Done' }),
      catalog: { DisplayOnly: displayOnly },
    });

    assert.deepStrictEqual(result, { outcome: 'not_found', available: [] });
  });
});

describe('resolveClick — surface preconditions', () => {
  it('reports no screen when none was rendered', () => {
    const result = resolveClick({
      surfaceId: null,
      surface: undefined,
      uiState: null,
      requested: 'Confirm booking',
      catalog: BUILTINS,
    });

    assert.strictEqual(result.outcome, 'no_surface');
  });

  it('reports no screen when the recorded surface has no root', () => {
    const result = press('Confirm booking', {
      surface: surface([{ id: 'stray', component: 'Form' }]),
    });

    assert.strictEqual(result.outcome, 'no_surface');
  });

  it('refuses an empty request', () => {
    const result = press('   ', {
      surface: single({ component: 'Form', fields: [{ id: 'a' }], submitLabel: 'Send' }),
    });

    assert.strictEqual(result.outcome, 'not_found');
  });

  it('walks into children, so a stacked screen is searchable', () => {
    const result = press('Deep clean', {
      surface: surface([
        { id: 'root', component: 'Column', children: ['grid'] },
        { id: 'grid', component: 'OptionGrid', options: [{ id: 'deep', name: 'Deep clean' }] },
      ]),
    });

    assert.strictEqual(result.outcome, 'resolved');
  });
});

describe('resolveClick — validation gating', () => {
  const CHECKED: ComponentContract = {
    component: 'Checked',
    purpose: 'A screen whose control declares checks.',
    props: {},
    publishes: {},
    actions: { go: { context: {} } },
  };
  const catalog: SurfaceContractCatalog = { ...BUILTINS, Checked: CHECKED };

  const checkedSurface = (checks: unknown, fields?: unknown) =>
    single({ component: 'Checked', checks, fields });

  it('refuses a press whose declared check fails', () => {
    const result = press('Go', {
      surface: checkedSurface([
        { call: 'required', args: { value: { path: '/email' } }, message: 'Email is required' },
      ]),
      catalog,
    });

    assert.strictEqual(result.outcome, 'checks_failed');
    if (result.outcome !== 'checks_failed') return;
    assert.deepStrictEqual(result.messages, ['Email is required']);
  });

  it('passes once the value the check reads is present', () => {
    const result = press('Go', {
      surface: checkedSurface([
        { call: 'required', args: { value: { path: '/email' } }, message: 'Email is required' },
      ]),
      catalog,
      uiState: uiStateWith({ email: 'a@b.c' }),
    });

    assert.strictEqual(result.outcome, 'resolved');
  });

  it('skips a check on a field kind withheld from the server, and says which', () => {
    const result = press('Go', {
      surface: checkedSurface(
        [{ call: 'required', args: { value: { path: '/cvc' } }, message: 'CVC is required' }],
        [{ id: 'cvc', label: 'CVC', kind: 'cvc' }],
      ),
      catalog,
    });

    assert.strictEqual(result.outcome, 'resolved');
    if (result.outcome !== 'resolved') return;
    assert.deepStrictEqual(result.skippedSensitiveChecks, ['cvc']);
  });
});
