# Experimental Matrix relay

A self-run **Matrix application service in relay mode**, not full Matrix support
in the Harmony client. Existing Discord bridge behavior is unchanged.

**Use dedicated test rooms/channels with consenting participants.** Explicit source
allowlists remain mandatory. Harmony member-controlled relay consent is checked at
queued delivery, in addition to the allowlist. Matrix-to-Harmony messages use native
generalized author metadata. Encrypted participant support and in-client Matrix
bridge setup are not implemented.

## What works

- Multiple one-to-one Matrix room / Harmony channel pairs, either or both directions.
- New plaintext text messages: native Matrix author attribution in Harmony; one AS
  sender with a Harmony author prefix on Matrix (no ghost/virtual users).
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

Not implemented: replies, edits, deletions, files, reactions, presence, ghost users,
account linking, history migration, shared instance hosting or encrypted messages.
Matrix messages containing relations (including replies) are ignored for now.
Harmony text parts are forwarded; attachments and mention parts are not.

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

The Matrix relay uses a dedicated sender such as `@harmony_relay:example.org`.
It does not impersonate existing Matrix users. Harmony messages arrive through
that sender with the Harmony author's name in the text. Matrix messages arrive
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
registration reserves **only** the exact relay user; it claims no room/alias namespace.
No application-service credentials are printed to the terminal.

Invite `@harmony_relay:<serverName>` to the selected **unencrypted** Matrix rooms.
Start the bridge:

```sh
npm run build
node --env-file=.env dist/index.js
# or, during development:
npm run dev
```

On startup it first verifies **every** configured channel is registered to this
Matrix bridge, then registers the AS sender if needed, joins rooms, verifies encryption
state, connects to Harmony and starts the durable queue worker. An ordinary bot,
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

## Gateway contracts and avatars

All endpoints use `Authorization: Bot <token>`; paths below are under `/api/v1`:

- `GET /channels/:channelId/bridge-platform` → `{ platform: "matrix" | "discord" | null }`.
  Read permission and authoritative DB registration checks are required; unavailable
  registration state must return 503, not pretend the bot is registered.
- `GET /channels/:channelId/bridge-consent/:userId` → `{ relay_allowed: boolean }`.
  Gateway verifies the paired bridge and the member's current setting. Unknown is
  false; unavailable checks fail closed. This is never cached by the relay.
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
uploads, with no SQLite schema change. Avatar fetch/upload errors omit the avatar but
still deliver text; external/invalid avatar references are ignored. Gateways without
this optional upload endpoint still relay text, but **not avatars**. Public copied
avatars are not deleted by an opt-out or retracted when the Matrix original disappears.

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
and opt-out between enqueue/retry and delivery.

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
and single-sender outbound relay against real Synapse. It does **not** test Gateway
storage/byte validation or DB registration/consent against a real Harmony database,
and does not claim encrypted message interoperability.

## Delivery and privacy limits

- Run **one process per database**; queue selection is intentionally single-worker.
- Synapse transactions are acknowledged only after SQLite acceptance. Redelivery is
  deduplicated, including after restart. Queues are bounded to 10,000 pending jobs;
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
