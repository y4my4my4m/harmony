---
title: REST API
description: Every route of the Harmony bot REST API - authentication, request and response bodies, permissions, errors and pagination.
---

# REST API

The bot REST API is how a bot acts: it sends and edits messages, reacts, creates threads, channels and roles, and reads server structure. This page lists every route the gateway registers, with its request body, response and errors. Events arrive over the [gateway](/build/gateway); what each permission allows is explained in [Permissions and rate limits](/build/permissions-rate-limits).

## Requests

| | |
|---|---|
| Base URL | `https://<instance>/bot-gateway/api/v1` (`http://localhost:3002/api/v1` without a reverse proxy) |
| Authentication | `Authorization: Bot <token>` on every request: the word `Bot`, one space, the token |
| Request bodies | JSON, `Content-Type: application/json`, at most 10 MB |
| Responses | JSON, except `204 No Content` |
| IDs | UUIDs, except IDs from Discord (snowflakes: 1 to 20 digits) |
| Timestamps | ISO 8601 |
| CORS | Any origin |

```bash
curl -X POST "https://<instance>/bot-gateway/api/v1/channels/$CHANNEL_ID/messages" \
  -H "Authorization: Bot $HARMONY_BOT_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"content": "Deploy finished"}'
```

## Errors

An error response is a JSON object with an `error` message. Some errors add fields: `code` (`AUTOMOD_BLOCKED`, or `30010` for the reaction limit), `missing_permissions`, `max_position` or `discord_thread_id`.

```json
{ "error": "Missing permission: send_messages" }
```

