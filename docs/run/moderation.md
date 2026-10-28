---
title: Moderation
description: AutoMod, rules acceptance, reports, message moderation, kicks, bans, timeouts and the audit log on a Harmony server.
---

# Moderation

This page covers the tools a server's owner and moderators use to keep it in order: AutoMod, rules acceptance, reports, deleting and pinning messages, kicks, bans, timeouts, and the audit log. Who counts as a moderator depends on the permissions you give roles; see [Roles and permissions](/run/roles-permissions).

| Task | Permission needed | Where |
|---|---|---|
| Configure AutoMod, rules acceptance | Manage Server | **Server settings** → **AutoMod**, **Welcome & rules** |
| Handle reports | Manage Messages | **Server settings** → **Reports** |
| Delete, pin and unpin messages, remove embeds | Manage Messages (pinning: Pin Messages or Manage Messages) | The message's menu |
| Kick | Kick Members | Member list, profile, `/kick` |
| Ban and unban | Ban Members | Member list, profile, `/ban`; **Server settings** → **Bans** |
| Remove a timeout | Timeout Members | **Server settings** → **AutoMod** |
| Read the audit log | View Audit Log | **Server settings** → **Audit log** |

The owner can do all of these. Holders of Administrator have every permission.

## AutoMod

AutoMod checks every message posted or edited in the server's channels before anyone sees it. It can block the message, post an alert, and time the author out. It runs on servers hosted on your own instance; a server hosted elsewhere is moderated by its home instance.

Open it from **Server settings** → **AutoMod**. The section needs **Manage Server**.

### Turn AutoMod on

A new server starts with AutoMod on and the recommended rules. A server created before AutoMod existed shows a banner at the top of its settings, "AutoMod is available for this server", with three buttons:

- **Turn on**: adds the recommended rules and switches AutoMod on.
- **Review rules**: opens the AutoMod section, which offers **Turn on recommended protections**.
- **Not now**: hides the banner and leaves AutoMod off.

The recommended setup turns on mention spam (more than 20 people mentioned in one message, or 50 in a minute), message floods (more than 10 messages in 10 seconds), cross-channel spam (the same message in more than 2 channels within 5 minutes) and an alert when 10 members join within a minute. It also adds rules for invites, slurs and new members, switched off.

### AutoMod settings

| Setting | What it does |
|---|---|
| **AutoMod** | Master switch. "Off. No rule is enforced; timeouts still apply." |
| **Alert channel** | The text channel where AutoMod posts what it blocked or flagged. **No alert channel** keeps events in the log only. |
| **Skip bots** | On by default: "Messages from installed bots and bridges are not checked." This includes [webhooks](/run/webhooks). |

### Rules

Select **Add rule** and pick a type. A server holds up to 25 rules, and a rule name is up to 100 characters. Each rule has a **Trigger**, one or more **Actions**, and optional **Exemptions**; select **Save** on the rule card to apply it.

| Type | Triggers on | Settings and limits |
|---|---|---|
| **Custom words** | Words, phrases or patterns you list | **Words and phrases**: up to 1000, each up to 60 characters. Whole words by default; `word*` matches a prefix, `*word` a suffix, `*word*` anywhere. Matching ignores case, accents, look-alike letters, spacing tricks and repeated letters. **Regular expressions**: up to 10, at most 260 characters each, case-insensitive, no back-references. **Allowed words**: up to 100. |
| **Word presets** | Built-in word lists | **Slurs**, **Sexual content**, **Profanity**; plus **Allowed words** |
| **Mention spam** | Too many mentions | **Mentions per message** (1 to 50, default 20); **Mentions per window (0 = off)** (0 to 1000, default 50) over **Window (seconds)** (10 to 3600, default 60). Distinct users and roles are counted; `@everyone` and `@here` each count as one. Optional: block `@everyone` and `@here` from members without **Mention @everyone**. |
| **Message flood** | Messages sent too fast, across all channels | **Messages allowed** (2 to 100, default 10) per **Window (seconds)** (2 to 300, default 10) |
| **Cross-channel spam** | The same message in several channels | **Channels allowed** (1 to 20, default 2), **Window (seconds)** (10 to 3600, default 300), **Minimum length** (1 to 500, default 10) |
| **Server invites** | Invites to other servers, Harmony or Discord | No settings. This server's own invites are allowed. |
| **Links** | Links by domain | **Mode**: **Allow only these domains** or **Block these domains**; **Domains**: up to 200, subdomains included |
| **New members** | Links, attachments or mentions from new accounts or members who joined recently | **Account younger than** (Not checked, 1 hour, 1 day, 1 week, 30 days), **Or joined less than** (Not checked, 5 minutes, 10 minutes, 30 minutes, 1 hour, 1 day); what to hold back: **Links**, **Attachments**, **Mentions** |

