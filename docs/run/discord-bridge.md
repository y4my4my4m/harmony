---
title: Discord bridge
description: Connect a Harmony server with a Discord server, choose where the bridge runs, pair channels, and fix the problems the bridge reports.
---

# Discord bridge

This page is for Harmony server owners and members with the Manage Server permission who want to connect their server with a Discord server. It covers the three ways to run the bridge, the setup steps in **Server settings** → **Discord Bridge**, what crosses the bridge, the Discord permissions it needs, and how to fix what it reports. Instance operators who want to offer bridges to their communities read [Hosting Discord bridges](/self-host/discord-bridges).

## What the bridge does

A bridge links channels of one Harmony server with channels of one Discord server. You pair channels one to one; a message posted in a paired channel appears in its partner on the other side.

- On Harmony, a Discord member's message shows their Discord server nickname (else their Discord display name, else their username) and their Discord avatar, with a Discord badge next to the name.
- On Discord, a Harmony member's message is posted through a channel webhook named "Harmony Bridge" under their Harmony server nickname (else display name, else username) and avatar. Discord refuses webhook names containing "discord" or "clyde"; the bridge removes those words.

On the Harmony side the bridge acts as a bot named **Discord Bridge**, which the bridge page creates and installs on your server for you. On the Discord side it is a Discord bot: either the instance's bot or one you create.

A server has at most one bridge, and a bridge links one Discord server. The Harmony server has to live on the instance you are signed in to.

## Choose where the bridge runs

The first screen of the bridge page, **Where should the bridge run?**, offers the options your instance supports.

| Option | What you do | Whose Discord bot | Offered when |
|---|---|---|---|
| **Use *instance*'s bot** (marked **Recommended**) | Click **Add to Discord**, pick your Discord server, then pair channels | The instance operator's | The operator set up the instance bot |
| **Use your own bot, run on this instance** | Create a Discord bot, paste its token into Harmony | Yours; the instance stores its token | The operator turned on hosting |
| **Run it yourself** | Create a Discord bot, run one Docker command on a computer that stays on | Yours; the token stays on your computer | Always |

How to choose:

- **The instance's bot** needs no Discord bot of your own and nothing to install. The bot carries the instance's name and avatar on Discord, and the instance operator can read every Discord channel the bot has access to.
- **Your own bot, run on this instance** gives the bot your own name and avatar with nothing to install. The operator holds your bot token and can read any Discord channel the bot can see.
- **Run it yourself** keeps the token away from the instance. The bridge works only while your computer is on and online.

In every mode, messages in bridged channels pass through the Harmony instance like any other message. Whatever you choose, give the Discord bot access only to the channels you bridge.

You need:

- on Harmony: ownership of the server, or the Manage Server permission ([Roles and permissions](/run/roles-permissions));
- on Discord: the Manage Server permission on the Discord server you connect;
- for `/bridge` commands in Discord: the Discord Administrator permission.

## Open the bridge page

1. Click the server name at the top of the channel list and choose **Server settings**.
2. Open **Discord Bridge**. The entry appears only to members who can manage the server.

The page polls every few seconds, so checks and channel lists update without a reload.

## Set up with the instance's bot

