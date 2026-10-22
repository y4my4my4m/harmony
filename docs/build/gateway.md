---
title: Gateway
description: Reference for the Harmony bot gateway WebSocket - connection URL, payloads, opcodes, identify, heartbeat, close codes, event delivery and every event payload.
---

# Gateway

The gateway is the WebSocket a bot keeps open to receive events. This page lists its URL, frame format, opcodes, close codes, the rules that decide which events a bot receives, and the payload of every event. To act on an event, use the [REST API](/build/rest).

## Connect

| Where | URL |
|---|---|
| Behind the instance's reverse proxy | `wss://<instance>/bot-gateway/gateway` |
| Directly, as in local development | `ws://localhost:3002/gateway` |

A bot may hold up to 5 identified connections, unless the instance sets `WS_MAX_CONNECTIONS_PER_BOT`; an identify past the limit closes that connection with `4029`. Every open connection of the bot receives every event, so a bot connected twice handles each event twice.

## Payloads

Every frame in both directions is a JSON object in a text frame:

| Field | Type | Description |
|---|---|---|
| `op` | integer | Opcode. |
| `t` | string | Event name. Present on opcode 0 only. |
| `d` | object | Event data, or the request body of an opcode the bot sends. |

## Opcodes

| Opcode | Name | Direction | Description |
|---|---|---|---|
| 0 | Dispatch | Receive | An event; `t` names it. |
| 1 | Heartbeat | Send | Keeps the connection open. `d` is not read. |
| 2 | Identify | Send | Authenticates the connection with the bot's token. |
| 6 | Register bridge data | Send | Bridge bots: the remote platform's members, for mention autocomplete. See [op 6](#register-bridge-data-op-6). |
| 7 | Bridge presence update | Send | Bridge bots: presence changes of members registered with op 6. See [op 7](#bridge-presence-update-op-7). |
| 11 | Heartbeat ACK | Receive | The answer to each op 1: `{ "op": 11 }`. |

The gateway ignores opcodes it does not know, and ignores op 1, 6 and 7 on a connection that has not identified. A frame that is not valid JSON, or that the gateway fails to handle (an identify whose `token` is not a string, for example), closes the connection with `1008`.

## Identify

Send opcode 2 once the socket is open. A connection that has not identified successfully 30 seconds after opening, unless the instance sets `WS_IDENTIFY_TIMEOUT_MS` (1 to 60 seconds), closes with `4003`.

```json
{ "op": 2, "d": { "token": "harmony_bot_…" } }
```

On success the gateway answers with a `READY` event:

```json
{
  "op": 0,
  "t": "READY",
  "d": {
    "bot": { "id": "3f6c1d2e-…", "username": "ping-bot" },
    "session_id": "b1a7e0c4-…",
    "heartbeat_interval": 30000
  }
}
```

| Field | Type | Description |
|---|---|---|
| `bot.id` | UUID | The bot's ID. Messages and reactions the bot writes carry it. |
| `bot.username` | string | The bot's username. |
| `session_id` | UUID | Identifies this connection. A new connection gets a new one. |
| `heartbeat_interval` | integer | Milliseconds between heartbeats. 30000 unless the instance sets `WS_HEARTBEAT_INTERVAL`. |

The connection starts receiving events before the gateway writes `READY`, so an event can arrive ahead of it. Handle `READY` in the same loop as other events rather than reading it as the first frame.

A refused token closes the connection with `4001` or `4004`, and an identify past the bot's connection limit with `4029`; see [Close codes](#close-codes).

## Heartbeat

Send `{ "op": 1 }` every `heartbeat_interval` milliseconds after `READY`. The gateway answers each with `{ "op": 11 }`.

Once per interval the gateway closes, with `1000` `Heartbeat timeout`, every connection whose last heartbeat, or whose identify when it has sent none, is more than twice the interval old. With the default interval, a bot that stops heartbeating is disconnected 60 to 90 seconds after its last heartbeat. The gateway sends the close frame and drops the connection without waiting for the bot's answer.

Heartbeats also keep the bot shown as **Online** in the app, which shows a bot offline once its last heartbeat is more than 90 seconds old.

## Frame rate limit

A connection may send 120 frames in any 60-second window. Heartbeats (op 1) are not counted; identify and bridge frames are. The frame over the limit closes the connection with `4008` `rate limited`, and frames already received behind it are dropped. Reconnect with a backoff.

## Close codes

| Code | Reason | Cause | Reconnect? |
|---|---|---|---|
| `1000` | `Heartbeat timeout` | No heartbeat for more than twice `heartbeat_interval`. | Yes |
| `1000` | `Server shutting down` | The gateway process is stopping. | Yes, with a backoff |
| `1008` | `Invalid payload` | A frame was not valid JSON or could not be handled. | Yes, after fixing the frame |
| `4001` | `Missing token` | Identify without `d.token`. | No |
| `4003` | `Not authenticated` | No successful identify within 30 seconds of the connection opening, or `WS_IDENTIFY_TIMEOUT_MS`. | Yes, and identify right after the socket opens |
| `4004` | `Invalid or expired token` | The token is unknown, revoked or past its expiry. | No |
| `4004` | `Bot not found or inactive` | The token is valid but its bot is deleted or deactivated. | No |
| `4004` | `Token verification unavailable` | The gateway could not look the token up. | Yes, with a backoff |
| `4004` | `Token revoked`, `Token expired`, `Bot inactive` | An open connection's token was reset, deleted or expired, or its bot was deactivated or deleted. The gateway rechecks open connections every 30 seconds unless the instance sets `WS_REVALIDATE_INTERVAL_MS` (1 to 60 seconds). | No |
| `4008` | `rate limited` | More than 120 frames other than op 1 within 60 seconds. | Yes, with a backoff |
| `4029` | `Too many connections` | The bot already holds 5 identified connections, or `WS_MAX_CONNECTIONS_PER_BOT`. | Yes, with a backoff, after closing a connection |

## Reconnect

There is no resume. After any close, open a new connection and identify again; `READY` carries a new `session_id`. The gateway does not queue events for a disconnected bot or replay them on reconnect. Events that occur while the gateway itself restarts are not sent either.

To recover messages missed while disconnected, read the channels you care about with [`GET /channels/{channel.id}/messages`](/build/rest#get-channel-messages).

## Event delivery

- **Server channels only.** Events come from channels of servers. Direct messages produce no events.
- **Readers.** A bot receives an event for a channel when it has an active installation in the channel's server with the `read_messages` permission, and it can see the channel: either the installation's channel list names it, or, without a list, @everyone can view it. See [Permissions and rate limits](/build/permissions-rate-limits#how-permissions-are-computed).
- **Own events.** A bot receives events for its own messages and reactions. Compare `author.id` or `bot_id` with `bot.id` from `READY` to skip them.
- **Every connection.** Each open connection of the bot receives each event.
- **Encrypted channels.** End-to-end encrypted messages produce no `MESSAGE_CREATE` or `MESSAGE_UPDATE`.
- **Timing.** The gateway reads the database on a schedule: new messages every second (up to 50 per read), edits and deletes every 2 seconds, reactions every 2 seconds (up to 100 new reactions per read).
- **Permission changes.** The gateway caches each server's installations and rechecks them every 10 seconds; a removed bot or changed permission or channel list affects delivery within about 10 seconds. Whether @everyone can view a channel is cached for 10 seconds.
- **Author details.** Usernames, display names and avatars are cached for 10 minutes and nicknames for 60 seconds, so a change can take that long to show in events.
- **No server ID.** Payloads carry `channel_id` and no server ID. [`GET /servers/{server.id}/channels`](/build/rest#list-channels) maps channels to servers.
- **No thread events.** Messages posted in a thread arrive as `MESSAGE_CREATE` with `thread_id` set; there is no separate thread event.

## Events

| Event | Sent when | Receivers |
|---|---|---|
| [`READY`](#ready) | Identify succeeds. | The identifying connection |
| [`MESSAGE_CREATE`](#message-create) | A message is posted in a server channel or thread. | Readers of the channel |
| [`MESSAGE_UPDATE`](#message-update) | A message's content changes. | Readers of the channel |
| [`MESSAGE_DELETE`](#message-delete) | A message is deleted. | Readers of the channel |
| [`MESSAGE_REACTION_ADD`](#message-reaction-add) | A reaction is added to a message. | Readers of the channel |
| [`MESSAGE_REACTION_REMOVE`](#message-reaction-remove) | A reaction is removed. | Readers of the channel |
| [`REFRESH_ATTACHMENTS`](#refresh-attachments) | A member asks for expired Discord attachment links of a bridged message to be renewed. | The bot that wrote the message |
| [`BRIDGE_CONFIG_UPDATE`](#bridge-config-update) | A Discord bridge's configuration changes. | The bridge's bot |

### READY

See [Identify](#identify).

### MESSAGE_CREATE

`d` is a message event object:

| Field | Type | Description |
|---|---|---|
| `id` | UUID | Message ID. |
| `channel_id` | UUID | Channel ID. A thread's messages carry the thread's parent channel. |
| `thread_id` | UUID or `null` | Thread the message was posted in. |
| `author` | object or `null` | The shown author; see [Authors](#authors). `null` when the author's account no longer exists. |
| `content` | string | The message's `text` parts joined with single spaces, trimmed. Mentions, emoji, links and files are not included; read them from `content_raw`. |
| `content_raw` | array | The stored message parts. See [Message parts](/build/rest#message-parts). |
| `is_system` | boolean | `true` for a notice the server generates, such as "Bob joined the server". See [System messages](#system-messages). |
| `reply_to` | UUID or `null` | ID of the message this one replies to. |
| `timestamp` | ISO 8601 | Creation time. |
| `edited_timestamp` | ISO 8601 | Time of the last content edit. Equal to `timestamp` until the content is edited. |
| `mentions` | string[] | The `user_id` field of each `mention` part. Mention parts the Harmony app writes carry `userId` instead and are absent here; read them from `content_raw`. |
| `mention_everyone` | boolean | `true` when the message mentions @everyone or @here and its author may: a member holding Mention Everyone in the channel, or a bot whose installation has `mention_everyone`. |
| `metadata` | object | Message metadata. Keys the server sets include `bot` and `created_via` (`bot_api` or `webhook`) on bot and webhook messages, `webhook` on webhook messages, and `embeds` once link previews are fetched. |

In `content_raw`, a `file` part whose `path` names an attachment stored on the instance carries a `url` signed for this event, valid for seven days. An `image` part of a `.jpg`, `.jpeg` or `.png` attachment also carries `render_url`, a signed rendition at most 1600 × 1600 pixels with the same lifetime; it is absent when the rendition cannot be signed.

```json
{
  "op": 0,
  "t": "MESSAGE_CREATE",
  "d": {
    "id": "0b9e5a61-…",
    "channel_id": "c2d4f8a0-…",
    "thread_id": null,
    "author": {
      "id": "8a1f3b77-…",
      "username": "alice",
      "display_name": "Alice",
      "avatar": "https://db.harmony.example.com/storage/v1/render/image/public/avatars/…",
      "nickname": "Al",
      "bot": false
    },
    "content": "!ping",
    "content_raw": [{ "type": "text", "text": "!ping" }],
    "is_system": false,
    "reply_to": null,
    "timestamp": "2026-10-13T12:00:00.000000+00:00",
    "edited_timestamp": "2026-10-13T12:00:00.000000+00:00",
    "mentions": [],
    "mention_everyone": false,
    "metadata": {}
  }
}
```

#### Authors

| Author kind | `id` | `bot` | Other fields |
|---|---|---|---|
| Member | Profile UUID | `false` | `nickname`: the member's nickname in the channel's server, or `null`. |
| Bot | Bot UUID | `true` | `nickname` is `null`. |
| Channel webhook | UUID of the webhook's hidden bot | `true` | `webhook: true`. `username` and `display_name` are the name the webhook posted under; `avatar` is its avatar URL or `null`. |
| Relayed Discord user | Discord user ID | `false` | `discord_user: true`, `nickname: null`. Set by a Discord bridge; see [Writing a bridge](/build/bridges#relayed-authors). |

`author.avatar` is an absolute URL. It is omitted when a member or bot has no avatar.

#### System messages

A system message has `is_system: true` and `author: null`: nobody wrote it. `metadata.type` says what happened and `metadata` names the people by profile UUID:

| `metadata.type` | People |
|---|---|
| `member_join`, `member_leave` | `subject_id`: the member |
| `member_kick`, `member_ban` | `subject_id`: the member; `actor_id`: the moderator; `reason` |
| `thread_created` | `actor_id`, or `actor_bot_id` and `discord_user` for a thread a bridge relayed; `thread_id`, `thread_name` |
| `channel_encryption_enabled`, `channel_encryption_disabled`, `channel_voice_encryption_enabled`, `channel_voice_encryption_disabled` | `actor_id` |
| `automod_alert` | `automod` |

`content` is English text for clients that do not know the type.

### MESSAGE_UPDATE

Sent when a message's stored content changes: an edit by its author, from the app or through the REST API, whatever the message's age. `d` is a message event object built from the edited message, with the same fields as `MESSAGE_CREATE`; `edited_timestamp` is the edit time.

No event is sent for changes that leave the content alone (metadata, pins, link previews) or for a [silent content patch](/build/rest#patch-content-silently).

### MESSAGE_DELETE

Sent once per message, when the message is deleted in the app or through the REST API.

| Field | Type | Description |
|---|---|---|
| `id` | UUID | Message ID. |
| `channel_id` | UUID | Channel ID. |
| `thread_id` | UUID or `null` | Thread the message was in. |
| `metadata` | object or `null` | The message's last metadata. |

A message removed from the database by other means, such as deleting its channel, produces no event.

### MESSAGE_REACTION_ADD

| Field | Type | Description |
|---|---|---|
| `reaction_id` | UUID | Reaction ID. |
| `message_id` | UUID | Message the reaction is on. |
| `channel_id` | UUID | Channel of that message. |
| `user_id` | UUID or `null` | Reacting member, when a member reacted. |
| `bot_id` | UUID or `null` | Reacting bot, when a bot reacted. |
| `emoji.id` | UUID or `null` | Custom emoji ID; `null` for a Unicode emoji or a bridged emoji stored without an emoji row. |
| `emoji.name` | string or `null` | Custom emoji shortcode, the Unicode character, or a bridged identifier such as `discord:name:id`. |
| `emoji.url` | string or `null` | Absolute image URL of a custom emoji. For a reaction without an emoji row, its `metadata.remote_emoji_url` when that is an `https` URL on Discord's CDN; otherwise `null`. |
| `emoji.animated` | boolean | `true` when `emoji.url` is a `.gif` or asks Discord's CDN for `animated=true`. |
| `metadata` | object | Reaction metadata; `{}` when unset. |

```json
{
  "op": 0,
  "t": "MESSAGE_REACTION_ADD",
  "d": {
    "reaction_id": "5e2c0b1d-…",
    "message_id": "0b9e5a61-…",
    "channel_id": "c2d4f8a0-…",
    "user_id": "8a1f3b77-…",
    "bot_id": null,
    "emoji": { "id": null, "name": "\ud83d\udc4d", "url": null, "animated": false },
    "metadata": {}
  }
}
```

### MESSAGE_REACTION_REMOVE

Same shape and values as the `MESSAGE_REACTION_ADD` of the removed reaction, as the gateway saw it when it was added. Match on `reaction_id`.

The gateway detects removals by checking a window of the 200 reactions it saw most recently, across the instance, every 2 seconds. Removing a reaction outside that window sends no event.

### REFRESH_ATTACHMENTS

Sent to the bot that wrote a message when all of these hold: the instance's bridge attachment mode is `refresh`, a member viewing the message asks for its expired Discord CDN links to be renewed, the message has a `file` or `url` part on `discordapp.com` or `discordapp.net`, and the bot is connected. Requests for the same message within 15 seconds produce one event.

```json
{
  "op": 0,
  "t": "REFRESH_ATTACHMENTS",
  "d": { "messageId": "0b9e5a61-…", "channelId": "c2d4f8a0-…", "content": [ … ] }
}
```

Field names in this event are camelCase. `content` is the message's stored parts. The bot renews the URLs and writes the parts back with a [silent content patch](/build/rest#patch-content-silently). See [Attachments](/build/bridges#attachments).

### BRIDGE_CONFIG_UPDATE

Sent to the bot of a Discord bridge: once on each new connection, at the gateway's first configuration check after identify, and again whenever the bridge's configuration changes (mode, guild, settings, or a channel pair added, removed or redirected). The gateway checks every 5 seconds unless the instance sets `BRIDGE_CONFIG_POLL_MS` (1 to 60 seconds). Status reports do not trigger it.

`d` is the same object [`GET /bridge/v2/config`](/build/bridges#get-config) returns, except that `base_url` is `null` when the instance has no configured public URL.

## Bridge opcodes

### Register bridge data (op 6)

Registers the remote platform's members for the channels a bridge relays. The app shows them in mention autocomplete and the member list. There is no reply.

```json
{
  "op": 6,
  "d": {
    "channels": [
      { "harmonyChannelId": "c2d4f8a0-…" },
      { "harmonyChannelId": "7d1e9b30-…", "members": [] }
    ],
    "members": [
      {
        "id": "80351110224678912",
        "username": "alice",
        "displayName": "Alice",
        "avatarUrl": "https://cdn.discordapp.com/avatars/…",
        "source": "discord"
      }
    ]
  }
}
```

- `channels` is required. An entry whose `harmonyChannelId` is not a UUID, is in a server where the bot has no active installation, or is a channel the bot cannot see, is dropped.
- A channel entry with its own `members` array, empty included, uses that list. The top-level `members` list applies to the entries without `members`, and only when those entries are all in one server; otherwise it is ignored.
- Each registration replaces the bot's previous one.
- The data lives in the gateway's memory while any connection of the bot is open, and is dropped when the last one closes.

| Member field | Type | Description |
|---|---|---|
| `id` | string | The member's ID on the remote platform. |
| `username` | string | |
| `displayName` | string | |
| `avatarUrl` | string | |
| `bannerUrl` | string or `null` | Optional. |
| `accentColor` | string or `null` | Optional. |
| `harmonyRoleIds` | string[] | Optional. Harmony roles the member corresponds to. |
| `roles` | array | Optional. Remote roles: `id`, `name`, `color`, `position`. |
| `joinedAt` | string or `null` | Optional. ISO 8601. |
| `createdAt` | string or `null` | Optional. ISO 8601. |
| `presenceStatus` | string | Optional. `online`, `away`, `busy` or `offline`. |
| `customStatus` | object or `null` | Optional. `{ "text", "emoji" }`. |
| `source` | string | `discord`. |

The gateway stores member objects as sent.

### Bridge presence update (op 7)

Changes the presence of members already registered with op 6, without registering again. There is no reply.

```json
{
  "op": 7,
  "d": {
    "updates": [
      { "id": "80351110224678912", "presenceStatus": "busy", "customStatus": { "text": "shipping", "emoji": "\ud83d\ude80" } },
      { "id": "80351110224678913", "presenceStatus": "offline", "customStatus": null }
    ]
  }
}
```

| Field | Description |
|---|---|
| `id` | The remote member's ID: 1 to 20 digits. Other entries are skipped. |
| `presenceStatus` | `online`, `away`, `busy` or `offline`. Absent or any other value leaves the stored status. |
| `customStatus` | `null` clears it; absent leaves it. `text` (a string, cut to 128 characters) is required; `emoji` is a string cut to 64 characters, or `null`. |

An update applies wherever the bot's last op 6 registration lists the member; IDs it does not list are ignored. The app sees the change on its next read of the member list.
