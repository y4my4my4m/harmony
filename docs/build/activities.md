---
title: Activities SDK
description: Write a play-together activity for Harmony - the sandbox it runs in, the SDK, the relay protocol and its limits.
---

# Activities SDK

An activity is a web app that runs inside Harmony, in a DM, a group, a text channel or a call, and that every member there can join. This page is for developers writing one. DrawinPhone (`activities/drawinphone/` in the repository) is a complete example.

## How an activity runs

```text
activity frame  ⇄ postMessage ⇄  Harmony client  ⇄ WebSocket ⇄  instance relay  ⇄  other clients
(sandboxed)                        (holds the token)                (game-agnostic)
```

- The activity runs in a sandboxed frame with an opaque origin. Its content policy refuses every network connection, so it reaches nobody directly.
- The SDK talks to the Harmony client that embeds it. The client checks each message's size and rate and forwards it to the instance relay over the account's own connection.
- The relay knows nothing about the game. It admits members of the conversation or channel, forwards their messages, and holds three things per session: a **shared state**, a **host store** and each member's **public state**.
- One member is the **host**: the first to connect. Only the host writes the shared state and the store. When the host disconnects for 8 seconds, the member who joined earliest becomes host and receives the store. Write the game so the host decides and everyone else displays.

## The package

An activity lives in `activities/<id>/`:

| File | Content |
| --- | --- |
| `manifest.json` | See below. |
| entry (`index.ts`) | Bundled by esbuild into one classic script. CSS imported from TypeScript arrives as text; images and sounds as data URLs. |
| icon | SVG or PNG, shown in launchers at 24–96 px. |

```json
{
  "id": "drawinphone",
  "name": "DrawinPhone",
  "version": "1.0.0",
  "description": "Write, draw, guess - then watch the chains unravel.",
  "i18n": { "ja": { "name": "DrawinPhone", "description": "…" } },
  "minPlayers": 2,
  "maxPlayers": 16,
  "contexts": ["direct", "group", "channel", "voice"],
  "icon": "icon.svg",
  "accent": "#F97316",
  "entry": "index.ts"
}
```

`id` is 2–40 characters of `a-z`, `0-9` and `-`, starting with a letter. A built-in activity also needs a row in `activity_apps`, seeded by a migration, which holds the admin's switch and the player limits the relay enforces.

The web build writes `activities/index.json` (the catalog) and `activities/<id>/app.<hash>.js`. On the dev server, `/activities/dev/` opens a harness that runs several players side by side against an in-memory relay, with buttons to add and remove players and to drop the host.

## Publish a package

Any instance can install an activity that is not built in. Build your entry into one classic script (esbuild `--bundle --format=iife`, the SDK included) and zip three files, at the root or inside one folder:

| File | Limit |
| --- | --- |
| `manifest.json` | 64 KB; the fields above, `accent` as `#rrggbb`, `i18n` keys among `en es fr de ja ko zh` |
| the script `manifest.entry` names, ending `.js` | 5 MB, UTF-8 |
| the icon `manifest.icon` names | SVG, PNG or WebP, 256 KB |

The zip is at most 6 MB, packed and unpacked, and holds nothing else. Admins install it from a file or an `https://` address; the instance keeps its own copy and serves it at hash-named paths, so a new version means a new zip and an update by each instance's admin. A package cannot take the id of a built-in activity.

## What the sandbox allows

| Allowed | Refused |
| --- | --- |
| Scripts, styles, images, media and fonts from the activity's own folder, `data:` and `blob:` | `fetch`, XHR, WebSocket, EventSource, `sendBeacon`, WebRTC |
| Canvas, WebGL, Web Audio, pointer lock, workers from `blob:` | Cookies, `localStorage`, IndexedDB |
| | Popups, forms, top navigation, downloads, `alert`/`confirm`, scripts in a nested frame |
| | Camera, microphone, geolocation, clipboard reads |

Keep everything in memory. A frame that leaves its document (navigating itself, or `location.reload()`) is detached for good. `saveImage` checks the bytes against the declared type and names the file with that type's extension. Call it from a click in the frame: Harmony refuses a save while the frame does not have focus, more than one every 2 seconds, or more than 20 per game.

## SDK

```ts
import { connect } from '../sdk'

const room = await connect()

room.on('message', (from, data) => { /* from: FrameMember | undefined */ })
room.on('state', (state) => render(state))
room.on('host', (hostId) => { if (room.isHost) resumeFrom(room.store) })

if (room.isHost) room.setState({ phase: 'lobby' })
room.send({ type: 'ready' }, 'host')
```

