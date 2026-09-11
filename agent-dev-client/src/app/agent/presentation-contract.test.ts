import { describe, it } from 'node:test';
import assert from 'node:assert';
import { buildPresentationContract } from './presentation-contract.ts';
import type { SiteConfig } from './site-config.ts';

function siteCfg(overrides: Partial<SiteConfig> = {}): SiteConfig {
  return {
    brandName: 'Test Co',
    navItems: [],
    defaultChips: [],
    mode: 'site',
    showHeader: false,
    appearance: 'light',
    ...overrides,
  };
}

describe('buildPresentationContract', () => {
  it('never simultaneously demands a render and forbids one', () => {
    const text = buildPresentationContract(siteCfg());
    const demandsRender = /anything the visitor should SEE goes on a surface/i.test(text);
    const forbidsRender = /plain text is correct/i.test(text);
    assert.strictEqual(
      demandsRender && forbidsRender,
      false,
      'these two rules cannot both be obeyed — that pairing is what defeated two rounds of prompt fixes',
    );
  });

  it('states the axis: the screen carries the substance, speech carries the takeaway', () => {
    const text = buildPresentationContract(siteCfg());
    assert.match(text, /SEE something new or changed/);
    assert.match(text, /SEE, KEEP, or VERIFY/);
    assert.match(text, /purely conversational/);
  });

  it('stays short — an exception layered on is the failure mode', () => {
    const lines = buildPresentationContract(siteCfg()).split('\n');
    assert.ok(lines.length <= 12, `presentation contract grew to ${lines.length} lines`);
  });

  it('keeps the mode split — that is a fact about the client, not an exception', () => {
    const chat = buildPresentationContract(siteCfg({ mode: 'chat' }));
    const site = buildPresentationContract(siteCfg());
    assert.match(chat, /stack inline in a scrolling transcript/);
    assert.match(site, /full page the visitor sees now/);
    assert.match(site, /Never say "above", "below"/, 'site mode bans the transcript vocabulary');
  });

  it('long work renders preliminary findings and sharpens them in place', () => {
    const text = buildPresentationContract(siteCfg());
    assert.match(text, /Long work is no reason for a blank page/);
    assert.match(
      text,
      /same surfaceId/,
      'refinement re-sends the same surface, never a second one',
    );
  });

  it('carries no voiceSummary requirement — the ladder owns speak-while-working', () => {
    assert.doesNotMatch(buildPresentationContract(siteCfg()), /voiceSummary/);
  });

  it('still orders reply text after the render', () => {
    assert.match(buildPresentationContract(siteCfg()), /AFTER the Render call/);
  });
});

describe('buildPresentationContract — the prose slot', () => {
  it('names the prose section as singular, so an answer updates it rather than stacking', () => {
    const text = buildPresentationContract(siteCfg());
    assert.match(text, /ONE prose section/);
    assert.match(text, /rather than adding a second/);
  });

  it('tells the agent a re-send is cheap and non-destructive', () => {
    const text = buildPresentationContract(siteCfg());
    assert.match(text, /keeps every section the visitor was using/);
    assert.match(text, /only the parts that actually changed/);
  });

  it('resolves read-vs-listen by the turn situation, not by a second standing rule', () => {
    const text = buildPresentationContract(siteCfg());
    assert.match(text, /If they SPOKE/);
    assert.match(text, /turn situation tells you which/);
  });

  it('states the consequence, not just the rule: unrendered text is never seen', () => {
    const text = buildPresentationContract(siteCfg());
    assert.match(text, /no longer shown anywhere/);
    assert.match(text, /or they never see it/);
  });

  it('is accurate about the one case where text IS the page', () => {
    assert.match(
      buildPresentationContract(siteCfg()),
      /Before any screen exists your reply text IS the page/,
      'a greeting renders as text; claiming text is never shown would be false',
    );
  });

  it('closes the judgement call — answering over an existing screen means a render', () => {
    assert.match(
      buildPresentationContract(siteCfg()),
      /answered over an existing screen means a render/,
    );
  });
});
