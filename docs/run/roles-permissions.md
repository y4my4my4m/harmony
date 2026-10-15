---
title: Roles and permissions
description: How Harmony roles, the role hierarchy and channel overrides decide what each member can do, with a reference of every permission bit.
---

# Roles and permissions

This page explains how roles and permissions work on a Harmony server, how channel overrides change them, and what each permission does. It is for server owners and the members they trust to manage roles.

## How permissions are decided

Every member's permissions in a server come from three things: whether they own the server, the roles they hold, and the overrides set on the channel they are in. The database computes this for every check (`get_user_permissions`), so the same rules apply in the app and to members of other instances.

1. **The server owner holds every permission**, in every channel, whatever roles they have.
2. **Roles combine by union.** A member's server-wide permissions are the permissions of `@everyone` plus the permissions of every other role they hold. A permission granted by any one role is granted.
3. **Administrator short-circuits.** If the combined permissions include Administrator, the member holds every permission in every channel, and channel overrides do not apply to them.
4. **Channel overrides are applied in three layers**, each one removing its denied permissions and then adding its allowed ones:
   1. the `@everyone` override of the channel;
   2. the overrides of all the member's other roles, combined: every permission any of those roles denies is removed, then every permission any of them allows is added;
   3. an override for that specific member.

A later layer wins over an earlier one. Within the role layer, Allow wins over Deny: if one of a member's roles denies a permission in a channel and another of their roles allows it, the member has it.

Only members hold permissions: someone who is not a member of the server, or is banned from it, holds none, whatever `@everyone` grants. And a member left without **View Channel** in a channel holds no other permission there either. The owner and Administrator holders are not affected by either rule.

Server-wide actions (kicking, banning, editing server settings, managing roles) use the server-wide result, without channel overrides.

### Worked example

`@everyone` has **Send Messages**. In `#announcements` you set the `@everyone` override for **Send Messages** to **Deny**, and the override for a `Staff` role to **Allow**.

| Member | Server-wide | After `@everyone` override | After role overrides | Can post? |
|---|---|---|---|---|
| Holds only `@everyone` | Send Messages | removed | unchanged | No |
| Holds `Staff` | Send Messages | removed | added back | Yes |
| Holds a role with Administrator | everything | not applied | not applied | Yes |
| Server owner | everything | not applied | not applied | Yes |

## Roles

Open roles from the server menu: click the server name at the top of the channel list, then **Server settings** → **Roles**. Members without **Manage Server** see the menu entry as **Overview**. Every member can open the **Roles** page; members without **Manage Roles** see it read-only with the note "Changing roles needs the Manage Roles permission."

Each role has three tabs:

| Tab | What you set |
|---|---|
| **Display** | **Role name**, **Role color**, **Display role members separately**, **Allow anyone to @mention this role** |
| **Permissions** | The role's server-wide permissions, in the sections **General Permissions**, **Membership Permissions**, **Text Permissions**, **Thread Permissions**, **Voice Permissions** and **Dangerous Permissions** |
| **Members** | Who holds the role: **Add members** to search and add, the remove button beside each name to take it away |

Changes on the Display and Permissions tabs take effect when you select **Save changes**.

### Roles every server starts with

Creating a server creates two roles:

| Role | Position | Permissions | Notes |
|---|---|---|---|
| `@everyone` (badge **Default**) | Always the bottom | View Channels, Create Invite, Send Messages, Send Messages in Threads, Create Public Threads, Embed Links, Attach Files, Add Reactions, Use External Emojis, Read Message History, Connect, Speak, Video, Use Soundboard, Use External Sounds | Every member holds it. Its name cannot be changed, it cannot be moved or deleted, and its **Members** tab has no roster. |
| `Admin` (badge **Admin**) | 999 | Every permission, Administrator included | Given to the owner. It cannot be deleted from the role editor, and the owner cannot be removed from it there (shown as **Protected**). |

### Create a role

