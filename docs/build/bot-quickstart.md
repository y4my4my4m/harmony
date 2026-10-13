---
title: Bot quickstart
description: Create a Harmony bot, add it to a server, receive a message over the gateway and reply through the REST API, with one Node.js file.
---

# Bot quickstart

This tutorial takes you from no bot to a bot that answers `!ping` with `Pong!` in your server. You need a Harmony account, a server you own (or one where you hold Manage Server), and Node.js 22 or later. The example uses Node's built-in `WebSocket` and `fetch`; it installs no package.

## 1. Create the bot

1. Open **User settings** and select **My bots**.
2. Select **New bot**. If you have no bots yet, the button reads **Create a bot**.
3. Fill in the **Create a bot** form:
   - **Username**: 3 to 32 lowercase letters, digits, hyphens or underscores, for example `ping-bot`. It cannot be changed later.
   - **Display name** and **Description**: optional; members see them.
   - **Type**: keep **Standard**. **Bridge** is for programs that relay another platform; see [Writing a bridge](/build/bridges).
   - **Public bot**: leave it checked to let other server owners add the bot. Only you can add a private bot.
4. Select **Create bot**.

## 2. Store the token

Harmony opens the bot's page and shows **Copy your bot token**. Select **Copy**, store the token, then select **I've stored the token**.

This is the only time the full token is shown: Harmony keeps only its SHA-256 hash. A token is `harmony_bot_` followed by 64 hexadecimal characters. Anyone who holds it controls the bot, so keep it out of source control and load it from an environment variable or a secret manager.

If you lose the token, select **Reset token** in the **Token** section of the bot's page. REST requests and new gateway connections with the old token are refused at once, an open gateway connection is closed at the gateway's next token check (every 30 seconds by default), and the new token is shown once.

## 3. Add the bot to a server

On the bot's page, the **Add to server** section lists the servers you own. Select **Add** next to one. The bot joins with permission to read messages, send messages and add reactions.

You can also add it from the server: open **Server settings** → **Advanced settings**, scroll to **Server bots**, find the bot under **Add a bot** and select **Add to server**, then **Add bot**. This works in any server where you hold Manage Server.

To change what the bot may do later, use **Permissions** and **Channels** next to the bot under **Server bots**. [Permissions and rate limits](/build/permissions-rate-limits) explains both.

## 4. Note the URLs

The **Connection** section of the bot's page lists the **Bot ID**, **Gateway URL** and **REST base URL** for your instance. On an instance at `https://harmony.example.com` they are:

| | |
|---|---|
| Gateway URL | `wss://harmony.example.com/bot-gateway/gateway` |
| REST base URL | `https://harmony.example.com/bot-gateway/api/v1` |

Check the token against the REST API:

```bash
export HARMONY_BOT_TOKEN='harmony_bot_…'
curl -H "Authorization: Bot $HARMONY_BOT_TOKEN" \
  https://harmony.example.com/bot-gateway/api/v1/users/@me
```

A working token returns the bot:

```json
{
  "id": "3f6c1d2e-…",
  "username": "ping-bot",
  "discriminator": "0000",
  "avatar": "https://harmony.example.com/default_avatar.webp",
  "bot": true,
  "verified": false,
  "public": true
}
```

A `401` with `Invalid or expired token` means the token is wrong or was reset.

## 5. Write the bot

Save this as `bot.mjs`:

