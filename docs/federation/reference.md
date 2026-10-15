---
title: ActivityPub reference
description: Endpoints, HTTP signatures, actors, activities, objects, JSON-LD extensions and FEPs of Harmony's ActivityPub implementation, for implementers of other software.
---
# ActivityPub reference

This page describes Harmony's ActivityPub implementation as the federation backend (`federation-backend/`) runs it, for people building or debugging other ActivityPub software. For what federates in user terms, see the [Federation overview](/federation/).

Throughout, `<domain>` is the instance's `INSTANCE_DOMAIN`. Every id is an `https://<domain>/...` URL. ActivityPub responses are served as `application/activity+json`.

## Discovery

### WebFinger

`GET /.well-known/webfinger?resource=acct:<name>@<domain>`, answered as `application/jrd+json`.

- Only `acct:` resources on this instance's domain resolve. A missing or malformed `resource` answers 400, an unknown name or another domain 404, and a deleted account 410.
- A name can match a local account and a local chat server at once. The answer then carries one `rel="self"` link per actor, each tagged with its type in `properties["https://www.w3.org/ns/activitystreams#type"]` (`Person` or `Group`). Only public, federation-enabled servers resolve, by their slug.
- An account also gets a `http://webfinger.net/rel/profile-page` link to `https://<domain>/social/profile/<name>`.
- `acct:instance.actor@<domain>` resolves to the instance actor, typed `Application`.

```json
{
  "subject": "acct:alice@chat.example.com",
  "aliases": ["https://chat.example.com/users/alice"],
  "links": [
    {
      "rel": "self",
      "type": "application/activity+json",
      "href": "https://chat.example.com/users/alice",
      "properties": { "https://www.w3.org/ns/activitystreams#type": "Person" }
    },
    {
      "rel": "http://webfinger.net/rel/profile-page",
      "type": "text/html",
      "href": "https://chat.example.com/social/profile/alice"
    }
  ]
}
```

`/.well-known/host-meta` (XRD) and `/.well-known/host-meta.json` (JRD) carry the `lrdd` template `https://<domain>/.well-known/webfinger?resource={uri}`.

### NodeInfo

`/.well-known/nodeinfo` links schema 2.0 at `/nodeinfo/2.0` and schema 2.1 at `/nodeinfo/2.1`.

| Field | Value |
|---|---|
| `software.name` | `harmony` |
| `software.version` | The backend version |
| `software.repository` | `https://github.com/y4my4my4m/harmony` (2.1 only) |
| `protocols` | `["activitypub"]` |
| `usage` | `users.total`, `users.activeMonth`, `users.activeHalfyear`, `localPosts`. Active users are local accounts with a sign-in, a session refresh, a post or a message in the past 30 or 180 days; suspended and deleted accounts and bots are not counted. Recomputed at most every 10 minutes. |
| `openRegistrations` | The instance's registration setting |
| `metadata` | `nodeName`, `nodeDescription`; `icon`, `banner`, `themeColor` and `maintainer` (`name`, `email`) when set |
| `metadata.features` (2.1 only) | `discord_like_servers`, `voice_chat`, `video_chat`, `emoji_reactions`, `mastodon_compatible`, `misskey_compatible` |

## Actors

| Actor | id | `type` | Inbox | Key |
|---|---|---|---|---|
| Account | `/users/<username>` | `Person` | `/users/<username>/inbox`; shared inbox `/inbox` | `/users/<username>#main-key` |
| Instance actor | `/users/instance.actor` | `Application` | `/users/instance.actor/inbox`, which is the shared inbox | `/users/instance.actor#main-key` |
| Chat server | `/servers/<uuid>` | `Group` | `/servers/<uuid>/inbox`; no shared inbox | `/servers/<uuid>#main-key` |

Keys are 2048-bit RSA, published as PEM in `publicKey.publicKeyPem` with `owner` set to the actor id. A key pair is generated on an account's first signed request or first actor fetch, and on a chat server's first activity or first `Group` fetch.

Usernames match `[a-zA-Z0-9_]`, so no account can take `instance.actor`. The instance actor signs forwarded reports and the instance's own fetches. Its outbox is an empty collection, and it has `manuallyApprovesFollowers: true` and `discoverable: false`.

### Person

The actor document's `@context` is `https://www.w3.org/ns/activitystreams`, `https://w3id.org/security/v1` and `{ alsoKnownAs, movedTo, harmony: "https://har.mony.lol/ns#" }`.

