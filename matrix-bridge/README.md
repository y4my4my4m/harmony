# Experimental Matrix bridge

A self-run **Matrix application service with ghost and relay sender modes**, not full Matrix support
in the Harmony client. Existing Discord bridge behavior is unchanged.

**Use dedicated test rooms/channels with consenting participants.** Explicit source
allowlists remain mandatory. Harmony member-controlled relay consent is checked at
queued delivery, in addition to the allowlist. Matrix-to-Harmony messages use native
generalized author metadata. Encrypted participant support and in-client Matrix
bridge setup are not implemented.

## What works

- Multiple one-to-one Matrix room / Harmony channel pairs, either or both directions.
- Native Matrix author attribution in Harmony, with unprefixed plaintext bodies.
- Administrator-controlled Matrix sender mode: dedicated per-Harmony-user ghosts with
  unprefixed text, or one AS relay sender with a Harmony author prefix.
- Eligible, explicitly allowlisted members synchronized before first speech for mention
  autocomplete; per-room ghost nicknames and safely mirrored avatars.
- Real user mentions in both directions, plus an exact-username relay command.
- Matrix rich replies linked to their original Harmony message when its mapping is known
  and still readable; missing/private parents fall back to the new reply text alone.
- Images and ordinary files copied in both directions into the destination's own storage,
  including file-only messages and captions; audio/video travel as files, without transcoding.
- Room-specific Matrix member names, fetched with the AS token, never event-supplied profiles.
- Optional Matrix avatars via authenticated HS thumbnails and authorized Harmony storage upload.
- Matrix application-service authentication and durable transaction acceptance.
- SQLite inbox/outbox, event deduplication, message mappings and bounded retry backoff.
- Matrix outbound transaction IDs stable across retries/restarts.
- Per-attempt checks of both sides' encryption policy; unknown state fails closed.
- Durable Matrix encryption-event fences, including events received during a preflight.
- Explicit sender allowlists, rechecked before queued delivery.
- Registered Matrix bridge/channel binding required at startup and every delivery.
- Harmony per-member consent revalidated on every send attempt, including retries;
  missing/unknown consent never allows delivery.
- No forwarding of Harmony bots, external bridge messages, system notices or threads.
- Health endpoint without message contents or credentials.

Not implemented: Harmony-to-Matrix reply context, edits, deletions, reactions,
presence, account linking, history migration, shared instance hosting or encrypted rooms/media.
Matrix thread relations and edits are ignored. Ordinary Matrix replies are accepted;
legacy plain/HTML reply quotes are stripped before forwarding or interpreting mentions.
Harmony text, user mention parts and supported file parts are forwarded. No room/mass
mentions are enabled by default.

## Attachments

- Matrix `m.image`, `m.file`, `m.audio` and `m.video` messages become native Harmony file
  parts, with captions when Matrix supplies a separate `filename`. A Matrix media reply
  keeps the same readable-parent rules as a text reply. Old reply quotes are not captions.
- Harmony text/mentions are sent first, then one Matrix event per attachment. File-only
  ghost messages need no extra text; shared relay mode adds the Harmony author attribution.
  Every acknowledged Matrix piece maps back to the original Harmony message for replies.
- Transfers are capped at **50 MiB per file**, or a lower live Harmony private-bucket size
  limit/destination upload limit. At most **20 files per Harmony message** are copied;
  extra files get a visible notice. Each binary HTTP transfer has a 60-second client timeout.
  Files are processed serially in bounded memory, not streamed end-to-end or transcoded.
- Matrix downloads use the authenticated media endpoint on the configured homeserver,
  never an arbitrary event URL. Harmony downloads use the currently readable stored message's
  raw file-part index: room-local private `message_media` objects, or a live Drive file still
  owned by that native author. URL-only/legacy/external attachment parts are not fetched.
