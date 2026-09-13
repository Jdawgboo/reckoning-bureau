# The Reckoning Bureau — specification

## Accepted business behavior

1. **Voice and stance.** The agent speaks as the office, first person plural,
   cold and procedural, entirely on the claimant's side. No sympathy theatre,
   no emojis, at most one dry line per turn.
2. **Compliance boundary.** Document preparation and case management only. Never
   legal advice, never representation, never a prediction of the outcome. Said
   plainly whenever it is at stake (will I win, should I settle, act for me), and
   the claimant is redirected to a lawyer for criminal, injury, custody,
   immigration or imminent-hearing matters.
3. **Arrival.** The `[user opened the agent]` turn renders `IntakeDesk` with one
   short line of text; no tool reads for that turn. The desk also contains a
   capability-code entry to the respondent's sealed-settlement panel.
4. **Intake is progressive.** One question at a time whenever the answer changes
   the next question; batched fields only for details that stand independently.
5. **The register is the authority on filings.** Docket numbers are minted
   server-side (`RB-<year>-<4-digit>`); the model never composes one. A file
   exists only after the claimant presses the stamp and the mutation succeeds.
6. **Hosted filing fee.** After a docket exists and a claimant elects to prepare
   an issued demand, `PaymentGate` shows a single $29 USD line item. Its narrow
   server-side payment bridge creates Stripe Checkout only from an explicit
   browser press. Card details never reach the Bureau. A demand is treated as
   paid only after the payment gate verifies the retained Checkout session.
7. **The Bureau does not transmit.** The demand letter is prepared for the
   claimant's signature. The `DEMAND ISSUED` entry is written only when the
   claimant confirms they have sent it.
8. **A real deadline is watched.** Issuing a regular demand sets an `at` schedule
   on the `escalation_review` handler for the deadline; the escalation run is
   idempotent per fire time.
9. **Demonstration tempo is explicit.** `?tempo=demo` starts a visible accelerated
   clock after a demand is recorded. It is stamped as a demonstration, does not
   change the letter's real calendar deadline, and triggers a live escalation
   draft without additional visitor input.
10. **Sealed settlement.** After a demand is recorded, claimant and respondent
    receive separate high-entropy capability codes. Each figure is encrypted and
    compared only in a deterministic server mutation. Normal docket reads,
    conversation history, UI props, ledger text and artefacts never contain a
    sealed figure. A successful overlap resolves at the nearest-$10 midpoint;
    a failed round returns only “No zone of agreement in this round.” Three
    failed rounds destroy the figures and leave the ordinary enforcement track
    open.
11. **Face the Opposition.** A registered CaseFile exposes a claimant-initiated,
    bounded respondent-side hearing. The specialist receives only the trusted
    action packet containing chronology and held-exhibit details; it has no
    tools and never receives the case summary, assessment, strength score,
    settlement floor, sealed values, or red-team notes. It asks one direct,
    factual question at a time, stops immediately on “stop,” and after 10
    answers or “end the hearing” returns a note on the three weakest answers
    and the exhibit each attack concerned (or the absence of one). It never
    insults, predicts an outcome, or says who would win.
12. **Grounding.** Facts come from the claimant, the file, a tool result, or
    Stripe payment verification. No invented statutes, rights, policy terms,
    amounts, deadlines, payment state or odds.

## Primary journeys