1. In **Server settings** → **Roles**, select **Create role**.
2. A role named "New Role" appears with a random colour. It starts with no permissions, members not shown separately, and mentions limited (see below).
3. Edit it on the **Display** and **Permissions** tabs, then select **Save changes**.
4. On the **Members** tab, add the members who should hold it.

The owner's new roles are placed at the top of the list. Anyone else's new role is placed directly below their own highest role.

### Role order and hierarchy

Roles are listed from highest to lowest. Drag a role to reorder it, or select it and use **Move up** and **Move down**. `@everyone` stays at the bottom.

A member's rank is the position of their highest role (the owner outranks everyone). Rank limits what a member with **Manage Roles** can do, and the database enforces each limit:

- They can create, edit, move, delete, assign and remove only roles ranked below their own highest role. They can edit `@everyone`'s permissions.
- They cannot give a role, or a channel override, a permission they do not hold themselves. In the editor those switches are disabled.
- Only the owner can create or change the protected `@everyone` and `Admin` flags.

The owner and the instance's administrators pass every rank and grant check.

Rank also limits moderation: kicking and banning need a highest role strictly above the target's highest role (see [Moderation](/run/moderation)). Voice moderation (Mute, Deafen and Move Members) ignores rank, as in Discord.

### Colour, separate display and mentions

- **Role color**: a member's name is shown in the colour of their highest role whose colour is not the default grey (`#99AAB5`).
- **Display role members separately**: members with this role are grouped under it in the member list, under their highest such role.
- **Allow anyone to @mention this role**: when off, mentioning the role notifies its members only if the sender holds **Mention @everyone** in that channel. The mention still renders either way. Roles created in the role editor start with this off.

### Delete a role

Select the role, then **Delete role** and confirm. `@everyone` and `Admin` have no delete button. Deleting a role removes it from every member and removes its channel overrides.

## Channel overrides

Overrides change permissions for one channel. Right-click the channel in the channel list, then **Edit channel** → **Permissions**. The **Edit channel** entry needs **Manage Channels**.

1. Pick a role in the list on the left. `@everyone` is selected first.
2. For each permission choose **Deny**, **Inherit** or **Allow**. "Allow grants, Deny revokes, Inherit uses the server-wide setting."
3. Select **Save permissions**.

**Inherit** stores nothing: the role's server-wide permission applies. A role whose every permission is back on Inherit has no override at all.

The channel editor lists these permissions:

| Group | Permissions |
|---|---|
| **General** | View Channel, Manage Channel, Manage Permissions, Manage Webhooks (text channels only) |
| **Messages** | Send Messages, Embed Links, Attach Files, Add Reactions, Use External Emojis, Mention @everyone, Manage Messages, Pin Messages, Read Message History |
| **Threads** | Create Public Threads, Send in Threads |
| **Voice** (voice channels only) | Connect, Speak, Video & Stream, Mute Members, Deafen Members, Move Members, Use Soundboard, Use External Sounds |

Saving touches only the permissions listed for that channel type; any other bits already stored on the override stay as they are.

Editing overrides needs **Manage Roles** or **Manage Channels** on that channel, and you cannot allow a permission you do not hold in that channel.

### Make a channel private

At the top of the **Permissions** tab, turn on **Private channel**: "Only the roles you choose, the owner and administrators can see it." Then tick the roles under **Who can see it**. This is a shortcut for the overrides it writes: **View Channel** set to **Deny** for `@everyone` and **Allow** for each ticked role. Members holding Administrator still see the channel. The same switch appears when you create a channel.

### What overrides do not cover

- **Categories have no permissions.** Overrides exist on channels only, and a channel does not inherit anything from its category.
- **Member overrides** (the third layer) are part of the permission model and can be written through the bot API, but the channel editor sets role overrides only.
- **Server-wide permissions** (Manage Server, Manage Expressions, View Audit Log, Kick, Ban and Timeout Members, Create Invite) are not offered: an override of them changes nothing. Invites lead to the server, not to a channel.
- Some menus follow the server-wide permission: a channel override granting **Manage Channel** lets the member edit that channel through the database, but the **Edit channel** menu entry only appears for members with **Manage Channels** server-wide.

