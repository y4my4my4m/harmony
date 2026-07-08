# Federation

Harmony speaks ActivityPub. This document is for people running other fediverse
software (Mastodon, Lemmy, Misskey, Pleroma, and anything else that federates)
who want to know what to expect when their instance talks to a Harmony instance,
and for anyone curious about how the chat-server side of things is modelled on
top of a protocol that was mostly designed around microblogging.

It is a description of what the code actually does today, not a wishlist. Where
something is half-built or deliberately non-standard it says so.

The wire format extensions are specified separately in
[`docs/ACTIVITYPUB_EXTENSIONS.md`](docs/ACTIVITYPUB_EXTENSIONS.md). This file is
the higher-level "how does it federate" overview; that one is the property-by-property
reference.

## What Harmony is

Harmony is a chat platform - think Discord-style servers with channels, threads,
voice, roles and permissions - that also has a microblog-style public timeline
glued to the same accounts. Both halves federate, but they federate differently,
and that distinction matters for interop:

- The **timeline** (posts, follows, likes, boosts, replies) is ordinary
  ActivityPub and is meant to interoperate with the wider fediverse. A Mastodon
  user can follow a Harmony user and see their posts.
- The **chat servers** (the Discord-like part) are modelled as `Group` actors
  with Harmony-specific extensions. Other Harmony instances understand the whole
  thing. Non-Harmony software will see a `Group` actor and some `Note`s and can
  do something sensible with them, but channels, roles and voice are extensions
  it won't know about.

The software identifies itself as `harmony` in NodeInfo. There is no central
directory; instances find each other the usual way, through WebFinger and by
following links in activities they receive.

## Implementation notes

The federation layer lives in `federation-backend/` - a Node/Express service,
separate from the Vue frontend and from Supabase. It is hand-written against the
spec rather than built on an ActivityPub framework, so the surface area is
exactly what's in the code and nothing more. HTTP signatures are done with
Node's `crypto`, fetching with `undici`, outbound delivery is queued through
BullMQ/Redis.

Inbound activities hit the backend directly. Outbound activities are produced by
Postgres triggers, which drop a job onto a queue (via `pg_notify`) that the
backend drains and delivers. So "user does a thing in the app" and "the fediverse
hears about it" are decoupled by a queue, which is worth knowing if you're
debugging delivery lag.

## Actors

All actor IDs live under the instance domain. There is no `/actors/` prefix; the
path tells you what kind of thing it is.

### People - `https://example.com/users/{username}`

Standard `Person` actors. They carry `inbox`, `outbox`, `followers`, `following`,
`featured`, a `publicKey` for HTTP signatures, and a shared inbox at
`https://example.com/inbox`. Profile colour, custom status and custom emoji ride
along as `harmony:` extensions and are safe to ignore.

This is the actor other fediverse software should care about. Follows, posts,
replies, likes and announces all work through it.

### Chat servers - `https://example.com/servers/{uuid}`

A Harmony "server" (a community/guild) is a `Group` actor tagged
`harmony:type: "ChatServer"`. It has its own inbox and its own keypair, because a
server signs its own moderation activities rather than borrowing the owner's
identity. `attributedTo` points at the `Person` who owns it. Membership is driven
by `Join` and `Leave` activities sent to the server's inbox.

Channels are **not** separate actors. They're embedded in the Group under the
`harmony:channels` extension, and each one is also addressable on its own at
`https://example.com/servers/{uuid}/channels/{channelId}` if you want to fetch it
directly. Channel types are `harmony:TextChannel`, `harmony:VoiceChannel` and
`harmony:Category`. Messages posted in a channel are plain `Note`s whose
`context` is the channel URL - that `context` link is how a message gets routed
back to the right channel on the receiving side.

If you only understand vanilla ActivityPub, a chat server reads as a `Group` with
some members and a pile of `Note`s. That's a reasonable degraded view. You just
won't get the channel structure, roles or permissions.

### Group conversations - `https://example.com/conversations/{id}`

Group DMs are also `Group` actors, but tagged `harmony:type: "harmony:GroupConversation"`
to distinguish them from chat servers. They exist so a multi-person DM can include
people from other instances.

## Discovery

### WebFinger

`GET /.well-known/webfinger?resource=acct:{username}@{domain}` resolves a user.
The response links `self` to the `Person` actor (`application/activity+json`) and
a `profile-page` to the human-readable profile. `host-meta` is served too, in
both XRD and JSON, pointing back at the WebFinger template.

Only `acct:` resources are resolved right now. There is an open gap here: the
server-discovery code expects remote instances to answer a `harmony://server@…`
WebFinger query for resolving a chat server by handle, but the local WebFinger
handler does not yet serve that scheme. Until it does, chat servers are
discovered by their full actor URL or through an invite link, not by an
`@`-style handle. See the invites section below.

### NodeInfo

`GET /.well-known/nodeinfo` links to NodeInfo 2.0 and 2.1 documents at
`/nodeinfo/2.0` and `/nodeinfo/2.1`. They report `software.name: "harmony"`,
`protocols: ["activitypub"]`, and usage counts. This is enough for the common
instance crawlers and "what is this server" probes to classify a Harmony node.

## Delivery and signatures

Inbound POSTs to any inbox must carry a valid HTTP Signature. The backend fetches
the signing actor's public key (and caches it), verifies the signature, and only
then processes the activity. Unsigned or badly-signed activities are rejected.