| Property | Value |
|---|---|
| `preferredUsername`, `name` | Username; display name, or the username without one |
| `summary` | Bio as HTML: escaped text, linked `http(s)` URLs, `<p>` paragraphs and `<br>` line breaks |
| `url` | The actor id |
| `inbox`, `outbox`, `followers`, `following`, `featured` | `/users/<username>/inbox`, `/outbox`, `/followers`, `/following`, `/featured` |
| `endpoints.sharedInbox` | `https://<domain>/inbox` |
| `published` | Account creation time |
| `icon`, `image` | Avatar and banner as `Image` with `url` and, from the file extension, `mediaType` |
| `attachment` | Profile fields as `PropertyValue` (`name`, `value`) |
| `manuallyApprovesFollowers` | Always present; `true` for a locked account |
| `discoverable` | The account's discoverability setting |
| `alsoKnownAs` | Account aliases, when there are any |
| `movedTo` | Target of a completed move |
| `tag`, `emojis` | Custom emoji of the display name and bio: `Emoji` tags, plus a Misskey-style `emojis` map of shortcode to URL |
| `harmony:profileColor`, `harmony:customStatus` | See [Extension properties](#extension-properties) |

A deleted account answers its actor URL with 410 and a `Tombstone` (`id`, `formerType: "Person"`, `deleted`).

### Group (chat server)

A server is served under the read rules in [Reads and access](#reads-and-access). A caller that may not read it gets a stub with `id`, `type`, `harmony:type`, `name`, `inbox`, `publicKey`, `discoverable: false` and `manuallyApprovesFollowers: true`, which is what a `Join` by invite and a check of the Group's signature need. A reader gets the full document:

| Property | Value |
|---|---|
| `harmony:type` | `"ChatServer"` |
| `preferredUsername` | The server's slug, its WebFinger name |
| `name`, `summary` | Server name and description |
| `inbox`, `outbox`, `members` | `/servers/<uuid>/inbox`, `/outbox`, `/members` |
| `followers` | `/servers/<uuid>/followers`; listed, not served |
| `attributedTo` | The owner's actor id |
| `published`, `updated` | Creation and last update times |
| `icon`, `image` | Server icon and banner, omitted when unset |
| `harmony:memberCount` | Accepted members |
| `harmony:channels` | The categories and channels the caller may view |
| `discoverable` | `true` for a public server |
| `manuallyApprovesFollowers` | `false` |
| `publicKey` | The Group's key, `/servers/<uuid>#main-key` |

Each `harmony:channels` entry has `type` (`harmony:TextChannel`, `harmony:VoiceChannel` or `harmony:Category`), `id` (`/servers/<uuid>/channels/<channel uuid>`), `localId`, `name`, `position`, `order`, `category` and `categoryId` (the parent category's id and UUID, or null), `description` and `channelType` (`text`, `voice` or `category`). A category is listed when it holds a channel the caller may view, or no channel at all.

`GET /servers/<uuid>/channels/<channel uuid>` serves one text or voice channel: `type`, `name`, `summary`, `context` and `attributedTo` (both the Group id), `position`, `published`, and `replies`, the channel's message collection.

## Endpoints

| Method and path | Serves |
|---|---|
| `GET /users/<username>` | `Person` actor |
| `GET /users/<username>/outbox` | `OrderedCollection` of the account's public and unlisted posts: `Create` for posts, `Announce` for boosts |
| `GET /users/<username>/followers`, `/following` | `OrderedCollection` of actor ids, accepted follows only |
| `GET /users/<username>/featured` | `OrderedCollection` of up to 10 pinned public or unlisted posts, as embedded `Note`s |
| `GET /users/<username>/inbox` | The account's received activities, to its owner or an instance admin signed in to Harmony; an empty collection to anyone else |
| `POST /users/<username>/inbox` | Personal inbox |
| `POST /inbox` | Shared inbox |
| `GET /users/<username>/quote_authorizations/<uuid>` | FEP-044f `QuoteAuthorization` |
| `GET /posts/<uuid>` | `Note` of a local post; HTML to clients that do not ask for `application/activity+json` or `application/ld+json` |
| `GET /posts/<uuid>/likes` | `OrderedCollection` of `Like` objects, 50 per page |
| `GET /posts/<uuid>/shares` | `OrderedCollection` of the post's public and unlisted boosts, as `Announce` ids, 50 per page |
| `GET /posts/<uuid>/replies` | `OrderedCollection` of public and unlisted reply ids, 20 per page |
| `GET /messages/<uuid>` | `Note` of a federated chat or direct message; only with an ActivityPub `Accept`, else 406 |
| `GET /servers/<uuid>` | `Group` actor |
| `GET /servers/<uuid>/members` | `OrderedCollection` of member actor ids, 50 per page |
| `GET /servers/<uuid>/outbox` | `OrderedCollection` of `Create` activities from the channels the caller may read, 20 per page |
| `GET /servers/<uuid>/channels/<channel uuid>` | Channel object |
| `GET /servers/<uuid>/channels/<channel uuid>/messages` | `OrderedCollection` of the channel's messages as `Note`s, 50 per page; `/outbox` at the same place serves the same collection |
| `POST /servers/<uuid>/inbox` | Chat server inbox; on a copy of a remote server, its Group's relays (see [Group relay](#group-relay)) |
| `GET /threads/<uuid>` | `ChatThread` of a thread in a local server's channel; only with an ActivityPub `Accept`, else 406 |
| `GET /threads/<uuid>/members` | `OrderedCollection` of the thread's member actor ids, 50 per page |
| `GET /channels/<channel uuid>/threads` | `OrderedCollection` of the channel's threads as `ChatThread`s, 20 per page; a thread opened on another instance by id |
| `GET /api/federation/invites/<code>` | JSON preview of a server invite (see [Invites](#invites)) |
| `GET /oembed?url=<post or invite URL>` | oEmbed for posts and invites |
| `POST /api/livekit/federated-token` | LiveKit token for a federated direct-message call (see [Voice](#voice)) |

Except `featured`, collections requested without a page parameter answer with `totalItems` and `first`. Account collections page with `?cursor=start&limit=<n>` (default 20, at most 100) and link `next` by cursor. Post and server collections page with `?page=<n>`.

`GET /posts/<uuid>` of a post stored from another instance answers with a 302 redirect to its origin id. A deleted public post answers 410 with a `Tombstone`. Followers-only and direct posts, and anything the caller may not read, answer 404 like an unknown id.

## HTTP signatures

### Outbound

Every delivery and every ActivityPub `GET` Harmony makes is signed with draft-cavage HTTP Signatures:

- `algorithm="rsa-sha256"`, `keyId` the signing actor's key id.
- `headers="(request-target) host date"`, plus `digest` on a request with a body.
- `Digest: SHA-256=<base64 of the SHA-256 of the body>`.
- Deliveries are `POST` with `Content-Type: application/activity+json`.

Harmony does not send RFC 9421 signatures.

| Request | Signed by |
|---|---|
| Activities of an account: posts, follows, reactions, blocks, profile updates, `Move`, direct messages, its chat messages and threads, voice | The account |
| Activities whose `actor` is a chat server `Group` (`Accept` and `Reject` of a `Join`, channel `Add`, `Update` and `Remove`, `Update` of the Group, `Delete` of a channel message, the `Announce` relaying a member's activity) | The `Group`'s own key |
| `harmony:VoiceChannelJoinAccept` | The server owner, who is also its `actor` |
| `Flag` | The instance actor |
| `GET` on behalf of a member: a private server's Group, channels and members | That member |
| Any other `GET` (actors, keys, objects, collections, NodeInfo) | The instance actor |
| Deliveries of a deleted account (its actor `Delete`) | The account's retained key, under its original `keyId` |

Each redirect hop of a `GET` is signed again for its own target. A 401 or 403 to a signed `GET` is final; Harmony does not retry it unsigned.

### Inbound deliveries

The three inboxes require a valid signature. Unsigned or failing deliveries answer 401. `REQUIRE_VALID_SIGNATURES=false` turns the requirement off for development only; the backend refuses to start with it in production. `Flag`, `Move` and a Group relay (an `Announce` of an embedded activity) require a matching signature in every mode.

draft-cavage signatures:

- `date` must be among the signed headers, and `Date` within five minutes of the server clock. `(created)` is not supported.
- A request with a body must carry a `Digest` header, list it in the signed headers, and match the SHA-256 of the raw body.
- The signature is verified as RSA-SHA256 over the rebuilt signing string.

RFC 9421 signatures, used when a `Signature-Input` header is present:

- `alg` is `rsa-v1_5-sha256` or absent.
- The covered components include `@method` and the target: `@target-uri`, or `@authority` with `@request-target`, or `@authority` with `@path` and, for a URL with a query, `@query`.
- A body must be covered by `content-digest` (RFC 9530), which must match.
- `keyid` and `created` are required, `created` within five minutes, and `expires`, when present, not passed.
- Components with parameters (`;sf`, `;key`, `;bs`, `;req`, `@query-param`) are refused.

Key resolution: a `keyId` with a fragment names its owner, the part before `#`. Any other `keyId` is fetched. The document must be the actor itself, a key naming its `owner`, or an actor listing the `keyId` under `publicKey`, as GoToSocial's `<actor>/main-key` does. The owner must be on the key's host. Keys are cached for an hour; when verification fails, the key is fetched again once to cover key rotation.

The activity's `actor` must equal the key owner (scheme, host and path compared, trailing slash ignored), or the delivery answers 403. No same-domain delegation is accepted, on any inbox.

### Reads and access

`GET` requests may be signed. A signature that does not verify, a draft-cavage signature that does not cover `(request-target)`, or a signer on a blocked instance reads as anonymous.

| Resource | Served to |
|---|---|
| Actors, public and unlisted posts and their collections, account collections | Anyone |
| Followers-only and direct posts, and their collections | A verified signer whose instance has an account allowed to read the post |
| Direct and group direct messages (`/messages/<uuid>`) | A verified signer whose instance has a participant in the conversation |
| A public server, and the channels `@everyone` can view | Anyone |
| A private server, and channels `@everyone` cannot view | A verified signer who is an accepted member and can view the channel; the instance actor and Group actors are not members |
| A thread, its members, a channel's threads | As the thread's channel. Only threads this instance named are served at `/threads/<uuid>`. |

Anything else answers exactly as an unknown id does: 404, same body. A response that holds non-public content is sent with `Cache-Control: private, no-store`.

## Inboxes

Inbox bodies are limited to 1 MB, as `application/activity+json`, `application/ld+json` or `application/json`.

| Status | When |
|---|---|
| 202 | Accepted. Processing errors are not reported back. A redelivered activity id answers `Activity already processed`. |
| 202 `{"status": "ignored"}` | A personal inbox received an activity not addressed to its account |
| 400 | No `type` or `actor`, or an `actor` that is not a URL |
| 401 | Missing or failing signature |
| 403 | `actor` differs from the key owner; on the shared and personal inboxes, also a blocked instance (a chat server inbox drops those with 202) |
| 404 | Personal inbox of an unknown account |
| 429 | More than 120 deliveries a minute from one IP, or more than 60 a minute from one signing instance |
| 500 | The activity could not be stored, for example a type outside the list below |

Every activity is stored before processing. On the shared and personal inboxes its type must be one of `Create`, `Update`, `Delete`, `Follow`, `Accept`, `Reject`, `Undo`, `Like`, `EmojiReact`, `EmojiReaction`, `Announce`, `Add`, `Remove`, `Invite`, `Join`, `Leave`, `Block`, `Flag`, `Move`, `Tombstone`, `QuoteRequest`, or one of the `harmony:Voice*` types. Activities from suspended accounts are dropped.

A personal inbox accepts `Like`, `EmojiReact`, `EmojiReaction`, `Undo`, `Accept`, `Reject`, `Follow`, `Flag`, `Move`, `Block` and `QuoteRequest` without addressing. Any other type must name the account in `to` or `cc`, be addressed to Public, carry a `Mention` of the account, or be addressed to the sender's followers collection while the account follows the sender. GoToSocial delivers followers-only posts that way.

### Delivery

Harmony delivers to a follower's shared inbox when it has one, else to the personal inbox. A direct message goes to the personal inbox first. Chat activities go to the shared inbox of each member instance; the Group's relays go to each member instance's copy of the server, `/servers/<uuid>/inbox`. A delivery is attempted at once, then retried after 5, 10, 20 and 40 minutes, five attempts in all. A 4xx answer other than 401, 408 and 429 ends the retries. Blocked instances and endpoints marked dead receive nothing.

## Activities sent

Social activities:

| Activity | Object | Sent when | To |
|---|---|---|---|
| `Create` | `Note` | A post is published | Followers (except direct posts), mentioned accounts; for a public or unlisted post also the remote author it replies to or quotes |
| `Update` | `Note` | A post is edited, or a quote is approved | As `Create` |
| `Delete` | `Tombstone` naming the post | A post is deleted | Followers and mentioned accounts, for every visibility |
| `Announce` / `Undo` | Post id / the `Announce` | A boost is made or removed | Followers and the original author |
| `Like` | Post id | A favourite; for Misskey-family receivers also a reaction, with `_misskey_reaction` | The post's author when remote, and the shared inboxes of the author's remote followers |
| `EmojiReact` | Post id | An emoji reaction, to software outside the Mastodon and Misskey families | As `Like` |
| `Undo` | The `Like` or `EmojiReact`, same id | A favourite or reaction is removed | As `Like` |
| `Follow` / `Undo` | Account | A follow is made or withdrawn | Followed account |
| `Accept` / `Reject` | The received `Follow` | A follow is accepted or declined | Follower |
| `Block` / `Undo` | Account | A block is made or lifted | Blocked account |
| `Add` / `Remove` | Post id, `target` the `featured` collection | A post is pinned or unpinned | Followers |
| `Update` | `Person` | The profile changes | Followers and instances that share a chat server with the account |
| `Delete` | The actor id | The account is deleted | Inboxes recorded at deletion |
| `Move` | The actor id, `target` the new account | The account moves | Remote followers' inboxes and instances that share a chat server with the account |
| `QuoteRequest` | Quoted post id, `instrument` the quoting `Note` | A post quotes another account's remote post | Quoted author |
| `Accept` / `Reject` | The received `QuoteRequest` | Answer to a quote request; an `Accept` has `result`, the `QuoteAuthorization` id | Requester |
| `Flag` | `[account, post...]`, `content` the comment | A local report is forwarded | The account's instance, shared inbox preferred |
| `Create` | `Note`, `directMessage: true` | A direct message | Each remote participant |
| `Create` | `Note` with `metadata.type: "group_invite"` | A remote account is added to a group direct message | That account |
| `Update` / `Remove` | Group conversation | A group direct message is renamed or its icon changes / a participant leaves | Remote participants |
| `Like` / `Undo` | Message id | A reaction on a direct message | Remote participants |

Chat-server activities:

| Activity | `actor` | Object | Sent when | To |
|---|---|---|---|---|
| `Join` | Account | Group id; `harmony:inviteCode` on the activity for a private server | An account joins a remote server | Group inbox |
| `Leave` | Account | Group id | An account leaves a remote server | Group inbox |
| `Accept` / `Reject` | Group | The received `Join`; a `Reject` has a `summary` reason | Host answers a `Join` | Joining account |
| `Create` / `Update` | Message author | Channel message `Note` | A message is sent or edited | Host: each instance with a member who can view the channel. Member: the Group inbox |
| `Delete` | `https://<sending domain>/servers/<uuid>` | Message id | A message is deleted | As `Create` |
| `Like` / `Undo` | Reactor | Message id | A reaction is added or removed | Host: each instance with a member who can view the channel. Member: the Group inbox |
| `Announce` | Group | A member's `Create`, `Update` or `Delete` of a message, a reaction, or the `Undo` of one, embedded unchanged | The host accepted it on the Group inbox | Each other member instance with a member who can view the channel, at its copy's inbox |
| `Create` / `Update` / `Delete` | Thread creator | `ChatThread` | A thread is created, changed or deleted | As channel messages |
| `Add` / `Update` / `Remove` | Group | `harmony:TextChannel`, `harmony:VoiceChannel`, `harmony:Category` | A channel or category is created, changed or removed | Member instances |
| `Update` | Group | `Group` | The server's name, description, icon or banner changes | Member instances |
| `harmony:VoiceChannelJoin` / `harmony:VoiceChannelLeave` | Account | `harmony:VoiceChannel` | An account joins or leaves a remote voice channel | Group inbox |
| `harmony:VoiceChannelJoinAccept` | Server owner | The `Join` id; `result` a `harmony:VoiceToken` | Host admits a voice join | The joining account's host, once, not retried |
| `harmony:VoiceCallInvite` / `Accept` / `Reject` / `End` | Account | `harmony:VoiceCall`, or the invite id | A direct-message call | The other party |

### Group relay

What a member on one instance does in a channel reaches the members on other instances as the Group's `Announce` of it, as in FEP-1b12:

```json
{
  "id": "https://chat.example.com/servers/<server>/relays/<id>",
  "type": "Announce",
  "actor": "https://chat.example.com/servers/<server>",
  "object": { "type": "Create", "actor": "https://other.example/users/bob", "object": { "type": "Note", "...": "..." } },
  "to": ["<the receiving instance's members>"],
  "cc": ["https://chat.example.com/servers/<server>/members"]
}
```

The host relays the `Create`, `Update` and `Delete` of a channel message, reactions and the `Undo` of a reaction, once it has accepted them on the Group inbox. The `Announce` is signed with the Group's key and sent to the copy of the server on each other instance with a member who can view the channel, at `https://<instance>/servers/<uuid>/inbox`; never to the sender's instance, and not to an instance known to run software other than Harmony. Its id derives from the inner activity's, so a redelivery is the same activity.

A receiver takes the relay from the Group of a server it copies, signed with that Group's key, and applies the inner activity without checking channel permissions again, which its copy holds incompletely. It refuses:

- an inner actor that is the Group, on the receiving instance, on a blocked instance, or suspended there;
- an inner actor that is not a member: neither an accepted member of the copy nor listed by the Group's `members` collection, which is read signed as a local member and then recorded in the copy. A ban on the copy refuses;
- a `Note` whose `harmony:serverId` is another server, whose `context` is not a channel of the Group, whose id is not on its author's host, or attributed to another actor;
- an edit, delete, reaction or `Undo` naming no message in the server's channels; an edit or `Undo` of another actor's message or reaction.

The inner object is not fetched from its origin: an instance serves a channel message only under its host's read rules. Harmony before 1.8.4 ignores activities on a copy's inbox.

## Activities accepted

Shared and personal inboxes:

| Activity | Object | Effect |
|---|---|---|
| `Follow` | Local account | Follow; `Accept` sent at once, or held as a request for a locked account. A follower the account blocks gets `Reject`. A repeat from an accepted follower is accepted again. |
| `Accept` | `Follow` (embedded or by id) | Follow accepted. Must come from the followed account. |
| `Accept` | `QuoteRequest` | Quote approved; `result` must be on the responder's host. The quote is sent again as `Update` with `quoteAuthorization`. |
| `Accept` | `Join` | Pending membership of a remote server accepted; the server is synced as the member |
| `Reject` | `Follow`, `QuoteRequest`, `Join` | Follow removed, quote marked refused, pending membership removed |
| `Create` | `Note`, `Article` | A post (public, unlisted, followers-only). A direct `Note` becomes a direct message; with several local recipients or `harmony:conversationType: "group"`, a group conversation. A `Note` with `harmony:serverId` is a channel message. The object id must be on the actor's host. |
| `Create` | `Question` | A post with a read-only poll (`oneOf` or `anyOf`, `votersCount`, `endTime`, `closed`) |
| `Create` | `ChatThread` | A thread in a channel of a server this instance mirrors |
| `Update` | `Person`, `Service`, `Application`, `Organization` | Profile refreshed. The signer must be the actor. |
| `Update` | `Note`, `Article`, `Question` | Post edited or poll counts refreshed, by its author only. A `Note` with `harmony:serverId` edits a channel message of a mirrored server, by its author on the server's host. |
| `Update` | `Group`, channel types, `ChatThread`, group conversation | Mirrored server, channel, thread or group conversation updated |
| `Delete` | Post or message id, or a `ChatThread` | Soft-deleted, by its author. A channel message of a mirrored server is also deleted by that server's `Group`. A `Delete` of an actor removes nothing. |
| `Like`, `EmojiReact`, `EmojiReaction` | Post or message | A `Like` with no emoji or a heart (❤, ♥) is a favourite. A `Like` with `_misskey_reaction` or `content`, and an `EmojiReact`, is a reaction and implies the favourite. |
| `Announce` | Post | Boost; the original is fetched when unknown |
| `Announce` | An embedded channel activity, from the `Group` of a mirrored server | See [Group relay](#group-relay) |
| `Undo` | `Like`, `EmojiReact`, `EmojiReaction`, `Follow`, `Announce`, `Block`, embedded or by id | Reverted. The undone activity's actor must be the signer. |
| `Add` / `Remove` | Post, `target` a `featured` collection | Pin or unpin, by the post's author |
| `Add` / `Remove` | Channel types, `target` a Group | Channel or category of a mirrored server added or removed |
| `Remove` | Account, `target` a group conversation | Participant removed |
| `Flag` | Local accounts and posts | A report owned by the sending domain, one per local account named. A Flag naming only posts is filed against their authors. At most 30 reports an hour per domain; a redelivered id is ignored. |
| `Block` | Local account | Block recorded; follows in both directions removed |
| `Move` | The actor, `target` the new account | Followers move (see [Account moves](#account-moves)) |
| `QuoteRequest` | Local post id, `instrument` the quoting post | `Accept` with a `QuoteAuthorization`, or `Reject` (see [Quote posts](#quote-posts)) |
| `harmony:VoiceCall*`, `harmony:VoiceChannelJoinAccept`, `harmony:VoiceChannelJoinReject` | | See [Voice](#voice) |

A chat server inbox (`/servers/<uuid>/inbox`) accepts:

| Activity | Effect |
|---|---|
| `Join` | Membership. A private server requires `harmony:inviteCode`, checked for expiry, use count and revocation and spent on success. Refused for suspended and banned accounts and accounts that moved from a banned one. Answered with `Accept` or `Reject`. |
| `Leave` | Membership removed. Accepted even with federation off for the server. |
| `Create` | A `Note` with `context` a channel URL of the server, or a `ChatThread`. The author must be an accepted, unbanned member with **Send Messages** in the channel, or **Send Messages in Threads** for a thread message and **Create Public Threads** or **Create Private Threads** for a new thread. |
| `Update` | Message edit by its author; thread changes by the thread's rules; channel, category or server changes by a member with **Manage Channels** |
| `Delete` | Message deleted by its author or by a member with **Manage Messages** |
| `Like`, `EmojiReact`, `EmojiReaction` | Reaction, by a member with **Add Reactions** |
| `Add`, `Remove` | Channel or category, by a member with **Manage Channels**. `Remove` of a member: by the member themself, the host, or a member with **Kick Members** whose highest role is above the target's. |
| `Undo` | Of a `Join` (leave) or a reaction |
| `harmony:VoiceChannelJoin`, `harmony:VoiceChannelLeave` | See [Voice](#voice) |

With federation off for the server, everything except `Leave` is dropped, and a `Join` is answered with `Reject`. `Accept` and `Reject` sent to a server inbox are ignored. Accepted messages, edits, deletions, reactions and their removals are relayed to the other member instances (see [Group relay](#group-relay)). The inbox of a remote server's copy takes only that server's Group's relays.

## Objects

### Note (post)

The `@context` is `https://www.w3.org/ns/activitystreams` plus Mastodon's status terms, FEP-044f and GoToSocial's interaction-policy vocabulary:

```json
{
  "sensitive": "as:sensitive",
  "Hashtag": "as:Hashtag",
  "toot": "http://joinmastodon.org/ns#",
  "Emoji": "toot:Emoji",
  "blurhash": "toot:blurhash",
  "quote": { "@id": "https://w3id.org/fep/044f#quote", "@type": "@id" },
  "quoteAuthorization": { "@id": "https://w3id.org/fep/044f#quoteAuthorization", "@type": "@id" },
  "quoteUrl": "as:quoteUrl",
  "quoteUri": "http://fedibird.com/ns#quoteUri",
  "misskey": "https://misskey-hub.net/ns#",
  "_misskey_quote": "misskey:_misskey_quote",
  "gts": "https://gotosocial.org/ns#",
  "interactionPolicy": { "@id": "gts:interactionPolicy", "@type": "@id" },
  "canQuote": { "@id": "gts:canQuote", "@type": "@id" },
  "automaticApproval": { "@id": "gts:automaticApproval", "@type": "@id" },
  "manualApproval": { "@id": "gts:manualApproval", "@type": "@id" }
}
```

With a focal point on an attachment, the context also maps `focalPoint` to `toot:focalPoint` as a list.

| Property | Value |
|---|---|
| `id` | `https://<domain>/posts/<uuid>` |
| `url` | `https://<domain>/social/post/<uuid>`, the post's page |
| `attributedTo` | Author's actor id |
| `content` | HTML: `<p>` paragraphs, `<br>` line breaks, mentions as Mastodon h-cards (`<span class="h-card"><a class="u-url mention">`), hashtags linked to `/social/hashtag/<name>`, custom emoji as `:shortcode:`, links with `rel="nofollow noopener noreferrer"` |
| `contentMap` | `{ "<language>": content }` when the post has a language |
| `summary`, `sensitive` | Content warning; sensitive flag (always present) |
| `published`, `updated` | Creation time; last edit time on an edited post |
| `to`, `cc` | See below |
| `inReplyTo` | The parent's ActivityPub id |
| `tag` | `Mention` (`href` the stored actor id, `name` the handle), `Hashtag`, `Emoji` |
| `attachment` | `Document` with `mediaType`, `url`, `name` (alt text, never the file name), `blurhash`, `focalPoint` |
| `likes`, `shares` | Collection with `totalItems` when the count is known, else its URL |
| `replies` | `/posts/<uuid>/replies` |
| `interactionPolicy` | `{ "canQuote": { "automaticApproval": [...] } }`: Public for public and unlisted posts, the author's followers collection for followers-only posts, the author alone for direct posts |
| `quote`, `quoteUrl`, `quoteUri`, `_misskey_quote` | The quoted post's id, on a quote |
| `quoteAuthorization` | The stamp approving the quote, once there is one |

A quote's `content` ends with `<p class="quote-inline">RE: <a href="...">...</a></p>` for software that does not show quotes.

| Visibility | `to` | `cc` |
|---|---|---|
| Public | Public | Followers, mentioned accounts |
| Unlisted | Followers | Public, mentioned accounts |
| Followers only | Followers | Mentioned accounts |
| Direct | Mentioned accounts | None |

Inbound, visibility is read the same way: Public in `to` is public, Public in `cc` is unlisted, a followers collection without Public is followers-only, and anything else addressed is direct. Quotes are read from `quote`, then `quoteUrl`, `quoteUri` and `_misskey_quote`, and the `quote-inline` element is dropped from the content.

### Channel message Note

```json
{
  "id": "https://chat.example.com/servers/<server>/activities/<message>",
  "type": "Create",
  "actor": "https://chat.example.com/users/alice",
  "to": ["<actor ids of the receiving instance's members>"],
  "object": {
    "type": "Note",
    "id": "https://chat.example.com/messages/<message>",
    "attributedTo": "https://chat.example.com/users/alice",
    "content": "<p>Hello</p>",
    "harmony:rawContent": [{ "type": "text", "text": "Hello" }],
    "context": "https://chat.example.com/servers/<server>/channels/<channel>",
    "harmony:channelName": "general",
    "harmony:channelType": "text",
    "harmony:serverId": "<server>",
    "harmony:serverName": "Example"
  }
}
```

`context` is the channel URL. Receivers match it against the channel's id, then by the channel UUID in its path; a member instance writes the URL with its own domain. Optional fields: `inReplyTo` (the replied-to message id), `updated`, `tag`, `attachment`, `harmony:threadId`, `harmony:parentMessageId`, `harmony:encrypted` and `harmony:voiceMessage`. Attachment URLs are capability links issued for the receiving instance:

```text
https://<domain>/api/federation/media/<path>?to=<receiving domain>&sig=<HMAC>
```

A link answers while that instance still receives the channel, with a redirect to a short-lived storage URL. Fetching it needs no signature.

### Direct message Note

A direct message is a `Create` of a `Note` with `id` `https://<domain>/messages/<uuid>`, `to` every participant, `directMessage: true`, `conversation` a `tag:` URI shared by the conversation, and `contentMap`. A group conversation adds `harmony:conversationType: "group"`, `harmony:conversationId` and `inReplyTo` the previous message, and lists local participants in `to` so the receiver can count the group.

### ChatThread

`type: "ChatThread"`, `id` `https://<domain>/threads/<uuid>`, `name`, `context` (channel id), `inReplyTo` (parent message id), `attributedTo`, `published`, `updated`, `archived`, `locked`, `autoArchiveDuration` (minutes), `messageCount`, `memberCount`, `lastMessageAt`, and `harmony:serverId`, `harmony:channelName`, `harmony:channelId`, `harmony:standalone` (a thread started without a parent message).

### QuoteAuthorization

```json
{
  "type": "QuoteAuthorization",
  "id": "https://chat.example.com/users/alice/quote_authorizations/<uuid>",
  "attributedTo": "https://chat.example.com/users/alice",
  "interactingObject": "<the quoting post>",
  "interactionTarget": "https://chat.example.com/posts/<uuid>"
}
```

## Quote posts

Harmony implements FEP-044f in both directions.

- **Quoted side.** A `QuoteRequest` names the quoted post as `object` and the quoting post as `instrument`. When `instrument` is embedded, its `attributedTo` must be the request's actor. The answer comes from the quoted post's author and is automatic, by the `canQuote` policy. Public and unlisted posts: anyone. Followers-only: accepted followers. Direct: nobody but the author. An account the author blocks: never. An `Accept` embeds the request and carries `result`, the stamp URL; a `Reject` embeds the request.
- **Quoting side.** A quote of another account's remote post is sent as a `Create`, followed by a `QuoteRequest` with id `<note id>#quote-request` to the quoted author's inbox. An `Accept` whose `result` is on the responder's host is stored, and the quote is sent again as `Update` with `quoteAuthorization`. A quote of a local post by another account carries a stamp issued locally. A self-quote carries none.

## Account moves

Harmony sends `Move` in the shape Mastodon sends it: `{ "type": "Move", "id": "<actor>#moves/<uuid>", "actor": "<actor>", "object": "<actor>", "target": "<new actor>" }`. The moved actor carries `movedTo`, and the new actor lists the old one in `alsoKnownAs`.

An inbound `Move` is accepted when all of these hold:

- It is signed by its `actor`, and `object` equals `actor`.
- The `target` is fetched fresh, lists the actor in `alsoKnownAs`, has no `movedTo` of its own, is not suspended, and is not on a blocked instance.
- The actor has not moved to a different target within the last 30 days.

Local followers of the old account then follow the target. A chat server host carries a member's membership, roles and nickname over when the new account joins, and refuses the `Join` if the old account is banned.

## Invites

A private chat server is joined by invite. Harmony resolves an invite link `https://<host>/invite/<code>` by fetching `https://<host>/api/federation/invites/<code>`. Unknown codes answer 404; expired, used-up or revoked codes answer 410.

```json
{
  "code": "abc123",
  "expiresAt": null,
  "maxUses": 0,
  "uses": 3,
  "instanceRules": [],
  "createdBy": { "username": "alice", "displayName": "Alice", "avatar": "https://..." },
  "server": {
    "id": "https://chat.example.com/servers/<uuid>",
    "serverId": "<uuid>",
    "name": "Example",
    "description": "",
    "icon": null,
    "banner": null,
    "memberCount": 42,
    "rules": [],
    "channels": [
      { "id": "https://chat.example.com/servers/<uuid>/channels/<channel>", "localId": "<channel>", "name": "general", "type": "text", "category": null, "categoryId": null, "order": 0, "description": null }
    ],
    "inbox": "https://chat.example.com/servers/<uuid>/inbox"
  }
}
```

The preview lists only what `@everyone` can view. Before showing it, the resolving instance fetches `server.id` and requires a `Group` on the same host as the invite, with its inbox on that host. The `Join` then carries `harmony:inviteCode`, and the host checks the code again.

## Voice

Voice media goes through LiveKit, not ActivityPub; the activities exchange tokens.

**Voice channels.** A member's instance sends `harmony:VoiceChannelJoin` to the Group inbox with a join id it minted. The host checks membership and channel permissions and answers with `harmony:VoiceChannelJoinAccept`: `actor` the server owner, `object` the join id, `result` a `harmony:VoiceToken` (`livekitUrl`, `token`, `roomName`, `expiresAt`, four hours ahead). Otherwise it answers `harmony:VoiceChannelJoinReject`. The answer is delivered once, to an inbox on the joining actor's host, and only the instance the join was sent to can answer it.

**Direct-message calls.** The caller's LiveKit hosts the room `federated-dm-<conversation uuid>-<milliseconds>`.

1. The caller's instance delivers `harmony:VoiceCallInvite` with a `harmony:VoiceCall` object (`callType` `voice` or `video`, `conversationId`, `livekitUrl`, `roomName`). It rings for 60 seconds.
2. The callee's instance rings its account only for a conversation it shares with the caller, with no block either way.
3. On accept, the callee's instance sends `POST /api/livekit/federated-token` to the caller's origin with `{ "actorId": "<callee>", "roomName": "<room>", "roomType": "dm_call" }`, signed with the callee's key. The caller's instance grants a token when `actorId` is the signer, the signer is the recipient of a live call for that room, and the signer is in the conversation. The answer is `{ "token", "wsUrl", "roomName", "identity" }`.
4. The callee's instance delivers `harmony:VoiceCallAccept`. `harmony:VoiceCallReject` and `harmony:VoiceCallAccept` are accepted only from the call's remote recipient, `harmony:VoiceCallEnd` only from the other party.

With `ALLOW_FEDERATED_VOICE=false`, an instance ignores call invites and refuses federated call tokens.

## Extension properties

Harmony uses four namespaces. None is served as a JSON-LD document by Harmony, and Harmony reads its extension properties by their compact `harmony:` names, not by JSON-LD expansion.

| Namespace | Used in |
|---|---|
| `https://har.mony.lol/ns#` (prefix `harmony`) | `Person` actors |
| `https://harmonyapp.dev/ns#` (prefix `harmony`) | Group actors, channels, channel messages, threads, `Join`, server-originated activities |
| `https://harmony.social/ns/voice` (a context URL) | Voice activities |
| `https://harmony.social/ns/extensions` (a context URL) | Group conversation `Update` and `Remove` |

| Property or type | On | Value |
|---|---|---|
| `harmony:profileColor` | `Person` | Accent colour as a CSS hex string |
| `harmony:customStatus` | `Person` | Custom status: `text`, `emoji`, `emoji_url` (absolute), `expires_at` |
| `harmony:type` | `Group` | `"ChatServer"` for a chat server, `"harmony:GroupConversation"` for a group conversation object |
| `harmony:ChatServer` | `Group` in an `Update` | `true` |
| `harmony:memberCount` | `Group` | Accepted members |
| `harmony:channels` | `Group` | Channel and category entries |
| `harmony:TextChannel`, `harmony:VoiceChannel`, `harmony:Category` | Channel entries, `Add`/`Update`/`Remove` objects | Channel and category types |
| `harmony:inviteCode` | `Join` | Invite code for a private server |
| `harmony:rawContent` | Channel message `Note` | The message as Harmony message parts (text, mentions, emoji, hashtags, links, files). Receivers re-derive mention locality, drop file storage paths and drop poll parts. Without it, `content` is used. |
| `harmony:channelName`, `harmony:channelType` | Channel message `Note` | Channel name; `"text"` |
| `harmony:serverId`, `harmony:serverName` | Channel message `Note`, `ChatThread` | The host's server UUID; server name |
| `harmony:threadId`, `harmony:parentMessageId` | Channel message `Note` | The thread's id and the thread's parent message id, for a message in a thread |
| `harmony:encrypted` | Channel message and direct message `Note` | `true` for end-to-end encrypted content, which receivers cannot decrypt |
| `harmony:voiceMessage` | Channel message `Note` | `{ duration, waveform }` of a voice message |
| `harmony:conversationType`, `harmony:conversationId` | Direct message `Note`, group conversation object | `"group"`; the sender's conversation UUID |
| `harmony:updateType` | Group conversation `Update` | `name`, `icon` or `icon_removed` |
| `ChatThread` (`harmony:ChatThread`) | Thread object | A thread; `autoArchiveDuration`, `messageCount`, `memberCount`, `lastMessageAt` map to `harmony:` terms |
| `harmony:channelId`, `harmony:standalone` | `ChatThread` | Channel UUID; `true` for a thread without a parent message |
| `harmony:VoiceCallInvite`, `harmony:VoiceCallAccept`, `harmony:VoiceCallReject`, `harmony:VoiceCallEnd` | Activity types | Direct-message calls |
| `harmony:VoiceChannelJoin`, `harmony:VoiceChannelLeave`, `harmony:VoiceChannelJoinAccept`, `harmony:VoiceChannelJoinReject` | Activity types | Voice channels |
| `harmony:VoiceCall`, `harmony:VoiceChannel`, `harmony:VoiceToken` | Voice objects | Call, channel and token objects |

Harmony also writes and reads terms from other software: Mastodon's `Emoji`, `blurhash`, `focalPoint`, `sensitive`, `alsoKnownAs` and `movedTo`; Misskey's `_misskey_reaction`, `_misskey_quote` and the `emojis` map; Fedibird's `quoteUri`; litepub's `EmojiReact`; GoToSocial's `interactionPolicy`, `interactingObject` and `interactionTarget`; and `directMessage` on direct messages.

## FEPs

| FEP | Use |
|---|---|
| [FEP-044f](https://codeberg.org/fediverse/fep/src/branch/main/fep/044f/fep-044f.md) | Quote posts and quote approvals, sent and received: `quote`, `quoteAuthorization`, `QuoteRequest`, `QuoteAuthorization`, `interactionPolicy.canQuote` |
| [FEP-c0e0](https://codeberg.org/fediverse/fep/src/branch/main/fep/c0e0/fep-c0e0.md) | Emoji reactions as `EmojiReact`, sent to software outside the Mastodon and Misskey families and received from any |
| [FEP-2c59](https://codeberg.org/fediverse/fep/src/branch/main/fep/2c59/fep-2c59.md) | Received only: a remote actor's `webfinger` property starts the check that confirms its canonical handle. Harmony's own actors do not publish it. |
