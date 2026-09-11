import type { SiteConfig } from './site-config.ts';

/**
 * How the agent should talk about — and shape — what it renders, derived
 * from THIS client's presentation config. The client is the only authority
 * on how screens and text appear (page vs notice vs transcript), so it
 * authors this note; the server injects it verbatim, presentation-agnostic.
 * Keep it in lockstep with the stage's actual routing (stage-view.ts): every
 * claim here must be true of the running client, or the model is being
 * taught to misuse its own output channels.
 *
 * **One axis: does the visitor want a NEW screen?** Everything here answers
 * that question. Earlier versions layered exceptions until they contradicted —
 * a STRICT RULE that anything visible must be rendered, sitting four lines
 * above a rule that plain text is correct when answering by voice. Asked by
 * voice about the screen, the model broke one or the other whichever way it
 * went, and two rounds of prompt fixes failed because the instructions could
 * not all be obeyed. If you add a rule here, check it against that axis; if it
 * needs an exception, the axis is wrong, not the exception.
 *
 * Per-turn facts (which channel, whether a screen exists) are NOT here — this
 * note is built once from `SITE_CONFIG`. The server states the situation of the
 * turn separately.
 */
export function buildPresentationContract(cfg: SiteConfig): string {
  const lines: string[] = ['<presentation>', `The visitor is on the "${cfg.brandName}" site.`];

  if (cfg.mode === 'chat') {
    lines.push(
      'Screens you render stack inline in a scrolling transcript, so earlier screens stay visible above the newest one; referring to a "form above" is accurate in this layout.',
      'A screen carries its own content — after rendering one, do not repeat its contents back in prose.',
    );
  } else {
    lines.push(
      'Each screen you render becomes the full page the visitor sees now; the previous screen moves into a navigable history rail, not "above" or "below". Never say "above", "below", or "the form above" — the visitor is looking at the current screen, so refer to it as "this" or by name.',
      'One SURFACE is the page, and it holds as many components as you need: RenderSectionStack composes them top-to-bottom in a single call (an answer paragraph above a table, a list plus a form). Wanting several things visible means ONE surface with several sections — two Render calls to two different surfaceIds do not stack, both surfaces exist but only one is the page.',
      'Render when the visitor wants to SEE something new or changed — or when they typed a question whose answer they should be able to READ. If they SPOKE, your voice line is the takeaway, not the whole delivery: when the answer contains anything the visitor might want to SEE, KEEP, or VERIFY — numbers, lists, sources, comparisons, summaries, generated artifacts — render it on screen as well, and keep the spoken line to the single most important point. Leave the screen untouched only when the reply is purely conversational and leaves nothing worth keeping. The turn situation tells you which.',
      'A screen has ONE prose section, at the top. Anything the visitor should READ goes in it — when you answer about a screen that already has one, re-send that section with the new wording rather than adding a second. Two prose blocks is a mistake, not a layout.',
      'Re-sending a screen keeps every section the visitor was using, including what they have typed — so updating the prose, the data, or one component is safe and cheap. Send the whole composition each time; only the parts that actually changed will change on screen.',
      'There is no chat log on this page. Before any screen exists your reply text IS the page — that is why a greeting works as plain text. Once a screen is up, your reply text is no longer shown anywhere: whatever a reading visitor must see has to be IN the render, or they never see it. So a typed question answered over an existing screen means a render — put the answer in the prose section — and keep the reply itself to a short spoken-style line, heard when voice is on and otherwise unseen.',
      'Long work is no reason for a blank page: the moment a research step or tool hands you substantive findings, render them — say in the prose that you are still verifying if you are — and keep working. Re-send the same surfaceId as facts firm up, so the visitor watches the answer sharpen instead of waiting in front of a spinner.',
      'Emit your reply text AFTER the Render call, never before — text streamed ahead of a render flashes on the page and is then replaced.',
    );
  }

  lines.push('</presentation>');
  return lines.join('\n');
}
