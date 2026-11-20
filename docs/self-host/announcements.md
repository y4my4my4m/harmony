---
title: Announcements
description: Announcements from an instance's admins - writing them in the admin panel, and where everyone on the instance reads them.
---

# Announcements

This page is for instance admins. An announcement tells everyone on this instance something: a pop-up when they open Harmony, a card on **Today**, and a list in **User settings** → **Announcements**.

## Write an announcement

Open **User settings** → **Instance admin**, tab **Content**. The **Announcements** card lists the announcements with **Edit** and **Delete**, and holds the form for a new one.

| Field | What it does |
|---|---|
| **Title** | The announcement's title. |
| **Content (supports basic HTML)** | The text. Paragraphs, line breaks, links, emphasis, strikethrough, code, quotes, lists, headings and images are kept; other HTML is removed. `:name:` outside code shows this instance's custom emoji of that name. An image shows when its address is `https` or this instance's storage. |
| **Icon (emoji or name: info, warning, megaphone)** | The icon beside the title. |
| **Image URL (optional)** | A picture shown with the announcement. |
| **Starts at (optional)**, **Ends at (optional)** | When the announcement shows. Without them it shows from now on, until you turn it off or delete it. |
| **Pinned** | Marks it **Pinned** and keeps it at the top. |
| **Show popup** | Also shows it as a pop-up when people open Harmony. Without it, it shows only on **Today** and in **User settings** → **Announcements**. |
| **Active** | When editing: off hides the announcement without deleting it. The list marks it **Inactive**. |

## Where people read it

| Place | What it shows |
|---|---|
| The pop-up | Announcements with **Show popup** that the person has not read yet and that started after their account was made, up to 10, with **Mark as read**, **Don't show again** and **View past announcements**. |
| **Today** | The current announcements, **Pinned** ones first, each with **Dismiss**, and **N more in Settings** when there are more. |
| **User settings** → **Announcements** | Past and current announcements from this instance's admins. |
