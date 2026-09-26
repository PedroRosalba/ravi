# Chat-Scoped User Overlay / WHY

Contact grants used to be global permission tags on the contact. Granting a
user image generation "in this group" silently granted it in every chat that
user ever spoke in, and the tag was not even consulted on the agent-identity
tool path, so the grant was both too broad and dead.

Chats are the unit humans reason about ("only in this group?"). Scoping grants
to a chat, with threads inheriting the chat, matches that mental model without
inventing a thread grant model. Chat tags cover the "all client groups" case
with one grant.

Intersecting with the executor agent ceiling keeps agent identity as the
primary authority: a user grant can only unlock what the agent already can do,
so the overlay cannot become a privilege-escalation path.

Governance is per chat so that shipping the overlay does not change any chat
that has no contact grants. The first grant in a chat is an explicit operator
decision that the chat is now gated per sender; the CLI says so in its hints.

Global grants stay available behind `--force` because trusted operators need
them, but the explicit flag, the refusal without scope, and the structured
confirmation (`global`, `force`) let an agent prove it did not go global by
accident.
