---
title: Discord Bridge
---

# Discord bridge

Sync a Discord guild with a Harmony server.

Install: [github.com/y4my4my4m/harmony-discord-bridge](https://github.com/y4my4my4m/harmony-discord-bridge)

## Setup

Open **Server Settings → Discord Bridge** (Manage Server permission). The page
creates the bridge's Harmony bot and offers, depending on what the instance
enables:

- **Use this instance's bot** (when the operator set one up): click **Add to
  Discord**, pick your Discord server and click **Authorize**. Discord sends you
  back to pair channels. The operator's bot reads the Discord channels you give
  it access to. Disconnecting the bridge, or moving it to another Discord
  server, makes the bot leave the old one by itself within about ten minutes.
- **Use your own bot, run on this instance**: create your own Discord bot, with
  your own name and avatar, and paste its token; the instance runs it.
- **Run it yourself**: create your own Discord bot and run the bridge with one
  Docker command and a one-time setup code from the page.

Channels are paired on the same page or from Discord with `/bridge link`.
Presence sync sends only status changes and needs Discord's Presence intent.

The bridge's Harmony bot starts with the bundled Discord bridge avatar.

## What is bridged (bridge 2.2.0, Harmony 1.6.16)

- Harmony authors appear on Discord under their nickname in the server, else
  their display name, else their username.
- Discord voice messages and audio files play in Harmony's audio player;
  PNG, APNG and GIF stickers show as images; animated custom emoji reactions
  stay animated.
- Deleting a Discord member's message on Harmony deletes it on Discord. The bot
  needs Discord's **Manage Messages** permission for that: a bot added under
  Harmony 1.6.15 or earlier lacks it until it is added again (instance bot:
  **Maintenance → Re-link the bot**, picking the same Discord server; own bot:
  **Invite the bot to your Discord server** on the status page). Without it the
  Discord copy stays.
- Harmony's AutoMod counts each Discord author on their own: message flood,
  cross-channel duplicates and mention spam apply to bridged messages even
  when bots are exempt, and new-member restrictions use the Discord member's
  join date when the bridge reports it. Blocked messages are not posted on
  Harmony; the AutoMod log and alerts name the Discord author. Timeouts do
  not apply to Discord authors.

## Old bridge (v1)

The old setup page includes a **pairing code**. The bridge can resolve it via:

`GET /bot-gateway/bridge-setup/HRM-XXXX-XXXX`

…to auto-fill `serverId` and gateway URLs.

## Manual install

```bash
git clone https://github.com/y4my4my4m/harmony-discord-bridge.git
cd harmony-discord-bridge
cp config/bridge-config.example.yml config/bridge-config.yml
docker compose up -d
```

Everything else (URLs, tokens, slash commands) is in the
[standalone README](https://github.com/y4my4my4m/harmony-discord-bridge).

Quick URL cheat sheet for har.mony.lol:

```yaml
# same server as instance
gatewayUrl: "ws://localhost:3002/gateway"
apiUrl: "http://localhost:3002"
baseUrl: "https://har.mony.lol"

# bridge on another machine
gatewayUrl: "wss://har.mony.lol/bot-gateway/gateway"
apiUrl: "https://har.mony.lol/bot-gateway"
baseUrl: "https://har.mony.lol"
```

`apiUrl` must not end in `/api/v1`.

## One bot, multiple servers

A single Discord application (one bot token) can bridge **multiple** Discord guilds when you run one bridge process with a `bridges:` list in `bridge-config.yml`. Each community still uses **their own** Discord app — you only combine pairs you operate yourself.

See also [Bot Gateway Setup](/BOT_GATEWAY_SETUP), [Bot API](/bot-api).