```js
// Answers "!ping" with "Pong!". Node.js 22 or later.
const TOKEN = process.env.HARMONY_BOT_TOKEN
const BASE = process.env.HARMONY_URL.replace(/\/+$/, '') // e.g. https://harmony.example.com
const GATEWAY_URL = BASE.replace(/^http/, 'ws') + '/bot-gateway/gateway'
const API_URL = BASE + '/bot-gateway/api/v1'

async function api(method, path, body) {
  const res = await fetch(API_URL + path, {
    method,
    headers: { Authorization: `Bot ${TOKEN}`, 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(`${method} ${path}: ${res.status} ${err.error ?? ''}`)
  }
  return res.status === 204 ? null : res.json()
}

let attempt = 0

function connect() {
  const ws = new WebSocket(GATEWAY_URL)
  let botId = null
  let heartbeat = null

  ws.addEventListener('open', () => {
    // Identify first; the gateway answers with READY.
    ws.send(JSON.stringify({ op: 2, d: { token: TOKEN } }))
  })

  ws.addEventListener('message', async (event) => {
    const { op, t, d } = JSON.parse(event.data)
    if (op !== 0) return // op 11 acknowledges a heartbeat

    if (t === 'READY') {
      attempt = 0
      botId = d.bot.id
      heartbeat = setInterval(() => ws.send(JSON.stringify({ op: 1 })), d.heartbeat_interval)
      console.log(`Connected as ${d.bot.username}`)
      return
    }

    if (t === 'MESSAGE_CREATE') {
      // Events can arrive just before READY, and the bot receives its own messages.
      if (!botId || !d.author || d.author.id === botId) return
      if (d.content !== '!ping') return
      try {
        await api('POST', `/channels/${d.channel_id}/messages`, {
          content: 'Pong!',
          reply_to: d.id,
          ...(d.thread_id ? { thread_id: d.thread_id } : {}),
        })
      } catch (err) {
        console.error(err.message)
      }
    }
  })

  ws.addEventListener('close', (event) => {
    clearInterval(heartbeat)
    console.log(`Gateway closed: ${event.code} ${event.reason}`)
    // 4001 and 4004 refuse the token; retrying with it fails again, unless the
    // gateway could not check it (reason "Token verification unavailable").
    if (event.code === 4001) return
    if (event.code === 4004 && event.reason !== 'Token verification unavailable') return
    const delay = Math.min(60_000, 1000 * 2 ** attempt++)
    setTimeout(connect, delay)
  })
}

connect()
```

What the file does:

- **Identify.** After the socket opens it sends opcode 2 with the token. The gateway replies with a `READY` event carrying the bot's ID and the heartbeat interval in milliseconds.
- **Heartbeat.** It sends `{ "op": 1 }` every `heartbeat_interval` milliseconds. A connection that sends none for twice that interval is closed.
- **Receive.** Each `MESSAGE_CREATE` event carries the message's `content` as plain text, its `channel_id`, its `thread_id` when it was posted in a thread, and its `author`. The bot ignores its own messages by comparing `author.id` with the ID from `READY`.
- **Reply.** It posts to `/channels/{channel_id}/messages` with `reply_to`, so the answer shows as a reply. A `thread_id` keeps the answer in the thread.
- **Reconnect.** There is no session resume. After a close the bot opens a new connection and identifies again, waiting 1, 2, 4 … up to 60 seconds between attempts.

## 6. Run it

```bash
export HARMONY_BOT_TOKEN='harmony_bot_…'
export HARMONY_URL='https://harmony.example.com'
node bot.mjs
```

The bot prints `Connected as ping-bot`. Type `!ping` in a channel of the server; the bot replies `Pong!`.

## If nothing happens

| Symptom | Cause and fix |
|---|---|
| `Gateway closed: 4004 Invalid or expired token` | The token is wrong, was reset, or the bot was deleted. Use the current token. |
| Connected, but no `MESSAGE_CREATE` arrives | The bot reads only channels it can see: channels @everyone can view, or the channels selected under **Server bots** → **Channels**. Check that **Read messages** is on under **Permissions**. Changes reach event delivery within about 10 seconds. |
| The reply fails with `403 Channel not visible to this bot` | Same cause as above, for sending. |
| The reply fails with `403 Missing permission in this channel: send_messages` | @everyone cannot send in that channel (an announcements channel, for example). Under **Channels**, choose **Selected channels** and check that channel; the bot then works only in the checked channels. |
| The reply fails with `429 Rate limit exceeded` | The bot sent more than 100 requests to one route on one channel within a minute (the default limit). See [Rate limits](/build/permissions-rate-limits#rest-rate-limits). |

## Next steps

- [Gateway](/build/gateway): every event, its payload, and the delivery rules.
- [REST API](/build/rest): reactions, edits, threads, channels, roles and more.
- [Permissions and rate limits](/build/permissions-rate-limits): what each route needs.
