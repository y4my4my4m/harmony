---
title: Setting up a server
description: Create a Harmony server, lay out channels and categories, invite people, add custom emoji and soundboard sounds, and find your way around the server settings.
---

# Setting up a server

This page walks a new server owner through creating a server and setting it up: templates, channels, categories, invites, custom emoji, soundboard sounds and the server settings. Roles are covered in [Roles and permissions](/run/roles-permissions) and moderation tools in [Moderation](/run/moderation).

## Create a server

1. Select the **Harmony Portal** button at the top of the server list to open **Discover communities**. If you are in no server yet, the start screen offers **Create a server** instead.
2. Select **Create your own server**.
3. Fill in the form and select **Create server**.

| Field | Notes |
|---|---|
| **Create from template** | Optional. See [Create a server from a template](#create-a-server-from-a-template). |
| **Server icon** | Optional. The app crops the image you choose; the stored icon is at most 5 MB. You can add it later. |
| **Server name** | 2 to 28 characters. |
| **Description** | Optional, up to 500 characters. |
| **Privacy settings** | **Private** ("People need an invite to join", the default) or **Public** ("Anyone can join this server"). |
| **Category** | Optional topic shown in Discover: Gaming, Technology, Art & design, Music, Education, Entertainment, Community, Science, Sports or Other. **Not set** lets Discover pick one from the name and description. |

There is no limit on how many servers you can own.

### What a new server contains

| Part | Contents |
|---|---|
| Categories and channels | A **Text Channels** category with the text channel `general`, and a **Voice Channels** category with the voice channel `voice chat` |
| Roles | `@everyone` and `Admin`, which you hold (see [Roles and permissions](/run/roles-permissions#roles-every-server-starts-with)) |
| AutoMod | On, with the recommended rules (see [Moderation](/run/moderation#automod)) |

### Create a server from a template

Harmony has no built-in templates. A template is a `.harmony-template.json` file exported from another Harmony server: its roles and their permissions, categories, channels and their permission overrides, settings, welcome screen and AutoMod rules.

1. In the create form, under **Create from template**, select **Choose file** and pick the file.
2. The card shows "From the template of …", how many roles, categories and channels it holds, and "Structure only: messages, members, emojis and images are not included."
3. The template fills in the name, description, privacy and category; change any of them before you select **Create server**.

If the template gives `@everyone` moderation or administration permissions, the card warns: "This template gives every member moderation or administration permissions. Review the roles after creating the server."

A template file can be at most 2 MB and hold at most 250 roles, 25 categories and 100 channels.

### Export a template

In **Server settings** → **Advanced settings**, the **Server template** card has **Export template**. It downloads `<server name>.harmony-template.json`. Exporting needs **Manage Server**. Messages, members, role assignments, emoji, icon, banner, invites, bans, bots, bridges and encryption settings are not exported.

## Channels

A server holds text channels and voice channels. There are no other channel types (no announcement, forum or stage channels, and no NSFW flag). A server holds at most 100 channels.

### Create a channel

Open the server menu (click the server name at the top of the channel list) and select **Create channel**, or right-click a category and select **Create channel** to add it there. Creating channels needs **Manage Channels**.

| Field | Notes |
|---|---|
| **Channel name** | Up to 100 characters. Text channel names are lowercased as you type, spaces become dashes, and only letters, digits, `-` and `_` are kept. |
| **Channel type** | **Text** or **Voice**. The type cannot be changed later. |
| **Private channel** | "Only the roles you choose, the owner and administrators can see it." Tick the roles under **Who can see it**. |
| **End-to-end encryption** | Shown when the server's encryption mode allows it. On and locked when the server requires encryption. |

### Edit a channel

Right-click the channel and select **Edit channel**.

- **General**: **Channel name**, **Description** (up to 1024 characters), **Slowmode** (text channels), and the channel's **Encryption** switches.
- **Permissions**: the private switch and per-role overrides. See [Roles and permissions](/run/roles-permissions#channel-overrides).
- **Webhooks** (text channels): see [Webhooks](/run/webhooks).

### Slow mode

**Slowmode** limits each member to one message per interval in a text channel: Off, 5, 10, 15 or 30 seconds, 1, 2, 5, 10, 15 or 30 minutes, or 1, 2 or 6 hours. "Moderators with Manage Messages are exempt." Members of other instances are not slowed. AutoMod's raid lockdown can set slow mode on every text channel at once (see [Moderation](/run/moderation#raid-protection)).

### Reorder and delete channels

- Drag a channel to move it within or between categories, or right-click it and use **Move up** and **Move down** (Alt+Up and Alt+Down on a focused channel). Dragging is not available on phones.
- To delete, right-click the channel and select **Delete channel**, then type the channel name to confirm. All its messages are deleted.

## Categories

Categories group channels in the channel list. A server holds at most 25 categories.

- **Create**: server menu → **Create category**. Names are 2 to 100 characters of letters, digits, `-` and `_`; spaces become dashes.
- **Rename**: right-click the category → **Edit category**.
- **Reorder**: drag it, or right-click → **Move up** / **Move down**.
- **Collapse**: click its name. Each member's collapsed categories are remembered for them.
- **Delete**: right-click → **Delete category** and type its name to confirm. The channels inside stay and move to the top of the list, outside any category.

A category with no channel a member can view is hidden from that member. A category can be made private, and its channels follow its permissions: see [Private categories](/run/roles-permissions#private-categories).

## Invites

Invites are links of the form `https://<instance>/invite/<code>`. Creating them needs **Create Invite**, which every member has through `@everyone` unless you remove it.

### Invite people

Open the server menu and select **Get invite link**, or right-click a text channel or the server's icon and select **Invite people**. "Anyone with the link can join this server." If you have no active link, one is created. Use **Copy** or **Share**.

### Link settings

Select **Link settings** to make a link with other limits, then **Create new link**. "Existing links keep working until they expire or you revoke them."

| Setting | Choices |
|---|---|
| **Expire after** | 30 minutes, 1 hour, 6 hours, 12 hours, 1 day, 7 days, **Never** |
| **Max uses** | **No limit**, 1, 5, 10, 25, 50, 100 |

### Revoke an invite

Select **Revoke** under the current link, or the remove button beside a link under **Your other active links**. You can see and revoke only the invites you created; there is no server-wide invite list, and owners cannot revoke other members' links. There are no custom (vanity) invite addresses.

### Joining without an invite

A server set to **Public directory** in **Privacy settings** is listed in Discover, and anyone on your instance can join it from there. People on other instances can join a public server whose federation is on without an invite; a private server needs an invite code from them too. A banned account cannot join by either route.

## Custom emoji

Open **Server settings** → **Emoji**. Every member can see the list; adding, renaming and deleting needs **Manage Expressions**.

- Select **Upload emoji**, or drop files. Several files upload at once.
- Stored emoji are PNG, GIF, WebP, APNG or JPEG, at most 1 MB. Still images up to 25 MB are shrunk to fit; animated images must already be under 1 MB.
- The name comes from the file name: Latin letters, digits, `_` and `-` are kept, spaces are removed, and it is cut to 20 characters. A duplicate name gets `_1`, `_2` and so on. Use **Rename emoji** to change it.
- The instance sets how many custom emoji a server can have; 50 unless its operator changed it.

## Soundboard sounds

Open **Server settings** → **Soundboard** (servers hosted on your own instance). Playing sounds needs **Use Soundboard**; adding, editing and removing them needs **Manage Expressions**.

1. Under **Add a sound**, select **Choose file**: "MP3, Ogg or WAV, up to 512 KB and 5.2 seconds."
2. Set a **Name** (1 to 32 characters), an optional **Emoji**, and the **Volume**. Use **Preview** to listen.
3. Select **Upload sound**.

The emoji button opens the emoji picker: pick a standard emoji, or a custom emoji of one of your servers, of the instance, or one of your own. **Remove emoji** clears it; a sound without one shows 🔊. To change a sound later, select its pencil. A custom emoji that is deleted is removed from the sounds using it.

A server holds at most 48 sounds. **Allow use in other servers** (on by default) lets members play this server's sounds in other servers they belong to, where they hold **Use External Sounds**.

## Server settings

Click the server name at the top of the channel list, then **Server settings**. Members without **Manage Server** see the entry as **Overview** and get a read-only view titled **Server information**.

| Section | Who sees it | What it holds |
|---|---|---|
| **Overview** | Everyone | Name, description, icon, banner, rules (read-only), owner; system messages and newcomer alerts |
| **Roles** | Everyone | [Roles and permissions](/run/roles-permissions) |
| **Bans** | Ban Members | The ban list ([Moderation](/run/moderation#unban)) |
| **Reports** | Manage Messages | Reports about messages in this server ([Moderation](/run/moderation#reports)) |
| **Audit log** | View Audit Log | [Moderation](/run/moderation#audit-log) |
| **AutoMod** | Manage Server | [Moderation](/run/moderation#automod) |
| **Welcome & rules** | Manage Server | Welcome screen and rules |
| **Emoji** | Everyone | Custom emoji |
| **Soundboard** | Everyone | Soundboard sounds |
| **Privacy settings** | Everyone | Federation, public listing, category, encryption |
| **Discord Bridge** | Manage Server | [Discord bridge](/run/discord-bridge) |
| **Advanced settings** | Everyone | Server ID and creation date, delete the server, template export, bots |

**Overview** and **Privacy settings** save with **Save changes** at the top; the other sections save on their own. A server hosted on another instance is managed on its home instance; its settings here are mostly read-only.

### Overview

- **Server name**: up to 28 characters. **Description**: up to 500.
- **Server icon** and **Server banner** ("Recommended: 1280×400px. Displayed at the top of your server."). The app crops and shrinks the image; the stored icon is at most 5 MB and the banner at most 10 MB, as JPEG, PNG, GIF, WebP or APNG.
- **Server rules** are shown here; select **Edit rules** to change them in **Welcome & rules**.

Editing the overview needs **Manage Server**.

### System messages

"Harmony posts a message when someone joins the server, leaves, is kicked or is banned." Turn **Send a message when members join or leave** off to stop all of them. **Channel** picks the text channel; **Automatic** "uses the first text channel everyone can see." Kick and ban messages name the moderator and show the reason.

### Newcomer alerts

"When someone who joined in the last 30 days posts for the first time, the owner and moderators get a notification so someone can greet them." The toggle is **Alert the owner and moderators**; **Use instance default** follows the instance's setting. Up to 10 people are notified: the owner and members holding Administrator, Manage Server, Kick Members, Ban Members or Timeout Members.

### Welcome screen and rules

In **Welcome & rules** (servers hosted on your own instance, needs **Manage Server**):

- **Show a welcome screen to new members**: "Shown once to members who join after you turn it on." Members can reopen it from the server menu, **Server rules & welcome**.
- **Welcome message**: up to 2000 characters, with bold, italic, code, quotes and links.
- **Rules**: up to 20, each a title (up to 100 characters) and optional details (up to 500). Rule titles are also shown to people opening an invite.
- **Members must accept the rules before sending messages**: see [Moderation](/run/moderation#require-new-members-to-accept-the-rules).

Select **Save**.

### Privacy settings

- **Enable federation**: "Allow users from other Harmony instances to join and interact with this server." Shown when the instance federates and you hold **Manage Server**. It is off for new servers. With it on, the server's **Server handle** is shown. Turning it off removes the members from other instances, after a confirmation that names how many (see [Turning federation off for a server](/federation/#turning-federation-off-for-a-server)).
- **Server discovery**: **Invite only** or **Public directory** ("Anyone can discover and join your server through the public server list"), and the **Category** used in Discover.
- **Server encryption policy**: **Disabled**, **Optional** or **Required**, plus **Require end-to-end encrypted voice and video**. Only the owner can change it. See [Privacy and security](/use/privacy-security).

### Advanced settings

Shows the server's creation date and ID. Members with **Manage Server** also find the **Server template** export and **Server bots**, where you add bots and choose what they may do (see [Build](/build/)).

## Leave or delete a server

- Members leave from the server menu, **Leave server**. The owner has no such entry.
- Only the owner can delete the server: **Advanced settings** → **Delete server**, then type the server name to confirm. This cannot be undone.
- Ownership cannot be transferred to another member. An owner whose server has other members cannot delete their account until they delete that server.