| Journey | Path | Observable outcome |
|---|---|---|
| Arrive | `[user opened the agent]` → `IntakeDesk` | Four lanes, procedure, not-a-law-firm line and confidential invitation entry |
| Choose a lane | `openLane` action | Interrogation for that grievance type begins |
| Open a file | `CaseFile` (no docket) → stamp → `cases.open` | Docket minted, `RECEIVED` stamped, `caseFiled` action returns the number |
| Checkout | `PaymentGate` → `requestCheckout` → Stripe Checkout | Hosted $29 USD payment link appears only after an explicit press |
| Review a file | `CaseFile` with docket | Live register copy: status stamp, particulars, chronology, evidence and docket ledger |
| Demand | verified payment → `DemandLetter` → copy → “I have sent it” | `DEMAND ISSUED` entry and deadline recorded |
| Clock set | ordinary `demandIssued` → `createSchedule` (`at`, `escalation_review`) | One line confirming the durable real clock |
| Demo clock | `?tempo=demo` + `DemandLetter` issue | Visible accelerated countdown, `DEADLINE ELAPSED`, then an escalation-draft action |
| Sealed settlement | `CaseFile` claimant panel or front-desk invitation → figure submit | One private figure per party; result only is visible to either party |
| Face the Opposition | registered `CaseFile` → `faceOpposition` → `OppositionHearing` | One evidence-only challenge question at a time; a stopped or final review state is visible in the same hearing screen |
| Settlement | overlapping figures | `SETTLED BY AGREEMENT`, resolved docket and midpoint amount; neither bid is shown |
| Escalate | `EscalationPack` → copy statement → “I have lodged it” | Kind-specific stamp, status `ESCALATED`, clock cleared |

## Owner decisions

- Concept: procedural grievance bureau, chosen over three alternatives for the
  hackathon build (durable multi-session case state, real escalation clocks,
  end-to-end artefacts).
- Identity: warm-paper ground, IBM Plex Serif / Sans / Mono, oxblood stamp ink,
  rubber-stamp status language (`RECEIVED`, `DEMAND ISSUED`, `ESCALATED`).
- Site mode `site`, header on, four grievance chips, composer reads
  “State your grievance…”.
- Revenue: a single **$29 USD** hosted Checkout filing fee for demand-letter
  preparation. The 15% recovery fee is a documented future policy and is not
  automatically invoiced yet.
- Jurisdiction discipline: no UK or UAE jurisdiction pack. Do not approximate
  local fees, forms, regulators or statutes; use a fact-led generic flow until
  an accurately sourced pack is built.
- Cadence: continuous build; the owner reviews the front desk in Preview
  themselves (Builder-side Preview session attachment was unavailable).

## Data contract

Case file JSON (`common/cases/<docket>.json`), maintained by the `cases` router:
docket, openedAt, updatedAt, status (`received | demand_issued | escalated |
resolved | withdrawn`), claimant name/contact, counterparty name/kind, category,
summary, remedySought, amountValue + currency, chronology[], evidence[] (`held`
flag), docketEntries[] (at, stamp, note), nextActionLabel, nextActionDueAt,
artifacts[], real-or-demo clock state, demo flag, outcome (route and recovery),
and HMAC-linked settlement audit entries. The opposition hearing does not write
another durable case record: its packet and question-and-answer transcript stay
within the current rendered hearing and session history. Only chronology plus
held evidence labels/descriptions enter that packet; confidential settlement
storage and any future assessment or red-team data are excluded by design.

A separate `common/cases/<docket>.settlement.json` contains only encrypted sealed
figures and access-code hashes. `common/cases/_settlement_access.json` maps code
hashes to a docket and role. Those files are never returned by `cases.get` and
never rendered to a general case screen.

## Known limits

- Ordinary case registers remain docket-keyed and shared: possession of a docket
  number grants access to ordinary case facts. Sealed settlement requires its own
  high-entropy capability code and is not part of that baseline.
- The normal escalation schedule is durable; the accelerated demonstration clock
  exists to make the product's autonomous path observable and requires the
  demonstration screen to remain open.
- Stripe success is verified by the PaymentGate when the claimant returns through
  its Stripe success URL; there is not yet a payment-complete webhook or an
  automatic return to an arbitrary later conversation.
- The register's `artifacts[]` is still reserved. Settlement notice and account
  artefacts are not generated files yet.
- Multi-claimant assembly, automated outcome invoicing and jurisdiction-specific
  packs are intentionally cut until they can be built with their own consent,
  payment and primary-source fact boundaries.
- The current register does not retain original uploaded exhibit bodies. The
  opposition hearing can use only the held-exhibit labels/descriptions and the
  timeline, and must say nothing that implies it inspected a missing attachment.
