---
id: permissions/tag-policy
title: "Permission Tags"
kind: capability
domain: permissions
capability: tag-policy
capabilities:
  - provider-runtime
  - contact-policy-permissions
  - tags
tags:
  - permissions
  - tags
  - security
applies_to:
  - src/tags
  - src/permissions/contact-policy-permissions-provider.ts
owners:
  - ravi-dev
status: active
normative: true
---

# Permission Tags

Tags are selectors and metadata. Tags MUST NOT authorize runtime behavior by
themselves.

The current supported permission tag path is the explicit
`contact-policy-permissions` provider. It recognizes permission-scoped contact
tags and materializes provider-runtime capabilities for the matching contact
only from provider-owned configuration.

A permission tag definition is also the **profile** referenced by chat-scoped
contact grants (`permissions/user-overlay`). Those grants live in
`permission_contact_chat_grants`, not in tag bindings, and reference the
profile by slug.

## Contact Permission Tags

A permission tag bound directly to a contact is a **global** contact grant. The
CLI creates or removes it only with `ravi permissions allow|deny --force`.
Inside governed chats it contributes to the user overlay; it never governs a
chat by itself.

`contact-policy-permissions` MUST materialize contact tags only when all are
true:

- the contact policy is `allowed`;
- the contact is not opted out;
- the tag is permission-scoped after normalization, e.g. `permission.family`
  becomes `permission-family`;
- the tag definition exists in `tag_definitions`;
- the tag definition has `kind=system` and `source=permissions`;
- the tag definition metadata declares explicit permission capabilities.

Permission capabilities MAY be declared as canonical strings or objects:

```json
{
  "permissions": {
    "capabilities": [
      "mutate:image:generate",
      "use:tool:image_generate",
      { "permission": "read", "objectType": "skills", "objectId": "show" }
    ]
  }
}
```

Compatibility operator tags `permission.admin`, `permission.owner`, and
`permission.superadmin` MAY continue to materialize `admin:system:*` for trusted
operators until they are migrated into tag definitions.

Generic tags such as `family`, `admin`, `vip`, or `customer` MUST NOT
materialize capabilities.

## Chat Tags As Grant Scope

`ravi permissions allow <profile> --to contact:<id> --chat-tag <tag>` stores a
chat-scoped grant whose scope is a chat tag. The chat tag is only a selector:
it decides which chats the contact grant covers (evaluated at turn time) and
MUST NOT grant anything by itself. Chat tags do not need a permission
namespace.

Explicit chat and chat-tag grants MUST apply to contacts that are not blocked
and not opted out, regardless of `allowed` status, because group participants
are often `discovered`/`pending` and status is intake policy. Global contact
permission tags keep the `allowed` requirement above.

Rules:

- Generic CRM tags MUST NOT grant authority.
- Permission-bearing tags MUST use a permission namespace.
- A provider MUST explicitly consume a tag before that tag affects
  authorization.
- Deleting a tag binding MUST affect the next provider-runtime materialization
  without requiring cleanup of removed policy tables.
- Tag management MUST NOT write authorization directly into unrelated provider
  state.
