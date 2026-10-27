---
title: Stickers
description: Instance stickers, the sticker limits in the admin panel, personal stickers, sticker reports, storage and federation on a Harmony instance.
---

# Stickers

This page is for instance admins. Harmony has three kinds of custom sticker: a server's (see [Server stickers](/run/stickers)), the instance's, which every local account can send, and personal ones. Sending stickers is covered in [Stickers](/use/stickers).

## Instance stickers

Open **User settings** → **Instance admin**, tab **Stickers**. Instance admins add, edit and remove instance stickers there, with the same form as server stickers: an image, a name of 2 to 30 characters unique among instance stickers, and a required description of up to 300 characters.

## Limits

**Config** → **Federation** holds the sticker caps. They live in `public.instance_config` and apply when you click **Save changes**.

| Setting | Key | Default | Range | Meaning |
|---|---|---|---|---|
| **Stickers per server** | `max_stickers_per_server` | `15` | `0` to `100` | Stickers one server holds. `0` turns server stickers off |
| **Instance stickers** | `max_instance_stickers` | `50` | `0` to `500` | Instance stickers. `0` turns them off |
| **Personal stickers per user** | `max_personal_stickers_per_user` | `0` | `0` to `100` | Stickers each person keeps in **User settings** → **My stickers**. `0` turns personal stickers off, which is the default |

A value above the range reads as its top; an unreadable one as the default. The database refuses a sticker past its cap, whoever writes it. Stickers already past a lowered cap stay.

To allow personal stickers, set **Personal stickers per user** above `0` and save. Lowering it back to `0` stops new uploads; existing personal stickers stay until their owners or your staff remove them.

## File limits

| | Limit | Enforced by |
|---|---|---|
| Type | PNG, APNG, WebP or GIF | the `stickers` bucket (`allowed_mime_types`) and `create_sticker`, which also checks that the stored type matches the file extension |
| File size | 512 KB | the bucket (`file_size_limit` 524288) and `create_sticker` |
| Size | 320 × 320 pixels | the app before upload, and `create_sticker` on the size the app reports |
| Animation | 5 seconds per loop | the app before upload, and `create_sticker` on the duration the app reports |

The database holds no image bytes, so the pixel size and the animation length are the values the uploading app decoded from the file header. The app scales a larger still image down before upload and refuses a larger or longer animation.

## Storage

Sticker files live in the public storage bucket `stickers`:

| Kind | Object name |
|---|---|
| Server | `server/<server id>/<uuid>.<png, apng, webp or gif>` |
| Instance | `instance/<uuid>.<ext>` |
| Personal | `user/<profile id>/<uuid>.<ext>` |

Removing a sticker deletes its row and then its file. Each message keeps the sticker's URL; once the row is gone, apps on this instance show **Sticker removed**.

## Reports and removal

Members report a sticker of this instance from a message's menu (**Report sticker**). The report appears in the admin panel's **Reports** tab with the sticker as reported, its name, description and kind. **Remove sticker** there removes it for everyone; admins and moderators can use it. Resolve the report as usual afterwards. A personal sticker's report names its owner.

## Federation

A message with a sticker carries the sticker and an image copy of it with the description as alt text. Harmony 1.9.2 and later on other instances show the sticker; older Harmony, Mastodon and other ActivityPub software show the image. The [federation reference](/federation/reference#extension-properties) lists the fields.

Stickers that arrive from other instances are shown from their own instance's URL and are not stored here. To act on one, use the reported message.

## Native apps

The desktop and mobile apps offer stickers only on an instance whose `/instance-info` lists the `custom-stickers` capability, which instances on 1.9.2 or later do.
