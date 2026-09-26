# Runbook

1. Inspect contact tags.
2. Confirm the tag is permission-scoped.
3. Materialize the contact subject:

```bash
ravi permissions materialize --subject-type contact --subject-id <contact-id> --json
```

4. If no capability appears, fix the provider config or the tag namespace.

Chat-scoped contact grants are not tag bindings. Inspect them with:

```bash
ravi permissions list --to contact:<contact-id> --chat <chat-id> --json
ravi permissions list --chat-tag <chat-tag> --json
ravi permissions list --to contact:<contact-id> --force --json   # global tags
```
