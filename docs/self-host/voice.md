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
   (`VOICE_RECONCILE_INTERVAL_SECONDS`).

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
`LIVEKIT_URL` are all set. Peer-to-peer calls use fixed public STUN servers
(Google's) and the public `openrelay.metered.ca` TURN relay, built into the
app; no setting changes them.

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
  `harmony-livekit` (`livekit/livekit-server:v1.9.4`)
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
ports from the `livekit` service yourself. Harmony has no settings for a
separate TURN server such as coturn.

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

Set `ALLOW_FEDERATED_VOICE=false` in `federation.env` to refuse such calls.

::: tip
The admin panel's **Config** → **Voice & video** tab stores a mode, a LiveKit
URL and a federated-calls switch in the database, but the backend does not
read them. `WEBRTC_MODE`, `LIVEKIT_PUBLIC_URL` and `ALLOW_FEDERATED_VOICE` in
`federation.env` decide.
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
