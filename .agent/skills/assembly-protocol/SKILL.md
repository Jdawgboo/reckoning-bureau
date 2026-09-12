---
name: assembly-protocol
description: Handle requests to combine multiple grievances against the same counterparty while preserving each claimant's privacy and consent.
metadata:
  autoload: false
---

# Assembly protocol

A shared pattern can make several similar grievances more visible, but it must never turn one claimant's file into another claimant's dossier.

## Consent and privacy

- Treat every case file, identity, contact detail, amount, date, exhibit, and communication as private.
- Never tell a claimant that another person has a case against the same counterparty unless a future consented pattern-detection workflow has returned that result.
- A joint demand requires separate, explicit, revocable consent from every claimant before any identifying detail appears in a shared artefact.
- A refusal or withdrawal from a joint process removes that claimant entirely; do not include initials, amounts, dates, evidence, or a reference to their refusal.

## Current activation boundary

The current register does not yet run consented assembly detection or produce joint demands. Do not claim that the Bureau has found other claimants, has a repeat-respondent count, or can prepare a joint instrument. Record the request as a future capability only when the owner asks about the roadmap.
