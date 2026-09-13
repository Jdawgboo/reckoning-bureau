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
  something else), the three-step procedure, and a private invitation field for
  a respondent who holds a sealed-settlement code.
- **Procedural intake** — the agent interrogates one question at a time using
  screens, pressing for dates, amounts, exact wording and documents.
- **Case file** (`CaseFile`) — the grievance recorded as the office records it:
  particulars, chronology, schedule of evidence, and remedy sought. Unfiled it
  is a draft; the claimant presses the stamp and the register mints the docket
  number.
- **Durable register** — case files persist as JSON in shared agent storage under
  a `RB-<year>-<sequence>` docket number, with stamped entries. They outlive the
  session that opened them.
- **Hosted filing-fee gate** (`PaymentGate`) — a claimant can explicitly create a
  one-time **$29 USD** Stripe Checkout session for demand-letter preparation.
  The Bureau never handles card details and must verify Stripe payment before it
  treats paid paperwork as ready to issue.
- **Demand letter** (`DemandLetter`) — a full letter before action on the
  Bureau's paper, prepared for the claimant's signature, copyable in one press.
  The Bureau never sends it; when the claimant confirms they have, the register
  stamps `DEMAND ISSUED` against the docket.
- **Escalation pack** (`EscalationPack`) — the next lever, prepared for the
  claimant to lodge: a chargeback with their card issuer, a referral to an
  ombudsman or redress scheme, or a small claim. Carries the facts the forum's
  form will demand, a full statement to paste, the documents to attach and the
  steps in order.
- **Escalation clock** — issuing a real demand sets a durable one-off schedule
  on the deadline. A visible `?tempo=demo` clock provides a clearly labelled,
  accelerated product demonstration without changing the document's real date.
- **Sealed settlement** — after a demand is recorded, the claimant can create
  independent claimant and respondent capability codes. Each party enters one
  confidential figure in their own panel; AES-encrypted figures are compared
  only server-side. When the ranges overlap, the docket resolves at the
  nearest-$10 midpoint without exposing either figure. After three failed
  rounds, the figures are destroyed and ordinary escalation remains available.
- **Face the Opposition** (`OppositionHearing`) — a claimant can open a bounded,
  respondent-side evidence hearing from a registered case file. Locked-down
  counsel sees only the chronology and the exhibits recorded as held, asks one
  direct factual question at a time, stops immediately on “stop,” and closes
  after 10 answers or an end request with a three-answer record-gap note.

## Current limits

- The register accepts ordinary entries only from a press on the relevant screen;
  the agent cannot write them from conversation alone.
- Ordinary case reads remain docket-keyed and shared across sessions. Sealed
  figures are deliberately outside that record and require the separate opaque
  capability code.
- Nothing is ever transmitted to a counterparty or a forum by the Bureau. Every
  outbound act is the claimant's own, apart from a claimant voluntarily opening
  their own Stripe-hosted checkout page.
- There are no jurisdiction-specific UK or UAE packs. The current escalation
  flow uses only facts established with the claimant and asks before naming a
  forum; it must not invent local statutes, fees, or time limits.
- The 15% recovered-outcome fee and consented multi-claimant assembly are
  documented policies, not yet automated invoicing or grouping capabilities.
- Evidence entries currently retain held-document labels and descriptions, not
  uploaded attachment bodies. The opposition hearing cannot claim to have read
  a source file that the register does not store.
