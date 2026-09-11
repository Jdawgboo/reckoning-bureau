# The Reckoning Bureau — specification

## Accepted business behavior

1. **Voice and stance.** The agent speaks as the office, first person plural,
   cold and procedural, entirely on the claimant's side. No sympathy theatre, no
   emojis, at most one dry line per turn.
2. **Compliance boundary.** Document preparation and case management only. Never
   legal advice, never representation, never a prediction of the outcome. Said
   plainly whenever it is at stake (will I win, should I settle, act for me), and
   the claimant is redirected to a lawyer for criminal, injury, custody,
   immigration or imminent-hearing matters.
3. **Arrival.** The `[user opened the agent]` turn renders `IntakeDesk` with one
   short line of text; no tool reads for that turn.
4. **Intake is progressive.** One question at a time whenever the answer changes
   the next question; batched fields only for details that stand independently.
5. **The register is the authority on filings.** Docket numbers are minted
   server-side (`RB-<year>-<4-digit>`); the model never composes one. A file
   exists only after the claimant presses the stamp and the mutation succeeds.
6. **The Bureau does not transmit.** The demand letter is prepared for the
   claimant's signature. The `DEMAND ISSUED` entry is written only when the
   claimant confirms they have sent it.
7. **A deadline is watched.** Issuing a demand sets an `at` schedule on the
   `escalation_review` handler for the deadline; the escalation run is
   idempotent per fire time.
8. **Grounding.** Facts come from the claimant, the file, or a tool result. No
   invented statutes, rights, policy terms, amounts, deadlines or odds.

## Primary journeys

| Journey | Path | Observable outcome |
|---|---|---|
| Arrive | `[user opened the agent]` → `IntakeDesk` | Four lanes and the procedure, with the not-a-law-firm line |
| Choose a lane | `openLane` action | Interrogation for that grievance type begins |
| Open a file | `CaseFile` (no docket) → stamp → `cases.open` | Docket minted, `RECEIVED` stamped, `caseFiled` action returns the number |
| Review a file | `CaseFile` with docket | Live register copy: status stamp, particulars, chronology, evidence, docket ledger |
| Demand | `DemandLetter` → copy → "I have sent it" | `DEMAND ISSUED` entry, deadline recorded as next action, `demandIssued` action |
| Clock set | `demandIssued` → `createSchedule` (`at`, `escalation_review`) | One line confirming the clock and what expiry triggers |
| Deadline passes | `escalation_review` schedule → `[escalation-clock]` turn | The office reopens the matter and puts the next lever to the claimant |
| Escalate | `EscalationPack` → copy statement → "I have lodged it" | Kind-specific stamp, status `escalated`, clock cleared, `packLodged` action |

## Owner decisions

- Concept: procedural grievance bureau, chosen over three alternatives for the
  hackathon build (durable multi-session case state, real escalation clocks,
  end-to-end artifacts).
- Identity: warm-paper ground, IBM Plex Serif / Sans / Mono, oxblood stamp ink,
  rubber-stamp status language (`RECEIVED`, `DEMAND ISSUED`, `ESCALATED`).
- Site mode `site`, header on, four grievance chips, composer reads
  "State your grievance…".
- Cadence: continuous build; the owner reviews the front desk in Preview
  themselves (Builder-side Preview session attachment was unavailable).

## Data contract

Case file JSON (`common/cases/<docket>.json`), maintained by the `cases` router:
docket, openedAt, updatedAt, status (`received | demand_issued | escalated |
resolved | withdrawn`), claimant name/contact, counterparty name/kind, category
(lane id), summary, remedySought, amountValue + currency, chronology[],
evidence[] (`held` flag), docketEntries[] (at, stamp, note), nextActionLabel,
nextActionDueAt, artifacts[]. A `_sequence.json` holds the year's counter and
`_index.json` a newest-first digest of the register.

## Known limits

- The register is docket-keyed and shared: possession of a docket number grants
  read access to that file.
- `artifacts[]` is reserved and currently unused; prepared documents live in the
  conversation, not in storage.
- The register only accepts an entry from a component confirmation (a browser
  press). A claimant who says in words that they sent the demand is asked to
  press the confirmation on the letter; the agent has no tool of its own for
  writing to the register.
- Verification status: the front desk was captured in Preview; intake, grounding
  and case-file drafting were exercised end to end through the HTTP messaging
  path and read back from traces. Not yet observed: the three register presses
  (stamp, demand issued, pack lodged), which need a browser click, and a real
  `escalation_review` fire — a one-off `at` schedule created in Preview did not
  deliver within ten minutes of its fire time, so the clock's registration and
  handler are code-verified only.
