---
title: Permissions and rate limits
description: How a Harmony bot's permissions are computed from its installation and @everyone, which permission each route needs, and the gateway's rate limits.
---

# Permissions and rate limits

This page explains what a bot may do in a server and in each channel, which permission every REST route needs, and the rate limits of the REST API, the gateway WebSocket and the Bridge v2 API. Webhook limits are on [Webhooks API](/build/webhooks#rate-limits).

## Installation permissions

When a server adds a bot, it stores an installation: a set of permission flags and an optional list of channels. Bots hold no roles, and no channel override can name a bot, so the installation and @everyone decide everything a bot may do.

Server members with Manage Server change the flags under **Server settings** → **Advanced settings** → **Server bots** → **Permissions**, and the channel list under **Channels**. Unless they own the server, hold Administrator or administer the instance, a member can turn on a flag only when they hold the matching permission themselves.

| Flag | Label in the app | Allows | Role bits it counts as |
|---|---|---|---|
| `read_messages` | **Read messages** (required) | Receiving message and reaction events; reading messages and threads | `VIEW_CHANNEL`, `READ_MESSAGE_HISTORY` |
| `send_messages` | **Send messages** (required) | Posting, editing its own messages, silent patches, metadata merges, threads, typing | `SEND_MESSAGES` |
| `add_reactions` | **Add reactions** | Adding and removing its own reactions | `ADD_REACTIONS` |
| `manage_messages` | **Manage messages** | Deleting messages written by others | `MANAGE_MESSAGES` |
| `manage_channels` | **Manage channels** | Creating channels and categories, moving channels, editing categories, writing channel permission overrides | `MANAGE_CHANNELS` |
| `manage_roles` | **Manage roles** | Creating, editing and deleting roles within its reach; see [Role writes](#role-writes) | `MANAGE_ROLES` |
| `mention_everyone` | Not shown | Keeping @everyone and @here as mentions, and notifying through any role | `MENTION_EVERYONE` |

The app always keeps **Read messages** and **Send messages** on. It does not offer `mention_everyone`, which is off for every installation made from the app.

Installations also carry `embed_links` and `attach_files` (on by default) and `kick_members` and `ban_members` (off). No route checks them, but they count as the role bits `EMBED_LINKS`, `ATTACH_FILES`, `KICK_MEMBERS` and `BAN_MEMBERS` when the gateway works out which bits a bot may grant.

| Added through | Flags on |
|---|---|
| **User settings** → **My bots** → **Add to server** | Read messages, Send messages, Add reactions; Manage channels too for a bot of type Bridge |
| **Server bots** → **Add a bot** | The flags checked in the dialog |
| A Discord bridge set up under **Server settings** → **Discord Bridge** | Read messages, Send messages, Manage channels, Manage roles |

## How permissions are computed

For a channel, the gateway computes the bot's permissions the way it does for a member whose only roles are @everyone and a role carrying the installation's bits:

1. Start from @everyone's server permissions, plus the role bits of the installation's flags.
2. If that includes administrator, the bot holds every bit.
3. Otherwise remove the bits @everyone's override on the channel denies, then add the bits it allows.

The installation's channel list then applies:

- **No list:** every channel follows the computation above.
- **A list:** channels it does not name are closed to the bot. A listed channel is open whatever @everyone's override says: the bot sees it, and uses every flag its installation holds there.

In the app, **Channels @everyone can view** clears the list and **Selected channels** sets it. A list is the only way to give a bot a channel hidden from @everyone, such as a private channel a bridge relays, or to let it post where @everyone is read-only. A member may add only channels they can view; listed channels they cannot view stay listed when they save.

## Channel access

Every request addressed by a channel, message or thread needs a channel the bot can see. A write also needs its flag and that flag's bit in the channel.

| Action | Flag | Channel bit |
|---|---|---|
| Receive message and reaction events; read messages, threads, bridged lookups | `read_messages` | `VIEW_CHANNEL` (seeing the channel) |
| Create, edit, silently patch or merge metadata on a message; create a thread; trigger typing | `send_messages` | `SEND_MESSAGES` |
| Delete another author's message | `manage_messages` | `MANAGE_MESSAGES` |
| Delete the bot's own message | none | `VIEW_CHANNEL` (seeing the channel) |
| Add or remove a reaction | `add_reactions` | `ADD_REACTIONS` |

Without a channel list, the bot sees a channel when @everyone keeps `VIEW_CHANNEL` there (or holds administrator), and writes when the write's bit survives @everyone's override too. A channel where @everyone cannot send, such as an announcements channel, is read-only for bots as well unless the channel list names it.

A refused request answers `403`:

| `error` | Meaning |
|---|---|
| `Missing permission: <flag>` | The installation lacks the flag, the bot is not installed in the channel's server, or the channel does not exist. The message read routes answer `Missing permission: read_messages` for every refusal. |
| `Channel not visible to this bot` | The bot holds the flag but cannot see the channel. |
| `Missing permission in this channel: <flag>` | The bot sees the channel, and @everyone's override there denies the flag's bit. |

## Permissions by route

| Needs | Routes |
|---|---|
| A valid token | `GET /users/@me`, `GET /users/{user.id}`, `GET /invites/{code}/preview`, `GET /emojis`, `POST /emojis` |
| An active installation in the server | `GET /servers/{server.id}`, `…/members`, `…/channels`, `…/categories`, `…/roles`, `…/emojis`; `GET /channels/{channel.id}/permission-overrides`; the `/guilds/…` aliases |
| `read_messages` and channel access | `GET /channels/{channel.id}/messages`, `GET /channels/{channel.id}/messages/lookup`, `GET /messages/{message.id}`, `GET /threads/{thread.id}`, `GET /channels/{channel.id}/threads/lookup` |
| `send_messages` and channel access | `POST /channels/{channel.id}/messages`, `PATCH /messages/{message.id}`, `PATCH /messages/{message.id}/content-silent`, `PATCH /messages/{message.id}/metadata`, `POST /channels/{channel.id}/typing`, `POST /channels/{channel.id}/threads` |
| Channel access only | `DELETE /messages/{message.id}` on the bot's own message |
| `manage_messages` and channel access | `DELETE /messages/{message.id}` on another author's message |
| `add_reactions` and channel access | `PUT` and `DELETE /messages/{message.id}/reactions/{emoji}` |
| `manage_channels` in the server | `POST /servers/{server.id}/channels`, `PATCH /channels/{channel.id}`, `POST /servers/{server.id}/categories`, `PATCH /servers/{server.id}/categories/{category.id}`, `PUT /channels/{channel.id}/permission-overrides`, `DELETE /channels/{channel.id}/permission-overrides/role/{role.id}` |
| `manage_roles` in the server | `POST`, `PATCH`, `DELETE /servers/{server.id}/roles…` |
| Being the bot of the server's Discord bridge | `POST /servers/{server.id}/emojis/discord`, `PUT /threads/{thread.id}/discord`, and a `discord_thread_id` on `POST /channels/{channel.id}/threads` |

Editing, silently patching and merging metadata are limited to the bot's own messages, except for the [bridge mapping keys](/build/rest#merge-message-metadata). Creating and moving channels and categories checks the `manage_channels` flag in the server and does not consult the channel list.

## Role writes

A bot with `manage_roles` may create, edit and delete roles within two bounds.

**Bits.** A role may carry only bits the bot could grant: @everyone's server permissions plus the role bits of the installation's flags, never administrator. Editing a role keeps the bits it already has; only added bits are checked. A refused mask answers `403` with `missing_permissions`.

**Positions.** Bots hold no roles, so the member who installed the bot stands in. The bot's limit is the position of that member's highest role, unlimited when that member owns the server and 0 when they hold no role. The position of the lowest administrator role lowers the limit further. A bot may create, move, edit and delete roles only at positions strictly below the limit. It cannot edit or delete @everyone or any administrator role. A refused position answers `403`, with `max_position` when there is a limit.

## Override writes

A permission override write may make effective only bits the bot holds in that channel, computed as in [How permissions are computed](#how-permissions-are-computed) but without the channel list's grant: bits it adds to `allow_permissions`, and bits it removes from `deny_permissions`. Deleting a role override removes all its deny bits, so each must be a bit the bot holds. In a channel its list does not name, a bot with a channel list holds no bit, and any grant there is refused.

A listed channel counts toward what the bot may do there, not toward what it may grant, so a bot cannot open a hidden or read-only channel to others.

## @everyone and @here

A bot's `role_mention` of @everyone or @here stays a mention only when its installation has `mention_everyone`; otherwise it is stored as the text `@everyone` or `@here`. Another role notifies its members when it is mentionable, or when the installation has `mention_everyone`. See [Mentions](/build/rest#mentions).

## Permission bits

Role permission masks, channel override masks and `missing_permissions` use these bits. A mask is a 64-bit integer; send it as a decimal string.

| Bit | Permission | Bit | Permission |
|---|---|---|---|
| 0 | `ADMINISTRATOR` | 16 | `EMBED_LINKS` |
| 1 | `VIEW_CHANNEL` | 17 | `ATTACH_FILES` |
| 2 | `MANAGE_CHANNELS` | 18 | `ADD_REACTIONS` |
| 3 | `MANAGE_ROLES` | 19 | `USE_EXTERNAL_EMOJIS` |
| 4 | `MANAGE_EMOJIS` | 20 | `MENTION_EVERYONE` |
| 5 | `VIEW_AUDIT_LOG` | 21 | `MANAGE_MESSAGES` |
| 6 | `MANAGE_WEBHOOKS` | 22 | `READ_MESSAGE_HISTORY` |
| 7 | `MANAGE_SERVER` | 23 | `PIN_MESSAGES` |
| 8 | `CREATE_INVITE` | 24 | `CONNECT` |
| 9 | `KICK_MEMBERS` | 25 | `SPEAK` |
| 10 | `BAN_MEMBERS` | 26 | `STREAM` |
| 11 | `TIMEOUT_MEMBERS` | 27 | `MUTE_MEMBERS` |
| 12 | `SEND_MESSAGES` | 28 | `DEAFEN_MEMBERS` |
| 13 | `SEND_MESSAGES_IN_THREADS` | 29 | `MOVE_MEMBERS` |
| 14 | `CREATE_PUBLIC_THREADS` | 30 | `USE_SOUNDBOARD` |
| 15 | `CREATE_PRIVATE_THREADS` | 31 | `USE_EXTERNAL_SOUNDS` |

The value of a bit is 2 to the power of its number: `SEND_MESSAGES` is `4096`. What each permission means for members is on [Roles and permissions](/run/roles-permissions).

## When changes apply

| Change | REST API | Events |
|---|---|---|
| Flags, channel list, removing the bot | The next request | Within about 10 seconds |
| @everyone's permissions or a channel's @everyone override | The next request | Within 10 seconds |
| A Discord bridge's channel pair removed | Routes that check the pairing notice within 60 seconds | |
| **Reset token**, deleting or deactivating the bot | The next request | Open connections close at the next token check, every 30 seconds by default |

## REST rate limits

The REST API counts requests per bot in buckets. A bucket is one route, and for routes that name a channel or server (`{channel.id}`, `{server.id}`, `/guilds/{server.id}`), one route on one channel or server. `GET /channels/{channel.id}/messages` on two channels uses two buckets; every message ID, emoji or invite code on one route shares one bucket. All methods on a route count together, so `GET` and `POST /channels/{channel.id}/messages` share a bucket. Case, a trailing slash and the query string do not matter. Requests that match no route share one bucket.

Each bucket allows 100 requests per 60-second window. The window starts at the first request in the bucket and resets when it ends. An instance can change both numbers with the gateway's `RATE_LIMIT_MAX_REQUESTS` and `RATE_LIMIT_WINDOW_MS` settings; see [Configuration](/self-host/configuration).

A request over the limit answers:

```http
HTTP/1.1 429 Too Many Requests
Content-Type: application/json

{ "error": "Rate limit exceeded", "retry_after": 60 }
```

`retry_after` is always `60`, whatever the window or the time left in it. No rate-limit headers are sent. Requests refused with `401` or `503` during authentication are not counted. When the gateway cannot reach its rate-limit store, it lets the request through.

The [Bridge v2](/build/bridges#bridge-v2-endpoints) routes a bridge bot calls with its token (`/config`, `/status`, `/pairs`) count in the same way, one bucket per route.

## Gateway rate limit

A WebSocket connection may send 120 frames in any 60 seconds, heartbeats not counted. The frame over the limit closes the connection with `4008`. See [Frame rate limit](/build/gateway#frame-rate-limit).

## Bridge v2 public route limits

The Bridge v2 routes that take no bot token are limited per client IP address:

| Route | Limit |
|---|---|
| `POST /bridge/v2/redeem` | 10 requests per 15 minutes |
| `GET /bridge/v2/hosted` and `/hosted/instance` | 30 requests refused with `401` per 15 minutes; accepted requests are not counted |
| `GET /bridge/v2/discord/authorize` and `/discord/callback` | 30 requests per 15 minutes, both routes together |

They send the standard `RateLimit` and `RateLimit-Policy` headers (IETF draft 7). A refused request answers `429` with `{ "error": "Too many attempts; try again later", "code": "rate_limited" }`.

## Other limits

| Limit | Value |
|---|---|
| Message text | The instance's message length limit, 2000 characters unless the operator changed it; text parts only |
| Different emoji on one message | 20; the 21st answers `400` with `code` `30010` |
| REST request body | 10 MB |
| Discord emoji image import | 512 KiB |
| Attachment mirrored from Discord | 50 MB; a larger file keeps its Discord URL |