Outbound activities are signed with the relevant actor's key - the user's key for
user activities, the server's own key for server/moderation activities. Delivery
is fanned out through the queue, with retries, so a remote instance being briefly
unreachable doesn't drop the activity.

There is a per-user shared inbox advertised at `/inbox`. Note that the `Person`
actor also advertises a `sharedOutbox` endpoint that is not actually served -
treat outboxes as per-actor (`/users/{username}/outbox`, `/servers/{uuid}/outbox`)
and ignore the shared-outbox hint. That's a known piece of cruft in the actor
document.

## Joining a server across instances

This is the part with no real fediverse precedent, so it's worth spelling out.

Public servers can be joined by anyone: discover the `Group` actor, send a `Join`
to its inbox, get an `Accept` back. Private servers require an invite. Invites are
short codes (`/invite/CODE` on the originating instance). When a user on instance
A joins a private server on instance B, the `Join` activity carries the code in a
`harmony:inviteCode` property. Instance B validates it against its own invite
table - checking expiry and use count - before accepting. The code is the
authorization; the activity is just the transport.

Invite previews (server name, description, member count, channel list) are fetched
over a small HTTP endpoint on the originating instance rather than baked into an
activity, so the joining user can see what they're walking into before committing.

That preview endpoint returns plain JSON, which is attacker-controlled: any host
can serve a convincing-looking blob. So before a preview is shown, the resolving
instance verifies the advertised `server.id` actually resolves to a genuine
`application/activity+json` `Group` actor **on the same host the invite came from**
(and that the actor's inbox lives there too). A host can't fake the card, and it
can't point the resolver at somebody else's real `Group` to borrow its identity.
Verification failure is surfaced to the user as "could not verify this as a genuine
federated server," with a fall-back to just opening the link in a browser. The
`Join` itself is independently re-validated at the target inbox (Group type +
invite code), so this preview check is defence-in-depth, not the only gate.

Cross-instance group-DM invites work differently: they arrive as a `Create` +
`Note` with `metadata.type: "group_invite"`, because there's no server to send a
`Join` to.

### Idea: capability negotiation via NodeInfo (not yet implemented)

Today "is this instance joinable as a chat server" is inferred implicitly: an
invite URL is treated as joinable, and the real test is whether the `Group` actor
fetch and the `Join`/`Accept` handshake succeed. That works, but it's discovered
by *trying*, and it bakes in the assumption that `/invite/CODE`-shaped URLs on a
foreign host speak Harmony's server dialect.

A cleaner future path is explicit capability advertisement. NodeInfo already
carries a free-form `metadata` object; a Harmony (or Harmony-compatible) node could
declare something like:

```jsonc
// /nodeinfo/2.1  →  metadata
"metadata": {
  "nodeName": "…",
  "features": ["chat-servers", "voice", "server-invites"]
}
```

The resolving client would probe NodeInfo first (the `instanceProbe` route already
fetches and parses it for other purposes) and only offer "Join Server" when the
remote *asserts* the `chat-servers` / `server-invites` capability, instead of
guessing from a URL pattern. Benefits:

- Compatibility becomes a claim made by the peer, verifiable up front, rather than
  a failure discovered mid-join.
- Third-party implementers get a documented, non-Harmony-branded way to opt in —
  advertise the feature flag, serve the `Group` actor and the invite endpoint, and
  they interoperate without pretending to be "harmony" in `software.name`.
- The same flags can gate other cross-instance affordances (voice, threads) as
  they mature, so clients degrade gracefully against partial implementations.

This is additive and backward-compatible: absence of the flag just means "fall back
to the current try-and-see behaviour." Worth doing alongside the chat-server
discovery-by-handle work noted above.

## Interoperability expectations

What works with non-Harmony software today:

- A Harmony user is a normal `Person`. Follow them, get their posts, reply, like,
  boost. Mentions resolve via WebFinger. Custom emoji follow the Misskey-style
  `emojis` convention.
- Public timeline posts are `Note`s and behave like Mastodon statuses.

What is Harmony-to-Harmony only:

- Channels, threads, roles, permissions, voice state, and server moderation. These
  are all `harmony:` extensions. Other software is expected to ignore properties
  it doesn't recognise (and standard ActivityPub says it should), so receiving
  them is harmless - it just won't render them.
- Chat-server discovery by handle (`server@instance`), pending the WebFinger work
  noted above.

If you're implementing against Harmony and something here doesn't match what you
observe on the wire, the wire is right and this document is stale - please open an
issue.

## The namespace

All extensions live under `https://harmonyapp.dev/ns#`, prefix `harmony`, and are
declared in the `@context` of any activity that uses them. Voice signalling uses a
second namespace, `https://harmony.social/ns/voice`, for historical reasons. The
full vocabulary - every property, with types and meaning - is in
[`docs/ACTIVITYPUB_EXTENSIONS.md`](docs/ACTIVITYPUB_EXTENSIONS.md). None of it has
been put through the FEP process yet; it's a draft and the version number in that
file is the one to trust.

## Contact

Bug reports and interop questions go through the project's issue tracker. If
you're bringing up another implementation and want to compare notes on the chat
extensions, that's the place - the extension spec is explicitly a draft and
feedback from a second implementer is the fastest way to find the parts that are
underspecified.
