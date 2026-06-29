---
title: Discord Bridge
---

# Discord bridge

Sync a Discord guild with a Harmony server.

Install: [github.com/y4my4my4m/harmony-discord-bridge](https://github.com/y4my4my4m/harmony-discord-bridge)

## Quick setup (recommended)

1. Open **Server Settings → Advanced → Discord Bridge** on your Harmony instance.
2. Create a bridge bot in **User Settings → My Bots** and add it under **Server Bots**.
3. Create your own [Discord application](https://discord.com/developers/applications), paste the **Client ID** into the setup page, and use the generated **invite URL** (scopes + permissions pre-filled).
4. Copy or download the generated `bridge-config.yml`, fill in bot tokens and channel IDs, and run the bridge.

The setup page includes a **pairing code**. The bridge can resolve it via:

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
