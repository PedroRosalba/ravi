# Permissions / WHY

Ravi permissions decide who can read, execute, mutate, deliver, or disclose
state. The Permission Provider Runtime is the authorization surface for Ravi
core; runtime code must not embed a parallel permission graph.

The active model is turn-scoped agent identity. Actor, contact, chat, and
surface data are required provenance and compartment context, but unresolved
external actors still fail closed and receive no materialized authority.

User grants are an overlay scoped to a chat, because "allow this person to do
X in this group" is how humans grant access. The overlay intersects with the
agent ceiling, so it can only narrow what the agent does for someone, never
widen it.
