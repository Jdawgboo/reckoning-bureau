---
name: respondent-counsel-protocol
description: Run the bounded Face the Opposition hearing after its CaseFile action, using only its supplied chronology-and-exhibit packet.
metadata:
  autoload: true
---

# Respondent counsel protocol

`Counsel for the Respondent` is an internal teammate. It is never directly exposed to a customer. The customer-facing hearing uses the locked-down `respondent-counsel` subagent, which has no tools and receives only a purpose-built hearing packet.

## Start

On the trusted `faceOpposition` action from `CaseFile`, use only `hearingPacket` from the action. It contains the case chronology and exhibits recorded as held. Do not read the docket, filesystem, full case screen, conversation history, assessment, strength score, settlement information, or red-team notes to supplement it.

Call `Subagent` with `subagent: "respondent-counsel"`. Its task must contain only:

- phase `BEGIN`;
- the exact hearing packet; and
- an instruction to return its required `QUESTION:` format.

Remove the `QUESTION:` prefix and render `OppositionHearing` with the exact packet, `exchange: 0`, an empty `transcript`, `state: "questioning"`, and the returned question.

## Continue

On `hearingAnswer`, the packet, transcript, current question, and answer are the only materials that may go to respondent counsel. The answer is not evidence. Do not add the case summary, remedy, claim amount, names, docket ledger, payment information, assessment, strength score, settlement information, or red-team notes.

- If `stopRequested` is true, do not call counsel. Re-render `OppositionHearing` as `state: "stopped"` with no question and no review.
- Otherwise append the current question and answer to the hearing-only transcript. If `endRequested` is true, call counsel with phase `REVIEW`; otherwise call counsel with phase `CONTINUE`.
- A `QUESTION:` response produces the next `OppositionHearing` with `exchange` advanced by one.
- A `REVIEW:` response produces `state: "complete"`, no question, and the returned review note.

The screen ends the tenth answer automatically. “End the hearing” also requests the review. Never ask an eleventh question.

## Conduct limits

Counsel asks one direct question at a time and challenges only gaps or contradictions in the supplied record. It remains cold, factual, and professional; it never insults, predicts an outcome, or says who would win. A stopped hearing ends immediately. A completed hearing returns the three weakest answers, the exhibit each attack concerned (or an explicit absence of an exhibit), and the factual gap remaining.

The current register stores evidence labels and descriptions marked held, not the original attachment bodies. Therefore counsel’s packet contains only those recorded exhibit details and the chronology; it must never claim to have read an attachment that the register has not stored.
