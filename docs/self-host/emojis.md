---
title: Emojis
description: The instance's emoji library in the admin panel - upload, rename, remove, purge, copy images to the instance and import emojis seen from other instances.
---

# Emojis

This page is for instance admins. It covers the emoji library of the admin panel. Emoji limits are in [Configuration](/self-host/configuration#emoji-limits); using emoji is covered in [Messages](/use/messages).

## The library

Open **User settings** → **Instance admin**, tab **Emojis**. It lists every custom emoji on this instance: uploads, imports, emojis cached from other instances, server emojis and personal ones.

| Filter | Options |
|---|---|
| **Kind** | **All**, **Instance**, **Imported**, **Federated cache**, **Server**, **Personal**, **AI generated**, **Available to import** |
| **Status** | **Active**, **Removed** |
| **Sort** | **Newest first**, **Oldest first**, **Name (A-Z)**, **Most used** |

**Search emojis** matches a name, server, owner or domain. **Select** turns on check boxes for the actions on several emojis at once; **Select all on this page** selects the page.

| Action | Effect |
|---|---|
| **Upload** | Adds instance emojis from image files. Only instance admins can upload them. |
| **Rename** | Names are 2 to 64 letters, digits, `_` or `-`, and no other active emoji may use the name. |
| **Remove** | Takes the emoji out of every emoji picker. Earlier messages and reactions keep showing it, and **Restore** brings it back. |
| **Purge** | Deletes the emoji and its file for good. Earlier messages and reactions that use it show a broken-image icon. |
| **Copy image to this instance** | For an emoji marked **hosted elsewhere**: it already works here, but its image still loads from another site. The image is copied to this instance; nothing else about the emoji changes. |

## Import emojis from other instances

Custom emojis this instance has received from other instances are kept as **Federated cache**. Importing one copies it into the instance emojis, where everyone on this instance can use it.

1. Set **Kind** to **Available to import**, or pick emojis with **Import** on a row.
2. Select one or many, then **Import selected**. One import takes up to 200 emojis.
3. The dialog lists each emoji with its origin instance and, when that instance states one, its licence. A name an instance emoji already uses is marked **name in use**: keep the suggested name, type another, or skip it.
4. Confirm. Each image is downloaded to this instance and added under the name shown. Existing emojis are never replaced.

An imported emoji keeps the licence and the origin instance its cache row holds. The image must be PNG, APNG, GIF, WebP or JPEG within the emoji file size limit; its metadata is removed before it is stored. Imports are limited per hour.
