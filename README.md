# The Reckoning Bureau

A procedural grievance office, built as an [Agentplace](https://agentplace.io) web agent.

You were wronged by a company, a landlord, a platform. You wrote emails. They stopped
replying. The Bureau takes the matter apart, records it as a numbered case file, prepares
the documents you send **under your own name**, and watches the deadlines.

Not a law firm. No legal advice, no representation. Document preparation and case
management only — you remain the party to your own dispute.

## What it does

| Stage | What happens |
|---|---|
| **Front desk** | Four intake lanes — refund refused, deposit kept, never delivered, something else — and the office's three-step procedure. |
| **Intake** | One question at a time. Dates, amounts, the exact wording of the refusal, what documents you hold and which you must go and find. |
| **The file** | Particulars, chronology, a schedule of evidence, remedy sought. You correct it, then stamp it. The register mints the docket number: `RB-<year>-<sequence>`. |
| **The demand** | A full letter before action on the Bureau's paper, prepared for your signature. You send it. Confirming that stamps `DEMAND ISSUED` on the docket. |
| **The clock** | Issuing a demand sets a durable one-off schedule on the response deadline. When it expires the office wakes itself, reads the file, and comes back to you. |
| **Escalation** | A chargeback with your card issuer, a referral to an ombudsman or redress scheme, or a small claim — with the statement written out, the documents listed, the steps in order. Lodging it moves the file to `ESCALATED`. |

## How it is built

An LLM orchestrator drives every turn: it answers, calls tools, and renders screens.
The interesting parts of this project are the seams it uses.

- **Screens** — a server-side contract (`agent-dev-server/src/surfaces/`) paired with a
  React renderer (`agent-dev-client/src/app/agent/surfaces/`) under the same component
  key. The platform generates one render tool per contract; the model decides when to
  call it. Custom screens here: `IntakeDesk`, `CaseFile`, `DemandLetter`, `EscalationPack`.
- **The register** — `agent-dev-server/src/trpc/routers/cases.router.ts`. Case files are
  JSON in shared agent storage under `common/cases/`, so a docket outlives the session
  that opened it and is readable by a background run. Docket numbers are minted
  server-side from a sequence file; the model never invents one.
- **The escalation clock** — a registered schedule handler (`escalation_review` in
  `agent-dev-server/src/container.ts`). Durable, idempotent per fire time, and safe
  across VM sleep: the fired event arrives through the agent's inbox, not a `setTimeout`.
- **Voice and conduct** — `agent-dev-server/src/instruction.md`. Cold, procedural, one
  question at a time, and hard rules against inventing a statute, a deadline, a reason
  code or an outcome.
- **Identity** — warm paper, IBM Plex Serif/Sans/Mono, oxblood stamp ink
  (`agent-dev-client/src/app/agent/theme.css`, `site-config.ts`, `BureauHeader.tsx`).

Project notes live in `.agentplace/`: purpose and capabilities in
`project-description.md`, accepted behaviour and limits in `specification.md`,
the system map in `high-level-architecture.md`.

## Layout

```
.agent/                  runtime agent config, skills, locales
.agentplace/             project description, specification, architecture
agent-dev-server/src/    orchestrator server: instruction, surfaces, tRPC, tools
agent-dev-client/src/    React client: stage shell (platform) + agent screens
shared/                  types shared across both sides
```

## Running it

```bash
cd agent-dev-server && bun install && bun run dev   # or: npm install && npm run dev
cd agent-dev-client && bun install && bun run dev
```

The server needs `MODEL_BASE_URL` and `MODEL_ACCESS_KEY` in `agent-dev-server/.env.runtime`;
on Agentplace those are injected by the platform. Nothing in this repo contains credentials.

## Tests

```bash
cd agent-dev-server && bun test src/surfaces src/trpc
```

Covers docket minting, storage round-trips, docket-entry appends, clearing the clock on
escalation, rejection of anything that is not a real docket key, and contract/renderer
parity for every screen.

## Limits, stated plainly

- The Bureau never transmits anything to a counterparty or a forum. Every outbound act is
  the claimant's own.
- The register accepts an entry only from a press on the relevant screen.
- A docket number is the key to its file: whoever holds the number can read the case.
