---
title: Server stickers
description: Add, describe, rename and remove a Harmony server's custom stickers, who may do it, and the limits that apply.
---

# Server stickers

A server's stickers can be sent by its members in the server's channels and threads. This page is for the people who manage them. How members send stickers is in [Stickers](/use/stickers).

## Who manages stickers

Open **Server settings** → **Stickers**. Server stickers exist for servers hosted on your own instance only; a server joined from another instance has no **Stickers** section.

Adding, editing and removing stickers takes the **Manage Expressions** permission (the one that also covers custom emoji and soundboard sounds), held by the owner, administrators and any role you give it. Members without it see the list only. The instance's admins can manage any local server's stickers.

## Add a sticker

1. Under **Add a sticker**, choose an **Image**: PNG, APNG, WebP or GIF, up to 512 KB and 320 × 320 pixels, animations up to 5 seconds. A larger still image is scaled down before upload; an animated one is refused.
2. Check the **Name**, 2 to 30 characters, filled in from the file name. Two stickers of one server cannot share a name, ignoring case.
3. Write a **Description** of up to 300 characters. It is required: screen readers read it, and other apps show it as the image's alt text.
4. Select **Upload sticker**.

The count beside the list shows the server's stickers against the instance's limit, 15 unless the instance changes it. At the limit the form is replaced by **Sticker limit reached**. When the instance sets the limit to 0, server stickers are off and the section says so.

## Edit or remove a sticker

**Edit** changes a sticker's name and description; the image stays. **Delete** removes the sticker after a confirmation. Messages that already sent it show **Sticker removed** in its place.

## Audit log

The [audit log](/run/moderation#audit-log) records `sticker.create`, `sticker.update` (name and description changes) and `sticker.delete`, filtered under **Stickers**.

## Reports

Members can report a server sticker. Reports about stickers go to the instance's admins and moderators, who can remove the sticker; they do not appear in the server's own report list.
