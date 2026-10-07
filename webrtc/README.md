# LiveKit (voice and video)

Harmony's voice channels, video and DM calls run on a [LiveKit](https://livekit.io/) SFU. The federation backend signs room tokens; clients connect to LiveKit directly. Without LiveKit, `WEBRTC_MODE=hybrid` (the default) falls back to peer-to-peer calls.

## In the self-host stack

Answer yes to voice during install, or later through `harmony config`. `self-host/configure.sh` then:

- writes `self-host/livekit.yaml` from `livekit.yaml.example`: the API key pair from `federation.env` under `keys`, `rtc.tcp_port` 7881, `rtc.udp_port` 7882 (one UDP port, multiplexed), TURN off, Redis at `redis:6379` with `REDIS_PASSWORD`, and a webhook to `http://federation-server:3001/api/livekit/webhook`
- sets `LIVEKIT_URL=ws://livekit:7880` and `LIVEKIT_PUBLIC_URL=wss://live.DOMAIN` in `federation.env`
- adds the `voice` profile, which starts `harmony-livekit` (`livekit/livekit-server:v1.9.4`)

Caddy serves signalling at `live.DOMAIN` and proxies it to `livekit:7880`. The host needs:

- a DNS record for `live.DOMAIN`
- inbound 7881/tcp and 7882/udp (media; published by the container)

An existing `self-host/livekit.yaml` is kept on re-run; deleting it makes `configure.sh` write a new one.

## Files

| File | Purpose |
|---|---|
| `livekit.yaml.example` | LiveKit server configuration template |
| `docker-compose.example.yml` | Standalone LiveKit with its own Redis, and LiveKit Egress under the `egress` profile |
| `egress.yaml` | Egress configuration for that profile. Harmony starts no recordings |
| `env.example` | `LIVEKIT_URL`, `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` for the load test |
| `TESTING.md` | Testing voice without several people |
| `test/load-test.ts`, `test/package.json` | Load test (`npm test` in `test/`) |

`livekit.yaml`, `docker-compose.yml` and `.env` in this directory are ignored by git.

## Standalone LiveKit

For a setup outside the self-host stack:

```bash
cd webrtc
cp livekit.yaml.example livekit.yaml
cp docker-compose.example.yml docker-compose.yml
```

In `livekit.yaml`:

- `keys`: one `key: secret` pair. LiveKit requires secrets of at least 32 characters (`openssl rand -hex 32`).
- `redis`: the address and password of the Redis LiveKit uses. In `docker-compose.example.yml` that is `redis:6379` with the password on its `redis-server --requirepass` line.
- `rtc.use_external_ip: true` discovers the public address; `rtc.node_ip` sets it instead. Inside Docker, one of the two is required, or LiveKit advertises its container address.
- `turn`: the example enables LiveKit's TURN server. TURN needs 3478/udp and its relay range (`turn.relay_range_start`-`turn.relay_range_end`) reachable. With `turn.enabled: false`, clients without UDP use ICE over TCP on 7881.
- `webhook`: uncomment it, with `api_key` the federation backend's `LIVEKIT_API_KEY` and `urls` its `/api/livekit/webhook`.

The ports LiveKit needs reachable are 7880 (signalling, behind TLS), 7881/tcp and 7882/udp. `docker-compose.example.yml` publishes 7880, 7881 (tcp and udp), 3478, 5349 and a 50000-50100/udp range, but not 7882/udp, the single media port `livekit.yaml.example` uses; the copy adds `7882:7882/udp`. The example compose also joins the external `supabase_default` network, which must exist.

Signalling goes through a TLS reverse proxy with WebSocket upgrades: `dev/nginx-livekit.template.conf` proxies `live.DOMAIN` to `localhost:7880`.

The federation backend then gets:

```env
LIVEKIT_API_KEY=<key from livekit.yaml>
LIVEKIT_API_SECRET=<its secret>
LIVEKIT_URL=ws://localhost:7880          # as the backend reaches LiveKit
LIVEKIT_PUBLIC_URL=wss://live.chat.example.com
WEBRTC_MODE=hybrid
```

LiveKit counts as configured when key, secret and `LIVEKIT_URL` are all set.

## How a client joins

1. `GET /api/livekit/config` tells the client whether LiveKit is configured, the mode, the URL to use (`LIVEKIT_PUBLIC_URL`) and whether federated calls are allowed.
2. `POST /api/livekit/token`, with the user's Supabase token, checks the user's access and returns a signed room token.
3. The client connects to LiveKit with that token; media flows to 7881/tcp or 7882/udp.
4. LiveKit's webhook (`participant_left`, `participant_connection_aborted`, `room_finished`) lets the backend remove participants who dropped. The worker also reconciles `voice_channel_participants` against the rooms every `VOICE_RECONCILE_INTERVAL_SECONDS` (60).

### Federated calls

A call to a user on another instance rings over ActivityPub (`harmony:VoiceCallInvite`). The room lives on the caller's LiveKit: on accept, the callee's instance requests a token for its user from the caller's instance (`POST /api/livekit/federated-token`). Both instances need LiveKit and `ALLOW_FEDERATED_VOICE=true`.

## End-to-end encryption

In a channel with voice encryption (the server's `voice_encryption_mode`, or the channel's own setting), clients encrypt every media frame with LiveKit's `ExternalE2EEKeyProvider`. The room key is random, minted by one participant and distributed over the Megolm channel that already carries message keys (`src/services/encryption/VoiceE2EEService.ts`). LiveKit forwards frames it cannot decrypt.

## Verifying

```bash
curl https://chat.example.com/api/livekit/health     # "status": "healthy" with the room count
curl https://chat.example.com/api/livekit/config     # "enabled": true and the public wsUrl
harmony logs livekit
```

`chrome://webrtc-internals` shows a client's ICE candidates and the transport it chose.

## Troubleshooting

- **`not_configured`**: the backend lacks `LIVEKIT_API_KEY`, `LIVEKIT_API_SECRET` or `LIVEKIT_URL`.
- **`unhealthy`**: the backend cannot reach `LIVEKIT_URL`, or the key pair is not in `keys`.
- **Joins, then no audio**: 7882/udp or 7881/tcp is blocked, or LiveKit advertises the wrong address (`use_external_ip`, `node_ip`).
- **Participants linger after a crash**: the webhook is missing or its `api_key` is not `LIVEKIT_API_KEY`; the worker still removes them within a few minutes.
- **Federated calls fail**: `ALLOW_FEDERATED_VOICE`, LiveKit on both instances, and `LIVEKIT_PUBLIC_URL` reachable from the other side.

## References

- [LiveKit documentation](https://docs.livekit.io/)
- [LiveKit ports and firewall](https://docs.livekit.io/transport/self-hosting/ports-firewall/)