Text rules (words, presets, links, invites, cross-channel spam) cannot read end-to-end encrypted messages and skip them. Mention, flood and new-member rules still apply.

### Actions

| Action | Effect |
|---|---|
| **Block message** | The message is not posted, and the author sees why. **Custom reason shown to the author**: up to 150 characters. |
| **Send alert** | Posts the event in the alert channel. |
| **Time out the member** | **No timeout**, 1 minute, 5 minutes, 10 minutes, 1 hour, 1 day or 1 week. A new timeout never shortens one already running. |

A rule needs at least one action; new rules start with **Block message** and **Send alert**. The first matching rule that blocks stops the check.

### Exemptions

- Per rule: **Roles** and **Channels and categories**. "Members with a selected role, and messages in selected channels or categories, skip this rule." Up to 50 roles and 100 channels or categories. Selecting `@everyone` exempts everyone.
- Always exempt from every rule: the server owner and members holding **Administrator** or **Manage Server**.
- Bots: skipped while **Skip bots** is on. Flood, cross-channel and new-member rules never apply to bots.
- Messages relayed from Discord by a bridge: mention, flood, cross-channel and new-member rules apply to the Discord author whatever **Skip bots** says; word, preset, invite and link rules apply only when **Skip bots** is off.

### What a blocked member sees

The message is not sent and their text stays in the message box. A notice explains why: the rule's custom reason if it has one, otherwise a message for the rule type, such as "Your message was blocked: it contains a word this server does not allow." If the rule also timed them out, the notice adds when the timeout ends.

### Alerts and the AutoMod log

With an alert channel set, each event is posted there as a system message naming the member, the rule and whether they were timed out, with an excerpt. Repeats by the same member on the same rule within 30 seconds are folded into one event.

The **AutoMod log** at the bottom of the AutoMod section lists what was blocked, alerted, timed out or slowed down, with the matched text. Entries are kept for 90 days. AutoMod's blocks are not in the [audit log](#audit-log); its timeouts are.

### Raid protection

**Raid protection** watches for a burst of joins.

| Setting | Range | Default |
|---|---|---|
| **Joins** | 3 to 1000 | 10 |
| **Window (seconds)** | 10 to 3600 | 60 |
| **When triggered** | **Alert only** or **Alert and slow down channels** | Alert only |
| **Slowmode (seconds)** | 5 to 21600 | 30 |

It only runs while AutoMod itself is on. **Lock down now** sets that slow mode on every text channel at once; **Lift lockdown** restores each channel's previous slow mode.

## Require new members to accept the rules

There is no join approval queue or verification level. What exists is a rules gate: in **Server settings** → **Welcome & rules** (needs **Manage Server**), add at least one rule and turn on **Members must accept the rules before sending messages**.

- Members who join after you save this see an **Accept rules** button instead of the message box until they accept. They can read channels meanwhile.
- "Current members are not asked. Only people who join after you save this must accept."
- The owner and members with **Manage Server** or **Administrator** are exempt.
- Members of other instances, bots and bridges are not checked.