- Matrix bytes go through the Gateway's live private-bucket MIME/size policy, file-type and
  signature checks, standard media-metadata stripping and content-addressed private storage.
  Harmony bytes are also metadata-stripped before Matrix upload. This is not a malware
  scanner: ordinary documents/archives can still contain unsafe content. Active formats such
  as SVG, HTML, scripts and executables, unknown MIME types and mismatched image bytes are
  refused. Other formats' metadata is not guaranteed to be removable.
- Unsupported, oversized, missing or permanently failed copies produce an explicit
  `[Attachment unavailable: filename]` notice, retaining accompanying text. Transient media
  failures retry with bounded backoff before falling back. Consent, binding, sender mode and
  both encryption policies are rechecked before upload/send; a policy refusal blocks delivery,
  rather than turning revoked material into a notice. Encrypted media descriptors in a
  plaintext room get a notice without downloading ciphertext or keys; encrypted rooms stay blocked.
- Queued attachment descriptors hold bounded references, not media bytes or signed download URLs. Matrix
  piece transaction IDs and senders are stable across retries. Repeated Matrix uploads may
  leave unreferenced media; interrupted/revoked transfers may also leave private Harmony
  uploads or Matrix uploads that were never posted. No media-specific orphan sweeper is added.
  Consent cannot atomically cancel a network request already in flight, and it does not erase
  previously copied files or historical messages. Normal platform retention/storage rules apply.

Encrypted room and encrypted-media support is follow-up work in [`ROADMAP.md`](../ROADMAP.md):
real participant crypto, safe device/key persistence and recovery, media verification, and
explicit consent for the plaintext trust boundary. Do not disable encryption to bridge a room.

## Bridge ecosystem parity

The creator's [Harmony Discord bridge](https://github.com/y4my4my4m/harmony-discord-bridge)
is the feature/UX reference (reviewed at `fd8801e`). Prefer the same Harmony message,
identity, privacy and settings contracts where semantics match, not a fork of the
Discord runtime or a platform-neutral framework built before another bridge needs it.

| Area | Matrix status / remaining parity work |
|---|---|
| Authors, members, user mentions | Native generalized authors, ghosts/shared relay, read-only external profiles and explicit user mentions work. No inferred native roles or account linking. |
| Attachments | Destination-owned copies, captions, multiple files and visible failures work. Discord's configurable aggregate budget, resized images and link fallback are not identical to Matrix's per-file cap/private-copy policy. Never leak signed URLs just to match a fallback. |
| Replies | Matrix → Harmony works, including every acknowledged outbound attachment piece. Harmony → Matrix context remains open. |
| Message lifecycle | Edits, deletes/redactions and reactions remain open; preserve current permissions, consent, moderation and durable mappings when adding them. |
| Threads, emoji and formatting | Threads, custom emoji/sticker fidelity, richer formatting and channel references remain open. Do not treat Matrix thread relations as ordinary replies. |
| Setup and operations | Per-pair manager mode and health work. Guided installation/pairing, hosting choices, richer diagnostics and hot pair configuration remain open. Matrix AS registration still needs the homeserver operator. |
| Presence and permissions | Presence and structure/role synchronization need separate product/security decisions. Matrix power levels must not automatically grant Harmony rights. |
| Encryption | Separately scoped follow-up; Discord text channels are not a template for Matrix device/session/media crypto. Current plaintext fences stay in force. |

Near-term parity priorities are outbound reply context, permission-aware message lifecycle
and reactions, and clearer setup/diagnostics; threads are their own feature. Keep SQLite
acceptance, frozen senders, explicit allowlists and live consent rather than copying weaker
loss/retry behavior for superficial parity. This table records gaps, not a claim that they ship.

## Requirements

- Node.js 24 recommended (minimum 22.13; Node 22 may print an SQLite experimental warning).
- A Harmony instance with the generalized-author/bridge-consent DB migrations applied
  and the matching Gateway endpoints described below. Older/unregistered bots fail
  clearly at startup, rather than silently posting anonymous or spoofed authors.
