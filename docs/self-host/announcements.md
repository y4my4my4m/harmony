---
title: Announcements
description: Announcements from a Harmony instance's admins, written in the admin panel, and the pop-up, Today card and settings page where everyone on the instance reads them.
---

# Announcements

This page is for instance admins. An announcement tells everyone on this instance something: a pop-up when they open Harmony, a card on **Today**, and a list in **User settings** → **Announcements**.

## Write an announcement

Open **User settings** → **Instance admin**, tab **Content**. The **Announcements** card lists the announcements, with **Edit** and **Delete** on each; **Create** opens the form for a new one.

| Field | What it does |
|---|---|
| **Title** | The announcement's title. Required. |
| **Content (supports basic HTML)** | The text. Required. Paragraphs, line breaks, links, emphasis, strikethrough, code, quotes, lists, headings and images are kept; other HTML is removed. Text without HTML keeps its line breaks. An image shows only when its address is `https`. `:name:` outside code shows this instance's custom emoji of that name. |
| **Icon (an emoji, or info, warning, megaphone, maintenance, update, security)** | The icon beside the title, in the pop-up, on **Today** and in both lists: an emoji as typed, or the named icon. Anything else shows as `info`. |
| **Image URL (optional)** | A picture under the text, in the pop-up and in **User settings** → **Announcements**. **Today** does not show it. |
| **Starts at (optional)**, **Ends at (optional)** | When the pop-up and **Today** show the announcement, in your time zone. An empty **Starts at** is now; an empty **Ends at** never ends. |
| **Pinned** | Lists it first in the pop-up and on **Today**, marked **Pinned**. |
| **Show popup** | On by default. Off, the announcement shows only on **Today** and in **User settings** → **Announcements**. |
| **Active** | When editing. Off, the pop-up and **Today** leave the announcement out; the list here marks it **Inactive**. |

The **All** tab of **User settings** → **Announcements** lists every announcement to everyone on the instance, whatever its dates and **Active**: one not started yet is marked **Scheduled**, one past its end **Expired**, one turned off **Inactive**. **Delete** takes an announcement off that list.

## Where people read it

| Place | What it shows |
|---|---|
| The pop-up | Unread announcements with **Show popup** that started after the person's account was made, up to 10, pinned first. One announcement has **Don't show again**; several have **Mark as read** each and **Mark all as read**. **View past announcements** opens **User settings** → **Announcements**. Closing the pop-up any other way leaves the announcements unread, and it opens again the next time Harmony opens. |
| **Today** | Up to 3 unread announcements, pinned first: pinned ones, and others that started after the account was made. **Dismiss** marks one read. **N more in Settings** opens **User settings** → **Announcements** when there are more. |
| **User settings** → **Announcements** | Every announcement from this instance's admins, on the tabs **Unread**, **All** and **Pinned**, with **Mark as read** and **Mark all as read**. |