The welcome screen itself is covered in [Setting up a server](/run/setup#welcome-screen-and-rules).

## Reports

### How members report

- **A message**: open the message's menu (right-click it) and choose **Report message**. This appears on messages you did not write.
- **A member**: open their full profile page, open its menu and choose **Report**.

The reporter picks a reason (**Spam or unwanted content**, **Harassment or bullying**, **Illegal content**, **Impersonation**, **Inappropriate/NSFW content**, **Other**) and can add details, up to 1000 characters. When the reported account is on another instance, they can also tick "Also send an anonymous copy of this report to …". A member can file up to 20 reports an hour, and cannot report themselves.

### Who receives them

| Report | Who sees it |
|---|---|
| A message in a channel of a server hosted on this instance | That server's owner and members with **Manage Messages**, in **Server settings** → **Reports** ("Reports in this server"); also the instance's administrators and moderators |
| A member, or anything else | The instance's administrators and moderators only |

Server moderators never see who filed a report: it shows as "Anonymous reporter". Nobody is notified when a report arrives; check the **Reports** section.

### Handle a report

The **Reports** section filters by status: **Pending**, **Investigating**, **Resolved**, **Dismissed** and **All**. On each report a server moderator can:

| Action | Effect |
|---|---|
| **Mark investigating** | Moves a pending report to investigating |
| **Resolve** / **Dismiss** | Closes the report |
| **Reopen** | Reopens a closed report |
| **Assign to me** / **Unassign** | Claims the report |
| **Delete message** | Deletes the reported message and resolves the report, after a confirmation |

Before resolving or dismissing you can write a "Note to the reporter (optional, sent on resolve or dismiss)", up to 1000 characters, and choose **Show my name to the reporter** (off by default). The reporter is notified when their report moves to investigating, resolved or dismissed.

Suspending accounts, warning them, and forwarding reports to other instances are the instance staff's actions, not a server moderator's.

### Remove a reported file

Removing files is also for instance staff: the instance's administrators and moderators, not server moderators. In the admin panel's **Reports** tab (**User settings** → **Instance admin**, or **Instance moderation** for instance moderators), a reported message that carries files lists them under **Attached files**:

| Action | Effect |
|---|---|
| **Remove file** | Deletes the file from its owner's [Drive](/use/drive). Messages that sent it show "This file was removed by the moderators". |
| **Remove and block re-uploads** | Removes the file and blocks its contents on the instance. |

A block works on the SHA-256 the server computes from the file's bytes, never on a hash the uploader's app reports. Once a file's contents are blocked:

- other copies of the same bytes on the instance are removed, in every account's Drive; a copy the server has not hashed yet is removed once it has;
- a later upload that reports the blocked hash is refused with "This file was removed by the instance moderators.", and any other upload of the same bytes is removed once the server has hashed it.

When the server has not hashed the file yet, **Remove and block re-uploads** removes it at once, and the block applies once the server has hashed it.

Blocked files are listed under **Blocked files** in the admin panel's **Drive** tab, which only instance admins see. **Unblock** lifts a block; files already removed stay removed.

## Moderate messages

Open a message's menu by right-clicking it.

| Entry | Who | Notes |
|---|---|---|
| **Delete message** | The author; members with **Manage Messages** for anyone's message | The message is replaced by a deleted marker. Deleting someone else's message is recorded in the audit log; the content is not stored. |
| **Pin message** / **Unpin message** | **Pin Messages** or **Manage Messages** | A channel holds at most 50 pins. |
| **Remove embeds** / **Show embeds** | The author; **Manage Messages** for others' messages | Hides the message's link previews for everyone. The previews are kept, so **Show embeds** brings them back, and the message is not marked edited. |

Nobody can edit another member's message. There is no bulk delete; the closest is the **Delete message history** option when you kick or ban.

The instance's administrators and moderators can also delete any message.

## Kick a member

A kick removes the member from the server. They can rejoin with an invite.

1. Right-click the member in the member list and choose **Kick** followed by their name. You can also use **Kick from server** in their profile's menu, or type `/kick` in the message box and pick the member.
2. Optionally enter a **Reason** (up to 512 characters) and choose how much of their recent messages to delete under **Delete message history**: **Don't delete any**, **Last hour**, **Last 24 hours** or **Last 7 days**.
3. Select **Kick**.

## Ban a member

A ban removes the member and stops them rejoining, by invite or from the public server list, until they are unbanned. Their roles are removed.

1. Right-click the member in the member list and choose **Ban** followed by their name, or use **Ban from server** in their profile's menu, or `/ban`.
2. Optionally enter a **Reason** and choose **Delete message history** as for a kick.
3. Select **Ban**.

### Rules for kicks and bans

- You need **Kick Members** or **Ban Members**. The owner always can.
- Unless you are the owner, your highest role must be strictly above the target's highest role. Holding Administrator does not change this.
- Nobody can kick or ban the owner, or themselves.
- If the server posts system messages, the kick or ban is announced there with the moderator's name and the reason. Anyone who can read that channel sees both. Turn system messages off in **Server settings** → **Overview** if you do not want this (see [Setting up a server](/run/setup#system-messages)).

### Unban

Open **Server settings** → **Bans** (needs **Ban Members**). Each entry shows "Banned by … on …". Select **Revoke ban** to unban; there is no confirmation.

## Timeouts

A timed-out member, until the timeout ends:

- cannot send or edit messages in the server's channels and threads, even with AutoMod switched off ("You are timed out in this server until … and cannot send messages, react or start threads.");
- cannot add a reaction, or join one someone else added;
- cannot start a thread;
- cannot join the server's voice channels, and is removed from the one they are in when the timeout starts.

They can still read, and delete their own messages. Their direct messages are not affected.

Timeouts are applied by AutoMod rules with the **Time out the member** action; the member list and profile menus have no timeout entry. A timeout lasts at most 28 days. The owner and members holding Administrator cannot be timed out.

### Remove a timeout

In **Server settings** → **AutoMod**, the **Timed-out members** card lists active timeouts with "Timed out until …". Select **Remove timeout**. The same link appears on AutoMod log entries. Removing a timeout needs **Timeout Members**; the AutoMod section itself needs **Manage Server**.

## Audit log

The audit log records changes to the server and moderators' actions for the last 90 days. Open **Server settings** → **Audit log**. It needs **View Audit Log** and covers servers hosted on your own instance.

Filter by **Action** (**All actions**, **Channels**, **Categories**, **Permission overrides**, **Roles**, **Members**, **Messages**, **Server**, **Settings**, **Invites**, **Emojis**, **Stickers**, **Sounds**, **Bots**) and by **Member** (who did it). Use **Load more** for older entries. Each entry names who did it: a member, a bot (marked **Bot**), **AutoMod**, or **System** for changes made by the instance's services.

| Action | Shown as |
|---|---|
| `channel.create`, `channel.update`, `channel.delete` | "… created channel …", "… updated channel …", "… deleted channel …" |
| `channel.reorder` | "… reordered channels" |
| `category.create`, `category.update`, `category.delete` | "… created category …", "… updated category …", "… deleted category …" |
| `category.reorder` | "… reordered categories" |
| `override.create`, `override.update`, `override.delete` | "… added permission overrides for … in …", "… updated …", "… removed …" |
| `role.create`, `role.update`, `role.delete` | "… created role …", "… updated role …", "… deleted role …" |
| `role.reorder` | "… reordered roles" |
| `member.role_add`, `member.role_remove` | "… gave … the role …", "… removed the role … from …" |
| `member.kick`, `member.ban`, `member.unban` | "… kicked …", "… banned …", "… unbanned …", with the reason and how many messages were deleted |
| `member.timeout`, `member.timeout_remove` | "… timed out … until …", "… removed the timeout on …" |
| `message.delete` | "… deleted a message by … in …" |
| `server.update` | "… updated the server" (name, description, icon, banner, public listing, category, cross-server emoji, federation, rules) |
| `settings.update` | "… updated the server settings" (system messages, newcomer alerts, sound sharing and other stored settings) |
| `invite.create`, `invite.delete` | "… created invite …", "… revoked invite …" |
| `emoji.create`, `emoji.update`, `emoji.delete` | "… added emoji …", "… renamed emoji …", "… removed emoji …" |
| `sticker.create`, `sticker.update`, `sticker.delete` | "… added sticker …", "… edited sticker …", "… removed sticker …" |
| `sound.create`, `sound.update`, `sound.delete` | "… added sound …", "… edited sound …", "… removed sound …" |
| `bot.add`, `bot.update`, `bot.remove` | "… added the bot …", "… changed the permissions of the bot …", "… removed the bot …" |

Reordering by drag is folded into one entry per member per minute. Deletions of one author's messages in one channel by the same moderator within 5 minutes are folded into one entry ("… deleted … messages by … in …").

Not recorded: AutoMod blocks and changes to AutoMod rules, pins, embed removal, welcome-screen changes other than the rule titles, invite use, timeouts running out, and members deleting their own messages.
