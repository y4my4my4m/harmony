---
title: Voice and video
description: Run LiveKit for voice channels, video and calls on a self-hosted Harmony instance, open the right ports, and check that it works.
---

# Voice and video

This page is for operators. Voice channels, video, screen sharing and DM
calls run on a [LiveKit](https://livekit.io/) server. The installer can run
one inside the stack; this page covers turning it on, the DNS name and ports
it needs, its keys, and how to check it.

## How calls connect

The federation backend signs room tokens; clients send their audio and video
to LiveKit directly.

1. The client reads `GET /api/livekit/config` from the backend: whether
   LiveKit is configured, the call mode, the URL to connect to
   (`LIVEKIT_PUBLIC_URL`) and whether calls with other instances are allowed.
   The web app has no LiveKit setting of its own.
2. It asks `POST /api/livekit/token` for a room token. The backend checks the
   user's access to the channel or call.
3. It connects to LiveKit's signalling at `wss://live.chat.example.com`, and
   media flows to 7882/udp, or 7881/tcp when UDP is blocked.
4. LiveKit reports departures to the backend's `/api/livekit/webhook`, which
   updates the channel's participant list within seconds. The worker also
   compares that list with LiveKit's rooms every 60 seconds
   (`VOICE_RECONCILE_INTERVAL_SECONDS`). A client on P2P is in no LiveKit
   room: it checks in every minute, and the database (pg_cron
   `voice-participant-sweep`) removes it from the list after 3 minutes
   without one.

`WEBRTC_MODE` in `federation.env` picks the transport. Every participant in a
room uses the same one:

| `WEBRTC_MODE` | LiveKit configured | Calls use |
|---|---|---|
| `hybrid` (default) | yes | LiveKit |
| `hybrid` | no | Peer-to-peer |
| `sfu` | yes | LiveKit |
| `sfu` | no | Nothing: joining fails |
| `p2p` | either | Peer-to-peer |

LiveKit counts as configured when `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` and
`LIVEKIT_URL` are all set. Peer-to-peer calls are described in
[Peer-to-peer calls](#peer-to-peer-calls).

## Turn voice on

With the installer stack:

```bash
harmony config
```

Answer `y` to **Enable voice/video (LiveKit; needs live.DOMAIN in DNS, UDP
7882 and TCP 7881 open)?**. Without prompts:

```bash
cd /opt/harmony/self-host
HARMONY_VOICE=y bash configure.sh --non-interactive
docker compose up -d
```

`configure.sh` then:

- sets `ENABLE_VOICE=true` and adds the `voice` profile, which starts
  `harmony-livekit` (`livekit/livekit-server:v1.13.11`)
- writes `self-host/livekit.yaml` from `webrtc/livekit.yaml.example`: the
  key pair from `federation.env` under `keys`, the stack's Redis with its
  password, TURN off, and a webhook to
  `http://federation-server:3001/api/livekit/webhook`
- sets `LIVEKIT_URL=ws://livekit:7880` and
  `LIVEKIT_PUBLIC_URL=wss://live.chat.example.com` in `federation.env`

Caddy then serves `live.chat.example.com` and obtains its certificate.
Turning voice off with `harmony config` removes the LiveKit container and
both URLs, and calls fall back to peer-to-peer. After
`configure.sh --non-interactive`, `docker compose up -d` leaves the container
of a disabled profile running; remove it with
`docker compose --profile voice rm -sf livekit`.

## Create the DNS record

Point `live.chat.example.com` (`LIVEKIT_DOMAIN`, `live.DOMAIN` by default) at
the server, like the app's own name. Caddy requests its certificate only
while voice is on.

## Open the ports

| Port | Carries |
|---|---|
| 443/tcp | Signalling at `wss://live.chat.example.com`, through Caddy |
| 7882/udp | All call media, multiplexed on one port |
| 7881/tcp | Call media over TCP, for clients whose network blocks UDP |

The `livekit` container publishes 7881/tcp and 7882/udp on every interface.
Open both in every firewall between the internet and the server: the host's
own (`ufw allow 7881/tcp`, `ufw allow 7882/udp`) and the provider's. When
7882/udp is blocked, calls connect but carry no audio for clients that cannot
fall back to TCP.

LiveKit's port 7880 stays inside Docker's network.

## Keys and secrets

`configure.sh` generates the LiveKit key pair once, on the first run:
`LIVEKIT_API_KEY` (`API` followed by 12 hexadecimal characters) and
`LIVEKIT_API_SECRET` (64 hexadecimal characters). They live in
`federation.env` and under `keys` in `livekit.yaml`; LiveKit requires a
secret of at least 32 characters.

An existing `livekit.yaml` is kept on every run. To regenerate it from the
template, with the keys of `federation.env`:

```bash
cd /opt/harmony/self-host
rm livekit.yaml
bash configure.sh --non-interactive
docker compose up -d
docker compose restart livekit
```

The webhook in `livekit.yaml` signs its calls with `webhook.api_key`, which
must be `LIVEKIT_API_KEY`; the backend checks them with
`LIVEKIT_API_SECRET`.

## Public address and LAN installs

LiveKit tells clients which address to send media to. The generated
`livekit.yaml` sets `rtc.use_external_ip: true`, so LiveKit discovers the
server's public address over STUN.

On a LAN install, where clients reach the server at a private address:

1. In `self-host/livekit.yaml`, under `rtc:`, remove `use_external_ip: true`
   and add `node_ip:` with the server's LAN address.
2. Restart LiveKit:

   ```bash
   cd /opt/harmony/self-host
   docker compose restart livekit
   ```

## TURN

The generated `livekit.yaml` turns LiveKit's built-in TURN server off. It
would relay through 3478/udp and the UDP range
`turn.relay_range_start`-`turn.relay_range_end` (30000-40000), which
`docker-compose.yml` does not publish. Clients that cannot use UDP connect
over ICE/TCP on 7881 instead.

Enabling it means `turn.enabled: true` in `livekit.yaml` and publishing those
ports from the `livekit` service yourself. A separate TURN server such as
coturn serves [peer-to-peer calls](#peer-to-peer-calls) only.

## Peer-to-peer calls

Without LiveKit (`WEBRTC_MODE=p2p`, or `hybrid` with LiveKit off) every
participant sends audio and video to every other participant directly.

**Signalling.** Offers, answers, ICE candidates, joins, leaves and media
states go through the database: the client calls `send_signal`, which
broadcasts them on the room's Realtime topic `harmony-voice-<room>` with the
caller's profile as the sender. DM call answers and hang-ups
(`dm-call:<conversation>`) and call effects (`easter-egg:<room>`) travel the
same way. Clients cannot broadcast on those topics themselves, so no
participant can send as another. An account sends at most
`account_signals_per_minute` signals (300) and places at most
`account_rings_per_minute` calls (10, to this instance and to others together), set in the admin panel's
**Anti-spam** tab. Apps from before 1.9.8 broadcast their signals themselves;
on an instance running 1.9.8 or later their peer-to-peer calls do not
connect, and their answers and hang-ups of DM calls do not reach updated
apps, until they update.

**STUN and TURN.** Each device asks a STUN server for its public address,
and a TURN server relays the media of two devices that cannot reach each
other, typically behind a strict NAT, a carrier-grade NAT or a firewall
that blocks UDP. With nothing set, calls use Google's STUN servers
(`stun:stun.l.google.com:19302`, `stun:stun1.l.google.com:19302`) and no
TURN server: participants' addresses go to Google, and two participants who
both sit behind strict NATs do not connect.

Set them in the admin panel under **Config** → **Voice & video** →
**Peer-to-peer calls: STUN and TURN**:

| Field | Key in `instance_config` | Value |
|---|---|---|
| **Use the default STUN servers** | `voice_stun_urls` | On: `"default"`, Google's list. Off: the list below |
| **STUN servers** | `voice_stun_urls` | `stun:` or `stuns:` URLs, one per line; empty for none |
| **TURN servers** | `voice_turn_urls` | `turn:` or `turns:` URLs, one per line; empty for none |
| **TURN credentials** | `voice_turn_auth` | **Shared secret** (`secret`) or **Username and password** (`password`) |
| **TURN username** | `voice_turn_username` | The account, for **Username and password** |
| **Shared secret** / **TURN password** | `voice_turn_secret` | coturn's `static-auth-secret`, or the account's password. Admins read it; the activity log records only that it was set |

Every signed-in account receives the servers through `voice_ice_servers`
when it joins a call. With a shared secret, each join gets its own
credentials, valid for 24 hours: username `<expiry>:<profile id>`,
password `base64(HMAC-SHA1(secret, username))`, as coturn's
`use-auth-secret` checks them. With a username and password, every account
receives that password.

### Run coturn

On a host with a public address, with `turn.chat.example.com` pointing at it
and a certificate for that name:

```bash
openssl rand -hex 32   # the shared secret
```

`/etc/coturn/turnserver.conf`:

```ini
listening-port=3478
tls-listening-port=5349
realm=turn.chat.example.com
use-auth-secret
static-auth-secret=the-secret-from-openssl
cert=/etc/coturn/fullchain.pem
pkey=/etc/coturn/privkey.pem
min-port=49160
max-port=49200
fingerprint
no-cli
no-multicast-peers
# Relays reach the internet only, not the host's own networks.
denied-peer-ip=0.0.0.0-0.255.255.255
denied-peer-ip=10.0.0.0-10.255.255.255
denied-peer-ip=100.64.0.0-100.127.255.255
denied-peer-ip=127.0.0.0-127.255.255.255
denied-peer-ip=169.254.0.0-169.254.255.255
denied-peer-ip=172.16.0.0-172.31.255.255
denied-peer-ip=192.168.0.0-192.168.255.255
```

```bash
docker run -d --name coturn --restart unless-stopped --network host \
  -v /etc/coturn:/etc/coturn:ro coturn/coturn -c /etc/coturn/turnserver.conf
```

Open 3478/udp, 3478/tcp, 5349/tcp and the relay range 49160-49200/udp. On a
host behind NAT, add `external-ip=<public address>/<private address>`.

Then, in **Peer-to-peer calls: STUN and TURN**:

- **STUN servers**: `stun:turn.chat.example.com:3478` (with **Use the default
  STUN servers** off, no participant address goes to Google)
- **TURN servers**:
  ```text
  turn:turn.chat.example.com:3478?transport=udp
  turn:turn.chat.example.com:3478?transport=tcp
  turns:turn.chat.example.com:5349
  ```
- **TURN credentials**: **Shared secret**, with the secret from `openssl`

A call that connects through the relay shows a candidate of type `relay` in
`chrome://webrtc-internals`. An address in a `denied-peer-ip` range that a
call needs, such as a LAN install's own network, needs its line removed.

## Run LiveKit outside the stack

On a manual deployment, run LiveKit from `webrtc/` (`livekit.yaml.example`,
`docker-compose.example.yml`, described in `webrtc/README.md`) or anywhere
else, put its signalling behind a TLS reverse proxy with WebSocket upgrades
(`dev/nginx-livekit.template.conf` is a template), and give the federation
backend:

```bash
LIVEKIT_API_KEY=key-from-livekit.yaml
LIVEKIT_API_SECRET=its-secret
LIVEKIT_URL=ws://localhost:7880
LIVEKIT_PUBLIC_URL=wss://live.chat.example.com
WEBRTC_MODE=hybrid
```

`LIVEKIT_URL` is the address the backend reaches; `LIVEKIT_PUBLIC_URL` the
one browsers and apps reach. In `livekit.yaml`, uncomment `webhook:` with
`api_key` set to `LIVEKIT_API_KEY` and `urls` pointing at the backend's
`/api/livekit/webhook`. Without the webhook, a client that drops stays in
the participant list until the worker's next check.

The installer stack does not support an external LiveKit: with voice off,
every `configure.sh` run, including the one in `harmony update`, removes
`LIVEKIT_URL` and `LIVEKIT_PUBLIC_URL` from `federation.env`.

## Calls with other instances

A call to a user on another instance rings over ActivityPub. The room lives
on the caller's LiveKit: when the callee accepts, their instance asks the
caller's instance for a token (`POST /api/livekit/federated-token`, signed
like any federation request). Both instances need LiveKit and
`ALLOW_FEDERATED_VOICE=true`, the default.

People from other instances who are members of a server here join its voice
channels the same way: their instance sends a join, and this one answers with
a token on its LiveKit or a refusal they see at once.

Set `ALLOW_FEDERATED_VOICE=false` in `federation.env` to refuse both.

::: tip
The admin panel's **Config** → **Voice & video** tab shows whether calls with
other instances are on, as the backend reports it. It also stores a mode and a
LiveKit URL in the database, which the backend does not read. `WEBRTC_MODE`,
`LIVEKIT_PUBLIC_URL` and `ALLOW_FEDERATED_VOICE` in `federation.env` decide.
:::

## Check that voice works

`harmony doctor` checks voice when it is on, in its **Services** section:

| Check | Passes when |
|---|---|
| `livekit` | `livekit.yaml` holds the key pair of `federation.env`, both LiveKit URLs are set, and `/api/livekit/health` answers `healthy` |
| `signalling` | `https://live.chat.example.com` answers |
| `media tcp` | 7881/tcp accepts a connection at the published address |
| `media udp` | 7882/udp is published and, when `ufw` is active, allowed. UDP cannot be probed from the server itself |

By hand:

```bash
curl https://chat.example.com/api/livekit/health   # "status": "healthy" and the active room count
curl https://chat.example.com/api/livekit/config   # "enabled": true and the public wsUrl
harmony logs livekit
```

| `/api/livekit/health` | Meaning |
|---|---|
| `not_configured` | The backend lacks `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` or `LIVEKIT_URL` |
| `healthy` | The backend reached LiveKit and listed its rooms |
| `unhealthy` (HTTP 503) | The backend cannot reach `LIVEKIT_URL`, or the key pair is not in `keys` |

When a call joins but nobody hears anything, 7882/udp or 7881/tcp is
blocked, or LiveKit advertises the wrong address (`use_external_ip`,
`node_ip`). In Chrome, `chrome://webrtc-internals` shows the candidates a
client tried and the one it chose.
