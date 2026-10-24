---
title: Outgoing webhooks
description: Receive a bot's or a server's events as signed HTTPS POSTs - events, request format, Standard Webhooks signatures, retries, limits and what is never sent.
---

# Outgoing webhooks

An outgoing webhook sends events to a URL you run, as HTTPS POST requests. It is the [gateway](/build/gateway)'s events without a WebSocket connection: a serverless function, a queue endpoint or any HTTP service can receive them.

Two kinds exist:

| Kind | Who registers it | Where | Receives |
|---|---|---|---|
| A bot's | The bot's owner | **User settings** → **Bots** → the bot → **Outgoing webhooks** | The events the bot's gateway connection receives, whether it is connected or not |
| A server's | The server's owner, an instance admin, or a member with **Manage Webhooks** | **Server settings** → **Outgoing webhooks** | The server's events, from channels the webhook's creator can view |

Each bot and each server has at most five. Incoming webhooks, which post messages into a channel, are a different feature: see [Webhooks API](/build/webhooks).

## Events

A webhook takes the events you tick when you create or edit it.

| Event | Sent when | Payload (`data`) |
|---|---|---|
| `MESSAGE_CREATE` | A message is posted in a server channel or thread | The gateway's [`MESSAGE_CREATE`](/build/gateway#message-create) |
| `MESSAGE_UPDATE` | A message's content changes | The gateway's [`MESSAGE_UPDATE`](/build/gateway#message-update) |
| `MESSAGE_DELETE` | A message is deleted | The gateway's [`MESSAGE_DELETE`](/build/gateway#message-delete) |
| `MESSAGE_REACTION_ADD` | A reaction is added | The gateway's [`MESSAGE_REACTION_ADD`](/build/gateway#message-reaction-add) |
| `MESSAGE_REACTION_REMOVE` | A reaction is removed | The gateway's [`MESSAGE_REACTION_REMOVE`](/build/gateway#message-reaction-remove) |
| `SERVER_MEMBER_ADD` | Someone becomes a member | [Member events](/build/gateway#member-events) |
| `SERVER_MEMBER_REMOVE` | A member leaves, is kicked or banned | [Member events](/build/gateway#member-events) |
| `SERVER_MEMBER_KICK` | A member is kicked | [Member events](/build/gateway#member-events) |
| `SERVER_BAN_ADD` | A member is banned | [Member events](/build/gateway#member-events) |
| `SERVER_BAN_REMOVE` | A ban is lifted | [Member events](/build/gateway#member-events) |
| `PING` | You select **Send test event** | `{ webhook_id, bot_id, server_id }` |

Every `data` carries `server_id`.

Never sent: direct messages, end-to-end encrypted messages, and channels the webhook may not read. A bot's webhook follows the bot's [channel access](/build/permissions-rate-limits#how-permissions-are-computed); a server's webhook stops receiving a channel's events when its creator can no longer view the channel, and stops receiving anything when its creator no longer manages the server's webhooks.

## The request

```http
POST /your/path HTTP/1.1
Content-Type: application/json
webhook-id: 9f0e2d4c-6c1a-4f7e-9d0b-2a7f5c3e1b88
webhook-timestamp: 1761296405
webhook-signature: v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=

{"type":"MESSAGE_CREATE","timestamp":"2026-10-24T09:00:00.000Z","data":{...}}
```

| Field | Meaning |
|---|---|
| `type` | The event |
| `timestamp` | When the event was queued |
| `data` | The payload |
| `webhook-id` | The delivery's id, the same on every attempt: use it to drop duplicates |
| `webhook-timestamp` | Unix seconds when this attempt was sent |
| `webhook-signature` | `v1,` then the base64 HMAC-SHA256 of `<webhook-id>.<webhook-timestamp>.<body>` |

Answer with any 2xx status within 10 seconds. Anything else, a redirect included, is a failed attempt.

## Verify the signature

The headers follow [Standard Webhooks](https://www.standardwebhooks.com/), so its libraries verify them. The secret is shown once when you create the webhook or select **Rotate secret**; it starts with `whsec_`, and the HMAC key is the base64 that follows.

```js
import crypto from 'node:crypto'

function verify(secret, headers, rawBody) {
  const key = Buffer.from(secret.slice('whsec_'.length), 'base64')
  const id = headers['webhook-id']
  const timestamp = headers['webhook-timestamp']
  if (Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) return false
  const expected = crypto.createHmac('sha256', key).update(`${id}.${timestamp}.${rawBody}`).digest('base64')
  return headers['webhook-signature'].split(' ').some((sig) => {
    if (!sig.startsWith('v1,')) return false
    const given = Buffer.from(sig.slice(3))
    const wanted = Buffer.from(expected)
    return given.length === wanted.length && crypto.timingSafeEqual(given, wanted)
  })
}
```

Verify the raw body before parsing it, and refuse a timestamp more than five minutes from your clock.

## Verification

A new webhook, or one whose URL changed, receives a `PING` first and no other event until its endpoint answers that `PING` with a 2xx. Until then its settings read "Waiting for a 2xx answer to the test event". A `PING` that fails is retried as any delivery is; **Send test event** sends another, at most one every 10 seconds.

## Delivery

- **Order.** Events are sent as they happen, each delivery on its own: a retried delivery can arrive after later ones.
- **Retries.** A failed attempt is retried after 30 seconds, 2 minutes, 10 minutes, 30 minutes, 1 hour, 3 hours and 6 hours. After the eighth failure the delivery is given up.
- **Pausing.** After 10 failed attempts in a row a webhook is paused: new events are skipped, and a `PING` probes it every 5 minutes. The first 2xx resumes it.
- **Turning off.** A webhook whose deliveries have failed for three days, with no success in between, is turned off and its owner is notified. Turning it on again in its settings resumes deliveries from then on.
- **Rate.** Each webhook takes at most the instance's events per minute (120 by default); events past it are skipped. Skipped events, whether over the rate or while paused, are counted in the webhook's settings.
- **Concurrency.** At most two attempts of one webhook are in flight at a time, and each destination host receives at most the instance's requests per minute (600 by default) across all webhooks; attempts past either wait.
- **Log.** **Deliveries** lists the last 25 of the past seven days with their status and the last answer.
- **Timing.** The gateway reads messages every second, and edits, deletes, reactions and member events every 2 seconds. A new or changed webhook takes effect within 10 seconds. Events that occur while the gateway restarts are not sent.

## Requirements and limits

- **HTTPS only.** Redirects are not followed.
- **Public addresses only.** A URL whose host resolves to a private, loopback, link-local or cloud metadata address is refused when the connection is made.
- **Credentials.** A URL with a user name or password is refused.
- **Size.** Five webhooks per bot and per server, and the instance's cap per person (10 by default) across the bots and servers they manage; names of 1 to 80 characters; URLs of at most 2048 characters.
- **Instance settings.** The instance's staff choose who may create outgoing webhooks (everyone who manages a bot or a server's webhooks, staff only, or no one), the rates and the cap above, and blocked destination domains. They can turn any webhook off; its owner cannot turn it back on.
- **Instance requirement.** Outgoing webhooks keep their secrets in Supabase Vault. An instance without it cannot create them.
