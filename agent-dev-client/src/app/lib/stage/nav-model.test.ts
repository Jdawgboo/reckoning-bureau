import { test } from 'node:test';
import { strict as assert } from 'node:assert';
import { resolveNavItems, type NavItem } from './nav-model.ts';

const TEMPLATE_BASELINE: NavItem[] = [
  { label: 'Services', intent: 'What services do you offer?' },
  { label: 'Book', intent: 'I want to book an appointment' },
  { label: 'Opening hours', intent: 'When are you open?' },
];

test('falls back to the template baseline when /nav is absent', () => {
  assert.deepEqual(resolveNavItems(undefined, TEMPLATE_BASELINE), TEMPLATE_BASELINE);
});

test('falls back to the template baseline when /nav is not an array', () => {
  assert.deepEqual(resolveNavItems({ label: 'x' }, TEMPLATE_BASELINE), TEMPLATE_BASELINE);
  assert.deepEqual(resolveNavItems('garbage', TEMPLATE_BASELINE), TEMPLATE_BASELINE);
  assert.deepEqual(resolveNavItems(null, TEMPLATE_BASELINE), TEMPLATE_BASELINE);
});

test('falls back to the template baseline when /nav is an empty array', () => {
  assert.deepEqual(resolveNavItems([], TEMPLATE_BASELINE), TEMPLATE_BASELINE);
});

test('a valid /nav overlay wins over the template baseline', () => {
  const overlay = [
    { label: 'Services', intent: 'What services do you offer?' },
    { label: 'My booking', intent: 'Show my booking', active: true },
  ];
  assert.deepEqual(resolveNavItems(overlay, TEMPLATE_BASELINE), [
    { label: 'Services', intent: 'What services do you offer?' },
    { label: 'My booking', intent: 'Show my booking', active: true },
  ]);
});

test('partial-invalid entries are dropped individually, valid ones kept', () => {
  const overlay = [
    { label: 'Services', intent: 'What services do you offer?' },
    { label: 'Missing intent' },
    { intent: 'Missing label' },
    'garbage',
    42,
    null,
    { label: 'Book', intent: 'I want to book an appointment' },
  ];
  assert.deepEqual(resolveNavItems(overlay, TEMPLATE_BASELINE), [
    { label: 'Services', intent: 'What services do you offer?' },
    { label: 'Book', intent: 'I want to book an appointment' },
  ]);
});

test('falls back to the template baseline when every entry is invalid', () => {
  const overlay = ['garbage', { label: 'no intent' }, 42];
  assert.deepEqual(resolveNavItems(overlay, TEMPLATE_BASELINE), TEMPLATE_BASELINE);
});

test('active is dropped when not a boolean, kept when true or false', () => {
  const overlay = [
    { label: 'A', intent: 'a', active: 'yes' },
    { label: 'B', intent: 'b', active: false },
  ];
  assert.deepEqual(resolveNavItems(overlay, TEMPLATE_BASELINE), [
    { label: 'A', intent: 'a' },
    { label: 'B', intent: 'b', active: false },
  ]);
});
