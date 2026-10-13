---
title: Webhooks API
description: Post messages to a Harmony channel through an incoming webhook URL - request body, GitHub deliveries, response, errors and rate limits.
---

# Webhooks API

A channel webhook is a secret URL that posts a message to one channel. Any service that can send an HTTP POST can use it: a CI pipeline, a monitoring alert, a script, or GitHub. This page covers executing a webhook. To create one, see [Webhooks](/run/webhooks) for server owners.

The request body follows Discord's execute-webhook format, so a tool that posts `content`, `username`, `avatar_url` or `embeds` to a Discord webhook works unchanged. Files are not accepted.

## The webhook URL

When you create a webhook, or select **Regenerate URL**, the channel's **Webhooks** settings offer **Copy URL** and **Copy GitHub URL**. The URL is shown only then; Harmony stores a hash of its token.

```text
https://<instance>/webhooks/channels/<webhook id>/<token>
https://<instance>/webhooks/channels/<webhook id>/<token>/github
```

| Part | Format |
|---|---|
| `<webhook id>` | UUID |
| `<token>` | 64 lowercase hexadecimal characters |

Anyone who has the URL can post with it. Treat it like a password. Regenerating the URL stops the old one at once; deleting the webhook stops it and keeps the messages it posted.

## Execute a webhook

`POST https://<instance>/webhooks/channels/<webhook id>/<token>`

```bash
curl -X POST "https://<instance>/webhooks/channels/$WEBHOOK_ID/$WEBHOOK_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"content": "Build 412 passed: https://ci.example.com/runs/412", "username": "CI"}'
```

The body is JSON (`application/json`) or form-encoded (`application/x-www-form-urlencoded`), at most 64 KB. A form-encoded body may carry the JSON object in a `payload_json` field. A `multipart/` body is refused with `415`.

