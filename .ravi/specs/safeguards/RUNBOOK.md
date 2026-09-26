# Safeguards / RUNBOOK

## How To Read This Domain

1. Read `safeguards` for the boundary against permissions and Console policy.
2. Read `safeguards/prompt-ingress` before changing trigger prompts, session prompt publish, session prompt consume, inbox delivery, bug follow, or mail enrichment.
3. Do not add a detector, a dataset, or a call into `publishSessionPrompt` from this domain spec alone.

## Confirm The Tree Indexes

```bash
ravi specs get safeguards --mode rules --json
ravi specs get safeguards/prompt-ingress --mode full --json
```

`prompt-ingress` MUST appear as a capability of `safeguards`.
