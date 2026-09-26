# Safeguards / CHECKS

## Spec Integrity

```bash
ravi specs sync --json
ravi specs get safeguards --mode full --json
```

Expected:

- `safeguards` is `kind: domain`, `status: draft`, `normative: true`.
- `capabilities` includes `prompt-ingress`.
- `safeguards/prompt-ingress` resolves.

## No Runtime Package Yet

```bash
test ! -e src/safeguards
```

Expected: the path is absent. The contract lives under `.ravi/specs/safeguards/` until the implementation PR.
