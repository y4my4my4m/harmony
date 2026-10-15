---
title: Webhooks
description: Create, edit, regenerate and delete channel webhooks on a Harmony server, and what webhook posts look like.
---

# Webhooks

A webhook is a secret URL that lets another service, such as GitHub or a build pipeline, post messages into one text channel. This page covers managing webhooks as a server owner or moderator. For the request format a service sends, see [Webhooks API](/build/webhooks).

## Who can manage webhooks

You need **Manage Webhooks** in the channel and must be able to see the channel. The server owner and the instance's administrators can always manage them. Grant **Manage Webhooks** on a role (see [Roles and permissions](/run/roles-permissions)); A channel override of it, set in the channel editor, grants or removes it in that channel.

Webhooks work only in:

- text channels (not voice channels);
- servers hosted on your own instance;
- channels whose messages are not end-to-end encrypted.

| Limit | Value |
|---|---|
| Webhooks per channel | 10 |
| Webhooks per server | 50 |
| Name | 1 to 80 characters |
| Avatar URL | an `https://` URL, at most 2048 characters |

A name cannot be "System", "everyone", "here", the instance's name, or contain `@everyone` or `@here` (letters and digits are compared, ignoring case and punctuation).

## Open a channel's webhooks

1. Right-click a text channel in the channel list.
2. Select **Edit channel**, then the **Webhooks** tab.

Members with **Manage Webhooks** but not **Manage Channels** see only the **Webhooks** tab. Members with **Manage Channels** but not **Manage Webhooks** also see the tab, but the list does not load and shows "You need the Manage Webhooks permission."

Each webhook in the list shows its name, avatar, who created it ("Created by" the member, or "Creator unknown"), when it was last used ("Last used" a date, or "Never used"), and the last four characters of its URL ("URL ends in …").

## Create a webhook

1. On the **Webhooks** tab, select **New webhook**.
2. Enter a **Name** (it defaults to "Webhook") and, optionally, an **Avatar URL**.
3. Select **Create webhook**.
4. Copy the URL now. "Copy the URL for … now: it is shown only once. Keep it secret, like a password." Use **Copy URL**, or **Copy GitHub URL** for a GitHub repository webhook, then **Done**.

The URL has the form `https://<instance>/webhooks/channels/<webhook id>/<token>`. Harmony stores only a hash of the token, so nobody can show you the URL again. Anyone who has it can post in the channel.

### Connect GitHub

Use **Copy GitHub URL** (the webhook URL followed by `/github`) as the **Payload URL** of a repository webhook in GitHub. Harmony posts `ping`, `push`, `pull_request`, `issues`, `issue_comment`, `release`, `workflow_run`, `check_run` and `star` events as short messages; other events, and actions within those events that it does not format, post nothing.

## Edit a webhook

Select **Edit** (the pencil) beside the webhook, change the **Name** or **Avatar URL**, then **Save**. Clearing the avatar URL removes the avatar. The URL does not change.

## Regenerate a webhook URL

If a URL leaked, select **Regenerate URL** beside the webhook and confirm **Regenerate**. "The current URL of … stops working. Services using it need the new URL." The new URL is shown once, as on creation.

## Delete a webhook

Select **Delete** beside the webhook and confirm. "… stops working. Messages it posted stay." Deleting a channel deletes its webhooks too.

## What webhook posts look like

- The author is shown with the webhook's name and avatar and a **WEBHOOK** badge. A service can set a different name and avatar for each message it sends; the same name rules apply.
- Posts are text and links. `@everyone`, `@here` and other mentions in the text notify no one.
- The first five links in a post get link previews; a link written inside angle brackets gets none.
- Webhook posts come from a bot account, so AutoMod skips them while the server exempts bots, which is the default. With the exemption off, AutoMod's text and mention rules apply to them and a blocked post is refused (see [Moderation](/run/moderation#automod)).
- Members delete a webhook's posts as they delete any message, with **Manage Messages**.

The instance limits how fast a webhook can post (per webhook and per channel). The numbers are in [Webhooks API](/build/webhooks).