1. On **Where should the bridge run?**, click **Use *instance*'s bot**. The page shows the step **Add the bot to Discord**.
2. Click **Add to Discord**. Discord opens.
3. Pick your Discord server and click **Authorize**. Discord sends you back to the bridge page, which says **Linked to** *server*. **Now pair the channels.**
4. On **Pair channels**, pair at least one channel (see [Pair channels](#pair-channels)). The first time, the Discord channels can take up to a minute to appear: the page shows **Connecting to** *server*… until the instance has started your bridge.
5. On **Options**, choose what the bridge copies (see [Bridge options](#bridge-options)), then click **Finish setup**.

The link Harmony prepares for **Add to Discord** works once and expires after 15 minutes. In the desktop app, **Add to Discord** opens your system browser, and Discord returns you to Harmony in that browser.

The instance's bot joins a Discord server only through this button. A Discord server can be linked to one Harmony server on the instance at a time.

## Set up with your own Discord bot

Both own-bot options share the same six steps: **Create your Discord bot**, **Start the bridge** (or **Give this instance the token**), **Check the connection**, **Choose the Discord server**, **Pair channels** and **Options**.

Click **Run it myself** or **Use my own bot here** on the first screen to start. **Chose the wrong option?** **Start over** below the steps removes the half-made bridge so you can choose again.

### Create your Discord bot

1. Open the [Discord Developer Portal](https://discord.com/developers/applications) and log in.
2. Click **New Application**, type the name people will see in Discord, accept Discord's terms and click **Create**.
3. In the menu on the left, click **Bot**.
4. Under **Privileged Gateway Intents**, set the switches as the bridge page lists them (see [Gateway intents](#gateway-intents)). The page shows **Sync member list** and **Sync presence** next to the list, because these two options decide which intents you need.
5. Click **Save Changes**.
6. Scroll up to **Token**, click **Reset Token**, then **Yes, do it!**, and click **Copy**.

Treat the token like a password: anyone who has it controls your bot. Discord shows it only once; if you lose it, reset it again. Click **I have the token** to continue.

### Give this instance the token

For **Use your own bot, run on this instance**:

1. Paste the token into **Discord bot token** and click **Save token**.
2. The page answers **Token saved. This instance starts your bridge within a minute or two.**

The instance stores the token encrypted and never shows it again. Saving a new token replaces the old one. The field recognises the other values on the Developer Portal pages: if it says **That's the Application ID**, **That's the Public Key** or **That looks like the Client Secret**, go back to **Bot** → **Reset Token** → **Copy**.

### Start the bridge

For **Run it yourself**, the bridge is a small program in Docker on a computer that stays on: a home server, a VPS, a Raspberry Pi. On Windows or macOS install and start Docker Desktop; on Linux install Docker Engine.

1. The page issues a **Setup code** (`HB-XXXX-XXXX-XXXX`). A code works once, expires after 30 minutes, and **New code** cancels older ones.
2. Under **How to start the bridge**, pick **Docker command** or **Docker Compose** and copy what the page shows. The Docker command has this shape:

   ```bash
   docker run -d --name harmony-discord-bridge --restart unless-stopped -e HARMONY_URL=https://chat.example.com -e HARMONY_SETUP_CODE=HB-XXXX-XXXX-XXXX -e DISCORD_TOKEN=PASTE_YOUR_DISCORD_BOT_TOKEN_HERE -v harmony-bridge-data:/data ghcr.io/y4my4my4m/harmony-discord-bridge:latest
   ```

3. Replace `PASTE_YOUR_DISCORD_BOT_TOKEN_HERE` with the token from step 1.
4. Run it in a terminal on that computer (PowerShell on Windows, Terminal on macOS). With Docker Compose, save the file as `docker-compose.yml` in an empty folder and run `docker compose up -d` there.
5. Click **I ran the command**.

On its first start the bridge trades the setup code for its own Harmony credentials and keeps them in the `harmony-bridge-data` volume, so later starts need no code. It starts again by itself after a reboot.

### Check the connection

**Check the connection** shows five checks, each **done**, **needs attention** or **waiting**:

| Check | Done when |
|---|---|
| **Bridge connected** | The bridge reported in during the last 90 seconds |
| **Discord accepted the bot token** | The bridge logged in to Discord |
| **Discord intents are switched on** | Every intent your options need is on |
| **The bot is in your Discord server** | The bot is in at least one Discord server |
| **Bridge signed in to Harmony** | The bridge is connected to Harmony |

While the bot is in no Discord server, the check offers **Invite the bot to your Discord server**: pick your server in the Discord window that opens and click **Authorize**. The invite asks for the permissions in [Discord permissions](#discord-permissions). **Next** unlocks once every check is done.

### Choose the Discord server

If the bot is in exactly one Discord server, that server is chosen for you. If it is in several, pick one and click **Bridge this server**. **Server missing from the list?** links to the invite again.

Once channels are paired, the choice is locked: to bridge a different Discord server, remove all channel pairs first.

## Pair channels

Each pair links one Harmony text channel with one Discord text or announcement channel. On **Pair channels** (or **Paired channels** on the status page):

1. Under **Add a pair**, choose a **Harmony channel** and a **Discord channel**.
2. Choose a **Direction**.
3. Click **Add pair**.

| Direction | Effect |
|---|---|
| **Both ways** | Messages go both ways (the default) |
| **Discord → Harmony only** | Discord messages appear on Harmony; Harmony messages stay on Harmony |
| **Harmony → Discord only** | Harmony messages appear on Discord; Discord messages stay on Discord |

When channels have the same name on both sides (ignoring case, emoji and punctuation), **Channels with the same name** offers to pair them all at once, both ways.

The Discord channel list marks channels the bot cannot use. A pair cannot be added while the bot **can't see** the Discord channel or, for a direction that posts to Discord, **can't post** there. **No webhook permission** does not block the pair, but Harmony messages then arrive under the bot's name with the author's name in bold instead of each sender's own name and picture.

You can also pair from Discord: run `/bridge link` in the Discord channel and choose the Harmony channel from the list. `/bridge unlink` removes the pair of the channel it runs in. `/bridge clone-server` creates a Harmony channel for every Discord channel, voice channels included unless `include_voice` is false, and pairs them all (see [Discord commands](#discord-commands)).

::: tip Private and read-only Harmony channels
The bridge's Harmony bot follows its channel access. By default it sees only channels `@everyone` can view and posts only where `@everyone` can post. To bridge a channel hidden from `@everyone`, or one where `@everyone` cannot post, open **Server settings** → **Advanced settings** → **Server bots**, click **Channels** on the **Discord Bridge** bot, choose **Selected channels** and tick the channel.
:::

A channel with end-to-end encryption cannot be bridged: the bridge cannot read it. See [Privacy and security](/use/privacy-security).

## Bridge options

**Options** holds five switches. Changes reach a running bridge within seconds.

| Option | Default | Effect | Discord intent needed |
|---|---|---|---|
| **Sync member list** | on | Discord members appear in this server's member list | Server Members Intent |
| **Sync presence** | off | Discord members' online status and custom status show on Harmony; only changes are sent | Presence Intent |
| **Sync reactions** | on | Emoji reactions are copied both ways | none |
| **Sync edits** | on | An edited message updates its copy on the other side | none |
| **Sync deletions** | on | A deleted message deletes its copy on the other side | none |

Presence sync works only together with member list sync. With the instance's bot, the intents are the operator's: presence works only while the operator has turned presence on for the bot.

## What crosses the bridge

| Content | Discord → Harmony | Harmony → Discord |
|---|---|---|
| Messages | Yes, with the author's Discord name and avatar | Yes, through the channel webhook as the Harmony author |
| Replies | A real reply when the original message was bridged | A link to the original Discord message on the first line, and a mention of its author |
| Threads | A Discord thread becomes a Harmony thread, on the copy of its starting message or standalone | A Harmony thread becomes a Discord thread, on the copy of its starting message or standalone |
| Reactions | Yes (**Sync reactions**) | Yes, as one bot reaction per emoji, removed when the last Harmony user removes theirs |
| Edits | Yes (**Sync edits**) | Yes (**Sync edits**) |
| Deletions | Yes, including bulk deletes (**Sync deletions**) | Yes (**Sync deletions**); see below |
| Files and pictures | Linked from Discord's CDN; see [Attachments from Discord](#attachments-from-discord) | Uploaded to Discord as attachments up to 8 MB per message by default and within the Discord server's upload limit; larger files are posted as a link |
| Voice messages, audio | Play in Harmony's audio player | As files |
| Stickers | As pictures; animated Lottie stickers as the text `[sticker: name]` | Not applicable |
| Forwarded messages | With an italic *↪ Forwarded* line | Not applicable |
| Custom emoji | As the Discord emoji picture, or as the Harmony server emoji imported from it | As Discord application emoji the bridge uploads on first use |
| Mentions | Paired channel mentions and synced role mentions become Harmony mentions; `@name` typed by hand becomes a Harmony mention | A mentioned Discord member is pinged on Discord |
| Member list | Discord members appear in the member list (**Sync member list**) | Not sent |
| Presence | Online, away, busy, offline and custom status (**Sync presence**) | Not sent |

A Harmony message longer than 2000 characters, Discord's limit, is posted as several Discord messages, split at line breaks or spaces; an open code block is closed and reopened across the split.

Thread notes:

- Threads cross the bridge on Harmony 1.7.5 or later with bridge 2.4.0 or later. The Discord bot needs **Create Public Threads** and **Send Messages in Threads**.
- Threads that existed before the bridge are picked up when someone next writes in them.
- On Harmony 1.7.6 or later, the "started a thread" notice names the Discord member who started the thread.

Deletion notes:

- Deleting a Discord member's message on Harmony, by a moderator or by AutoMod, deletes it on Discord too when the bot holds **Manage Messages** there. A bot added without that permission keeps the Discord message; add the bot again to grant it (see [Maintain the bridge](#maintain-the-bridge)).
- Deleting the Discord copy of a Harmony message does not delete the Harmony original.

To mention a Harmony member from Discord, use the `/mention` (or `/m`) command; it autocompletes Harmony users.

### What does not cross

- Messages sent while the bridge is offline. The bridge copies messages as they arrive and does not replay missed ones.
- Messages posted by Discord bots, and by Harmony bots other than the bridge itself.
- Harmony's join, leave, kick and ban notices.
- Renaming, archiving or deleting a thread.
- Audio and video in voice channels.
- Games, music and other Discord activities in presence.
- Channels with end-to-end encryption.

### Attachments from Discord

Discord's file links expire after a while. The instance operator chooses what Harmony does with them, instance-wide: keep the Discord link (it stops working when it expires), refresh an expired link when someone views it, or copy the file into the instance's storage. Ask your instance's admin which policy applies.

## Discord permissions

The invite links and **Add to Discord** request these Discord permissions:

| Permission | Used for |
|---|---|
| View Channels | Seeing the paired channels |
| Read Message History | Reading the paired channels |
| Send Messages | Posting Harmony messages, as the bot when no webhook is available |
| Manage Webhooks | Posting each Harmony message under its author's name and avatar |
| Embed Links | Link previews and Harmony invite cards in bridged messages |
| Attach Files | Uploading Harmony files as attachments |
| Add Reactions | Copying Harmony reactions |
| Manage Messages | Deleting a Discord member's message that was deleted on Harmony |
| Create Public Threads | Starting the Discord side of a Harmony thread |
| Send Messages in Threads | Posting into bridged threads |
| Use External Emojis | Instance bot only |

| Bot | Permission integer |
|---|---|
| Your own bot (run yourself, or on the instance) | `309774642240` |
| The instance's bot | `309774904384` |

Both invites use the scopes `bot` and `applications.commands`. To build the invite for your own bot by hand, replace `APPLICATION_ID` with the **Application ID** from **General Information**:

```text
https://discord.com/oauth2/authorize?client_id=APPLICATION_ID&permissions=309774642240&scope=bot+applications.commands
```

In Discord, a channel's own permission settings can take these away again. The bridge page lists each channel where the bot cannot see, post or manage webhooks, with the fix.

### Gateway intents

| Intent (Developer Portal name) | Needed |
|---|---|
| Message Content Intent | Always; without it the bridge cannot read what people write |
| Server Members Intent | While **Sync member list** is on |
| Presence Intent | While **Sync presence** is on |

These are switched on in the Developer Portal under **Bot** → **Privileged Gateway Intents**. With the instance's bot, the operator manages them.

## Discord commands

The bridge registers these commands in the bridged Discord server. `/bridge` is visible to, and works for, members with the Discord Administrator permission only.

| Command | Effect |
|---|---|
| `/mention`, `/m` | Mention up to five Harmony users with a message; autocompletes Harmony users |
| `/bridge status` | Paired channels and current problems, in plain language |
| `/bridge link` | Pair this Discord channel with a Harmony channel chosen from the list; optional direction |
| `/bridge unlink` | Remove this channel's pair |
| `/bridge clone-server` | Create a Harmony channel for every Discord channel and pair them; never overwrites; `dry_run`, `include_voice` and `clone_roles` options |
| `/bridge sync-order` | Copy Discord's channel and category order to Harmony |
| `/bridge sync-perms` | Copy Discord roles and the permissions of every paired channel to Harmony |
| `/bridge import-emojis` | Copy the Discord server's custom emoji into the Harmony server under the same names; a rerun adds only new ones (Harmony 1.6.25 or later) |

`/bridge link` offers only Harmony channels the bridge's Harmony bot can see. An imported emoji is one emoji on both sides, so reactions with it count together; a Harmony emoji that already has the same name is linked instead of duplicated.

## Moderation and spam

Harmony's AutoMod treats each Discord author as a separate person, whatever the server's bot exemption says:

- message flood, duplicate spam and mention spam rules apply to bridged messages;
- new-member rules use the Discord member's join date when the bridge reports it;
- keyword, preset, invite and link rules apply only when bots are not exempt;
- a blocked message is not posted on Harmony, and AutoMod's log and alerts name the Discord author;
- timeouts do not apply to Discord authors.

The bridge also limits each Discord member to 8 messages per 10 seconds in a channel and 30 per minute across channels, and drops the same text sent again within 30 seconds. See [Moderation](/run/moderation).

## Maintain the bridge

After **Finish setup**, the bridge page shows the bridge's state: **Bridge is online**, **Bridge is online, with problems**, **Bridge is offline** or **Bridge hasn't connected yet**, with **Runs**, **Discord server**, **Discord bot** and **Bridge version**. Below are the problems to fix, **Paired channels**, **Options** and **Maintenance**. **Show setup steps** opens the steps again.

**Maintenance** depends on the mode:

| Mode (**Runs**) | Maintenance action | What it does |
|---|---|---|
| **On your computer** | **Move the bridge to another computer, or reinstall it** | **Get a setup code** issues a new code and shows the command again |
| **On this instance** | **Replace the Discord bot token** | Saves a new token; the instance restarts your bridge with it |
| **With this instance's Discord bot** | **Re-link the bot, or link a different Discord server** | **Add to Discord again** |

When a bridge you run yourself starts with a new setup code, it gets new Harmony credentials and the old installation can no longer sign in; remove the old container.

With the instance's bot, adding the bot to the same Discord server again keeps the channel pairs and grants permissions an older link lacks, such as **Manage Messages** and the thread permissions. Adding it to another Discord server moves the bridge there and removes the channel pairs; the bot leaves the old Discord server by itself within about ten minutes.

With your own bot, **Invite the bot to your Discord server** on the status page re-invites it with the current permission set.

### Update a bridge you run yourself

```bash
docker pull ghcr.io/y4my4my4m/harmony-discord-bridge:latest
docker rm -f harmony-discord-bridge
```

Then run the same Docker command as before. The bridge keeps its Harmony sign-in in the volume, so an expired setup code in the command does no harm. With Docker Compose, run `docker compose pull && docker compose up -d` in its folder.

## Remove a pair

Click **Remove** next to the pair under **Paired channels**, or run `/bridge unlink` in the Discord channel. Messages already copied stay on both sides.

## Disconnect the bridge

1. On the bridge page, under **Disconnect the bridge**, click **Disconnect bridge**.
2. Confirm with **Disconnect**.

Bridging stops at once, every channel pair is removed and the bridge's Harmony bot is retired. Messages already bridged stay. This cannot be undone; to bridge again you set it up from the start.

What else to do depends on the mode:

- **Run it yourself**: stop the program on your computer with `docker rm -f harmony-discord-bridge`. To remove its saved sign-in as well, run `docker volume rm harmony-bridge-data`. Delete the application in the Developer Portal if you no longer need it.
- **Your own bot, run on this instance**: the stored Discord token is deleted. Your Discord bot is not; delete it in the Developer Portal if you no longer need it.
- **The instance's bot**: the bot leaves your Discord server by itself within about ten minutes. There is nothing to remove in Discord.

## Troubleshooting

The bridge page and `/bridge status` list each problem with its fix. For a bridge you run yourself, `docker logs --tail 50 harmony-discord-bridge` shows the same.

| Problem shown | Cause | Fix |
|---|---|---|
| **The bridge is offline.** | No report from the bridge for 90 seconds | Yours: make sure the computer is on and Docker runs, then `docker start harmony-discord-bridge`. Hosted or instance bot: wait a few minutes, then contact the instance's admin |
| **Discord rejected the bot token.** | The token was reset or is wrong | Developer Portal → **Bot** → **Reset Token**. Yours: `docker rm -f harmony-discord-bridge`, then run the setup command again with the new token. Hosted: save the new token. Instance bot: contact the admin |
| **Discord refused the** *intent* | A needed intent is off | Developer Portal → **Bot** → **Privileged Gateway Intents**, switch it on, **Save Changes**; restart a bridge you run (`docker restart harmony-discord-bridge`). Or turn off the option that needs it |
| **The bot isn't in any Discord server yet.** | The bot was never invited | **Invite the bot to your Discord server**; with the instance bot, **Add to Discord** again |
| **The bot isn't in** *server* | The bot left or was removed | Invite it again, or choose another Discord server; with the instance bot, **Add to Discord** again |
| **No Discord server chosen yet.** | The bot is in several servers | **Choose the Discord server** |
| **The bot can't see** *channel* | View Channel or Read Message History denied | In Discord, the channel's **Edit Channel** → **Permissions**: allow both for the bot or its role |
| **The bot can't post in** *channel* | Send Messages denied | Allow Send Messages for the bot in the channel |
| **The bot can't manage webhooks in** *channel* | Manage Webhooks denied | Allow Manage Webhooks for the bot in the channel |
| **The bridge can no longer sign in to Harmony.** | The bridge was deleted, or a newer setup code was used elsewhere | Yours: reset the bridge (`docker rm -f harmony-discord-bridge && docker volume rm harmony-bridge-data`) and run the command with a new setup code. Otherwise contact the admin, or disconnect and set up again |
| **A paired Harmony channel no longer exists.** | The channel was deleted | Remove its pair |
| *channel* **is end-to-end encrypted, so the bridge can't read it.** | The Harmony channel uses end-to-end encryption | Remove the pair and pair a channel without encryption |
| **Discord is slowing the bridge down.** | Discord or Harmony rate limits | The bridge retries; a message still refused after its retries is dropped. If it keeps happening, turn off presence or member list sync |
| **The bridge can't reach Discord.** | Network or Discord outage | The bridge retries; check the computer's connection |
| **The bridge can't reach this Harmony instance.** | Network problem | Check that the computer running the bridge can open the instance's address; the bridge retries |

Messages from Discord that never arrive on Harmony may have been dropped by AutoMod or by the bridge's spam limits; see [Moderation and spam](#moderation-and-spam).

### Setup messages

| Message | Fix |
|---|---|
| **The new Discord bridge isn't available on this instance yet.** | The instance runs an older Harmony; ask its admin to update |
| **This instance doesn't run bridges for communities at the moment.** | Hosting is off; choose **Run it yourself** |
| **This instance already runs as many bridges as it allows.** | The hosting limit is reached; run it yourself, or ask the admin |
| **This server already has a Discord bridge set up another way.** | Disconnect the existing bridge first |
| **This instance's bot is already in as many Discord servers as it allows.** | Use a Discord bot of your own, or ask the admin |
| **That link expired or was already used.** | Click **Try again** |
| **That Discord server is already bridged to another server on this instance.** | Pick another Discord server, or remove the bridge on the other Harmony server |
| **The bot wasn't added: the request was cancelled in Discord.** | Click **Try again** and choose **Authorize** |
| **Discord didn't confirm the link.** | Try again in a moment; if it persists, contact the admin |

For a bridge you run yourself, the log says why it stopped:

| Log line | Fix |
|---|---|
| `Harmony Discord bridge is not configured.` | `HARMONY_URL` is missing from the command |
| `DISCORD_TOKEN is not set.` | Add the bot token to the command |
| `Harmony refused the setup code` | The code was used or is older than 30 minutes: click **New code** and run the command again |
| `No setup code and no saved credentials.` | The volume was removed: run the command with a new setup code |
| `Cannot write /data/credentials.json` | `/data` is not writable: mount a named volume as the page's command does |
| `The container name is already in use` (from Docker) | Remove the old container with `docker rm -f harmony-discord-bridge`, then run the command again |

## Upgrade from the old bridge

A server that used the old config-file bridge (v1) shows **Upgrade to the new Discord bridge** on the bridge page. The old bridge keeps working until you switch. Set up the new bridge as above; once it works, stop the old bridge program, or every message is copied twice. **Old bridge setup (v1)** at the bottom of the page keeps the old pairing code and config file for bridges not yet moved.