- A dedicated Harmony bot installed with **Read messages** and **Send messages** only
  in explicitly scoped dedicated channels, then operator-registered with
  `configure_matrix_bridge(p_bot_id, p_server_id, p_channel_ids uuid[])`. An authorized
  server manager runs this RPC; it sets `bot_type = 'bridge'`, platform `matrix`, and
  replaces that server's channel bindings. The relay does not register itself in the DB.
  Do not grant the bot Manage Server, roles or messages.
- A Matrix homeserver whose administrator can register an application service.
  A public Matrix account without homeserver administration is useful as a test user,
  but is not sufficient to host this application service.
- A reachable callback address from the homeserver to the relay. The relay needs
  outbound access to that homeserver and the Harmony gateway.

**Pre-merge test deployments:** the three bridge migrations were renumbered from
`20261109100001`–`20261109100003` to `20261111100001`–`20261111100003` to follow upstream
without version collisions. If you applied the old versions, do not blindly replay the
renamed files: reconcile the existing bridge objects, migration history and intervening
upstream migrations first. No automatic upgrade or database reset is performed.

The Matrix bridge reserves a dedicated AS sender such as `@harmony_relay:example.org`
and a dedicated ghost namespace. It never impersonates existing Matrix users. In
`relay` mode Harmony messages arrive through the AS sender with the Harmony author's
name in the text. In `ghost` mode they arrive unprefixed from a stable per-Harmony-UUID
Matrix account, with that room's nickname/avatar. Matrix messages arrive
through the Harmony bot with an **unprefixed** body and
`metadata.bridge_author = { platform: "matrix", id: "@full:mxid", username: "full", display_name?, avatar_url? }`.
`username` is the bounded Matrix localpart; the full MXID is the stable identity. Names are
bounded to 100 characters, IDs to 255, avatar references/URLs to 2048. Missing or
invalid optional fields are omitted; inaccessible/non-joined member state prevents
sending (transient fetch failures retry). Event-supplied author/profile metadata is ignored.

## Local setup

From this directory:

```sh
npm ci
cp config.example.json config.json
cp .env.example .env
chmod 600 config.json .env
```

Populate `config.json`:

- `harmony.apiUrl`: gateway base, e.g. `https://chat.example.org/bot-gateway`.
- `harmony.gatewayUrl`: e.g. `wss://chat.example.org/bot-gateway/gateway`.
- `harmony.allowedUserIds`: Harmony profile UUIDs eligible for relay, additionally
  subject to their current native bridge-consent setting.
- `matrix.homeserverUrl`: actual client API URL, which may differ from the user-ID domain.
- `matrix.serverName`: the server name in Matrix user IDs (e.g. `example.org`).
- `matrix.applicationServiceUrl`: callback URL reachable **from the homeserver**.
- `matrix.allowedUserIds`: consenting Matrix users' full IDs, not display names.
- `pairs`: actual Harmony channel UUID / Matrix room ID pairs. Room IDs are opaque:
  older rooms commonly use `!opaque:server`; modern rooms may use `!opaque` without
  a server suffix. Use the complete ID returned by Matrix, not a room alias.
  Directions are `both`, `to_harmony` and `to_matrix`.
- `pairs[].senderMode`: `ghost` or `relay`, used **only for the first DB room binding**.
  Omitted means `relay` for old configurations; the example explicitly selects `ghost`.
  Once bound, the administrator's current DB mode wins, even after restart. Both
  allowlists are mandatory and capped at 1000 IDs; DB eligibility does not override them.

Use HTTPS/WSS across untrusted networks. Plain HTTP/WS is supported for trusted
local development or a private container network; the configured endpoints carry
credentials. Never put tokens into URLs.

Populate `.env` **locally**, not in chat or an issue:

```dotenv
HARMONY_TOKEN=harmony_bot_<64 hex characters issued by Harmony>
MATRIX_AS_TOKEN=<first independently generated random token>
MATRIX_HS_TOKEN=<second independently generated random token>
```

