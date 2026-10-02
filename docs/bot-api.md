---
title: Bot API
description: Gateway and REST reference for Harmony bots
---

# Bot API

A Harmony bot receives events over a WebSocket gateway and acts through a REST API. Both authenticate with the bot's token. The `bot-gateway` service implements both.

The protocol is modeled on Discord's gateway: dispatch, heartbeat, identify and heartbeat-ACK use opcodes 0, 1, 2 and 11, and REST requests carry `Authorization: Bot <token>`. It is not Discord-compatible. There is no HELLO, RESUME, sequence number or intent; the heartbeat interval arrives in READY; IDs are UUIDs; routes, payloads and pagination differ. Discord libraries do not work unmodified.

## Endpoints

| | URL |
|---|---|
| Gateway | `wss://<instance>/bot-gateway/gateway` |
| REST base | `https://<instance>/bot-gateway/api/v1` |

`<instance>` is the host that serves the Harmony web app. Without a reverse proxy, as in local development, the URLs are `ws://localhost:3002/gateway` and `http://localhost:3002/api/v1`. The bot's page in User Settings shows both URLs for its instance.

## Quick start

1. **Create the bot.** Open **User Settings → My Bots** and select **New bot**. The username is 3 to 32 lowercase letters, digits, hyphens or underscores and cannot be changed later. Any server owner can find and add a public bot; only its creator can add a private one.
2. **Copy the token.** It is shown once, in a dialog after creation. Store it in a secret manager or an environment variable.
3. **Add the bot to a server**, either:
   - from the bot's page, under **Add to server**, which lists the servers you own. The bot joins with `read_messages`, `send_messages` and `add_reactions`; or
   - from the server, under **Server Settings → Advanced → Server Bots**, which lists public bots.

   Permissions and channel access are edited under **Server Settings → Advanced → Server Bots**.
