---
title: Discord Bridge
---

# Discord bridge

Sync a Discord guild with a Harmony server.

Install: [github.com/y4my4my4m/harmony-discord-bridge](https://github.com/y4my4my4m/harmony-discord-bridge)

The bridge hits **bot-gateway** only. Not Supabase (`db.*` hosts are storage).

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

See also [Bot Gateway Setup](/BOT_GATEWAY_SETUP), [Bot API](/bot-api).