Generate each Matrix token separately with `openssl rand -hex 32`.
The AS token authorizes the relay to Matrix; the HS token authorizes homeserver
callbacks to the relay. Keep them distinct.

Generate the private application-service registration:

```sh
npm run registration
```

This writes `registration.json` (mode `0600`) and refuses to overwrite an existing
file. JSON is valid YAML. Give this file to your homeserver administrator, add its
path to Synapse's `app_service_config_files`, and restart/reload Synapse as required.
The file's `url` must be reachable from Synapse, not just from your browser. This
registration reserves the exact AS sender plus the exclusive namespace
`@<senderLocalpart>_h_<32 lowercase UUID hex digits>:<serverName>`. It claims no
room/alias namespace. Existing installations must update their homeserver AS
registration with this namespace before enabling ghost mode; preserve the AS/HS tokens.
The generator refuses to overwrite a registration file, so generate/review a separate
private file rather than deleting working secrets. No credentials are printed.

Invite `@harmony_relay:<serverName>` to the selected **unencrypted** Matrix rooms.
Start the bridge:

```sh
npm run build
node --env-file=.env dist/index.js
# or, during development:
npm run dev
```

On startup it first verifies **every** configured channel is registered to this
Matrix bridge, registers the AS sender if needed, binds each configured room through
Gateway without overriding an existing admin mode, leaves owned ghosts from removed
pairs, joins rooms, verifies encryption state, connects to Harmony and starts the worker. An ordinary bot,
missing migration/endpoint, encrypted, inaccessible or unverifiable pairing aborts startup.
There is no fallback to the old prefix-based inbound format.

`GET http://127.0.0.1:9009/health` reports `ready`, `pending` and `failed`. `ready`
means Matrix startup completed and Harmony's gateway is connected; it is not a
continuous guarantee that every room is accessible. Every delivery rechecks access
and encryption independently. A failed count needs operator attention.

Harmony members can withdraw relay consent through the native server bridge-privacy
setting. Consent is queried **after enqueue, immediately before every Harmony-to-Matrix
send attempt**, so pending/retry jobs cannot bypass a later opt-out. False or malformed
consent rejects the job; an unavailable endpoint sends nothing and may retry later.
The operator can additionally remove an ID from either allowlist and restart, or
remove channel bindings/revoke permissions to stop a pairing. Already copied messages
are not retracted. To stop all forwarding, stop the process/revoke the bot tokens.

## Sender modes, member sync and mentions

Ghost IDs are stable per Harmony UUID, not nickname. The bridge persists ownership,
registration and joined-room tracking in additive SQLite tables. Unknown pre-existing
Matrix accounts are **not adopted**: a namespace/collision/registration refusal fails
closed with no silent relay fallback. Keep the SQLite database with the AS registration.
If a crash loses registration confirmation after Matrix accepted it, recovery may require
operator ownership review; do not clear ownership rows to bypass a collision.

Every READY requests a complete refresh. The same single worker refreshes pairs round-
robin, targeting one full sweep per 30 seconds (long network/provisioning work can extend
that interval); no overlapping async sync loops run. Both sides must be verified
plaintext before fetching/publishing profiles. Native candidates are intersected with
`harmony.allowedUserIds`, then current consent is checked again before provisioning and
profile exposure. Matrix imports are intersected with `matrix.allowedUserIds`, excluding
the AS sender and **all** owned ghosts, then published through authenticated WS op 6.
Every op-6 update contains the complete per-channel snapshot, including explicit empty
channel lists, because the Gateway replaces all registered channels on each frame.
Member lists are capped at 1000 and pairs at 100; oversized lists fail closed rather than
partially inventing a directory. Large first-time syncs can delay queued delivery.

