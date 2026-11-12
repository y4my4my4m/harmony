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
| `GET` | [`/imports`](#history-import) | Bridge bot token | List the bridge's history import jobs |
| `POST` | [`/imports`](#history-import) | Bridge bot token | Queue import jobs for pairs |
| `PATCH` | [`/imports/{id}`](#history-import) | Bridge bot token | Report a job's state and progress |
| `POST` | [`/imports/{id}/cancel`](#history-import) | Bridge bot token | Cancel a job |
| `POST` | [`/imports/{id}/messages`](#history-import) | Bridge bot token | Insert a batch of old messages |
| `POST` | [`/imports/{id}/threads`](#history-import) | Bridge bot token | Create an old thread |
| `POST` | [`/imports/{id}/replies/link`](#history-import) | Bridge bot token | Link imported replies to their originals |
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
| `history_import` | object | `{ "enabled": boolean, "reason": null \| "instance_off" \| "bridge_mode" }`. Whether this bridge may [import history](#history-import): the instance switch is on and the bridge's `mode` is `self`. Absent on a gateway before 1.9.7: treat as disabled. |
| `privacy_version` | string | Opaque. Changes whenever the server's [opt-out list](#privacy) changes; fetch the list again when it differs. |

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
| `rate_limited` | Discord or this instance is slowing the bridge down. | |
| `discord_unreachable` | The bridge can't reach Discord. | |
| `harmony_unreachable` | The bridge can't reach the instance. | |
| `message_content_needed_for_import` | A history import is waiting for the Message Content Intent. | |
| `private_threads_skipped` | A notice: the import left out a channel's private threads. It doesn't count as a problem to fix, and the bridge stays "online". | `discord_channel_id`, optional `count` |

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
- **Server emoji.** [`GET /servers/{server.id}/emojis`](/build/rest#list-server-emojis) lists the server's emoji with their `discord_emoji_id`, and [`POST /servers/{server.id}/emojis/discord`](/build/rest#import-a-discord-emoji) imports a Discord emoji once. [`GET /servers/{server.id}/emojis/discord`](/build/rest#list-discord-linked-emojis) lists the emoji limit and the Discord-linked emoji (removed ones too), `update` on the import renames or restores an imported emoji, and [`DELETE /servers/{server.id}/emojis/{emoji.id}`](/build/rest#remove-a-server-emoji) removes one. A reaction with the mapped emoji's UUID counts together with Harmony members' reactions.
- **Soundboard.** [`GET /servers/{server.id}/sounds`](/build/rest#list-server-sounds) lists the server's sounds, [`POST /servers/{server.id}/sounds/discord`](/build/rest#import-a-discord-sound) imports a Discord soundboard sound once, and [`DELETE /servers/{server.id}/sounds/{sound.id}`](/build/rest#delete-a-server-sound) removes one. The gateway downloads the clip itself.

## Members and presence

A bridge registers the Discord members of each relayed channel with [op 6](/build/gateway#register-bridge-data-op-6), and sends their status changes with [op 7](/build/gateway#bridge-presence-update-op-7). The app lists them in mention autocomplete and the member list of the server. The registration lives in the gateway's memory, so send op 6 again after every reconnect.

## Attachments

Discord CDN attachment URLs expire. The instance administrator chooses how Harmony handles them for bridged messages:

| Mode | Behavior |
|---|---|
| `link` (default) | URLs are stored as the bridge sends them. |
| `refresh` | When a member views a bridged message whose Discord links have expired, the gateway sends the authoring bot [`REFRESH_ATTACHMENTS`](/build/gateway#refresh-attachments). The bridge renews the URLs with Discord and writes the parts back with [`PATCH /messages/{message.id}/content-silent`](/build/rest#patch-content-silently). |
| `mirror` | `file` and `url` parts pointing at `discordapp.com` or `discordapp.net` in created or edited messages are copied into the instance's storage, up to the instance's upload ceiling each, and become `file` parts there. Photos and videos are stored without their location, camera and other metadata ([Photo and video metadata](/build/rest#photo-and-video-metadata)). A failed copy keeps the Discord URL. |

The gateway applies `mirror` on its own, so a bridge sends Discord URLs in every mode. Only `refresh` needs the bridge's help: it must answer `REFRESH_ATTACHMENTS`.

## History import

A bridge copies Discord messages as they arrive. History import copies a paired channel's older Discord messages into its Harmony channel, with their original dates. The bridge (2.6.0 and later) reads Discord and posts batches to the routes below; the gateway checks the bridge, the pair and the job on every call. A message imported this way notifies no one, changes no unread count, and is not federated or sent to bots, outgoing webhooks or other clients' realtime feeds; AutoMod and slowmode skip it. Its row carries `metadata.history_import: true` and `metadata.created_via: "history_import"`. The server drops `history_import` and `discord_reply_to` from the `metadata` a bot supplies on an ordinary send or a metadata merge, and refuses them (and any `created_via` other than the app's own) in a member's message.

All routes are under `/bridge/v2/imports`, take `Authorization: Bot <bridge bot token>`, and answer `404` `{ "code": "import_not_found" }` for a job that is not this bridge's, or an `id` that is not a UUID.

Import runs only for a bridge of `mode` `self` on an instance whose admin turned it on. Otherwise every route answers `403` `{ "code": "import_disabled", "reason": "instance_off" | "bridge_mode" }`. Read `history_import` in the [config](#get-config) and call these routes only while it is enabled: no polling, no command, for a bridge that may not import. The gateway names the feature `bridge_history_import` in its [capabilities](/build/gateway#ready).

A `429` carries `Retry-After` in seconds, repeated as `retry_after` in the body. It is a wait, not a failure: keep the job in its state and try again after it.

### Jobs

One job covers one pair. A pair is importable when its direction is `both` or `to_harmony` and its Harmony channel is not encrypted. The app's settings create jobs too, so the bridge lists jobs and works the ones it finds.

States: `queued`, `running`, `paused`, `done`, `failed`, `cancelled`. Phases: `messages`, `threads`, `replies`.

```json
{
  "id": "…", "harmony_channel_id": "…", "discord_channel_id": "1400000000000000100",
  "state": "running", "phase": "messages", "cancel_requested": false,
  "start_discord_message_id": "…", "start_at": "2023-06-01T00:00:00Z",
  "reached_discord_message_id": "…", "reached_at": "2023-03-02T09:14:00Z",
  "channel_created_at": "2023-01-01T00:00:00Z",
  "threads_total": null, "threads_done": 0, "thread_cursor": null,
  "imported_count": 1200, "skipped_count": 3, "pins_skipped": 0,
  "authors_skipped": 14, "automod_skipped": 0,
  "error": null, "requested_via": "harmony", "requested_by_remote": null,
  "created_at": "…", "updated_at": "…", "finished_at": null
}
```

| Route | Body | Answer |
|---|---|---|
| `GET /imports` | none | `200` `{ "imports": [job] }`: this bridge's jobs in every state, oldest first |
| `GET /imports/{id}` | none | `200` `{ "import": job }` |
| `POST /imports` | `{ "discord_channel_ids": ["…"], "requested_by": { "id": "…", "username": "…" } }`; omit the ids to queue every importable pair; `[]` queues nothing. `requested_by` is the Discord member who ran the command; the job keeps it as `requested_by_remote` | `201` `{ "imports": [job] }`, requested via `discord` |
| `PATCH /imports/{id}` | Any of `state`, `phase`, `start_discord_message_id`, `start_at`, `reached_discord_message_id`, `reached_at`, `channel_created_at`, `threads_total`, `threads_done`, `thread_cursor`, `error` (200 characters are kept), `authors_skipped` | `200` `{ "import": job }` |
| `POST /imports/{id}/cancel` | none | `200` `{ "imports": [job] }` |
| `POST /imports/{id}/messages` | `{ "messages": [message] }`, 1 to 100 | `200` `{ "inserted": [{ "discord_message_id", "id" }], "skipped": ["…"], "rejected": [{ "discord_message_id", "reason" }] }` |
| `POST /imports/{id}/threads` | A thread, below | `200` `{ "thread_id": "…" }` |
| `POST /imports/{id}/replies/link` | none | `200` `{ "linked": 12 }` |

| Status and code | Cause |
|---|---|
| `400` `pair_not_importable` (with `discord_channel_id`) | `POST /imports` named a channel that is unpaired, one-way to Discord, or encrypted |
| `400` `invalid_request` | Malformed `discord_channel_ids` |
| `400` `invalid_patch` | A `PATCH` body that is not an object, or has a value out of range |
| `400` `invalid_batch` | A body that is not a list of 1 to 100 messages. A message that cannot be stored does not fail the batch; see `rejected` under [Messages](#messages) |
| `403` `import_disabled` (with `reason`) | Import is off for this bridge; any route |
| `429` `import_busy` | `PATCH` asked for `running` while the instance runs its maximum number of imports. A running job silent for 10 minutes gives its slot away and is set to `paused` |
| `429` `import_rate_limited` | `POST messages` past the instance's messages per minute for one import. Nothing was stored; send the same batch after the wait, at most 60 s |
| `400` `invalid_thread` | A thread body that is not an object or has bad values |
| `409` `invalid_transition` | `PATCH` asked for a state change the job's state does not allow |
| `409` `import_not_running` | The job is not `running`. A job whose pair was removed, whose channel became encrypted, or whose import was turned off is set to `failed` with `error` `pair_removed`, `channel_encrypted` or `import_disabled`; stop it and do not retry |
| `500` | `{ "error": "Import request failed" }` |

`PATCH` moves a job from `queued` to `running`, from `running` to `paused`, `done` or `failed` (with `error`), and from `paused` back to `running`. It moves a job to `cancelled` only after `cancel_requested` is true: poll `GET /imports` for that flag, and stop when it is set. A person restarting a `failed`, `cancelled` or `paused` job in the app sets it back to `queued` with its cursors kept.

Report `reached_discord_message_id` and `reached_at` after each committed batch, and `phase`, `threads_total` and `threads_done` as the job moves on; the app draws its progress from `start_at`, `reached_at` and `channel_created_at`. Resume a job found `running` or `queued` after a restart from its stored `reached_discord_message_id`.

### Messages

Walk the Discord channel from its newest message back to its first, skipping messages by bots and system messages as the live relay does. Send up to 100 messages per call, each built like a live relayed message:

| Field | Type | Description |
|---|---|---|
| `discord_message_id` | string | Required. Digits. The dedupe key. |
| `created_at` | ISO 8601 | Required. The Discord timestamp. |
| `edited_at` | ISO 8601 | Optional. The message then reads as edited. |
| `content` | array | Required. Harmony content parts, as for an ordinary send. |
| `discord_user` | object | The `metadata.discord_user` a relayed message carries. |
| `reply_to_discord_message_id` | string or null | The replied-to Discord message; linked at once if it is in the channel, otherwise by `replies/link`. |
| `thread_id` | UUID or null | The Harmony thread from `POST threads`. |
| `pinned` | boolean | Pin the message, up to 50 per channel; the rest increment `pins_skipped`. |

Content runs through the same pipeline as an ordinary send, with the instance's [attachment policy](#attachments). User and role mention parts are stored as text: imported history pings nobody.

Leave out messages whose author is no longer a member of the guild and messages of authors on the opt-out list, and report the run's total of those in `authors_skipped`.

`inserted` lists the new rows. `skipped` lists every other ID of the batch: IDs already in the channel (live relayed, or imported before) and IDs dropped because their content came out empty. Sending a batch again is harmless: it answers all `skipped`. `rejected` lists messages that were refused alone, with a `reason`; the rest of the batch is unaffected, and each rejected ID is also in `skipped`, so a bridge that ignores `rejected` still sees every ID answered. A rejection is final: do not send that message again, except `too_long`, which the bridge may shorten and send in a later batch.

| `reason` | Cause |
|---|---|
| `invalid` | A field of the wrong type, a date that is no date, a `thread_id` that is not a thread of the channel, or a content part the server refuses |
| `future_date` | `created_at` or `edited_at` more than a minute ahead of the gateway's clock. Start the walk a few minutes behind now |
| `opted_out` | The author opted out of this server's bridge; see [Privacy](#privacy) |
| `automod` | A blocking keyword, invite or link rule of the server's AutoMod, when its bots are not exempt. Counted in `automod_skipped` |
| `too_long` | Over the instance's message length limit, 2000 characters by default while Discord allows 4000 |
| `check_violation` | Another check of the messages table |

An entry without a usable `discord_message_id` is answered nowhere. A live message and a batch that carry the same `discord_message_id` leave one row. `imported_count` counts only inserted rows, so do not read `skipped` as imported.

Mirroring attachments makes a batch slow; use a generous HTTP timeout.

### Threads

After the channel's messages, list the Discord threads (active and archived public; skip Discord's private threads, since every Harmony thread is visible to the whole channel) and create each one:

```json
{
  "discord_thread_id": "1400000000000000300", "name": "Weekend",
  "created_at": "2023-02-01T12:00:00Z",
  "starter_discord_message_id": "…", "discord_user": { "id": "…", "username": "dana" },
  "archived": true, "locked": false
}
```

The call is idempotent per `discord_thread_id`. A starter that is not in Harmony makes a standalone thread. Send the thread's messages with the returned `thread_id` in each message.

### Replies

Messages arrive newest first, so a reply often precedes its target. After the thread phase, set `phase` to `replies` and call `POST /imports/{id}/replies/link` once: it links every imported reply whose target is now in the channel. A target that never arrives stays an unresolved reply.

## Privacy

A remote user opts out of a server's bridge, and has what the bridge brought erased. The routes are under `/bridge/v2/privacy`, take the bridge bot token, serve every bridge mode, and act on the bridge's server. `{id}` is a Discord user ID; anything else answers `400` `{ "code": "invalid_remote_user" }`. The gateway names the feature `bridge_privacy` in its [capabilities](/build/gateway#ready).

| Route | Body | Answer |
|---|---|---|
| `GET /privacy/optouts` | none | `200` `{ "version": "…", "remote_user_ids": ["…"] }`. `version` equals the config's `privacy_version` |
| `GET /privacy/optouts/{id}` | none | `200` `{ "opted_out": boolean, "since": "…" \| null, "source": "self" \| "manager" \| "admin" \| null }` |
| `PUT /privacy/optouts/{id}` | none | The status, `opted_out` `true` |
| `DELETE /privacy/optouts/{id}` | none | The status. Opting in lifts the user's own opt-out only: after a removal by a server manager or an instance admin the answer still has `opted_out` `true` with that `source` |
| `POST /privacy/erase` | `{ "remote_user_id": "…" }` | `202` `{ "opted_out": true, "erased": 37, "more": false }`. Opts the user out and deletes their relayed and imported messages, reactions and AutoMod events in this server. With `more` `true` the gateway finishes in the background. `429` `erase_recent` for the same user within 60 s |

A bridge keeps the list and sends nothing of an opted-out author: no message, edit, reaction or thread. The gateway enforces it as well:

- `POST /channels/{id}/messages` and an edit whose `metadata.discord_user.id` is opted out answer `403` `{ "code": "BRIDGE_AUTHOR_OPTED_OUT" }`. Drop the message; do not retry.
- A batch of [history import](#history-import) answers `rejected` with `reason` `opted_out` for it.
- A delete is always accepted.

Erasing deletes rows without a `MESSAGE_DELETE` event, so a bridge that mirrors Harmony deletes to the remote platform leaves the originals there. The first message of a thread stays as a deleted row without content or author (`metadata.bridge_erased`), also without an event.

Offer the choice where the remote user is: the Discord bridge registers `/bridge-privacy` (`opt-out`, `opt-in`, `status`, `erase`) for every member, answers only to the caller, and acts on the caller's own ID.

## Legacy pairing codes

Bridges set up before Bridge v2 used a pairing code, `HRM-XXXX-XXXX`, and a configuration file. `GET https://<instance>/bot-gateway/bridge-setup/{pairing code}` answers `{ "pairing_code", "server_id", "base_url", "gateway_url_remote", "api_url_remote", "gateway_url_colocated", "api_url_colocated" }`, or `400` for a malformed code and `404` for an unknown one. A legacy bridge bot (type Bridge, with no v2 bridge record) relays authors in every channel of a server that has such a pairing. The app offers server owners the move to the current bridge.
