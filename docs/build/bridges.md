---
title: Writing a bridge
description: How a Discord bridge program works against Harmony - the Bridge v2 API, its configuration object, relayed authors, and message, thread and emoji mapping.
---

# Writing a bridge

A bridge relays messages between Harmony channels and another platform. This page is for developers who write or modify a bridge program: it describes the Bridge v2 API, the configuration a bridge receives, and how a bridge maps authors, messages, threads, reactions and emoji between the two sides. Server owners who want to connect a server to Discord should read [Discord bridge](/run/discord-bridge); operators who host bridges should read [Discord bridges](/self-host/discord-bridges).

The official bridge is [harmony-discord-bridge](https://github.com/y4my4my4m/harmony-discord-bridge). It is the reference client for everything on this page.

## Scope

The bridge features of Harmony are built for Discord. A Discord bridge is a bot of type Bridge, tied to one server through a bridge record that holds its configuration and its channel pairs. The Bridge v2 API, relayed authors (messages shown under the remote author's name and avatar), and the Discord mapping routes all require that record.

A bridge to another platform can run as an ordinary bot, with the [gateway](/build/gateway) and the [REST API](/build/rest). Its relayed messages then appear under the bot's own name: the server drops `discord_user` and `bridge_source` metadata from a bot whose bridge does not relay the channel.

## How a bridge is set up

A server has at most one Discord bridge. Setting it up under **Server settings** → **Discord Bridge** creates the bridge record and a bot of type Bridge for it, installed in the server with Read messages, Send messages, Manage channels and Manage roles. The bridge program authenticates with that bot's token. How it gets the token depends on where it runs:

| Mode | In the app | Who runs the program | How the program gets the Harmony token |
|---|---|---|---|
| `self` | **Run it yourself** | The community, on its own computer | Trades a one-time setup code for the token with [`POST /bridge/v2/redeem`](#post-redeem) |
| `hosted` | **Use your own bot, run on this instance** | The instance's bridge host, with the community's Discord bot | [`GET /bridge/v2/hosted`](#get-hosted), with the instance's host secret |
| `instance` | **Use *name*'s bot**, named after the instance | The instance's bridge host, with the instance's own Discord bot | [`GET /bridge/v2/hosted/instance`](#get-hosted-instance), with the instance's host secret |

Once it has a token, the program uses the same three things in every mode: the gateway for events, the REST API for writes, and the bridge-bot routes of the Bridge v2 API for its configuration and status.

## Bridge v2 endpoints

Base URL: `https://<instance>/bot-gateway/bridge/v2`.

| Method | Path | Authentication | Purpose |
|---|---|---|---|
| `POST` | [`/redeem`](#post-redeem) | A setup code in the body | Trade a setup code for the bridge bot's token |
| `GET` | [`/config`](#get-config) | `Authorization: Bot <token>` of a bridge bot | Read the bridge's configuration |
| `POST` | [`/status`](#post-status) | Bridge bot token | Report health and the Discord side's channels |
| `POST` | [`/pairs`](#post-pairs) | Bridge bot token | Pair a Discord channel with a Harmony channel from the Discord side |
| `DELETE` | [`/pairs/{discord channel id}`](#delete-pairs) | Bridge bot token | Remove a pair from the Discord side |
| `GET` | [`/hosted`](#get-hosted) | `X-Bridge-Host-Secret` header | List hosted bridges with their tokens |
| `GET` | [`/hosted/instance`](#get-hosted-instance) | `X-Bridge-Host-Secret` header | The instance's Discord bot and the bridges it runs |
| `GET` | [`/discord/authorize`](#discord-authorize-and-callback) | None (browser) | Redirect to Discord's consent screen for the instance bot |
| `GET` | [`/discord/callback`](#discord-authorize-and-callback) | None (browser) | Discord's OAuth2 redirect; links the Discord server to the bridge |

The bridge-bot routes answer `403` `Bot is not a Discord bridge` when the token's bot drives no bridge, and `503` `Bridge lookup unavailable` when the lookup fails. They count against the [REST rate limit](/build/permissions-rate-limits#rest-rate-limits); the others are [limited per IP address](/build/permissions-rate-limits#bridge-v2-public-route-limits). Every response of `/redeem`, `/hosted`, `/hosted/instance` and the `/discord` routes carries `Cache-Control: no-store`.

### POST /redeem

Trades a setup code for the bridge bot's Harmony token. Server owners get the code under **Server settings** → **Discord Bridge** → **Run it myself** → **Get a setup code**.

```json
{ "code": "HB-7KQM-2XRT-9PLD" }
```

The code is `HB-` followed by three groups of four characters. Case, separators and the `HB` prefix are optional when typed. A code lasts 30 minutes, works once, and getting a new code cancels older ones.

```json
{
  "bridge_id": "1c5e…",
  "server_id": "9a02…",
  "harmony_token": "harmony_bot_…",
  "base_url": "https://harmony.example.com",
  "api_url": "https://harmony.example.com/bot-gateway",
  "gateway_url": "wss://harmony.example.com/bot-gateway/gateway"
}
```

| Field | Description |
|---|---|
| `harmony_token` | The bridge bot's token. Redeeming revokes the bot's previous tokens. |
| `base_url` | The instance's public URL. |
| `api_url` | The gateway's base: the REST API is at `{api_url}/api/v1` and this API at `{api_url}/bridge/v2`. |
| `gateway_url` | The gateway WebSocket. |

When the instance has no configured public URL, the three URLs are built from the origin the request reached, without the `/bot-gateway` prefix. Any failure, whether an unknown, used, expired or malformed code, answers `400` `{ "error": "Invalid or expired setup code", "code": "invalid_code" }`.

### GET /config

Returns the bridge's configuration. The gateway also pushes this object as [`BRIDGE_CONFIG_UPDATE`](/build/gateway#bridge-config-update) on each new connection and on every change, so a bridge can rely on events after its first read.

```json
{
  "bridge_id": "1c5e…",
  "server_id": "9a02…",
  "mode": "self",
  "discord_guild_id": "80351110224678912",
  "settings": {
    "sync_member_list": true,
    "sync_presence": false,
    "sync_reactions": true,
    "sync_edits": true,
    "sync_deletes": true
  },
  "updated_at": "2026-10-13T08:12:44.120391+00:00",
  "base_url": "https://harmony.example.com",
  "pairs": [
    {
      "harmony_channel_id": "c2d4f8a0-…",
      "harmony_channel_name": "general",
      "discord_channel_id": "80351110224678913",
      "discord_channel_name": "general",
      "direction": "both"
    }
  ],
  "harmony_channels": [
    { "id": "c2d4f8a0-…", "name": "general", "type": 0, "category": "Text", "category_id": "4b1e…", "encrypted": false }
  ]
}
```

| Field | Type | Description |
|---|---|---|
| `bridge_id` | UUID | |
| `server_id` | UUID | The Harmony server. |
| `mode` | string | `self`, `hosted` or `instance`. |
| `discord_guild_id` | string or `null` | The Discord server the bridge serves. |
| `settings` | object | The server owner's choices: `sync_member_list`, `sync_presence`, `sync_reactions`, `sync_edits`, `sync_deletes`, all booleans. Harmony stores and delivers them; the bridge program applies them. |
| `updated_at` | ISO 8601 | Last configuration change. |
| `base_url` | string or `null` | The instance's public URL. |
| `pairs` | array | Paired channels; see below. |
| `harmony_channels` | array | Every channel of the server the bridge bot can see, categories excluded, ordered by position, then name. |

| Pair field | Description |
|---|---|
| `harmony_channel_id`, `harmony_channel_name` | The Harmony side. |
| `discord_channel_id`, `discord_channel_name` | The Discord side. |
| `direction` | `both`, `to_harmony` or `to_discord`: which way messages flow. |

| Channel field | Description |
|---|---|
| `id`, `name` | |
| `type` | `0` text, `1` voice. |
| `category`, `category_id` | The channel's category name and ID, or `null`. |
| `encrypted` | `true` when the channel's messages are end-to-end encrypted. The bridge cannot read them. |

`503` `Bridge configuration unavailable` means a lookup failed; retry.

### POST /status

The bridge's heartbeat and its view of Discord. The app's bridge page reads it to show health, problems and the Discord channels available for pairing. The app shows the bridge offline when its last report is more than 90 seconds old, so report well within that, for example every 30 seconds.

```json
{
  "version": "2.4.1",
  "discord": {
    "connected": true,
    "application_id": "1100000000000000000",
    "bot_user": { "id": "1100000000000000001", "name": "Harmony Bridge", "avatar": "…" },
    "intents": { "message_content": true, "members": true, "presence": false }
  },
  "harmony": { "connected": true },
  "guilds": [
    {
      "id": "80351110224678912",
      "name": "My Community",
      "icon": "…",
      "channels": [
        {
          "id": "80351110224678913",
          "name": "general",
          "type": 0,
          "parent_id": null,
          "position": 0,
          "can_view": true,
          "can_send": true,
          "can_manage_webhooks": true
        }
      ]
    }
  ],
  "problems": [{ "code": "cannot_send", "params": { "discord_channel_id": "80351110224678914" } }]
}
```

The gateway keeps only these fields. Strings are cut (names to 100 characters, `icon` and `avatar` to 512, `version` to 64); IDs must be 1 to 20 digits, and a guild or channel without a valid `id` is dropped. At most 100 guilds, 500 channels per guild and 50 problems are kept. A problem `code` matches `^[a-z][a-z0-9_]{0,63}$`; it keeps up to 10 `params` whose keys match `^[a-z][a-z0-9_]{0,31}$`, with string values cut to 200 characters, numbers and booleans.

What Harmony stores:

- Always: the status, the version and the time of the report.
- When `discord.connected` is `true`: also the guild snapshot, the Discord application ID and bot name, and the names of paired Discord channels. If no guild is selected and the snapshot holds exactly one, that guild is selected. An `instance` bridge keeps only its own linked guild.

Returns `{ "ok": true, "discord_guild_id": "…" }` with the bridge's guild, which can be `null`. A body that is not an object answers `400`; a stored status over 64 KiB or snapshot over 2 MiB answers `400` `Status not stored`.

The app explains these problem codes, using the `params` shown:

| Code | Shown as | Params |
|---|---|---|
| `discord_token_invalid` | Discord rejected the bot token. | |
| `intent_missing` | Discord refused an intent. | `intent`: `message_content`, `members` or `presence` |
| `bot_not_in_guild` | The bot isn't in the Discord server. | `guild_id` |
| `no_guild` | The bot isn't in any Discord server yet. | |
| `guild_not_selected` | No Discord server chosen yet. | |
| `channel_not_visible` | The bot can't see a channel. | `discord_channel_id` or `harmony_channel_id` |
| `cannot_send` | The bot can't post in a channel. | `discord_channel_id` or `harmony_channel_id` |
| `cannot_manage_webhooks` | The bot can't manage webhooks in a channel. | `discord_channel_id` or `harmony_channel_id` |
| `harmony_auth_failed` | The bridge can no longer sign in to Harmony. | |
| `harmony_channel_missing` | A paired Harmony channel no longer exists. | |
| `harmony_channel_encrypted` | A channel is end-to-end encrypted. | `harmony_channel_id` |
| `rate_limited` | Discord is slowing the bridge down. | |
| `discord_unreachable` | The bridge can't reach Discord. | |
| `harmony_unreachable` | The bridge can't reach the instance. | |

Any other code shows as "The bridge reported a problem" with the code. The app derives `intent_missing`, `no_guild` and `bot_not_in_guild` from the status on its own as well.

### POST /pairs

Pairs a Discord channel with a Harmony channel, for a bridge that offers linking from the Discord side.

| Field | Type | Description |
|---|---|---|
| `discord_channel_id` | string | Required. A channel of the bridge's guild, as the last status report listed it. |
| `harmony_channel_id` | UUID | Required. A channel of the bridge's server that the bridge bot can see; not a category. |
| `direction` | string | `both` (default), `to_harmony` or `to_discord`. |
| `discord_channel_name` | string | Optional; defaults to the name in the snapshot. |

Sending an existing pair again updates its direction and name. Returns `201` with `{ "id", "harmony_channel_id", "discord_channel_id", "direction" }`.

| Status | Cause |
|---|---|
| `400` | A malformed ID or direction, a Harmony channel of another server, no guild selected yet, or a Discord channel not in the selected guild. |
| `403` | `The bridge bot cannot see that Harmony channel` |
| `409` | Either channel is already paired with another. |

### DELETE /pairs

`DELETE /bridge/v2/pairs/{discord channel id}` removes the pair of that Discord channel. Returns `204`, or `404` `That Discord channel is not paired`.

Adding or removing a pair changes the configuration, so the bridge receives `BRIDGE_CONFIG_UPDATE`.

### GET /hosted

For the instance's bridge host, not for community bridges. The request carries `X-Bridge-Host-Secret`, the secret the operator configured on the gateway and the host. Returns the bridges the instance runs with a community's own Discord bot:

```json
[{ "bridge_id": "1c5e…", "harmony_token": "harmony_bot_…", "discord_token": "…" }]
```

`404` while the gateway has no host secret of at least 32 characters or the instance does not host bridges; `401` `Invalid host secret`; `503` `Hosting state unavailable`.

### GET /hosted/instance

For the instance's bridge host. Same header. Returns the instance's own Discord bot and the bridges linked to it:

```json
{
  "application_id": "1100000000000000000",
  "discord_token": "…",
  "presence": false,
  "bridges": [{ "bridge_id": "1c5e…", "harmony_token": "harmony_bot_…", "discord_guild_id": "80351110224678912" }]
}
```

`presence` says whether the instance enables Discord presence for the shared bot. `404` while the instance bot is off or not configured.

### Discord authorize and callback

`GET /bridge/v2/discord/authorize?state=…` and `GET /bridge/v2/discord/callback` run the browser flow behind **Use *name*'s bot**: the app sends the server owner to `authorize`, which redirects to Discord's consent screen; Discord redirects back to `callback`, which links the Discord server to the bridge and returns the browser to the server's **Discord Bridge** settings with `linked=1` or a `link_error` (`state_invalid`, `guild_linked_elsewhere`, `discord_denied`, `exchange_failed`, `limit_reached`). Bridge programs do not call these routes. The operator registers `https://<instance>/bot-gateway/bridge/v2/discord/callback` as the Discord application's redirect URI.

## Relayed authors

A message the bridge posts for a Discord user carries that user in `metadata.discord_user`:

```json
{
  "content": "hello from Discord",
  "metadata": {
    "discord_user": {
      "id": "80351110224678915",
      "username": "alice",
      "display_name": "Alice",
      "avatar_url": "https://cdn.discordapp.com/avatars/…",
      "joined_at": "2024-03-01T10:00:00.000Z"
    },
    "discord_message_id": "1290000000000000000"
  }
}
```

The server keeps `discord_user` (and `bridge_source`) only from a bot of type Bridge whose bridge relays the channel; from any other bot it drops them. The app then shows the message under the Discord user's display name and avatar, and bots receive it with `author.discord_user: true`, `author.id` set to the Discord ID and `author.bot: false`.

With a numeric `id`, the server's AutoMod treats the relayed author as a person: message flood, duplicate and mention spam rules count that author's messages whether or not the server exempts bots, and new-member rules apply when `joined_at` parses, taking membership age from it and account age from the Discord ID. Other rules apply as to any bot's message. Timeouts are not applied to relayed authors. A blocked message answers `403` `AUTOMOD_BLOCKED`.

## Message mapping

A bridge keeps both sides' message IDs in the Harmony message's metadata.

| Direction | What the bridge does |
|---|---|
| Discord → Harmony | Post the message with `metadata.discord_message_id` (and `discord_user`). Find it later with [`GET /channels/{channel.id}/messages/lookup?discord_message_id=…`](/build/rest#look-up-a-bridged-message). |
| Harmony → Discord | On `MESSAGE_CREATE`, post to Discord, then record the Discord side with [`PATCH /messages/{message.id}/metadata`](/build/rest#merge-message-metadata): `discord_message_id`, `discord_message_ids`, `discord_via_webhook`, `discord_uploaded_files`, and `bridge_source: "harmony"`. A bridge may write these keys, and only these, on messages it did not author, in channels it relays. |

`MESSAGE_UPDATE` and `MESSAGE_DELETE` events carry the message's metadata, so the bridge finds the Discord copy from the event alone. To apply a Discord edit, the bridge edits its own message with `PATCH /messages/{message.id}`; to apply a Discord delete, it deletes with `DELETE /messages/{message.id}`, which needs `manage_messages` for messages it did not write. Skip events whose `author.id` is the bridge bot's own ID, or whose `metadata.discord_user` is set, to avoid echoing.

## Threads

Harmony threads pair with Discord threads per bridge.

- **Discord thread to Harmony.** Create it with [`POST /channels/{channel.id}/threads`](/build/rest#create-thread), passing `discord_thread_id`, the starter in `discord_user`, and `message_id` when the Discord thread started from a bridged message. The call is idempotent per Discord thread. Post the thread's messages with `thread_id`.
- **Harmony thread to Discord.** Messages in a thread arrive with `thread_id`. [`GET /threads/{thread.id}`](/build/rest#get-thread) returns `discord_thread_id: null` for an unpaired thread; create the Discord thread, then record it with [`PUT /threads/{thread.id}/discord`](/build/rest#pair-a-thread-with-a-discord-thread). The first pair stands.
- **Lookup.** [`GET /channels/{channel.id}/threads/lookup?discord_thread_id=…`](/build/rest#look-up-a-bridged-thread) finds the Harmony thread of a Discord thread.

## Reactions and emoji

- **Discord reaction to Harmony.** Add it with [`PUT /messages/{message.id}/reactions/{emoji}`](/build/rest#add-reaction), with `metadata.discord_user` naming the reacting Discord user. For an emoji with no Harmony counterpart, use an identifier such as `discord:name:id` and set `metadata.remote_emoji_url` to its Discord CDN URL. Remove it with `DELETE` and `{ "discord_user_id": "…" }`.
- **Harmony reaction to Discord.** `MESSAGE_REACTION_ADD` and `MESSAGE_REACTION_REMOVE` carry the emoji's name, image URL and ID.
- **Server emoji.** [`GET /servers/{server.id}/emojis`](/build/rest#list-server-emojis) lists the server's emoji with their `discord_emoji_id`, and [`POST /servers/{server.id}/emojis/discord`](/build/rest#import-a-discord-emoji) imports a Discord emoji once. A reaction with the mapped emoji's UUID counts together with Harmony members' reactions.

## Members and presence

A bridge registers the Discord members of each relayed channel with [op 6](/build/gateway#register-bridge-data-op-6), and sends their status changes with [op 7](/build/gateway#bridge-presence-update-op-7). The app lists them in mention autocomplete and the member list of the server. The registration lives in the gateway's memory, so send op 6 again after every reconnect.

## Attachments

Discord CDN attachment URLs expire. The instance administrator chooses how Harmony handles them for bridged messages:

| Mode | Behavior |
|---|---|
| `link` (default) | URLs are stored as the bridge sends them. |
| `refresh` | When a member views a bridged message whose Discord links have expired, the gateway sends the authoring bot [`REFRESH_ATTACHMENTS`](/build/gateway#refresh-attachments). The bridge renews the URLs with Discord and writes the parts back with [`PATCH /messages/{message.id}/content-silent`](/build/rest#patch-content-silently). |
| `mirror` | `file` and `url` parts pointing at `discordapp.com` or `discordapp.net` in created or edited messages are copied into the instance's storage, up to 50 MB each, and become `file` parts there. Photos and videos are stored without their location, camera and other metadata ([Photo and video metadata](/build/rest#photo-and-video-metadata)). A failed copy keeps the Discord URL. |

The gateway applies `mirror` on its own, so a bridge sends Discord URLs in every mode. Only `refresh` needs the bridge's help: it must answer `REFRESH_ATTACHMENTS`.

## Legacy pairing codes

Bridges set up before Bridge v2 used a pairing code, `HRM-XXXX-XXXX`, and a configuration file. `GET https://<instance>/bot-gateway/bridge-setup/{pairing code}` answers `{ "pairing_code", "server_id", "base_url", "gateway_url_remote", "api_url_remote", "gateway_url_colocated", "api_url_colocated" }`, or `400` for a malformed code and `404` for an unknown one. A legacy bridge bot (type Bridge, with no v2 bridge record) relays authors in every channel of a server that has such a pairing. The app offers server owners the move to the current bridge.