Ghosts leave on observed member removal/opt-out or `ghost`→`relay`; removed pairs are
cleaned at startup. History is not deleted. Changes are observed at the next successful
refresh, not instantaneously; unavailable endpoints cannot promise immediate cleanup.
Messages always recheck consent independently of that refresh. A Matrix sender is frozen
in SQLite before its first send attempt because Matrix transaction deduplication is
sender-scoped. If the admin mode changes before a retry, the job fails rather than
resending from another identity. It never silently changes a frozen sender.

- Matrix→Harmony: only `m.text`, explicit `m.mentions.user_ids`, and validated
  `https://matrix.to/#/<MXID>` pills can produce native user mention parts. Targets must
  be durably confirmed owned ghosts resolving to currently eligible, allowlisted native
  members; a matching-but-unknown colliding MXID is not a mention target. HTML
  is never forwarded or fetched. HTML/plaintext disagreement preserves the plain body;
  explicit annotated targets without a usable pill are appended as native mention parts.
  Plain display names and unannotated pills never guess or ping a user.
- In relay mode, send `!mention <exact_native_username> <message>` to mention one
  eligible Harmony member. Ambiguous/unknown names stay plain text. This is a literal
  text command, **not a slash command**; relay mode offers no native-user slash autocomplete.
- Harmony→Matrix consumes structured `mention` parts for Matrix targets:
  `{ type: "mention", userId: "@sam:example.org", username: "sam", domain: "example.org",
     isLocal: false, isBridged: true, bridgeSource: "matrix" }`.
  Targets must be allowlisted and currently joined. Native UUID mentions can also resolve
  to eligible joined ghosts in ghost mode. The bridge emits escaped HTML `matrix.to`
  links plus `m.mentions.user_ids`, never room mentions. Unresolved targets stay text.
  The frontend marker is `<@matrix:ENCODED_MXID>` with `encodeURIComponent(fullMXID)`;
  this process consumes structured parts, not raw marker strings. Discord tokens are unchanged.

## Gateway contracts and avatars

All endpoints use `Authorization: Bot <token>`; paths below are under `/api/v1`:

- `GET /channels/:channelId/bridge-platform` → `{ platform: "matrix" | "discord" | null }`.
  Read permission and authoritative DB registration checks are required; unavailable
  registration state must return 503, not pretend the bot is registered.
- `GET /channels/:channelId/bridge-consent/:userId` → `{ relay_allowed: boolean }`.
  Gateway verifies the paired bridge and the member's current setting. Unknown is
  false; unavailable checks fail closed. This is never cached by the relay.
- `PUT /channels/:channelId/bridge-room` with
  `{ room_id: "!opaque", initial_sender_mode: "ghost" | "relay" }` → `{ room_id, sender_mode }`.
  `GET` on the same path returns the fresh authoritative binding/mode. A mismatched
  bound room fails closed. A bind must never overwrite an existing administrator mode.
- `GET /channels/:channelId/bridge-members` → an array of eligible accepted,
  channel-visible, opted-in native `{ id, username, display_name, avatar_url, domain }`.
- `GET /channels/:channelId/bridge-members/:userId/avatar` → `{ data, content_type }`,
  at most 1 MiB decoded, from the instance's own avatar bucket only and only for a
  currently eligible member. The relay never fetches a native `avatar_url` itself.
- `GET /channels/:channelId/encryption` → `{ messages_encrypted: boolean }`.
- `POST /channels/:channelId/bridge-avatar` accepts
  `{ data: "<base64, at most 1 MiB decoded>", content_type: "image/png|image/jpeg|image/webp|image/gif" }`
  and returns `{ avatar_url: "<full public Harmony storage URL>" }`. Gateway must require
  a registered Matrix bridge and scoped read/send permission, validate bytes/MIME/size,
  and use existing `avatars` storage with content-addressed
  `bridges/<bot-id>/<sha256>.<ext>` paths. This relay adds no storage credentials or API.