4. **Connect.** Open the gateway, send IDENTIFY, heartbeat at the interval given in READY, and call the REST API. See [Examples](#examples).

To check a token:

```bash
curl -H "Authorization: Bot $HARMONY_BOT_TOKEN" \
  https://<instance>/bot-gateway/api/v1/users/@me
```

## Tokens

A token is `harmony_bot_` followed by 64 hex characters. Harmony stores its SHA-256 hash, not the token, so a lost token cannot be recovered. The bot's page shows the token's last four characters, when it was created and when it was last used.

**Reset token** on the bot's page revokes the current token and shows the replacement once. REST requests with the old token fail with `401` from that moment, and an IDENTIFY with it closes with `4004`. A gateway connection already authenticated with the old token closes with `4004` at the gateway's next recheck of open connections, every 30 seconds by default.

## Gateway

### Payloads

Every frame is a JSON object:

| Field | Type | Description |
|---|---|---|
| `op` | integer | Opcode |
| `t` | string | Event name; op 0 only |
| `d` | object | Event data or request body |

| Opcode | Name | Direction | Description |
|---|---|---|---|
| 0 | Dispatch | receive | An event. `t` names it. |
| 1 | Heartbeat | send | Keeps the connection open. |
| 2 | Identify | send | Authenticates the connection. |
| 6 | Register bridge data | send | Bridge bots only; see [Bridge support](#bridge-support). |
| 11 | Heartbeat ACK | receive | Reply to op 1: `{ "op": 11 }`. |

The gateway ignores unknown opcodes, and ignores op 1 and op 6 until IDENTIFY succeeds. A frame that is not valid JSON closes the connection with `1008`.

### Identify

Send op 2 after the socket opens:

```json
{
  "op": 2,
  "d": { "token": "harmony_bot_…" }
}
```

On success the gateway replies with READY:

```json
{
  "op": 0,
  "t": "READY",
  "d": {
    "bot": { "id": "3f6c1d2e-…", "username": "deploy-bot" },
    "session_id": "b1a7e0c4-…",
    "heartbeat_interval": 30000
  }
}
```

| Field | Description |
|---|---|
| `bot.id` | The bot's ID. Messages the bot sends carry it as `author.id`. |
| `bot.username` | The bot's username. |
| `session_id` | UUID for this connection. |
| `heartbeat_interval` | Milliseconds between heartbeats. The instance default is 30000. |

The connection is registered for events before READY is written, so a dispatch can precede READY on the same socket. Handle READY in the same loop as other events rather than reading it as the first frame.

### Heartbeat

Send `{ "op": 1 }` every `heartbeat_interval` milliseconds. The gateway answers each with `{ "op": 11 }`. Once per interval it closes any connection that has not sent a heartbeat, or identified, within the last `2 × heartbeat_interval`.

### Close codes

| Code | Reason | Cause |
|---|---|---|
| `4001` | Missing token | IDENTIFY without `d.token`. |
| `4004` | Authentication failed | Token unknown, revoked or expired, or the bot is inactive. Also sent when the token lookup fails on the server. |
| `4004` | Token revoked, Token expired, Bot inactive | An open connection's token was revoked, rotated or deleted, or expired, or its bot was deactivated or deleted. Checked every 30 seconds by default. |
| `1008` | Invalid payload | Frame is not valid JSON. |
| `1000` | Heartbeat timeout | No heartbeat for more than `2 × heartbeat_interval`. |
| `1000` | Server shutting down | The gateway process is stopping. |

### Reconnecting

There is no RESUME. After any close, open a new connection and IDENTIFY again; READY carries a new `session_id`. Events that occur while the bot is disconnected are not queued or replayed. Recover missed messages with [`GET /channels/{channel.id}/messages`](#get-channel-messages) and `after`.

### Event delivery

- Message and reaction events go to every bot with an active installation holding `read_messages` that can view the channel; see [Permissions](#permissions).
- Every open connection of the bot receives each event. A bot connected twice receives everything twice.
- A bot receives events for its own messages and reactions. Compare `author.id` or `bot_id` with `bot.id` from READY.
- Encrypted messages produce no `MESSAGE_CREATE` or `MESSAGE_UPDATE`.
- Direct messages produce no events.
- Events are produced by polling the database: new messages every second; edits, deletes and reactions every 2 seconds. Edits, deletes and reaction removals are detected on a bounded window of recently seen messages and reactions; changes to older ones produce no event.
- The gateway caches each server's installations for 5 minutes. Permission changes and removals affect event delivery within that time.
- Payloads carry `channel_id` and no server ID.

### Events

| Event | Sent when |
|---|---|
| `READY` | IDENTIFY succeeds. |
| `MESSAGE_CREATE` | A message is posted in a server channel. |
| `MESSAGE_UPDATE` | A message's content changes. |
| `MESSAGE_DELETE` | A message is deleted. |
| `MESSAGE_REACTION_ADD` | A reaction is added. |
| `MESSAGE_REACTION_REMOVE` | A reaction is removed. |
| `REFRESH_ATTACHMENTS` | Bridge bots only; see [Bridge support](#bridge-support). |

#### MESSAGE_CREATE

`d` is a message event object:

| Field | Type | Description |
|---|---|---|
| `id` | UUID | Message ID. |
| `channel_id` | UUID | Channel ID. |
| `author` | object or `null` | `null` when the author's account no longer exists. |
| `author.id` | string | Profile or bot UUID. A Discord user ID when `author.discord_user` is `true`. |
| `author.username` | string | |
| `author.display_name` | string | |
| `author.avatar` | string | Absolute URL. Omitted when the author has no avatar. |
| `author.bot` | boolean | `true` when a bot wrote the message. |
| `author.discord_user` | boolean | Present and `true` when a bridge bot relayed the message from Discord. See [Bridge support](#bridge-support). |
| `content` | string | The `text` parts of the message joined with single spaces, trimmed. Mention, emoji, URL and file parts are not included. |
| `content_raw` | array | The stored message parts. |
| `is_system` | boolean | `true` for system messages. |
| `reply_to` | UUID or `null` | ID of the message this one replies to. |
| `timestamp` | ISO 8601 | Creation time. |
| `edited_timestamp` | ISO 8601 | Time of the last content edit. Equal to `timestamp` until the content is edited. |
| `mentions` | string[] | The `user_id` field of each `mention` part. Mention parts written by the Harmony web client carry `userId` instead and are absent here; read them from `content_raw`. |
| `metadata` | object | Message metadata. |

```json
{
  "op": 0,
  "t": "MESSAGE_CREATE",
  "d": {
    "id": "0b9e5a61-…",
    "channel_id": "c2d4f8a0-…",
    "author": {
      "id": "8a1f3b77-…",
      "username": "alice",
      "display_name": "Alice",
      "avatar": "https://db.harmony.example.com/storage/v1/render/image/public/avatars/…",
      "bot": false
    },
    "content": "!ping",
    "content_raw": [{ "type": "text", "text": "!ping" }],
    "is_system": false,
    "reply_to": null,
    "timestamp": "2026-09-30T12:00:00.000Z",
    "edited_timestamp": "2026-09-30T12:00:00.000Z",
    "mentions": [],
    "metadata": {}
  }
}
```

#### MESSAGE_UPDATE

Sent when a message's stored content changes, including a [silent content patch](#patch-content-silently). Metadata-only changes send nothing.

`d` is a message event object built from the edited row, with three differences: `timestamp` is omitted, `reply_to` is `null` and `is_system` is `false`, whatever the original message holds.

#### MESSAGE_DELETE

Sent for soft and hard deletes.

| Field | Type | Description |
|---|---|---|
| `id` | UUID | Message ID. |
| `channel_id` | UUID | Channel ID. |
| `metadata` | object | The message's last known metadata. |

#### MESSAGE_REACTION_ADD

| Field | Type | Description |
|---|---|---|
| `reaction_id` | UUID | Reaction ID. |
| `message_id` | UUID | Message the reaction is on. |
| `channel_id` | UUID | Channel of that message. |
| `user_id` | UUID or `null` | Reacting user, when a user reacted. |
| `bot_id` | UUID or `null` | Reacting bot, when a bot reacted. |
| `emoji.id` | UUID or `null` | Custom emoji ID; `null` for Unicode emoji. |
| `emoji.name` | string or `null` | Custom emoji shortcode, or the Unicode character. |
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
    "emoji": { "id": null, "name": "\ud83d\udc4d" },
    "metadata": {}
  }
}
```

#### MESSAGE_REACTION_REMOVE

Same shape as `MESSAGE_REACTION_ADD`. Only `reaction_id`, `message_id` and `channel_id` are populated: `user_id` and `bot_id` are `null`, `emoji` is `{ "id": null, "name": null }` and `metadata` is `{}`. Match `reaction_id` against earlier `MESSAGE_REACTION_ADD` events to identify the removed reaction.

## REST API

### Requests

- Base URL: `https://<instance>/bot-gateway/api/v1`.
- Every request carries `Authorization: Bot <token>`: the word `Bot`, one space, the token.
- Request bodies are JSON with `Content-Type: application/json`, up to 10 MB.
- IDs are UUIDs. Timestamps are ISO 8601.
- Error bodies are `{ "error": "<message>" }`. See [Errors](#errors).

### Access

Each route requires one of these access levels:

| Access | Meaning |
|---|---|
| Token | Any valid bot token. |
| Installed | The bot has an active installation in the server. |
| *permission* | The installation grants that permission. For routes addressed by channel or message, the server is the channel's server, and the channel must allow it; see [Channel access](#channel-access). |

The API has no route that lists the servers a bot is installed in or resolves a channel to its server.

### Routes

| Method | Path | Access |
|---|---|---|
| `POST` | [`/channels/{channel.id}/messages`](#create-message) | `send_messages` |
| `GET` | [`/channels/{channel.id}/messages`](#get-channel-messages) | `read_messages` |
| `GET` | [`/messages/{message.id}`](#get-message) | `read_messages` |
| `PATCH` | [`/messages/{message.id}`](#edit-message) | `send_messages`, own messages |
| `DELETE` | [`/messages/{message.id}`](#delete-message) | Visible channel for own messages; `manage_messages` otherwise |
| `PUT` | [`/messages/{message.id}/reactions/{emoji}`](#add-reaction) | `add_reactions` |
| `DELETE` | [`/messages/{message.id}/reactions/{emoji}`](#remove-reaction) | `add_reactions` |
| `POST` | [`/channels/{channel.id}/typing`](#trigger-typing) | `send_messages` |
| `GET` | [`/servers/{server.id}`](#get-server) | Installed |
| `GET` | [`/servers/{server.id}/members`](#list-members) | Installed |
| `GET` | [`/servers/{server.id}/channels`](#list-channels) | Installed |
| `POST` | [`/servers/{server.id}/channels`](#create-channel) | `manage_channels` |
| `PATCH` | [`/channels/{channel.id}`](#edit-channel) | `manage_channels` |
| `GET` | [`/servers/{server.id}/categories`](#list-categories) | Installed |
| `POST` | [`/servers/{server.id}/categories`](#create-category) | `manage_channels` |
| `PATCH` | [`/servers/{server.id}/categories/{category.id}`](#edit-category) | `manage_channels` |
| `GET` | [`/servers/{server.id}/roles`](#list-roles) | Installed |
| `POST` | [`/servers/{server.id}/roles`](#create-role) | `manage_channels` |
| `PATCH` | [`/servers/{server.id}/roles/{role.id}`](#edit-role) | `manage_channels` |
| `DELETE` | [`/servers/{server.id}/roles/{role.id}`](#delete-role) | `manage_channels` |
| `GET` | [`/channels/{channel.id}/permission-overrides`](#list-permission-overrides) | Installed |
| `PUT` | [`/channels/{channel.id}/permission-overrides`](#set-permission-override) | `manage_channels` |
| `DELETE` | [`/channels/{channel.id}/permission-overrides/role/{role.id}`](#delete-role-override) | `manage_channels` |
| `GET` | [`/users/@me`](#get-current-bot) | Token |
| `GET` | [`/users/{user.id}`](#get-user) | Token |
| `GET` | [`/invites/{code}/preview`](#get-invite-preview) | Token |
| `GET` | [`/emojis`](#list-emojis) | Token |
| `POST` | [`/emojis`](#create-emoji) | Token |
| `GET` | [`/channels/{channel.id}/messages/lookup`](#look-up-bridged-message) | `read_messages` |
| `PATCH` | [`/messages/{message.id}/content-silent`](#patch-content-silently) | `send_messages`, own messages |
| `PATCH` | [`/messages/{message.id}/metadata`](#merge-message-metadata) | `send_messages` |

`/guilds/{server.id}`, `/guilds/{server.id}/members` and `/guilds/{server.id}/channels` are deprecated aliases of the `/servers/…` routes with the same behavior.

### Messages

#### Message object

REST routes return a subset of the [message event object](#message-create):

| Field | Type | Description |
|---|---|---|
| `id` | UUID | |
| `channel_id` | UUID | |
| `author` | object or `null` | `id`, `username`, `display_name`, `avatar`, `bot`. |
| `content` | string | `text` parts joined with single spaces. |
| `reply_to` | UUID or `null` | |
| `timestamp` | ISO 8601 | Creation time. |
| `edited_timestamp` | ISO 8601 | Time of the last content edit; equal to `timestamp` until edited. |
| `mentions` | string[] | As in the event object. |
| `metadata` | object | |

REST message objects have no `content_raw` or `is_system`, and `author` never carries `discord_user`; a bridged message's author is the bridge bot.

#### Create message

`POST /channels/{channel.id}/messages`

| Field | Type | Description |
|---|---|---|
| `content` | string or array | A string becomes one `{ "type": "text", "text": … }` part. An array is stored as the message's parts. |
| `embeds` | object[] | Each object is appended to the parts as `{ "type": "embed", …object }`. Not validated. |
| `reply_to` | UUID | Message to reply to. |
| `metadata` | object | Merged over `{ "bot": true, "created_via": "bot_api" }`. |

A message needs at least one part; a request that produces none fails with `500`. Part shapes follow `MessagePart` in `src/types/chat.ts`. For example, a mention:

```json
{
  "content": [
    { "type": "mention", "userId": "8a1f3b77-…", "username": "alice", "domain": "harmony.example.com", "isLocal": true },
    { "type": "text", "text": " deploy finished" }
  ]
}
```

There is no upload route; `file` parts reference URLs.

Returns `201` with the message object. After the insert the gateway asks the federation backend to generate link previews for the message.

#### Get channel messages

`GET /channels/{channel.id}/messages`

| Query | Default | Description |
|---|---|---|
| `limit` | 50 | Maximum number of messages. |
| `before` | | ISO 8601 timestamp. Messages created before it. |
| `after` | | ISO 8601 timestamp. Messages created after it. |

Returns message objects, newest first, with or without `after`. Soft-deleted and encrypted messages are not filtered out.

#### Get message

`GET /messages/{message.id}`

Returns the message object. This route resolves bot authors only: `author` is `null` on messages written by users.

#### Edit message

`PATCH /messages/{message.id}`

| Field | Type | Description |
|---|---|---|
| `content` | string or array | Replaces the message's parts. |

Only messages the bot wrote. `embeds` is ignored. Returns the message object. Editing another author's message, or an unknown ID, returns `403` `Cannot edit messages from other bots or users`.

#### Delete message

`DELETE /messages/{message.id}`

Deletes the row. The bot's own messages need only a channel the bot sees; other messages need `manage_messages` too. Returns `204`.

#### Trigger typing

`POST /channels/{channel.id}/typing`

Has no effect. Answers as a message to the channel would: `204` where the bot may send, `403` otherwise.

### Reactions

`{emoji}` is a custom emoji's UUID or a URL-encoded Unicode emoji, for example `%F0%9F%91%8D`.

#### Add reaction

`PUT /messages/{message.id}/reactions/{emoji}`

Optional body: `{ "metadata": { … } }`, stored on the reaction. Returns `204`.

#### Remove reaction

`DELETE /messages/{message.id}/reactions/{emoji}`

Removes the bot's own reactions with that emoji from the message. Returns `204`, including when there was nothing to remove. Optional body `{ "discord_user_id": "…" }` limits the removal to reactions whose `metadata.discord_user.id` matches.

### Servers

#### Get server

`GET /servers/{server.id}`

| Field | Type | Description |
|---|---|---|
| `id` | UUID | |
| `name` | string | |
| `owner_id` | | The server's owner. |
| `description` | string or `null` | |
| `member_count` | integer | |

#### List members

`GET /servers/{server.id}/members`

| Query | Default | Description |
|---|---|---|
| `limit` | 100 | Maximum number of members. |

Returns member objects. The list is not ordered and not filtered by membership status, so pending and banned memberships appear.

| Field | Type | Description |
|---|---|---|
| `user.id` | UUID | Profile ID. |
| `user.username` | string | |
| `user.display_name` | string | |
| `user.domain` | string or `null` | Instance domain. |
| `user.is_local` | boolean | |
| `user.avatar` | string | Absolute URL; omitted when unset. |
| `nick` | string or `null` | Server nickname. |
| `roles` | array | Always empty; role assignments are not exposed. |

#### List channels

`GET /servers/{server.id}/channels`

Returns channel objects ordered by `order`.

| Field | Type | Description |
|---|---|---|
| `id` | UUID | |
| `type` | integer | `0` for every channel, voice channels included. |
| `guild_id` | UUID | Server ID. |
| `name` | string | |
| `position` | integer | Same value as `order`. |
| `order` | integer | Sort position. |
| `parent_id` | UUID or `null` | Same value as `category_id`. |
| `category_id` | UUID or `null` | Category ID. |

#### Create channel

`POST /servers/{server.id}/channels`

| Field | Type | Description |
|---|---|---|
| `name` | string | Required. Trimmed and cut to 100 characters. |
| `type` | integer | `1` creates a voice channel; any other value a text channel. |
| `category_id` | UUID or `null` | |
| `description` | string | Cut to 1024 characters. |
| `order` | integer | Default `0`. |

Returns `201` with the channel object.

#### Edit channel

`PATCH /channels/{channel.id}`

| Field | Type | Description |
|---|---|---|
| `order` | integer | |
| `category_id` | UUID or `null` | `null` removes the channel from its category. |

Other fields are ignored; a body with neither returns `400`. Returns the channel object.

#### List categories

`GET /servers/{server.id}/categories`

Returns category rows ordered by `order`: `id`, `server_id`, `name`, `order`, `created_at`, `updated_at`, `federation_status`.

#### Create category

`POST /servers/{server.id}/categories`

| Field | Type | Description |
|---|---|---|
| `name` | string | Required. Trimmed and cut to 100 characters. |
| `order` | integer | Default `0`. |

Returns `201` with the category row.

#### Edit category

`PATCH /servers/{server.id}/categories/{category.id}`

Body: `name`, `order`, as in create. A body with neither returns `400`. Returns the category row.

### Roles

Role and override permissions are Harmony role-permission bitmasks. Requests accept them as a decimal string or a number; send strings for values above 2^53. Bit 0 (administrator) is cleared on every write.

Creating, editing and deleting roles needs `manage_roles`. A role may carry only bits the bot holds: its installation's permissions and @everyone's. A role's position must be below the highest role of the user who installed the bot (unlimited when that user owns the server) and below every administrator role; roles at or above that position, administrator roles and the default role cannot be edited, moved or deleted. A refused mask returns `403` with `missing_permissions`, the refused bits as a decimal string; a refused position returns `403`, with `max_position` when one exists.

#### List roles

`GET /servers/{server.id}/roles`

Returns roles ordered by `position`, highest first: `id`, `name`, `color`, `position`, `permissions`, `is_default`, `is_admin`, `mentionable`, `hoist`.

#### Create role

`POST /servers/{server.id}/roles`

| Field | Type | Description |
|---|---|---|
| `name` | string | Required. Trimmed and cut to 100 characters. |
| `color` | string or `null` | |
| `position` | integer | Default `0`. |
| `permissions` | string or number | Bitmask. An unparseable value is stored as `0`. |
| `mentionable` | boolean | Default `true`. |
| `hoist` | boolean | Default `false`. |

Returns `201` with `id`, `name`, `color`, `position`, `permissions`, `mentionable`, `hoist`. Bits the bot does not hold return `403`.

#### Edit role

`PATCH /servers/{server.id}/roles/{role.id}`

Same fields as create, all optional. Returns the role in the same shape. Bits the role already has may stay; added bits must be ones the bot holds. The default role, admin roles and roles at or above the bot's position limit return `403`.

#### Delete role

`DELETE /servers/{server.id}/roles/{role.id}`

Returns `204`. The default role, admin roles and roles at or above the bot's position limit return `403`.

### Channel permission overrides

Overrides apply to Harmony users and roles. The @everyone override of a channel also decides whether bots read it; see [Permissions](#permissions). Writing overrides needs `manage_channels`. A write may make effective only bits the bot holds in the channel: bits it adds to `allow_permissions`, and bits it removes from `deny_permissions` (deleting an override removes all of them). Others return `403` with `missing_permissions`.

#### List permission overrides

`GET /channels/{channel.id}/permission-overrides`

Returns `id`, `channel_id`, `target_type`, `role_id`, `user_id`, `allow_permissions`, `deny_permissions` for each override on the channel.

#### Set permission override

`PUT /channels/{channel.id}/permission-overrides`

| Field | Type | Description |
|---|---|---|
| `target_type` | `"role"` or `"user"` | Required. |
| `role_id` | UUID | Required when `target_type` is `role`. |
| `user_id` | UUID | Required when `target_type` is `user`. |
| `allow_permissions` | string or number | Bitmask; default `0`. |
| `deny_permissions` | string or number | Bitmask; default `0`. |

Creates or replaces the override for that role or user. Returns `201` with the new row, or `200` with the updated row. When both masks are `0`, the existing override is deleted and the response is `204`. An unparseable bitmask returns `400`.

#### Delete role override

`DELETE /channels/{channel.id}/permission-overrides/role/{role.id}`

Returns `204`.

### Users

#### Get current bot

`GET /users/@me`

| Field | Type | Description |
|---|---|---|
| `id` | UUID | Bot ID. |
| `username` | string | |
| `discriminator` | string | |
| `avatar` | string | Absolute URL; omitted when unset. |
| `bot` | boolean | Always `true`. |
| `verified` | boolean | |
| `public` | boolean | |

#### Get user

`GET /users/{user.id}`

Any profile on the instance: `id`, `username`, `display_name`, `avatar`, `bio`. Bot IDs are not profiles and return `404`.

### Invites

#### Get invite preview

`GET /invites/{code}/preview`

| Field | Type | Description |
|---|---|---|
| `code` | string | |
| `invite_url` | string | |
| `server_name` | string | |
| `server_description` | string or `null` | |
| `server_icon_url` | string or `null` | |
| `member_count` | integer | Accepted memberships. |

Unknown, used and expired codes return `404`.

### Emojis

#### List emojis

`GET /emojis`

Returns emoji rows from across the instance. Query `url` limits the result to emoji with exactly that image URL.

#### Create emoji

`POST /emojis`

| Field | Type | Description |
|---|---|---|
| `name` | string | Required. |
| `url` | string | Required. Image URL. |
| `domain` | string | Source domain. |

Creates an instance-wide emoji credited to the bot's owner. A non-null `server_id` in the body returns `403`. Returns `201` with `id`, `created_at`, `name`, `url`, `server_id`, `uploader`, `domain`, `scope`.

## Bridge support

These parts of the API exist for bridge bots, which relay messages between Harmony and another platform. The reference consumer is [harmony-discord-bridge](https://github.com/y4my4my4m/harmony-discord-bridge).

### Relayed authors

A message created with `metadata.discord_user` set to `{ "id", "username", "display_name", "avatar_url" }` is dispatched with that user as `author` and `author.discord_user: true`, `author.bot: false`.

### Look up bridged message

`GET /channels/{channel.id}/messages/lookup?discord_message_id={id}`

Returns the newest non-deleted message in the channel whose `metadata.discord_message_id` equals the query value. A missing parameter returns `400`; no match returns `404`.

### Patch content silently

`PATCH /messages/{message.id}/content-silent`

| Field | Type | Description |
|---|---|---|
| `content` | array | Required. Replacement message parts. |

Only messages the bot wrote. Replaces the content without changing `edited_timestamp`, so clients show no edited marker; bots still receive `MESSAGE_UPDATE`. The write succeeds only if the content is unchanged since the gateway read it; otherwise the response is `409`. Returns `{ "ok": true }`.

### Merge message metadata

`PATCH /messages/{message.id}/metadata`

| Field | Type | Description |
|---|---|---|
| `metadata` | object | Required. Merged into the existing metadata, top-level keys only. |

Does not change `edited_timestamp` and sends no event. Returns `{ "ok": true, "metadata": { … } }` with the merged object.

### Register bridge data (op 6)

Registers the members of the remote platform for Harmony's mention autocomplete:

```json
{
  "op": 6,
  "d": {
    "channels": [{ "harmonyChannelId": "c2d4f8a0-…" }],
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

`members` at the top level applies to every listed channel; a channel entry with its own non-empty `members` array uses that instead. Channels in servers where the bot has no active installation, and channels the bot cannot see, are dropped. There is no reply. The data lives in gateway memory until the bot disconnects.

### REFRESH_ATTACHMENTS

When the instance's bridge attachment mode is `refresh` and a user views a bridged message whose Discord CDN attachment URLs have expired, the gateway sends this event to the bot that wrote the message:

```json
{
  "op": 0,
  "t": "REFRESH_ATTACHMENTS",
  "d": { "messageId": "0b9e5a61-…", "channelId": "c2d4f8a0-…", "content": [ … ] }
}
```

A bridge handles it by re-signing the URLs and writing them back with a [silent content patch](#patch-content-silently). Field names in this event are camelCase.

### Attachment mirroring

When the instance's bridge attachment mode is `mirror`, `file` and `url` parts pointing at `discordapp.com` or `discordapp.net` in created or edited messages are copied into Harmony storage and their URLs rewritten, up to 50 MB per file. A failed copy keeps the original URL.

## Permissions

Server owners grant permissions per bot under **Server Settings → Advanced → Server Bots**. The gateway enforces six:

| Permission | Grants |
|---|---|
| `read_messages` | Message and reaction events; `GET` channel messages, `GET` message, bridged message lookup. |
| `send_messages` | Create messages; edit, silently patch and merge metadata on messages; trigger typing. Edits and silent patches are limited to the bot's own messages. |
| `manage_messages` | Delete messages written by others. |
| `add_reactions` | Add and remove the bot's own reactions. |
| `manage_channels` | Create channels and categories; edit channel order and category; edit categories; set and delete channel permission overrides. |
| `manage_roles` | Create, edit and delete roles below the bot's position limit; see [Roles](#roles). |

Read routes for server structure (server, members, channels, categories, roles, overrides) need an active installation and no permission.

### Channel access

Every read and write addressed by a channel or a message needs a channel the bot sees. A write also needs its permission's bit in the channel:

| Action | Permission | Channel bit |
|---|---|---|
| Message and reaction events; `GET` channel messages, `GET` message, bridged message lookup | `read_messages` | |
| Create, edit, silently patch or merge metadata on a message; trigger typing | `send_messages` | `SEND_MESSAGES` |
| Delete another author's message | `manage_messages` | `MANAGE_MESSAGES` |
| Delete the bot's own message | none | |
| Add or remove a reaction | `add_reactions` | `ADD_REACTIONS` |

Bots hold no roles and no override names a bot, so in a channel the installation's channel list does not name, the bot holds what @everyone holds there plus its permissions:

- it sees the channel when @everyone keeps `VIEW_CHANNEL` after the channel's @everyone override, or @everyone holds administrator;
- it writes when, in addition, the write's bit survives that override. A channel where @everyone cannot send, such as an announcements channel, is read-only for bots too.

The installation's channel list changes this:

- without a list, every channel follows the rule above;
- with a list, channels it does not name are closed to the bot, and a listed channel is open to it whatever @everyone's override denies: the bot sees it and uses every permission its installation holds there.

A refused route answers `403` with `Channel not visible to this bot` when the bot cannot see the channel, and `Missing permission in this channel: <permission>` when it sees the channel but the channel's @everyone override denies the bit.

The channel list is set under **Server Settings → Advanced → Server Bots → Channels**, by the server owner or a member with Manage Server. **Channels @everyone can view** clears the list; **Selected channels** sets it. A list is the only way to give a bot a channel hidden from @everyone, such as a private channel a bridge mirrors, or to let it post where @everyone is read-only. A member may add only channels they can view; listed channels they cannot view stay listed when they save.

A listed channel counts toward what the bot may do there, not toward what it may grant: a channel permission override write is still bounded by the bot's permissions after @everyone's override, so a bot cannot open a hidden or read-only channel to others.

REST checks read the installation on every request. Event delivery uses a cache that refreshes within 5 minutes.

## Rate limits

REST requests are counted per bot, per route and per channel or server the route names: `GET /channels/{channel.id}/messages` on two channels counts in two buckets, while every message ID, emoji or invite code on one route counts in one. Spelling does not matter: case, a trailing slash and the query string are ignored. All methods on a route count together. Requests that match no route share one bucket. The defaults are 100 requests per 60-second window; both are set per instance. The window starts at the first request in a bucket and resets when it expires.

A request over the limit returns:

```http
HTTP/1.1 429 Too Many Requests
Content-Type: application/json

{ "error": "Rate limit exceeded", "retry_after": 60 }
```

`retry_after` is always `60` and does not reflect the time left in the window. No rate-limit headers are sent. Requests rejected with `401` or `503` are not counted. The gateway WebSocket is not rate limited.

## Errors

| Status | `error` | Cause |
|---|---|---|
| `400` | varies | Missing or invalid field or query parameter. |
| `401` | `Missing Authorization header` | No `Authorization` header. |
| `401` | `Invalid Authorization header format. Expected: Bot TOKEN` | Header is not `Bot <token>`. |
| `401` | `Invalid or expired token` | Token unknown, revoked or expired, or the bot is inactive. |
| `403` | `Missing permission: <permission>` | The installation lacks the permission, the bot is not installed in the server, or the channel does not exist. |
| `403` | `Channel not visible to this bot` | The bot holds the permission but cannot see the channel; see [Channel access](#channel-access). Also sent when the visibility lookup fails. |
| `403` | `Missing permission in this channel: <permission>` | The bot sees the channel, and the channel's @everyone override denies the permission's bit; see [Channel access](#channel-access). |
| `403` | `Bot not in server` | No active installation; server read routes. The members route returns `Bot not in guild`. |
| `403` | varies | Editing or silently patching another author's message, modifying the default or an admin role, creating a server emoji. |
| `404` | varies | Message, channel, role, user or invite not found. Unknown routes return `Not found`. |
| `409` | `Message content changed; re-fetch and retry` | Silent content patch lost a race. |
| `429` | `Rate limit exceeded` | See [Rate limits](#rate-limits). |
| `500` | varies | Database error, including constraint violations. A malformed JSON body returns `500` `Internal server error`. |
| `503` | `Token verification unavailable` | The token lookup failed on the server. Retry. |

## Examples

Both examples answer `!ping` with `Pong!`.

### Node.js

Node 18 or later, with the `ws` package.

```javascript
import WebSocket from 'ws'

const TOKEN = process.env.HARMONY_BOT_TOKEN
const GATEWAY_URL = 'wss://harmony.example.com/bot-gateway/gateway'
const API_URL = 'https://harmony.example.com/bot-gateway/api/v1'

async function sendMessage(channelId, content) {
  const res = await fetch(`${API_URL}/channels/${channelId}/messages`, {
    method: 'POST',
    headers: { Authorization: `Bot ${TOKEN}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  })
  if (!res.ok) throw new Error(`${res.status} ${(await res.json()).error}`)
  return res.json()
}

function connect() {
  const ws = new WebSocket(GATEWAY_URL)
  let botId = null
  let heartbeat = null

  ws.on('open', () => {
    ws.send(JSON.stringify({ op: 2, d: { token: TOKEN } }))
  })

  ws.on('message', async (raw) => {
    const { op, t, d } = JSON.parse(raw)
    if (op !== 0) return

    if (t === 'READY') {
      botId = d.bot.id
      heartbeat = setInterval(() => ws.send(JSON.stringify({ op: 1 })), d.heartbeat_interval)
      console.log(`Connected as ${d.bot.username}`)
      return
    }

    if (t === 'MESSAGE_CREATE' && d.author?.id !== botId && d.content === '!ping') {
      await sendMessage(d.channel_id, 'Pong!').catch(console.error)
    }
  })

  ws.on('error', (err) => console.error(err.message))

  ws.on('close', (code, reason) => {
    clearInterval(heartbeat)
    console.log(`Gateway closed: ${code} ${reason}`)
    // 4001 and 4004 are token errors; a retry with the same token fails again.
    if (code !== 4001 && code !== 4004) setTimeout(connect, 5000)
  })
}

connect()
```

### Python

Python 3.9 or later, with the `websockets` and `requests` packages.

```python
import asyncio
import json
import os

import requests
import websockets

TOKEN = os.environ["HARMONY_BOT_TOKEN"]
GATEWAY_URL = "wss://harmony.example.com/bot-gateway/gateway"
API_URL = "https://harmony.example.com/bot-gateway/api/v1"


def send_message(channel_id, content):
    r = requests.post(
        f"{API_URL}/channels/{channel_id}/messages",
        headers={"Authorization": f"Bot {TOKEN}"},
        json={"content": content},
        timeout=10,
    )
    r.raise_for_status()
    return r.json()


async def heartbeat(ws, interval_ms):
    while True:
        await asyncio.sleep(interval_ms / 1000)
        await ws.send(json.dumps({"op": 1}))


async def run():
    async with websockets.connect(GATEWAY_URL) as ws:
        await ws.send(json.dumps({"op": 2, "d": {"token": TOKEN}}))
        bot_id = None
        beat = None
        try:
            async for raw in ws:
                payload = json.loads(raw)
                if payload["op"] != 0:
                    continue
                event, data = payload["t"], payload["d"]

                if event == "READY":
                    bot_id = data["bot"]["id"]
                    beat = asyncio.create_task(heartbeat(ws, data["heartbeat_interval"]))
                    print(f"Connected as {data['bot']['username']}")
                elif event == "MESSAGE_CREATE":
                    author = data.get("author") or {}
                    if author.get("id") != bot_id and data["content"] == "!ping":
                        await asyncio.to_thread(send_message, data["channel_id"], "Pong!")
        finally:
            if beat:
                beat.cancel()


asyncio.run(run())
```

## Token handling

- Keep tokens out of source control; load them from the environment or a secret manager.
- Use a separate bot, and therefore a separate token, for development and production.
- Reset a leaked token from the bot's page, then restart every running instance of the bot with the new one.
- Ask server owners for the permissions the bot uses and no others.

## Gateway setup

Running the gateway locally or behind a reverse proxy is covered in the [Bot Gateway Setup Guide](/BOT_GATEWAY_SETUP).
