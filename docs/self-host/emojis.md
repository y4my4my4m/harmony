---
title: Emojis
description: The emoji library in a Harmony instance's admin panel, with upload, rename, remove, purge and copying images to the instance, and importing emojis seen on other instances.
---

# Emojis

This page is for instance admins. It covers the emoji library of the admin panel. Server and personal emoji limits are in [Configuration](/self-host/configuration#emoji-limits); using emoji is covered in [Messages and threads](/use/messages#reactions).

## The library

Open **User settings** → **Instance admin**, tab **Emojis**. It lists every custom emoji on this instance, 50 to a page: uploads, imports, emojis cached from other instances, server emojis and personal ones.

| Filter | Options |
|---|---|
| **Kind** | **All**, **Instance**, **Imported**, **Federated cache**, **Server**, **Personal**, **AI generated**, **Available to import** |
| **Status** | **Active**, **Removed** |
| **Sort** | **Newest first**, **Oldest first**, **Name (A-Z)**, **Most used** |

**Search emojis** matches a name, server, owner or domain. **Select** turns on check boxes for acting on several emojis at once, and **Select all on this page** selects the page: **Remove selected** (**Restore selected** under **Removed**), **Purge selected**, and **Copy images to this instance** when the selection holds emojis hosted elsewhere.

| Action | Effect |
|---|---|
| **Upload** | Adds instance emojis from PNG, APNG, GIF, WebP or JPEG files, several at once, each named after its file. |
| **Rename** | Names are 2 to 64 letters, digits, `_` or `-`. No other active emoji of the same server, of the same person, or of the instance may hold the name, in any letter case. |
| **Remove** | Takes the emoji out of every emoji picker; a typed `:name:` no longer finds it. Earlier messages and reactions keep showing it. **Restore**, under **Removed**, brings it back, unless another active emoji has taken its name or the emoji limit is reached. |
| **Purge** | Deletes the emoji and its file for good. Earlier messages, posts and reactions that use it show a broken-image icon with its `:name:`. |
| **Copy image to this instance** | For an instance emoji marked **hosted elsewhere**: it already works here, but its image still loads from another site. The image is copied to this instance; nothing else about the emoji changes. |

A server emoji removed here stays removed when the server's emoji list arrives again, from its Discord bridge or, for a server hosted on another instance, from that instance. A purged server emoji that came from Discord is not copied back by the bridge.

## Import emojis from other instances

Custom emojis seen in posts and reactions from other instances can be imported. An import downloads the image to this instance and adds it to the instance emojis, where everyone here can use it. The original stays where it is.

1. Select **Import** at the top, or set **Kind** to **Available to import**. The list shows the emojis not imported yet, with how often each was seen; **Search emojis** matches the name, and **Source instance** narrows the list to one instance.
2. Select **Import** on a row for one emoji. For several, select **Select**, tick them or **Select all on this page**, then **Import selected**.
3. The dialog lists each emoji with its instance and, when that instance states one, its licence. A name an instance emoji already holds is marked **name in use** and offered with a number appended: keep it, type another, or tick **Skip**.
4. Select **Import N emojis**. Each image is downloaded to this instance and added under the name shown. **Stop** leaves the emojis not yet started. Existing emojis are never replaced.

An imported emoji keeps the licence and the instance it came from. The image must be PNG, APNG, GIF, WebP or JPEG, judged by its content, and at most 1 MB; its metadata is removed before it is stored. Imports and image copies count toward a limit of 1000 an hour per admin.