Matrix `mxc://` images cannot be rendered directly by a plain browser with modern
Matrix authenticated media. The relay accepts only bounded MXC references from the
sender's actual room-member state. It requests a 128×128 thumbnail through the
**configured homeserver only**, using the AS bearer header and the standard
`/_matrix/client/v1/media/thumbnail/{server}/{mediaId}` route. It never fetches arbitrary
external profile URLs, follows redirects, puts tokens in URLs, or exposes a media proxy.
Responses have a 15-second deadline, a 1 MiB streaming limit, and a raster MIME allowlist.
The HS may federate MXC media according to its own policy; secure that server separately.

Both room/channel plaintext checks precede profile/media fetch and upload; destination
encryption is checked again afterward, with the durable Matrix encryption fence before
message send. A 256-entry in-memory MXC→uploaded-URL cache avoids repeated successful
uploads. Native avatars use the trusted byte endpoint above and authenticated Matrix
media upload, with a separate bounded 256-entry cache keyed by member and avatar URL.
No arbitrary native/external avatar URL is fetched. Avatar fetch/upload errors still
deliver text: new ghosts omit the avatar, existing ghosts preserve their previous avatar
on optional failures, and an actual native avatar removal clears it. External/invalid
Matrix avatar references are ignored. Gateways without
this optional upload endpoint still relay text, but **not avatars**. Public copied
avatars are not deleted by an opt-out or retracted when the Matrix original disappears.
Native cached copies follow avatar URL changes; an overwrite at the same storage URL
requires a bridge restart to refresh. This is profile mirroring, not media lifecycle sync.

## Docker

Build locally; no official Matrix bridge image is published by this contribution:

```sh
docker build -t harmony-matrix-bridge:dev .
```

For container use, set `listen.host` to `0.0.0.0` and choose an application-service
URL reachable from the homeserver (for example a service DNS name on a shared
private Docker network). Do not expose the callback port publicly without need.
A process listening on container loopback is not reachable from other containers.

With a private Docker network named `matrix-net` already configured:

```sh
mkdir -p data
chmod 700 data
docker run --rm --name harmony-matrix-bridge \
  --network matrix-net --user "$(id -u):$(id -g)" \
  --env-file .env \
  -v "$PWD/config.json:/app/config.json:ro" \
  -v "$PWD/data:/app/data" \
  harmony-matrix-bridge:dev
```

The user override lets the process read the private bind-mounted config and write
its database as your UID. Adjust ownership explicitly if using a different service
account. The example's relative database path resolves to `/app/data/bridge.sqlite`.

## Tests

```sh
npm run type-check
npm test
npm run build
npm audit
```

The tests cover authenticated transaction handling, queue atomicity/restarts,
deduplication, encryption rejection, sender/pair restrictions, retry scheduling,
protocol requests, reconnect/shutdown behavior, required bridge registration, room-member
profiles, invalid/oversized avatars, avatar failures, encryption-before-upload ordering,
opt-out between enqueue/retry and delivery, ghost ownership/collision handling,
frozen sender modes, two-user provisioning, member import restrictions, real mentions,
file-only/caption/multi-file delivery, bounded authenticated media, visible transfer failures,
per-piece reply mappings and policy changes during media transfers.

For a real **local Synapse** protocol smoke test (Docker, Linux host networking):

```sh
npm run test:synapse
```

The harness creates private temporary configuration and random tokens, binds only
loopback ports, runs its own uniquely named Synapse container, and removes only
that container and its temporary files on completion. It leaves the downloaded
image in Docker's cache. It pulls Synapse `latest` and runs the resolved immutable
digest, which it reports for reproducibility. No account credentials are needed.

It exercises actual AS registration, joins, authenticated transactions, room-member
state, authenticated media thumbnails, Matrix send idempotency, and the plaintext-to-
encrypted-room transition. A local **Gateway contract fake** additionally exercises
registration rejection, generalized authors, avatar upload, queued member opt-out,
**two real Synapse ghosts**, per-room nickname/avatar, WS member publication, real
mentions both ways, idempotent ghost sends, relay mode, ghost leaves on opt-out/mode
change, retained history, attachment uploads/downloads in both directions, captions, file replies,
media-failure notices, and refusal to retry a frozen transaction under another sender. It does **not** test Gateway
storage/byte validation or DB registration/consent against a real Harmony database,
and does not claim encrypted message interoperability.