## Permission reference

The bit is the position in the 64-bit mask stored for roles (`server_roles.permissions`) and overrides (`allow_permissions`, `deny_permissions`); the value is `1 << bit`. The labels are those of the role editor and, where the permission is offered there, the channel editor. The `@everyone` column shows what a new server's `@everyone` role holds.

| Bit | Value | Name | Role editor label | Channel editor label | `@everyone` | What it does |
|---|---|---|---|---|---|---|
| 0 | 1 | `ADMINISTRATOR` | Administrator | not listed | No | Every permission in every channel; channel overrides do not apply. Members holding it cannot be timed out. Granting it needs it. Deleting the server stays with the owner. |
| 1 | 2 | `VIEW_CHANNEL` | View Channels | View Channel | Yes | See the channel, read its messages, threads, reactions and search results, and receive its notifications. Also required to join a voice channel. |
| 2 | 4 | `MANAGE_CHANNELS` | Manage Channels | Manage Channel | No | Create, edit, reorder and delete channels and categories; set a channel's encryption; edit channel overrides; rename or delete other members' threads. |
| 3 | 8 | `MANAGE_ROLES` | Manage Roles | Manage Permissions | No | Create, edit, reorder, delete, assign and remove roles below the member's highest role; edit `@everyone`'s permissions; edit channel overrides. Grants are limited to permissions the member holds. |
| 4 | 16 | `MANAGE_EMOJIS` | Manage Expressions | not listed | No | Add, rename and delete the server's custom emoji and soundboard sounds, and choose whether the server's sounds can be played in other servers. |
| 5 | 32 | `VIEW_AUDIT_LOG` | View Audit Log | not listed | No | Read the **Audit log**, and see the moderator and reason on kick, ban and unban events. |
| 6 | 64 | `MANAGE_WEBHOOKS` | Manage Webhooks | Manage Webhooks (text channels) | No | Create, edit, regenerate and delete a channel's webhooks. See [Webhooks](/run/webhooks). |
| 7 | 128 | `MANAGE_SERVER` | Manage Server | not listed | No | Edit the server's name, description, icon, banner, public listing, category, federation, welcome screen and rules, system messages and newcomer alerts; configure AutoMod, bots and the Discord bridge; export a template. Exempt from AutoMod. Does not allow deleting the server. |
| 8 | 256 | `CREATE_INVITE` | Create Invite | not listed | Yes | Create invites to the server. |
| 9 | 512 | `KICK_MEMBERS` | Kick Members | not listed | No | Kick members whose highest role is below the kicker's; see kick, ban and unban reasons. |
| 10 | 1024 | `BAN_MEMBERS` | Ban Members | not listed | No | Ban members whose highest role is below the banner's, unban, and open the **Bans** list. |
| 11 | 2048 | `TIMEOUT_MEMBERS` | Timeout Members | not listed | No | Remove a member's timeout (**Server settings** → **AutoMod**). The app has no menu to time a member out by hand; AutoMod rules do that. |
| 12 | 4096 | `SEND_MESSAGES` | Send Messages | Send Messages | Yes | Post messages in a text channel. Without it the message box is read-only. |
| 13 | 8192 | `SEND_MESSAGES_IN_THREADS` | Send Messages in Threads | Send in Threads | Yes | Post replies inside threads. Send Messages does not reach threads; without this the thread's message box is read-only. |
| 14 | 16384 | `CREATE_PUBLIC_THREADS` | Create Public Threads | Create Public Threads | Yes | Start threads, from a message or from the channel's threads list. Without it **Create thread** is not offered. |
| 15 | 32768 | `CREATE_PRIVATE_THREADS` | Create Private Threads | not listed | No | Grants nothing: every Harmony thread is visible to the whole channel, and starting one needs Create Public Threads. |
| 16 | 65536 | `EMBED_LINKS` | Embed Links | Embed Links | Yes | Links the member posts show previews. Without it their links post as plain links with previews turned off, and they cannot turn them back on. |
| 17 | 131072 | `ATTACH_FILES` | Attach Files | Attach Files | Yes | Upload files with a message. GIFs from the picker, links and media hosted elsewhere need no permission. |
| 18 | 262144 | `ADD_REACTIONS` | Add Reactions | Add Reactions | Yes | Add a new reaction. Joining a reaction someone already added needs no permission. |
| 19 | 524288 | `USE_EXTERNAL_EMOJIS` | Use External Emojis | Use External Emojis | Yes | Use custom emoji from outside the server (other servers', the instance's, personal and AI emoji) in messages and reactions. Without it the picker offers unicode and the server's own emoji, and other custom emoji are refused. |
| 20 | 1048576 | `MENTION_EVERYONE` | Mention @everyone | Mention @everyone | No | Notify through `@everyone`, `@here` and roles that have mentions turned off. Without it those mentions still render but notify no one. |
| 21 | 2097152 | `MANAGE_MESSAGES` | Manage Messages | Manage Messages | No | Delete other members' messages, remove system messages, pin and unpin, suppress other members' link previews, open the server's **Reports**, and skip slow mode. It does not allow editing other members' messages. |
| 22 | 4194304 | `READ_MESSAGE_HISTORY` | Read Message History | Read Message History | Yes | Read messages sent before the member opened the channel. Without it, as on Discord, the channel, its threads, pins and search show only messages sent since they opened it in this session of the app; after a reload or on another sign-in the earlier ones are hidden again. A note at the top says so. Their own messages stay visible. |
| 23 | 8388608 | `PIN_MESSAGES` | Pin Messages | Pin Messages | No | Pin and unpin messages; Manage Messages also does. A channel holds at most 50 pins. |
| 24 | 16777216 | `CONNECT` | Connect | Connect | Yes | Join a voice channel (also needs View Channel and no active timeout). |
| 25 | 33554432 | `SPEAK` | Speak | Speak | Yes | Send microphone audio in a voice channel. Without it the member joins as a listener. |
| 26 | 67108864 | `STREAM` | Video | Video & Stream | Yes | Turn on the camera and share the screen (with its sound) in a voice channel. |
| 27 | 134217728 | `MUTE_MEMBERS` | Mute Members | Mute Members | Yes | Server-mute any member, the owner and oneself included: their microphone and soundboard stay off, in every voice channel, until lifted or they leave the server. |
| 28 | 268435456 | `DEAFEN_MEMBERS` | Deafen Members | Deafen Members | Yes | Server-deafen any member, the owner and oneself included: they hear nothing and their microphone stays off until lifted or they leave the server. |
| 29 | 536870912 | `MOVE_MEMBERS` | Move Members | Move Members | Yes | Move any member, the owner and oneself included, to another voice channel (also one they cannot connect to themselves, if they can see it) or disconnect them; end anyone's watch-together activity. Moving into a channel also needs Connect there. |
| 30 | 1073741824 | `USE_SOUNDBOARD` | Use Soundboard | Use Soundboard | Yes | Play the server's soundboard sounds in a voice channel. Also needs Speak there. |
| 31 | 2147483648 | `USE_EXTERNAL_SOUNDS` | Use External Sounds | Use External Sounds | Yes | Play sounds from the member's other servers. Also needs Use Soundboard and Speak there. |

"Not checked" means the switch is stored and shown, but no part of Harmony refuses an action because a member lacks it. Set those bits for bots, which read them through their install permissions; see [Bot permissions and rate limits](/build/permissions-rate-limits).

::: details Masks for common setups
The default `@everyone` mask is `3343872258`. A role with every permission except Administrator is `4294967294` (bits 1 to 31).
:::

## Instance staff

Instance administrators (the people running the Harmony instance, not a server role) can change any local server's channels, categories, roles, overrides, emoji and webhooks, and read its audit log, whatever their roles in it. Instance administrators and instance moderators can also delete any message. Server permissions do not limit them.