| Status | `error` | Cause |
|---|---|---|
| `400` | varies | A missing or invalid field or query parameter. |
| `401` | `Missing Authorization header` | No `Authorization` header. |
| `401` | `Invalid Authorization header format. Expected: Bot TOKEN` | The header is not `Bot <token>`. |
| `401` | `Invalid or expired token` | The token is unknown, revoked or expired, or the bot is inactive. |
| `403` | `Missing permission: <permission>` | The installation lacks the permission, the bot is not installed in the server, or the channel does not exist. |
| `403` | `Channel not visible to this bot` | The bot holds the permission but cannot see the channel. Also sent when the visibility lookup fails. |
| `403` | `Missing permission in this channel: <permission>` | The bot sees the channel, and @everyone's override there denies the permission's bit. |
| `403` | `Bot not in server`, `Bot not in guild`, `Bot is not in this server` | No active installation in the server (server read routes). |
| `403` | `Blocked by the server's AutoMod` | The server's AutoMod dropped the message. `code` is `AUTOMOD_BLOCKED`. Sending the same message again meets the same rule. |
| `403` | varies | Editing another author's message, a role outside the bot's reach, a channel no bridge of this bot relays. |
| `404` | varies | Message, channel, thread, role, user or invite not found. A path no route matches answers `Not found`. |
| `409` | varies | A silent content patch lost a race, or a thread is already paired. |
| `429` | `Rate limit exceeded` | See [Rate limits](/build/permissions-rate-limits#rest-rate-limits). |
| `500` | varies | A database error, including constraint violations and message text over the instance's length limit. A body that is not valid JSON, or is over 10 MB, answers `Internal server error`. |
| `502` | varies | A Discord emoji image could not be downloaded or stored. |
| `503` | `Token verification unavailable` | The token lookup failed on the server. Retry. |

Where [Permissions and rate limits](/build/permissions-rate-limits#channel-access) describes a channel check, the `403` messages above are the ones it produces.

## Pagination

Only [`GET /channels/{channel.id}/messages`](#get-channel-messages) and [`GET /servers/{server.id}/members`](#list-members) take a `limit`. Messages page by time with `before` and `after`; members have no cursor. Other list routes return every row.

## Route index

Access levels: **Token** needs any valid bot token. **Installed** needs an active installation in the server. A permission name needs that permission in the server's installation; for routes addressed by a channel, message or thread, the server is the channel's and the bot must also pass the [channel checks](/build/permissions-rate-limits#channel-access).

| Method | Path | Access | Purpose |
|---|---|---|---|
| `POST` | [`/channels/{channel.id}/messages`](#create-message) | `send_messages` | Post a message, in the channel or one of its threads |
| `GET` | [`/channels/{channel.id}/messages`](#get-channel-messages) | `read_messages` | List a channel's messages, newest first |
| `GET` | [`/channels/{channel.id}/messages/lookup`](#look-up-a-bridged-message) | `read_messages` | Find a message by the Discord message ID in its metadata |
| `GET` | [`/messages/{message.id}`](#get-message) | `read_messages` | Read one message |
| `PATCH` | [`/messages/{message.id}`](#edit-message) | `send_messages`, own messages | Edit the bot's message |
| `DELETE` | [`/messages/{message.id}`](#delete-message) | Own: channel visible. Others: `manage_messages` | Delete a message |
| `PATCH` | [`/messages/{message.id}/content-silent`](#patch-content-silently) | `send_messages`, own messages | Replace content without an edited marker |
| `PATCH` | [`/messages/{message.id}/metadata`](#merge-message-metadata) | `send_messages`; own messages, or bridge mapping keys | Merge keys into a message's metadata |
| `PUT` | [`/messages/{message.id}/reactions/{emoji}`](#add-reaction) | `add_reactions` | React to a message |
| `DELETE` | [`/messages/{message.id}/reactions/{emoji}`](#remove-reaction) | `add_reactions` | Remove the bot's reactions with one emoji |
| `POST` | [`/channels/{channel.id}/typing`](#trigger-typing) | `send_messages` | No effect; answers as a send would |
| `POST` | [`/channels/{channel.id}/threads`](#create-thread) | `send_messages` | Start a thread on a message, or a standalone thread |
| `GET` | [`/channels/{channel.id}/threads/lookup`](#look-up-a-bridged-thread) | `read_messages`, Discord bridge | Find the thread paired with a Discord thread |
| `GET` | [`/threads/{thread.id}`](#get-thread) | `read_messages` | Read a thread |
| `PUT` | [`/threads/{thread.id}/discord`](#pair-a-thread-with-a-discord-thread) | `read_messages`, Discord bridge | Record the Discord thread a bridge created for a thread |
| `GET` | [`/servers/{server.id}`](#get-server) | Installed | Read a server |
| `GET` | [`/servers/{server.id}/members`](#list-members) | Installed | List a server's members |
| `GET` | [`/servers/{server.id}/channels`](#list-channels) | Installed | List a server's channels |
| `POST` | [`/servers/{server.id}/channels`](#create-channel) | `manage_channels` | Create a text or voice channel |
| `PATCH` | [`/channels/{channel.id}`](#edit-channel) | `manage_channels` | Move a channel: order and category |
| `GET` | [`/servers/{server.id}/categories`](#list-categories) | Installed | List a server's categories |
| `POST` | [`/servers/{server.id}/categories`](#create-category) | `manage_channels` | Create a category |
| `PATCH` | [`/servers/{server.id}/categories/{category.id}`](#edit-category) | `manage_channels` | Rename or move a category |
| `GET` | [`/servers/{server.id}/roles`](#list-roles) | Installed | List a server's roles |
| `POST` | [`/servers/{server.id}/roles`](#create-role) | `manage_roles` | Create a role |
| `PATCH` | [`/servers/{server.id}/roles/{role.id}`](#edit-role) | `manage_roles` | Edit a role |
| `DELETE` | [`/servers/{server.id}/roles/{role.id}`](#delete-role) | `manage_roles` | Delete a role |
| `GET` | [`/channels/{channel.id}/permission-overrides`](#list-permission-overrides) | Installed | List a channel's permission overrides |
| `PUT` | [`/channels/{channel.id}/permission-overrides`](#set-a-permission-override) | `manage_channels` | Create, replace or clear an override |
| `DELETE` | [`/channels/{channel.id}/permission-overrides/role/{role.id}`](#delete-a-role-override) | `manage_channels` | Delete a role's override |
| `GET` | [`/emojis`](#list-emojis) | Token | List the instance's emoji, or look one up |
| `POST` | [`/emojis`](#create-emoji) | Token | Create an instance emoji |
| `GET` | [`/servers/{server.id}/emojis`](#list-server-emojis) | Installed | List a server's emoji with their Discord links |
| `POST` | [`/servers/{server.id}/emojis/discord`](#import-a-discord-emoji) | The server's Discord bridge bot | Import a Discord emoji as a server emoji |
| `GET` | [`/users/@me`](#get-current-bot) | Token | Read the bot itself |
| `GET` | [`/users/{user.id}`](#get-user) | Token | Read a profile |
| `GET` | [`/invites/{code}/preview`](#get-invite-preview) | Token | Read an invite's server card |
| `GET` | [`/guilds/{server.id}`](#deprecated-aliases) | Installed | Deprecated alias of `GET /servers/{server.id}` |
| `GET` | [`/guilds/{server.id}/members`](#deprecated-aliases) | Installed | Deprecated alias of `GET /servers/{server.id}/members` |
| `GET` | [`/guilds/{server.id}/channels`](#deprecated-aliases) | Installed | Deprecated alias of `GET /servers/{server.id}/channels` |

The API has no route that lists the servers a bot is installed in.

## Messages

### Message object

REST routes return this object. It is a subset of the gateway's [message event object](/build/gateway#message-create).

| Field | Type | Description |
|---|---|---|
| `id` | UUID | |
| `channel_id` | UUID | |
| `thread_id` | UUID or `null` | Thread the message is in. |
| `author` | object or `null` | `id`, `username`, `display_name`, `avatar` (absolute URL, omitted when unset), `bot`. |
| `content` | string | The `text` parts joined with single spaces. |
| `reply_to` | UUID or `null` | |
| `timestamp` | ISO 8601 | Creation time. |
| `edited_timestamp` | ISO 8601 | Time of the last content edit; equal to `timestamp` until the content is edited. |
| `mentions` | string[] | As in the event object. |
| `metadata` | object | |

REST message objects have no `content_raw`, `is_system` or `mention_everyone`. `author` is the account that wrote the row: for a relayed Discord message it is the bridge bot, and for a webhook message the webhook's hidden bot.

### Message parts

A message's content is an array of parts. These are the part types a bot sends; the full set is `MessagePart` in `src/types/chat.ts` of the Harmony repository.

| `type` | Fields | Notes |
|---|---|---|
| `text` | `text` | Plain text. Markdown in it is rendered by the app. |
| `url` | `url`, `preview` | A link. Unless `preview` is `false`, the instance fetches a link preview card for it, except for links to the instance itself. A link inside a `text` part gets no card. |
| `mention` | `userId`, `username`, `domain`, `isLocal` | A member mention. |
| `role_mention` | `roleId`, `roleName`, `roleColor` | A role mention; `roleId` `here` is @here. See [Mentions](#mentions). |
| `channel_mention` | `channelId`, `name`, optional `messageId` | A channel link. The server fills in `serverId` and the stored name. |
| `emoji` | `emoji`: `{ "id", "name", "url" }` | A custom emoji. |
| `file` | `url`, `fileType`, optional `fileName`, `fileSize`, `altText` | An attachment by URL; there is no upload route. `fileType` is `image`, `video`, `audio` or `file`: the app shows images and videos inline, plays `audio` in a player, and links the rest. |
| `embed` | `url`, `provider`, `previewId`, optional `collapsed` | Kept only when `url` is an `http(s)` URL of at most 2048 characters, `provider` is one of `harmony-post`, `harmony-invite`, `fediverse-post`, `youtube`, `spotify`, `generic`, and `previewId` is a non-empty string; reduced to those fields. |

The server drops `system` parts a bot sends, and removes `path` from every part on create and edit: a bot names attachments by URL.

The text parts of a message may hold at most the instance's message length limit, 2000 characters unless the operator changed it. A longer message fails with `500` and an error such as `Message text exceeds the instance limit of 2000 characters (got 2417)`.

### Mentions

Before storing, the server checks `role_mention` and `channel_mention` parts against the channel's server:

- A `role_mention` naming a role of that server keeps its part, with the stored role name and color. A `channel_mention` naming a channel of that server keeps its part, with the stored name and the server's ID. Any other such part becomes the text `@roleName` or `#name`.
- @everyone (the server's default role) and @here (`{ "type": "role_mention", "roleId": "here" }`) stay mentions only when the installation has `mention_everyone`; otherwise they become the text `@everyone` or `@here`. @here notifies the members who are online and can view the channel.
- Another role notifies its members when it is mentionable, or when the installation has `mention_everyone`.

Edits and silent content patches apply the same check.

### Create message

`POST /channels/{channel.id}/messages`

| Field | Type | Description |
|---|---|---|
| `content` | string or array | A string becomes one `text` part. An array is the message's [parts](#message-parts). |
| `embeds` | object[] | Each object is appended as an `embed` part and kept only if it is a valid one. |
| `reply_to` | UUID | Message this one replies to. |
| `thread_id` | UUID | Post in this thread of the channel. |
| `metadata` | object | Stored with the message; see below. |

```json
{
  "content": [
    { "type": "mention", "userId": "8a1f3b77-…", "username": "alice", "domain": "harmony.example.com", "isLocal": true },
    { "type": "text", "text": " the deploy finished: " },
    { "type": "url", "url": "https://ci.example.com/runs/412", "preview": true }
  ],
  "reply_to": "0b9e5a61-…"
}
```

`metadata` keys the server reserves are dropped: `type`, `federated`, `ap_id`, `from_domain`, `original_url`, `published`, `conversation`, `in_reply_to_ap`, `pending_thread_ap_id`, `federated_at`, `federated_to`, `automod`, `bot`, `created_via`, `embeds`, `suppress_embeds` and `webhook`. `discord_user` and `bridge_source` are kept only from a bridge bot whose bridge relays the channel; see [Relayed authors](/build/bridges#relayed-authors). The server then sets `bot: true` and `created_via: "bot_api"`.

When the instance's bridge attachment mode is `mirror`, `file` and `url` parts pointing at `discordapp.com` or `discordapp.net` are copied into the instance's storage first; see [Attachments](/build/bridges#attachments).

Returns `201` with the [message object](#message-object). The instance then fetches link previews for the message's `url` parts.

| Status | `error` | Cause |
|---|---|---|
| `400` | `Cannot send an empty message` | No part is left after the checks above. |
| `400` | `thread_id is not a thread of this channel` | |
| `403` | `Thread is locked` | |
| `403` | `Blocked by the server's AutoMod` | `code` is `AUTOMOD_BLOCKED`. |
| `500` | `Message text exceeds the instance limit of …` | Text over the length limit. |

Channel access errors are listed under [Errors](#errors).

### Get channel messages

`GET /channels/{channel.id}/messages`

| Query | Default | Description |
|---|---|---|
| `limit` | 50 | Number of messages. The gateway sets no maximum. |
| `before` | | ISO 8601 timestamp. Only messages created before it. |
| `after` | | ISO 8601 timestamp. Only messages created after it. |

Returns an array of [message objects](#message-object), newest first, with or without `after`. The result includes the messages of the channel's threads, soft-deleted messages and end-to-end encrypted messages; the message object has no field that marks the last two. Authors are resolved for members and bots.

`after` with `limit` returns the newest `limit` messages after that time, not the oldest. To read everything since a point, page backwards: request with `before` set to the oldest `timestamp` you received, until you reach messages you already have.

A bot that cannot read the channel, for any reason, gets `403` `Missing permission: read_messages`.

### Get message

`GET /messages/{message.id}`

Returns the [message object](#message-object). This route resolves bot authors only: `author` is `null` on messages written by members.

| Status | `error` |
|---|---|
| `404` | `Message not found`, `Channel not found` |
| `403` | `Missing permission: read_messages` |

### Edit message

`PATCH /messages/{message.id}`

| Field | Type | Description |
|---|---|---|
| `content` | string or array | Replaces the message's parts. |

Only messages the bot wrote. `embeds` is not read. The [mention checks](#mentions) and the attachment mirror apply as on create. Returns the [message object](#message-object); bots reading the channel receive `MESSAGE_UPDATE`.

| Status | `error` | Cause |
|---|---|---|
| `400` | `Cannot send an empty message` | |
| `403` | `Cannot edit messages from other bots or users` | Another author's message, or an unknown ID. |
| `403` | `Blocked by the server's AutoMod` | |

### Delete message

`DELETE /messages/{message.id}`

Deletes the message from the database. The bot's own messages need only a channel the bot can see; another author's message needs `manage_messages` and the channel's `MANAGE_MESSAGES` bit. Returns `204`; bots reading the channel receive `MESSAGE_DELETE`. An unknown ID answers `404` `Message not found`.

### Patch content silently

`PATCH /messages/{message.id}/content-silent`

| Field | Type | Description |
|---|---|---|
| `content` | array | Required. Replacement parts. |

Replaces the content of a message the bot wrote without changing `edited_timestamp`, so the app shows no edited marker, and without a `MESSAGE_UPDATE` event. Bridges use it to renew expired attachment URLs. `system` parts are dropped, `embed` parts are checked and [mentions](#mentions) are checked as on create.

The write applies only if the stored content has not changed since the gateway read it. Returns `{ "ok": true }`.

| Status | `error` |
|---|---|
| `400` | `content must be a MessagePart array` |
| `403` | `Cannot update messages from other bots or users` |
| `409` | `Message content changed; re-fetch and retry` |

### Merge message metadata

`PATCH /messages/{message.id}/metadata`

| Field | Type | Description |
|---|---|---|
| `metadata` | object | Required. Merged into the existing metadata; top-level keys replace. |

On the bot's own message, reserved keys are dropped as on create. On another author's message, only a bridge bot whose bridge relays the channel may write, and only these keys: `discord_message_id`, `discord_message_ids`, `discord_via_webhook`, `discord_uploaded_files`, and `bridge_source` with the value `harmony`. Both cases need `send_messages` in the channel.

Does not change `edited_timestamp` and sends no event. Returns `{ "ok": true, "metadata": { … } }` with the merged object.

| Status | `error` |
|---|---|
| `400` | `metadata must be a JSON object` |
| `403` | `Bots can only update metadata on their own messages` |
| `404` | `Message not found` |

### Look up a bridged message

`GET /channels/{channel.id}/messages/lookup?discord_message_id={id}`

Returns the newest message in the channel that is not soft-deleted and whose `metadata.discord_message_id` equals the query value, as a [message object](#message-object). A missing parameter answers `400`; no match answers `404` `Message not found`.

### Trigger typing

`POST /channels/{channel.id}/typing`

Has no effect. Answers as a message to the channel would: `204` where the bot may send, `403` otherwise.

## Reactions

`{emoji}` is a custom emoji's UUID, or the URL-encoded text of any other emoji, for example `%F0%9F%91%8D` for the thumbs-up emoji (U+1F44D), or a bridged identifier such as `discord:name:id`.

### Add reaction

`PUT /messages/{message.id}/reactions/{emoji}`

Optional body: `{ "metadata": { … } }`, stored on the reaction. For an `{emoji}` that is not a custom emoji UUID, `metadata.remote_emoji_url` is the image the app shows; it is kept only when it is an `https` URL on `cdn.discordapp.com` or `media.discordapp.net`.

Each call adds a reaction by the bot. A bridge adds one per remote user, with `metadata.discord_user` naming that user. Returns `204`.

| Status | `error` | Cause |
|---|---|---|
| `400` | `Maximum number of reactions reached (20)` | The message already carries 20 different emoji. `code` is `30010`. |
| `404` | `Message not found` | |

### Remove reaction

`DELETE /messages/{message.id}/reactions/{emoji}`

Removes the bot's reactions with that emoji from the message. An optional body `{ "discord_user_id": "…" }` limits the removal to reactions whose `metadata.discord_user.id` matches. Returns `204`, also when nothing matched.

## Threads

A thread's messages carry the parent channel's `channel_id` and the thread's `thread_id`. Writing in a thread follows the parent channel's `send_messages` access.

### Thread object

| Field | Type | Description |
|---|---|---|
| `id` | UUID | |
| `channel_id` | UUID | Parent channel. |
| `parent_message_id` | UUID | The message the thread hangs off; for a standalone thread, its "started a thread" notice. |
| `name` | string | |
| `archived` | boolean | |
| `locked` | boolean | A locked thread refuses new messages from bots. |
| `created_at` | ISO 8601 | |
| `discord_thread_id` | string or `null` | The Discord thread the calling bot's bridge on that server paired with this thread. |

### Create thread

`POST /channels/{channel.id}/threads`

| Field | Type | Description |
|---|---|---|
| `name` | string | Required. Trimmed and cut to 100 characters. |
| `message_id` | UUID | Start the thread on this message of the channel. Without it the thread is standalone. |
| `discord_thread_id` | string | Discord bridges: pair the new thread with this Discord thread. |
| `discord_user` | object | With `discord_thread_id`: the Discord member who started the thread, `{ "id", "username", "display_name", "avatar_url" }`. The notice names them. |

The server posts a system notice, "started a thread", authored by the bot, with `metadata.type` `thread_created`, `thread_id` and `thread_name`. A standalone thread hangs off that notice, which also carries `metadata.standalone: true`.

A message holds one thread: when `message_id` already has one, it is returned and no notice is posted. With `discord_thread_id`, the call is idempotent for the bot's bridge: a Discord thread already paired returns its thread.

Returns `201` with the [thread object](#thread-object), also when an existing thread is returned.

| Status | `error` | Cause |
|---|---|---|
| `400` | `name is required`, `message_id must be a message id`, `discord_thread_id must be a Discord snowflake` | |
| `403` | `The channel is not bridged by this bot` | `discord_thread_id` from a bot whose bridge does not relay the channel. |
| `404` | `Message not found in this channel` | `message_id` is not a message of this channel, or is itself in a thread. |

### Get thread

`GET /threads/{thread.id}`

Returns the [thread object](#thread-object). A thread that does not exist, or whose channel the bot cannot read, answers `404` `Thread not found`.

### Look up a bridged thread

`GET /channels/{channel.id}/threads/lookup?discord_thread_id={id}`

Returns the thread of this channel that the bot's Discord bridge paired with the Discord thread. `400` when `discord_thread_id` is not a snowflake, `403` `Channel not visible to this bot` when the bot cannot read the channel, `404` `Thread not found` when the bot runs no bridge on the server or no such pair exists.

### Pair a thread with a Discord thread

`PUT /threads/{thread.id}/discord`

| Field | Type | Description |
|---|---|---|
| `discord_thread_id` | string | Required. The Discord thread the bridge created for this Harmony thread. |

Only the bridge bot of a channel its bridge relays. The first pair stands: the same ID again returns the thread, a different one answers `409` with `discord_thread_id` set to the standing pair. Returns the [thread object](#thread-object).

| Status | `error` |
|---|---|
| `400` | `discord_thread_id must be a Discord snowflake` |
| `403` | `The channel is not bridged by this bot` |
| `404` | `Thread not found` |
| `409` | `Thread is already paired` |

## Servers

### Get server

`GET /servers/{server.id}`

| Field | Type | Description |
|---|---|---|
| `id` | UUID | |
| `name` | string | |
| `owner_id` | UUID or `null` | The server's owner; `null` when the owner's account was deleted. |
| `description` | string or `null` | |
| `member_count` | integer | |

### List members

`GET /servers/{server.id}/members`

| Query | Default | Description |
|---|---|---|
| `limit` | 100 | Number of members. There is no cursor; raise `limit` to read more. |

Returns member objects, in no defined order. Memberships are not filtered by status, so pending and banned members appear.

| Field | Type | Description |
|---|---|---|
| `user.id` | UUID | Profile ID. |
| `user.username` | string | |
| `user.display_name` | string | |
| `user.domain` | string or `null` | The member's instance. |
| `user.is_local` | boolean | `false` for members from other instances. |
| `user.avatar` | string | Absolute URL; omitted when unset. |
| `nick` | string or `null` | Nickname in this server. |
| `roles` | array | Always empty; role assignments are not exposed. |

A bot without an installation gets `403` `Bot not in guild`.

### List channels

`GET /servers/{server.id}/channels`

Returns every channel of the server, ordered by `order`, including channels the bot cannot see.

| Field | Type | Description |
|---|---|---|
| `id` | UUID | |
| `type` | integer | Always `0`, for voice channels too. |
| `guild_id` | UUID | Server ID. |
| `name` | string | |
| `position` | integer | Same value as `order`. |
| `order` | integer | Sort position. |
| `parent_id` | UUID or `null` | Same value as `category_id`. |
| `category_id` | UUID or `null` | |

### Create channel

`POST /servers/{server.id}/channels`

| Field | Type | Description |
|---|---|---|
| `name` | string | Required. Trimmed and cut to 100 characters. |
| `type` | integer | `1` creates a voice channel; any other value a text channel. |
| `category_id` | UUID or `null` | |
| `description` | string | Cut to 1024 characters. |
| `order` | integer | Default `0`. |

Returns `201` with the [channel object](#list-channels); its `type` is `0` whatever the channel's type. `400` `name is required`; `403` `Missing permission: manage_channels`.

### Edit channel

`PATCH /channels/{channel.id}`

| Field | Type | Description |
|---|---|---|
| `order` | integer | |
| `category_id` | UUID or `null` | `null` removes the channel from its category. |

Other fields are ignored; a body with neither answers `400` `No valid fields to update`. Returns the channel object. `404` `Channel not found`.

### List categories

`GET /servers/{server.id}/categories`

Returns category rows ordered by `order`: `id`, `server_id`, `name`, `order`, `created_at`, `updated_at`, `federation_status`.

### Create category

`POST /servers/{server.id}/categories`

| Field | Type | Description |
|---|---|---|
| `name` | string | Required. Trimmed and cut to 100 characters. |
| `order` | integer | Default `0`. |

Returns `201` with the category row.

### Edit category

`PATCH /servers/{server.id}/categories/{category.id}`

Body: `name` and `order`, as on create, both optional. A body with neither answers `400` `No valid fields to update`. Returns the category row.

## Roles

Permission masks are 64-bit role-permission bitmasks; [Permission bits](/build/permissions-rate-limits#permission-bits) lists the bits. Requests accept a mask as a decimal string or a number; send strings, since numbers above 2^53 lose precision. Bit 0 (administrator) is cleared on every write.

Role writes are bounded by the bot's own reach; see [Role writes](/build/permissions-rate-limits#role-writes). A refused mask answers `403` with `missing_permissions`, the refused bits as a decimal string. A refused position answers `403` with `max_position`, the highest position the bot may use.

### List roles

`GET /servers/{server.id}/roles`

Returns roles ordered by `position`, highest first: `id`, `name`, `color`, `position`, `permissions`, `is_default`, `is_admin`, `mentionable`, `hoist`. `is_default` marks @everyone.

### Create role

`POST /servers/{server.id}/roles`

| Field | Type | Description |
|---|---|---|
| `name` | string | Required. Trimmed and cut to 100 characters. |
| `color` | string or `null` | |
| `position` | integer | Default `0`. Must be below the bot's position limit. |
| `permissions` | string or number | Bitmask. A value that does not parse is stored as `0`. |
| `mentionable` | boolean | Default `true`. |
| `hoist` | boolean | Default `false`. |

Returns `201` with `id`, `name`, `color`, `position`, `permissions`, `mentionable`, `hoist`.

| Status | `error` |
|---|---|
| `400` | `name is required`, `position must be an integer` |
| `403` | `Missing permission: manage_roles` |
| `403` | `Role position must be below the bot's highest manageable position` (with `max_position`) |
| `403` | `Cannot grant permissions the bot does not hold in this server` (with `missing_permissions`) |

### Edit role

`PATCH /servers/{server.id}/roles/{role.id}`

Same fields as create, all optional. Bits the role already has may stay; bits added must be ones the bot may grant. Returns the role in the same shape as create.

| Status | `error` |
|---|---|
| `403` | `Cannot modify default or admin roles via bot API` |
| `403` | `Role is at or above the bot's highest manageable position` |
| `404` | `Role not found` |

The create errors apply as well.

### Delete role

`DELETE /servers/{server.id}/roles/{role.id}`

Returns `204`. The default role, administrator roles and roles at or above the bot's position limit answer `403`, as on edit.

## Channel permission overrides

Overrides apply to members and roles; no override can name a bot. The @everyone override of a channel also decides whether bots see it and post in it; see [Channel access](/build/permissions-rate-limits#channel-access).

### List permission overrides

`GET /channels/{channel.id}/permission-overrides`

Returns `id`, `channel_id`, `target_type`, `role_id`, `user_id`, `allow_permissions`, `deny_permissions` for each override of the channel. Needs an installation in the channel's server.

### Set a permission override

`PUT /channels/{channel.id}/permission-overrides`

| Field | Type | Description |
|---|---|---|
| `target_type` | `"role"` or `"user"` | Required. |
| `role_id` | UUID | Required when `target_type` is `role`. |
| `user_id` | UUID | Required when `target_type` is `user`. |
| `allow_permissions` | string or number | Bitmask; default `0`. |
| `deny_permissions` | string or number | Bitmask; default `0`. |

Creates or replaces the override for that role or member. Returns `201` with the new row, or `200` with the updated row. When both masks are `0`, an existing override is deleted and the response is `204`.

A write may make effective only bits the bot holds in the channel: bits it adds to `allow_permissions`, and bits it removes from `deny_permissions`. Others answer `403` `Cannot grant permissions the bot does not hold in this channel` with `missing_permissions`. A mask that does not parse answers `400` `Invalid permission bitmask`.

### Delete a role override

`DELETE /channels/{channel.id}/permission-overrides/role/{role.id}`

Returns `204`. Deleting lifts every deny bit the override carried, so each must be a bit the bot holds in the channel, as for a write.

## Emojis

### List emojis

`GET /emojis`

Returns every emoji row of the instance, every column. Every account can read every emoji row.

| Query | Description |
|---|---|
| `url` | Only emoji whose image URL equals this value. |
| `id` | Return this one emoji as an object instead of an array. `404` `Emoji not found` when absent, `400` when not a UUID. |

### Create emoji

`POST /emojis`

| Field | Type | Description |
|---|---|---|
| `name` | string | Required. |
| `url` | string | Required. Image URL. |
| `domain` | string | Source instance domain. |

Creates an instance-wide emoji (`scope` `instance`, no server) credited to the bot's owner. A non-null `server_id` in the body answers `403`. Returns `201` with `id`, `created_at`, `name`, `url`, `server_id`, `uploader`, `domain`, `scope`.

### List server emojis

`GET /servers/{server.id}/emojis`

Returns the server's emoji: `id`, `name`, `url`, `server_id`, `discord_emoji_id`. `discord_emoji_id` is the Discord emoji a bridge imported the row from, or `null`.

### Import a Discord emoji

`POST /servers/{server.id}/emojis/discord`

Only the bot of the server's Discord bridge.

| Field | Type | Description |
|---|---|---|
| `discord_emoji_id` | string | Required. Discord emoji ID. |
| `name` | string | Required. 1 to 32 of `A`–`Z`, `a`–`z`, `0`–`9`, `_`. |
| `animated` | boolean | Fetch the animated (`.gif`) image. |

| Outcome | Status | Meaning |
|---|---|---|
| `existing` | `200` | The Discord emoji was already imported into this server. |
| `linked` | `200` | A server emoji with the same name (ignoring case) and no Discord link now carries this Discord ID. |
| `created` | `201` | The gateway downloaded the image from Discord's CDN (at most 512 KiB) and created a server emoji. |

The response is `{ "status", "id", "name", "url", "discord_emoji_id" }`. Importing the same Discord emoji again never creates a second row. `403` `Bot is not the Discord bridge of this server`; `502` when the image cannot be downloaded or stored.

## Users

### Get current bot

`GET /users/@me`

| Field | Type | Description |
|---|---|---|
| `id` | UUID | The bot's ID. |
| `username` | string | |
| `discriminator` | string | |
| `avatar` | string | Absolute URL; omitted when unset. |
| `bot` | boolean | Always `true`. |
| `verified` | boolean | |
| `public` | boolean | Any server owner can add a public bot. |

### Get user

`GET /users/{user.id}`

Any profile the instance knows: `id`, `username`, `display_name`, `avatar`, `bio`. Bot IDs are not profiles and answer `404` `User not found`.

## Invites

### Get invite preview

`GET /invites/{code}/preview`

| Field | Type | Description |
|---|---|---|
| `code` | string | |
| `invite_url` | string | `/invite/<code>` on the gateway's configured public URL. |
| `server_name` | string | |
| `server_description` | string or `null` | |
| `server_icon_url` | string or `null` | |
| `member_count` | integer | Accepted memberships. |

Unknown and used codes answer `404` `Invite not found or expired`; expired codes `404` `Invite expired`.

## Deprecated aliases

`GET /guilds/{server.id}`, `GET /guilds/{server.id}/members` and `GET /guilds/{server.id}/channels` behave as the `/servers/…` routes. Each counts in its own [rate limit bucket](/build/permissions-rate-limits#rest-rate-limits).

## Other gateway endpoints

The gateway serves these outside `/api/v1`. The app and bridge programs call them; a bot does not need them.

| Method | Path | Authentication | Purpose |
|---|---|---|---|
| `GET` | `/health` | None | `{ "status": "ok", "uptime", "timestamp" }`. |
| `GET` | `/status` | A signed-in user's session token, `Authorization: Bearer …` | Connected bots: `connected_bots`, `total_connections`, `bots[]`. |
| `GET` | `/bridged-users/{channel.id}` | User session; member of the channel's server | The op 6 members registered for the channel: `channel_id`, `has_bridge`, `users`. |
| `GET` | `/bridged-users/server/{server.id}` | User session; member of the server | The registered members of all the server's channels, one entry per remote ID. |
| `POST` | `/attachments/refresh` | User session; member of the message's server | Body `{ "messageId" }`. Sends [`REFRESH_ATTACHMENTS`](/build/gateway#refresh-attachments) to the message's bot. |
| `GET` | `/bridge-setup/{pairing code}` | None | Legacy Discord bridge pairing lookup; see [Writing a bridge](/build/bridges#legacy-pairing-codes). |
| | `/bridge/v2/…` | Varies | The [Bridge v2 API](/build/bridges#bridge-v2-endpoints). |
