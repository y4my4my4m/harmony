# Experimental Matrix relay

A self-run **Matrix application service in relay mode**. This is the first working
slice of Harmony's [bridges beyond Discord roadmap](../ROADMAP.md), not full
Matrix support in the Harmony client. Existing Discord bridge behavior is unchanged.

**Use dedicated test rooms/channels with consenting participants.** Only explicitly
allowlisted users are forwarded. Native author rendering, member-controlled opt-out,
in-client setup and encrypted participant support are still to be implemented.
Do not deploy this milestone as a transparent community-wide bridge.

## What works

- Multiple one-to-one Matrix room / Harmony channel pairs, either or both directions.
- New plaintext text messages with explicit sender attribution.
- Matrix application-service authentication and durable transaction acceptance.
- SQLite inbox/outbox, event deduplication, message mappings and bounded retry backoff.
- Matrix outbound transaction IDs stable across retries/restarts.
- Per-attempt checks of both sides' encryption policy; unknown state fails closed.
- Durable Matrix encryption-event fences, including events received during a preflight.
- Explicit sender allowlists, rechecked before queued delivery.
- No forwarding of Harmony bots, external bridge messages, system notices or threads.
- Health endpoint without message contents or credentials.

Not implemented: replies, edits, deletions, files, reactions, presence, ghost users,
account linking, history migration, shared instance hosting or encrypted messages.
Matrix messages containing relations (including replies) are ignored for now.
Harmony text parts are forwarded; attachments and mention parts are not.

## Requirements

- Node.js 24 recommended (minimum 22.13; Node 22 may print an SQLite experimental warning).
- A Harmony instance running this branch's bot gateway, including the new authenticated
  `GET /api/v1/channels/:channelId/encryption` endpoint. Older gateways fail closed.
- A normal Harmony bot installed with **Read messages** and **Send messages** only in
  the dedicated channels. Do not grant Manage Server, roles or messages.
- A Matrix homeserver whose administrator can register an application service.
  A public Matrix account without homeserver administration is useful as a test user,
  but is not sufficient to host this application service.
- A reachable callback address from the homeserver to the relay. The relay needs
  outbound access to that homeserver and the Harmony gateway.

The Matrix relay uses a dedicated sender such as `@harmony_relay:example.org`.
It does not impersonate existing Matrix users. Harmony messages arrive through
that sender with the Harmony author's name in the text. Matrix messages arrive
through the Harmony bot with the full Matrix user ID in the text.

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
- `harmony.allowedUserIds`: Harmony profile UUIDs whose messages may leave Harmony.
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

On startup it registers the relay user if needed, joins configured rooms, verifies
encryption state, connects to Harmony and starts the durable queue worker.
An encrypted, inaccessible or unverifiable pairing aborts startup.

`GET http://127.0.0.1:9009/health` reports `ready`, `pending` and `failed`. `ready`
means Matrix startup completed and Harmony's gateway is connected; it is not a
continuous guarantee that every room is accessible. Every delivery rechecks access
and encryption independently. A failed count needs operator attention.

To withdraw a user's opt-in, remove their ID from the allowlist and restart. Pending
jobs are checked against the new list. This is an **operator-controlled development
safeguard**, not the roadmap's native per-member opt-out. Already copied messages
are not retracted. To stop all forwarding, stop the process/revoke the bot tokens.

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
protocol requests, reconnect/shutdown behavior and registration scope.

For a real **local Synapse** protocol smoke test (Docker, Linux host networking):

```sh
npm run test:synapse
```

The harness creates private temporary configuration and random tokens, binds only
loopback ports, runs its own uniquely named Synapse container, and removes only
that container and its temporary files on completion. It leaves the downloaded
image in Docker's cache. It pulls Synapse `latest` and runs the resolved immutable
digest, which it reports for reproducibility. No account credentials are needed.

It exercises actual AS registration, joins, authenticated transactions, Matrix send
idempotency, and the plaintext-to-encrypted-room transition. It does **not** test
Harmony against a real database or claim encrypted message interoperability.

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

Before a community-facing release, add native generalized remote authors, a real
member-controlled opt-out, reviewable server/channel authorization, and setup in
Harmony settings. Keep the existing Discord API compatible. This milestone deliberately
does not rename Discord tables, introduce a shared bridge SDK or alter encryption policy.

## License

AGPL-3.0, consistent with Harmony. Protocol/transport patterns are adapted from the
reference [harmony-discord-bridge](https://github.com/y4my4my4m/harmony-discord-bridge)
by Harmony's contributors. See the repository's [LICENSE](../LICENSE),
[COPYRIGHT](../COPYRIGHT) and [additional terms](../LICENSE-ADDITIONAL-TERMS.md).