## Delivery and privacy limits

- Run **one process per database**; queue selection is intentionally single-worker.
- Synapse transactions are acknowledged only after SQLite acceptance. Event IDs, not
  transaction receipts, deduplicate jobs even if a homeserver reuses transaction IDs
  after restart; new encryption fences are always processed atomically. Previously
  acknowledged events dropped by older versions are not automatically recovered.
  Queues are bounded to 10,000 pending jobs;
  a full queue refuses new Matrix transactions rather than acknowledging their loss.
- Harmony's WebSocket has no resume/replay. Events missed while disconnected are
  not recovered. Storage/queue failures receiving Harmony events are logged, but
  Harmony cannot replay those events automatically.
- Harmony POST has no idempotency key. Ambiguous network/5xx failures after starting
  a send are marked failed, **not blindly retried** (a rate-limit rejection may retry).
  A crash after acceptance but before local completion can still produce a duplicate
  on restart. This is **not exactly-once delivery**.
- Jobs are processed in ready-ID order; a delayed retry can be overtaken by later jobs.
- Retries are bounded; terminal failures are counted, not silently replayed forever.
- Database contents are sensitive: pending jobs contain plaintext messages and sender
  IDs. Keep the database, sidecars and backups private. Receipts/mappings are retained
  for deduplication; completed/failed jobs clear their payloads. SQLite pages, WAL files
  and backups may retain older data; this is not secure erasure. Monitor disk usage.
  Encryption at rest is not provided here.
- Storage read/write faults pause the worker and refuse new Matrix transactions;
  inspect storage and restart rather than continuing with uncertain queue state.
- Consent/registration and sends are separate remote operations too: an opt-out or
  permission revocation after the final check cannot cancel an already-started send.
- There is a residual encryption-policy race: checks and sends are separate remote
  operations. Matrix encryption events durably block a room, and the destination is
  checked last, but a transition after the final check or while an HTTP send is already
  in flight cannot be atomically fenced by this client. Do not use this plaintext
  milestone for sensitive rooms that may transition to encryption. Atomic destination
  enforcement/participant crypto must precede that use case.
- No cross-platform encryption guarantee exists. The bridge must eventually be a
  participant trusted with plaintext, not a tunnel for interchangeable ciphertext.

## Next integration work

The maintainer's intended model is a **revocable participant**: bridge keys, room
membership and permissions should have the same lifecycle as a user's. Harmony
and Matrix both using Megolm does not make their key distribution, device identity,
trust or history-sharing rules interoperable.

Before supporting encrypted rooms, implement a participant-crypto adapter on each
side: independent device/session stores, authorized key acquisition, decryption and
reencryption, membership/revocation handling and queued-send reauthorization. Use
those systems' supported key-sharing rules; do not copy ciphertext between them or
weaken existing guards. Revocation prevents future access/delivery; like a user, a
bridge cannot be made to forget plaintext/keys it already received by simply removing
its permissions.

Before a community-facing release, validate the Gateway/DB registration, native-author,
consent and avatar-storage contracts together on a deployed instance, and add Matrix
bridge setup in Harmony settings. Keep the existing Discord API compatible. This
relay does not rename Discord tables, introduce a shared bridge SDK or alter encryption policy.

## License

AGPL-3.0, consistent with Harmony. Protocol/transport patterns are adapted from the
reference [harmony-discord-bridge](https://github.com/y4my4my4m/harmony-discord-bridge)
by Harmony's contributors. See the repository's [LICENSE](../LICENSE),
[COPYRIGHT](../COPYRIGHT) and [additional terms](../LICENSE-ADDITIONAL-TERMS.md).