| Field | Type | Description |
|---|---|---|
| `content` | string | Message text. |
| `username` | string | Name shown on this message instead of the webhook's name. |
| `avatar_url` | string | Avatar shown on this message instead of the webhook's avatar. |
| `embeds` | object[] | Discord embeds, turned into text; see below. |
| `flags` | integer | `4` (Discord's `SUPPRESS_EMBEDS`) posts the message without link previews. Other bits are ignored. |
| `payload_json` | string | The other fields as a JSON string, for form-encoded bodies. |

`allowed_mentions`, `tts`, `components`, `attachments`, `poll` and `thread_name` are ignored. A webhook always posts to the channel itself, never in a thread.

### How the message is built

- **Text only.** `content` and the flattened `embeds` are joined with a line break. A message with no text after that is refused with `400`.
- **Embeds.** Each of up to 10 embeds becomes lines of text: the author name, the title with its URL, the description, up to 25 fields, the image URL and the footer. Discord's length limits apply to each piece, and the embeds together are cut to 6000 characters.
- **Links.** Masked links `[label](https://…)` become `label (<https://…>)`. URLs in the text become links; the first five get link previews. A URL written as `<https://…>` gets no preview.
- **No mentions.** Mention syntax stays plain text. `@everyone` in a webhook message notifies no one.
- **Length.** The text, not counting links, may hold at most the instance's message length limit: 2000 characters unless the operator changed it.

### Username and avatar overrides

| Field | Rule |
|---|---|
| `username` | 1 to 80 characters after runs of whitespace become one space. Control characters, the names `system`, `everyone` and `here`, the instance's own name (letters and digits compared, case ignored), and any text containing `@everyone` or `@here` are refused. Blank keeps the webhook's name. |
| `avatar_url` | An `https://` URL of at most 2048 characters. Blank keeps the webhook's avatar. |

### Response

A posted message answers `204 No Content`.

Add `?wait=true` to the URL to receive `200` and the message as a Discord message object instead:

```json
{
  "id": "0b9e5a61-…",
  "type": 0,
  "channel_id": "c2d4f8a0-…",
  "webhook_id": "6f0d2c47-…",
  "content": "Build 412 passed: https://ci.example.com/runs/412",
  "author": { "id": "6f0d2c47-…", "username": "CI", "avatar": null, "discriminator": "0000", "bot": true },
  "timestamp": "2026-10-13T12:00:00.000000+00:00",
  "edited_timestamp": null,
  "tts": false,
  "mention_everyone": false,
  "mentions": [],
  "mention_roles": [],
  "attachments": [],
  "embeds": [],
  "pinned": false,
  "flags": 0
}
```

`id` and `channel_id` are Harmony UUIDs. `webhook_id` and `author.id` are the webhook's ID. `content` is the text as built above. `flags` is `4` when link previews were suppressed.

## GitHub deliveries

Use the URL ending in `/github` as the **Payload URL** of a repository or organization webhook on GitHub. Either content type works (`application/json`, or `application/x-www-form-urlencoded` with the JSON in `payload`), up to 1 MB. Harmony reads the `X-GitHub-Event` header and posts a short summary that starts with the repository name and ends with a link.

| Event | Posts for |
|---|---|
| `ping` | The webhook being connected, with its event list |
| `push` | Pushed and force-pushed commits (the first five listed), and created or deleted branches and tags |
| `pull_request` | `opened`, `reopened`, `ready_for_review`, `closed` (shown as merged or closed) |
| `issues` | `opened`, `closed`, `reopened` |
| `issue_comment` | `created` |
| `release` | `published` |
| `workflow_run` | `completed`, with its conclusion |
| `check_run` | `completed`, with its conclusion |
| `star` | `created` |

Other events and actions answer `204` and post nothing. The token in the URL authenticates the delivery; GitHub's webhook secret is not checked.

## Where a webhook can post

A webhook posts to a text channel of a server on this instance. It cannot post to an end-to-end encrypted channel. A channel holds at most 10 webhooks and a server at most 50.

The server's AutoMod applies to webhook messages as to a bot's. A webhook stops working when its creator's account is suspended or deleted.

## What bots see

A webhook message reaches bots as [`MESSAGE_CREATE`](/build/gateway#message-create) with `author.webhook: true`, `author.bot: true`, and `username` and `display_name` set to the name it was posted under. Its `metadata` carries `created_via: "webhook"` and `webhook: { "id", "name", "avatar_url" }`.

## Errors

Error bodies follow Discord's format, `{ "message", "code" }`.

| Status | `code` | `message` | Cause |
|---|---|---|---|
| `400` | `50006` | `Cannot send an empty message` | No text, or the body is not an object. |
| `400` | `50035` | varies | `content`, `username` or `avatar_url` is not a string, `embeds` is not an array, `payload_json` is not a JSON object, the text is over the length limit, or an override breaks its rule. |
| `400` | `50109` | `The request body contains invalid JSON.` | |
| `401` | `50027` | `Invalid Webhook Token` | The ID or token is malformed, unknown, wrong or deactivated. All look alike. |
| `403` | `CHANNEL_ENCRYPTED` | `This channel is end-to-end encrypted; webhooks cannot post to it` | |
| `403` | `CHANNEL_UNSUPPORTED` | varies | The channel is not a text channel of a server on this instance. |
| `403` | `AUTOMOD_BLOCKED` | `Blocked by the server's AutoMod` | |
| `404` | `0` | `404: Not Found` | Another path under `/webhooks/channels/`. |
| `405` | `0` | `405: Method Not Allowed` | A method other than `POST`. |
| `413` | `40005` | `Request entity too large` | Over 64 KB, or 1 MB on the GitHub route. |
| `415` | `0` | `Attachments are not accepted; send JSON or a form-encoded body` | A multipart body. |
| `429` | | | Rate limited; see below. |
| `500` | | `Internal error` | |
| `503` | | | The rate limiter could not count the request. Retry after the `Retry-After` header. |

## Rate limits

| Limit | Scope |
|---|---|
| 5 requests per 2 seconds, and 30 per minute | Per webhook URL |
| 10 requests per 2 seconds, and 60 per minute | Per channel, across all its webhooks |
| 30 failed authentications per minute | Per client IP address; past it, every request from that address is refused for the rest of the minute |
| Link previews for 20 messages per minute | Per channel; past it, messages post without previews |

The channel limits count from a URL's second request on, once the channel behind it is known.

A refused request answers `429` with `X-RateLimit-Limit`, `X-RateLimit-Remaining`, `X-RateLimit-Reset` (Unix seconds) and `Retry-After` (seconds) headers:

```json
{ "error": "Too Many Requests", "message": "You are being rate limited.", "retryAfter": 2 }
```

An address refused for failed authentications gets the same shape with the message `Too many invalid webhook requests from this address.`

When the limiter cannot count a request, the request is refused with `503`, `Retry-After: 5` and `{ "error": "Service Unavailable", "message": "Rate limiting is unavailable; retry later." }`.
