---
name: ui-interaction
description: How your screens, actions, and UI state work — the interaction loop that holds on every channel
metadata:
  autoload: true
---

# Screens & the interaction loop

How your UI system works, independent of where you are being used. Where a
screen LANDS (a live page, a chat card, plain markdown) is decided per channel
by the platform — never by you. What follows is true everywhere.

## Rendering

- A screen is one component OR a stack of several: `RenderSectionStack`
  composes any of your components onto one page in a single call — never
  assume one-component-per-page.
- Screens are catalog contracts you FILL, never invent: each `Render<Component>`
  tool is one screen type with a fixed schema. Fill props only from real data.
- Write response-specific titles, descriptions, option labels, validation, and
  other Render props in the committed language named by `<session_locale>`.
  Preserve brands, names, identifiers, prices, units, dates, policy effects,
  form value identity, and every other fact while translating their presentation.
  Stable shell and component chrome is bundle-owned; do not recreate it in props.
- Re-using a `surfaceId` UPDATES that screen in place — use it for corrections
  and refinements of what is showing. A new `surfaceId` is a NEW screen — use
  it for a new task or subject.
- Re-rendering a screen does NOT throw away what the visitor has entered. Any
  input section already on that screen is carried forward when your new
  composition leaves it out, and typed values survive. So answering a question
  about a form is a normal re-render of the same `surfaceId` with the answer
  added — you do not need to re-send the form to protect it, and you should not
  refuse to re-render for fear of clearing it.
- Several blocks on ONE screen: a single `RenderSectionStack` call — its
  `sections` array lists the components top-to-bottom, each with that
  component's own props. Never make several Render calls hoping they will all
  show; only one becomes the page, and it is the FIRST — every later call in
  that turn is written and then never seen. At most one interactive section of a kind
  (Form, OptionGrid, ChoiceBoard) per stack, and never a SectionStack inside
  a SectionStack.
- A free-form or prose answer that deserves the screen: `RenderTextBlock`
  (title, markdown body, optional heading/text/image/button blocks).
- A screen renders live only where a viewer is present. Everywhere else the
  screen becomes markdown, and that markdown is all the recipient gets. Most
  screens derive it from the props you already passed — leave `fallbackMarkdown`
  out and take the derived one. Write it yourself only when the schema marks it
  required, or when the derived version would genuinely lose the answer. Do not
  restate the whole screen in it by habit: that is a second copy of everything
  you just wrote, generated before the screen can appear. The tool result tells
  you which happened — trust it.
- TURN SHAPE: perform reads needed to ground the screen; once its props are
  ready, render before unrelated bookkeeping. Then follow runtime presentation
  for any reply line and stop. The screen carries its own content — do not
  narrate it afterwards.
- Subagents never render — they return data; you render from the main turn.

## What comes back to you

- `a2uiAction` events are TRUSTED UI interactions — the visitor clicked or
  submitted something on a screen you rendered. They are structured events,
  not typed text; act on their `name` and `context` directly.
- The `<action log>` block lists interim screen interactions since the last
  message, in order.
- `<ui_state>` carries the CURRENT values of what the visitor is editing on
  screen (fields, selections). Read it before answering questions about the
  screen they are on; do not echo it back verbatim.
- It updates when a field LOSES focus, not per keystroke — a value being typed
  right now may not be there yet.
- Passwords and card fields are NEVER in it. Those values stay in the browser
  by design, so an empty one means "withheld", never "the visitor left it
  blank". Never say a payment or credential field is empty, and never ask the
  visitor to tell you what they typed into one.

## Sessions

- One conversation can have several viewers and channels at once (web, voice,
  API callers) — screens and UI state are shared per session, so what you
  render is what every participant's channel projects in its own way.
- The committed session locale governs every channel's new dynamic content. A
  browser's stable wording activates separately and may still show its previous
  complete bundle; follow the activation fact in `<session_locale>` and never
  claim a pending browser update is already visible.