### `Room`

| Member | Description |
| --- | --- |
| `session` | `{ id, appId, context, startedBy, maxPlayers, minPlayers }`; `context` is `direct`, `group`, `channel` or `voice`. |
| `me`, `members`, `member(id)` | Connected members in join order: `{ id, name, username, avatar, joinedAt, spectator, state }`. `avatar` is an object URL or null. |
| `hostId`, `isHost` | The host. |
| `canEnd` | This member may end the session for everyone: the starter, or a channel member with **Manage messages**. |
| `state` | The shared state. |
| `store` | The host store, a `Map`; empty unless this member hosts. |
| `locale` | The member's language, such as `en` or `ja`. |
| `theme` | `{ scheme: 'dark' \| 'light', accent, reducedMotion }`. |
| `visible` | False while the activity is hidden: a minimised panel or a background tab. |
| `connection` | `connected`, `reconnecting` or `offline`. Sends are dropped while not connected. |
| `serverNow()` | The relay's clock in epoch milliseconds. Put deadlines in the shared state in this clock. |
| `send(data, to?)` | To every other member; `'host'`; or a list of member ids. |
| `setState(state)` | Host only. Replaces the shared state and sends it to everyone. |
| `storeSet(key, value)` | Host only. `undefined` deletes the key. Nobody else receives it. |
| `setMyState(state)` | This member's public state, sent to everyone. |
| `end()` | Ends the session for everyone, when `canEnd` or hosting. |
| `leave()` | Closes the activity for this member. |
| `notify(text)` | Draws the member's attention while the activity is hidden. |
| `saveImage(blob, name)` | Hands a PNG, JPEG, WebP or GIF of at most 10 MB to Harmony's download; resolves to whether it was saved. |

### Events

| Event | Arguments |
| --- | --- |
| `join` | `member` |
| `leave` | `member, reason` (`left`, `timeout` or `removed`) |
| `host` | `hostId, previousHostId` |
| `message` | `from, data, fromId` |
| `state` | `state, fromId` |
| `member` | `member` (its `state` changed) |
| `resync` | After a reconnect: members, host, state and store were replaced. |
| `ended` | `reason`: `host_ended`, `empty`, `disabled`, `idle` or `ended` |
| `error` | `code, message?` for a refused send (`NOT_HOST`, `TOO_LARGE`, `STORE_FULL`, `RATE_LIMITED`) |
| `connection`, `visibility`, `theme` | The new value |

### Writing for reconnects

A member's frame can reload (moving between a panel and the call stage) and its connection can drop. After `connect()` and on `resync`, a member that does not host has only the shared state and its own public state. Ask the host for anything private:

```ts
if (!room.isHost) room.send({ type: 'sync' }, 'host')
room.on('message', (from, data) => {
  if (room.isHost && data?.type === 'sync') room.send(privateViewFor(from!.id), [from!.id])
})
```

Messages sent to the host while it is away are lost; resend anything unacknowledged on `host`.

## Limits

| Limit | Value |
| --- | --- |
| `send` payload | 256 KB of JSON |
| Shared state | 64 KB |
| Store | 1,024 keys, 256 KB a value, 8 MB in all |
| Member state | 2 KB |
| Rate | 40 messages a second (bursts of 80), 1 MB a second (bursts of 4 MB) |
| Players | `maxPlayers`; up to 16 more join as spectators (`spectator: true`) |

## Relay protocol

The client speaks JSON text frames to `wss://<instance>/api/federation/activities/socket`; activities never see it. The first frame is `{ "op": "hello", "v": 1, "token": "<access token>", "session": "<uuid>" }`, within 10 seconds. The relay answers `welcome` or an `error` with `fatal: true` and closes:

| Close code | Meaning |
| --- | --- |
| 4000 | No `hello` in time |
| 4001 | Token invalid or expired; refresh with `{ "op": "auth", "token": … }` before it expires |
| 4002 | Malformed frame |
| 4003 | Refused; the error's `refusal` names why (`NOT_FOUND`, `NOT_IN_CALL`, `ENDED`, `FULL`, …) |
| 4004 | Too many frames, or too slow to read them |
| 4005 | The session ended |
| 4009 | The same account connected again elsewhere |
| 4013 | The relay could not check the account or is full; connect again |

The frame and relay types are in `activities/sdk/protocol.ts`.
