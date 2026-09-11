# The Reckoning Bureau — project description

## Purpose

A procedural grievance office for people who have been wronged by a company,
landlord, platform or service provider and have run out of patience. The Bureau
takes a complaint apart, records it as a numbered case file, prepares the
documents the person sends under their own name, and watches the deadlines.

It is explicitly **not** a law firm: it prepares documents and manages a case
file, gives no legal advice, and never acts as anyone's representative. The
claimant remains the party to their own dispute.

## Who it is for

- Consumers refused a refund they are owed.
- Tenants whose deposit is being withheld.
- Buyers who paid and never received the goods or service.
- Anyone with a documentable grievance against a business who wants a paper
  trail rather than another ignored email.

Out of scope, and told so plainly: criminal matters, personal injury, custody,
immigration status, and anything with an imminent court date — those need a
licensed lawyer.

## Delivered capabilities

- **Front desk** (`IntakeDesk`) — the arrival screen: the desk's question, four
  intake lanes (refund refused, deposit withheld, paid and never delivered,
  something else) and the office's three-step procedure.
- **Procedural intake** — the agent interrogates one question at a time using
  builtin screens, pressing for dates, amounts, exact wording and documents.
- **Case file** (`CaseFile`) — the grievance recorded as the office records it:
  particulars, chronology, schedule of evidence (including the documents the
  claimant does *not* yet hold), and remedy sought. Unfiled it is a draft; the
  claimant presses the stamp and the register mints the docket number.
- **Durable register** — case files persist as JSON in shared agent storage under
  a `RB-<year>-<sequence>` docket number, with a docket ledger of stamped
  entries. They outlive the session that opened them.
- **Demand letter** (`DemandLetter`) — a full letter before action on the
  Bureau's paper, prepared for the claimant's signature, copyable in one press.
  The Bureau never sends it; when the claimant confirms they have, the register
  stamps `DEMAND ISSUED` against the docket.
- **Escalation pack** (`EscalationPack`) — the next lever, prepared for the
  claimant to lodge: a chargeback with their card issuer, a referral to an
  ombudsman or redress scheme, or a small claim. Carries the facts the forum's
  form will demand, a full statement to paste, the documents to attach and the
  steps in order. Lodging it stamps the docket and moves the file to `ESCALATED`.
- **Escalation clock** — issuing a demand sets a durable one-off schedule on the
  deadline. When it expires the office wakes itself, reads the file and takes the
  escalation back to the claimant.

## Current limits

- The register accepts entries only from a press on the relevant screen; the
  agent cannot write to it from conversation alone.
- The register is keyed by docket number and shared across sessions: anyone who
  holds a docket number can retrieve that file.
- Nothing is ever transmitted to a counterparty or a forum by the Bureau. Every
  outbound act is the claimant's own.
