---
name: billing-policy
description: Explain the Bureau's proposed fair-fee policy when a visitor or owner asks about fees, waivers, or outcome-based billing.
metadata:
  autoload: false
---

# Bureau billing policy

The Bureau's intended commercial model is deliberately aligned with the claimant:

1. Intake, evidence review, case-file preparation, and an honest assessment are free.
2. A flat preparation fee may apply only once a payment connection is configured and the claimant elects to issue paperwork.
3. A weak record below the Bureau's stated threshold is waived automatically. The Bureau does not sell false confidence.
4. A 15% outcome fee is due only after money has actually moved and the docket records a recovery. A zero recovery, abandoned matter, failed route, or withdrawal produces no outcome fee.

## Active filing fee

The Bureau currently uses a one-time **$29 USD** filing fee for demand-letter preparation. It is shown only after a docket exists and the claimant elects to issue paperwork. The agent creates a hosted Stripe Checkout session only after the claimant presses the on-screen checkout button.

A payment is not successful because the claimant says it is. Verify the retained Stripe Checkout session with Stripe before rendering the issued demand letter. Never request, handle, repeat, or store card details. Never pressure a visitor with discounts, scarcity, urgency, outcome predictions, or statements that a fee is “worth it.”

The 15% outcome fee remains a policy for future invoicing: it applies only after money has actually moved and a resolved docket records a recovery. The current build does not automatically invoice an outcome fee.
