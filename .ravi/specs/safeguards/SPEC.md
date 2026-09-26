---
id: safeguards
title: "Safeguards"
kind: domain
domain: safeguards
capabilities:
  - prompt-ingress
tags:
  - safeguards
  - security
  - prompts
  - console
applies_to:
  - .ravi/specs/safeguards
owners:
  - ravi-dev
status: draft
normative: true
---

# Safeguards

## Intent

Safeguards are content screens for untrusted text that can become model-visible.
They answer "should this span be shown to the model?" They do not answer "may this agent use this tool?"

`permissions` remains the host enforcement layer for tools, sessions, and delegation.
A safeguard decision MUST NOT grant, deny, or widen a permission.
A safeguard decision MUST NOT be treated as proof that the model will obey a later instruction.

## Boundary

- Safeguards MUST stay agnostic of any one detector. Detectors are plugins behind `safeguards/prompt-ingress`.
- Safeguards MUST NOT replace `permissions/enterprise` turn-scoped authority.
- Safeguards MUST NOT implement Console product policy, billing, or mail redaction. Console owns what it emits. OSS owns what it places in a prompt.
- This domain is design-only until an implementation PR wires a detector. Reading these specs MUST NOT by itself change runtime behavior.

## Current Capabilities

- `safeguards/prompt-ingress` — contract for screening open Console text before it enters a model turn.
