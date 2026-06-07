# Discord-Harmony Bridge

Cross-platform bridge connecting Discord and Harmony servers.

This is a **standalone** service: it talks only to a Harmony `bot-gateway` over
WebSocket + REST. You do not need the Harmony backend, database, or this repo's
source tree on the host — just Docker and a config file.

## Quick start (Docker)

**Prerequisites:** Docker + Docker Compose, a Harmony instance with
[bot-gateway](https://github.com/y4my4my4m/harmony) running, and bots on both
sides.

### 1. Gather these values

| What | Where to get it |
|------|-----------------|
| **Discord bot token** | [Discord Developer Portal](https://discord.com/developers/applications) → your app → **Bot** → **Reset Token**. Enable **Message Content Intent** on the Bot page. |
| **Discord server (guild) ID** | Discord → **User Settings** → **Advanced** → enable **Developer Mode** → right-click your server icon → **Copy Server ID**. |
| **Discord channel ID(s)** | Right-click each channel to bridge → **Copy Channel ID**. |
| **Harmony bot token** | Harmony admin → **Bot Management** → create a bot → copy token. Grant **Read Messages** and **Send Messages** on the target server. |
| **Harmony server ID** | UUID of the Harmony server (from server settings or URL). |
| **Harmony channel ID(s)** | UUID of each channel to bridge (from the channel URL or dev tools). |
| **bot-gateway URL** | Where your Harmony instance exposes the bot gateway. Examples: `http://localhost:3002` (same machine), or `https://chat.example.com/bot-gateway` (behind your reverse proxy). |

**Discord bot invite:** in the Developer Portal → **OAuth2** → **URL Generator**,
scopes: `bot`. Permissions: View Channels, Send Messages, Read Message History,
Add Reactions, Manage Webhooks (for name/avatar puppeting on Harmony → Discord).

### 2. Configure

```bash
cp config/bridge-config.example.yml config/bridge-config.yml
```

Edit `config/bridge-config.yml` — at minimum set `discord.token`, `discord.guildId`,
`harmony.token`, `harmony.serverId`, `harmony.baseUrl`, and one entry under
`channelMappings`. Point `harmony.gatewayUrl` and `harmony.apiUrl` at your
bot-gateway (see the comments in the example file).

### 3. Run

```bash
docker compose up -d
```

Done. Check logs with `docker compose logs -f`.

To stop: `docker compose down`.

The image is built locally on first run; config is mounted read-only and channel
mappings hot-reload when you edit the file.

---

## Features

- Bi-directional message sync
- Bi-directional reaction sync (unicode emojis both ways; custom Discord emojis
  are synced into Harmony as federated emojis)
- User mention translation
- Custom emoji translation
- Attachment support
- Message editing sync
- Message deletion sync
- Loop prevention
- Configurable channel mappings

## Configuration reference

```yaml
discord:
  token: "YOUR_DISCORD_BOT_TOKEN"
  guildId: "123456789012345678"

harmony:
  token: "YOUR_HARMONY_BOT_TOKEN"
  # Local bot-gateway on the same host:
  gatewayUrl: "ws://localhost:3002/gateway"
  apiUrl: "http://localhost:3002/api/v1"
  # Remote Harmony instance (behind reverse proxy):
  # gatewayUrl: "wss://chat.example.com/bot-gateway/gateway"
  # apiUrl:     "https://chat.example.com/bot-gateway/api/v1"
  serverId: "YOUR_HARMONY_SERVER_UUID"
  baseUrl: "https://chat.example.com"

channelMappings:
  - discord: "987654321098765432"
    harmony: "550e8400-e29b-41d4-a716-446655440000"
    bidirectional: true
    name: "general"

settings:
  syncAttachments: true
  syncReactions: true
  syncEdits: true
  syncDeletes: true
  mentionTranslation: true
```

## Troubleshooting

### Messages not bridging

1. `docker compose logs -f` — look for connection or permission errors
2. Confirm bot-gateway is reachable from this container (`harmony.apiUrl` / `gatewayUrl`)
3. Verify channel IDs in `channelMappings`
4. Confirm both bots have read/send permissions in their channels
5. On Discord: **Message Content Intent** must be enabled

### Mentions not translating

- Set `mentionTranslation: true` in config
- Discord mentions require the user to be in the Discord server
- Harmony mentions use profile IDs

### Attachments not working

- Set `syncAttachments: true`
- Attachments are linked, not re-uploaded
- Bots need embed/attachment permissions

## How it works

**Discord → Harmony:** discord.js receives the message → translate mentions/emojis
→ send via bot-gateway REST API → appears in Harmony.

**Harmony → Discord:** WebSocket event from bot-gateway → skip if already bridged
from Discord → post via Discord webhook (Harmony user's name/avatar) → appears
in Discord.

**Loop prevention:** own bot messages ignored; `metadata.bridge_source = "discord"`
skipped on the way back; Harmony → Discord uses webhooks so messages are not
re-ingested as user messages.

## Limitations

- No voice/video bridging
- Embeds are simplified
- 2000 character Discord limit
- Custom Discord emojis are synced to Harmony as federated emojis; Harmony custom
  emojis only bridge to Discord if a matching guild emoji name exists

## Development

For hacking on the bridge itself (not required to run it):

```bash
npm ci
cp config/bridge-config.example.yml config/bridge-config.yml
# edit config/bridge-config.yml
npm run dev          # watch mode
# or
npm run build && npm start
```

Requires Node 20+. The production Docker image uses the same `Dockerfile` as
`docker compose build`.

## License

GNU **AGPL-3.0** — see repository `LICENSE`.
