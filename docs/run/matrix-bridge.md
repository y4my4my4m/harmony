---
title: Matrix bridge
description: Connect channels of a Harmony server with Matrix rooms - set up the bridge, pair channels, choose how members appear, and fix the problems the bridge reports.
---

# Matrix bridge

This page is for Harmony server owners and members with the Manage Server permission who want to connect their server with Matrix, and for the members and Matrix people whose messages cross the bridge. It covers the ways to run the bridge, the setup in **Server settings** → **Bridges** → **Matrix**, what crosses, and how to fix what the bridge reports. Instance operators who want to run bridges for their communities read [Hosting Matrix bridges](/self-host/matrix-bridges).

## What the bridge does

A bridge links channels of one Harmony server with Matrix rooms, one to one. A message posted in a paired channel appears in its room, and the other way round.

- On Harmony, a Matrix person's message shows their name and avatar, with a Matrix badge next to the name.
- On Matrix, Harmony members appear as Matrix users of their own, or together under the bridge's account with their name in front ([How Harmony members appear](#how-harmony-members-appear-in-matrix)).

This is a **plaintext bridge**, not an encrypted participant. Text, mentions, images and ordinary files flow both ways; Matrix replies can keep their Harmony reply context. Edits, reactions, deletions and threads are not mirrored. End-to-end encrypted channels and rooms are not bridged.

A server has at most one bridge that is set up here. It runs beside the server's [Discord bridge](/run/discord-bridge) and any bridge program of your own.

## Choose how the bridge runs

The first screen of **Server settings** → **Bridges** → **Matrix**, **Where should the bridge run?**, offers what your instance supports.

| Option | What you do | Who can read the rooms | Offered when |
|---|---|---|---|
| **Use *instance*'s bridge** (marked **Recommended**) | Invite the bridge to a room and post a code there | The instance's operator, every room you link | The operator set the instance's bridge up |
| **Use your own Matrix account, run on this instance** | Sign in with a Matrix account, pair channels with rooms | The instance's operator, every room the account is in | The operator turned it on |
| **Run it yourself** | Run one command on a computer that stays on, with your own homeserver or a Matrix account, pair channels with rooms | Whoever runs that computer | Always |
| **Use your own bridge program** | Create a bot, give its token to the program, choose its channels; the rooms are in the program's configuration | Whoever runs the program | Always |

In every case the messages in bridged channels pass through the Harmony instance like any other message.

You need, on Harmony, ownership of the server or the Manage Server permission ([Roles and permissions](/run/roles-permissions)). A server whose own bridge program was set up before 1.9.9 opens on it, unchanged; **Choose how to run it** below it shows the options.

The page updates by itself every few seconds. **Chose the wrong option?** **Start over** below the steps removes the half-made bridge.

## Set up with the instance's bridge

You need a Matrix room whose settings you may change, or someone there who may.

1. Click **Use *instance*'s bridge**. **Check the connection** waits until the instance has started your bridge, a minute or two.
2. On **Pair channels**, choose the channel, the direction and, where it is offered, how Harmony members appear, and click **Get a code**.
3. In Matrix, invite the account the page shows to the room.
4. Once the account has joined, post the message the page shows there: `!harmony link ML-XXXX-XXXX-XXXX`.
5. The pair appears on the page by itself. Click **Finish setup** once at least one channel is paired.

- Only someone who may change the room's settings can link it: an admin of the room, or whoever the room allows.
- An encrypted room cannot be linked, and an encrypted channel gets no code.
- A code is for one channel, works once, is valid for 30 minutes and stops working when the manager who got it no longer manages the server. **New code** replaces it.
- A code moves the room to your channel from whatever it was linked with before. The card of the pair that lost it says so: **Link a room again** gets a code for that channel.

## Set up with your own Matrix account, run on this instance

1. Click **Use my own account here**.
2. On **Sign in to Matrix**, enter the homeserver (its server name, such as `matrix.org`, or its address), the user name and the password, and click **Sign in**. The password goes from your browser to the homeserver alone: Harmony never gets it, and it is not kept. The bridge appears in the account's sessions as "Harmony bridge".
3. Where the homeserver offers no password sign-in, or your browser cannot reach it, choose **Paste an access token**. A token copied from a Matrix app's settings works only where tokens do not expire; on matrix.org they do, within minutes.
4. **Check the connection** waits until the instance has started the bridge. Then [pair channels](#pair-channels).

The instance's operator holds the account's access token and can read every room the account is in. Use an account made for the bridge, in the rooms you bridge alone: the names of the rooms it is in are shown to the managers of the server. Direct chats are left out. End-to-end encrypted rooms are not relayed.

Every message from Harmony comes from that account, with the member's name in front.

Under **Maintenance**, **Replace the Matrix account** signs in with the same or another account; end the old "Harmony bridge" session in Matrix. After another homeserver the page waits for the bridge again; the pairs stay. Two bridges on an instance cannot use one account.

| What the sign-in says | What it means |
|---|---|
| The homeserver can't be reached from this browser | The name is wrong, the server is down, or it does not answer web pages. Try the homeserver's own address, or paste a token |
| No Matrix homeserver answered there | The name is another website's. Enter the homeserver's own address |
| The homeserver refused the user name or the password | Check both |
| Too many tries | Wait as long as it says |
| This homeserver gives out access tokens that expire | Use an account on another homeserver |

## Set up a bridge you run yourself

You need a computer that is always on, with Docker or with Node.js, and one of:

- a Matrix homeserver whose operator can install an application service: one you run, or one whose operator you can ask. A room moderator cannot do this part. The homeserver has to reach the computer: both are on the same computer or network, or the bridge has a public address;
- a Matrix account on any homeserver, made for the bridge.

Click **Run it myself**. The three steps are **Start the bridge**, **Check the connection** and **Pair channels**.

### Start the bridge

Choose **How the bridge signs in to Matrix**.

**On a homeserver you run, or whose operator you can ask**

1. Fill in the three fields. The commands take them in:

   | Field | Example | What it is |
   |---|---|---|
   | **Homeserver address** | `https://matrix.example.org` | The address Matrix apps connect to |
   | **Server name** | `example.org` | The part after the colon in the homeserver's user IDs |
   | **Address of the bridge** | `http://192.168.1.20:9009` | How the homeserver reaches the bridge, which listens on port 9009 |

2. Choose **Docker command**, **Docker Compose** or **From source**, copy what the page shows, and run it on that computer.
3. When it starts, the bridge writes `registration.json`. With Docker, `docker cp harmony-matrix-bridge:/data/registration.json .` copies it out of the container; from source it is in the `data` folder. Give it to the homeserver's operator. On Synapse they add its path to `app_service_config_files` in `homeserver.yaml` and restart Synapse.
4. The bridge connects by itself once the homeserver knows it.

**With a Matrix account**

1. Fill in **Homeserver address**.
2. Run the first command the page shows. It asks for the account's user name and password in the terminal, signs in as the session "Harmony bridge" and prints the access token. Nothing is written to disk. With Docker it has this shape:

   ```bash
   docker run --rm -it -e MATRIX_HOMESERVER_URL=https://matrix.example.org ghcr.io/y4my4my4m/harmony-matrix-bridge:latest node dist/index.js --login
   ```

3. Put the token into the command or file that starts the bridge, in place of `PASTE_YOUR_MATRIX_ACCESS_TOKEN_HERE`, and run it.

A token copied from a Matrix app's settings works only where tokens do not expire; on matrix.org they do, within minutes. Signing the "Harmony bridge" session out ends the token. Every message from Harmony comes from that account, with the member's name in front, and the names of the rooms it is in are shown to the managers of the server.

**In both cases**

The setup code in the command is valid for 30 minutes and works once. It stops working when the manager who got it no longer manages the server. **New code** cancels older ones.

`registration.json` holds the bridge's keys to the homeserver. Do not post it, an access token, the setup code or any other credential in messages, screenshots or public links.

Keep the bridge's data: the Docker volume `harmony-matrix-bridge-data`, or the `data` folder. It holds the bridge's Harmony sign-in, the registration, and which Matrix event is which Harmony message. Back it up, and take it along when you move the bridge. Without it the bridge has to be registered again, and replies to earlier messages cross without what they reply to. Once the new registration is on the homeserver, the bridge takes its Matrix users over again.

The [README](https://github.com/y4my4my4m/harmony-matrix-bridge#readme) of the program lists every setting.

## Check the connection

| Check | What it means when it is not green |
|---|---|
| Bridge connected | A bridge you run has not signed in to Harmony with the code; the program's log says why. One the instance runs has not been started: wait a few minutes, then ask the instance's admin |
| Bridge signed in to the homeserver | The homeserver does not know the bridge or refuses its sign-in, or cannot be reached |
| Bridge signed in to Harmony | The bridge reached Harmony before but cannot stay connected |

## Pair channels

Each pair links one text channel with one room. With the instance's bridge a [code](#set-up-with-the-instance-s-bridge) makes the pair. Otherwise choose the channel and the room, or **Another room…** to type a room's address (`#general:example.org`), its ID (`!abc:example.org`) or a `matrix.to` link. A channel and a room each belong to one pair.

- The room list holds the rooms the bridge's account is in, then those it is invited to. It joins a room only when a pair names it, and accepts an invitation the same way. Invite the account, named on the page, to a room that is not open to everyone.
- End-to-end encrypted channels and rooms are greyed out: the bridge cannot read them. A room the bridge cannot check counts as encrypted. Rooms it may not post in are greyed out unless the direction is **Matrix → Harmony only**.
- **Direction** is **Both ways**, **Matrix → Harmony only** or **Harmony → Matrix only**.
- **Harmony members appear in Matrix** is offered when the bridge runs as an application service.

The bridge can read and write in the paired channels alone. Its Harmony bot, **Matrix Bridge**, is made and installed for you with Read messages and Send messages for these channels.

Click **Finish setup** once at least one channel is paired.

## When the bridge runs

The tab shows the bridge's state, its Matrix account and homeserver, its version, the messages it still holds and those it gave up on, and each pair. A bridge that has not reported for 90 seconds is shown as offline. Direction and how members appear can be changed on each pair's card; **Remove** ends a pair.

| Pair state | Meaning |
|---|---|
| Waiting for the bridge | The bridge has not seen the pair yet |
| Joining the room | It is joining the room or checking its encryption |
| Working | Messages cross |
| Not working | The card says why |

| Reason | What to do |
|---|---|
| No room was found at the address | Check the address, or remove the pair |
| The room needs an invitation | Invite the bridge's account to it on Matrix |
| The room or channel is end-to-end encrypted | Pair one without encryption. Never turn encryption off for a bridge |
| The account may not post in the room | Matrix messages still arrive. Ask an admin of the room to let the account post |
| The room is bridged to another channel | Choose another room. With the instance's bridge, get a new code for this channel |
| Matrix users cannot be added to the room | Matrix messages still arrive. Let the account invite people there, or choose the shared bridge account |

| Problem | What to do |
|---|---|
| The homeserver doesn't know the bridge yet | Give `registration.json` to the homeserver's operator |
| The homeserver rejected the bridge's sign-in | Application service: the registration there is another bridge's, or an old one; hand over the current file again. Account: sign in again, or start the bridge with a new token |
| Another bridge on this instance already uses this Matrix account | Use an account made for this bridge alone |
| The bridge can't reach the homeserver, or this Harmony instance | Check the address, and the network of the computer that runs the bridge. It keeps retrying |
| The bridge can no longer sign in to Harmony | Remove the container and start it again with a new setup code. Its data stays |
| The bridge stopped relaying: it can't write its data | Check the computer's disk, then restart the bridge |
| Some older messages of a room weren't relayed | Nothing. New messages are relayed as usual |

Problems on the instance's side, for a bridge the instance runs, are its admin's to fix; the card says so.

For a bridge you run, **Move the bridge to another computer, or reinstall it** under **Maintenance** gives a new setup code and the commands again.

**Disconnect bridge** stops bridging and removes the pairs and the bridge's Harmony bot. Messages that were already bridged stay; **Remove all bridged messages** under **Bridge privacy** deletes them first if you want that. Matrix users and rooms are not deleted. What else is left to do depends on who runs the bridge:

| Bridge | Afterwards |
|---|---|
| You run it | Stop the program on your computer; have the registration taken out of the homeserver, or end the account's "Harmony bridge" session |
| Your account, run on the instance | The stored token is deleted. End the account's "Harmony bridge" session in Matrix |
| The instance's bridge | It leaves the rooms by itself |

## Use your own bridge program

For another program, or for [harmony-matrix-bridge](https://github.com/y4my4my4m/harmony-matrix-bridge) with a `config.json` you write. It works as before 1.9.9, also beside a bridge that is set up here, for other channels.

For a member with **Manage Server** who owns the program's bot:

1. Create a dedicated bot under **User settings** → **My bots** and give its token to the program's configuration.
2. Add the bot to the server under **Server settings** → **Advanced settings** → **Server bots**, with **Read messages** and **Send messages**. Under **Channels**, choose **Selected channels** and tick the channels to bridge.
3. Open **Server settings** → **Bridges** → **Matrix**, choose **Use your own bridge program**, then the bot, and tick the channels to pair. Only text channels in the bot's channel list can be ticked; the others are greyed out with a note saying where to add them. A paired channel shows **Waiting for the bridge to connect a room** until the running program binds the Matrix room from its configuration.

A manager without such a bot sees these steps. **Change paired channels** replaces the bot's channels; **Unpair**, for the bot's owner or any manager, removes all of the bot's pairs in the server. The status card at the top counts the paired channels, those with a Matrix room and those still waiting, and any the bot can no longer bridge because it was turned off, lost read or send, or lost the channel from its list. It cannot tell whether the program is running.

The program's `config.json` holds the room/channel pairs and directions, and the sender mode of a first binding; without one, a pair starts with the shared relay. Lists of the Harmony members and Matrix people it relays can be added there. They are additional restrictions: they never grant access to someone who opted out.

## How Harmony members appear in Matrix

Each pair has its own **Harmony members appear in Matrix** choice:

| Choice | Effect |
|---|---|
| **As their own Matrix users (recommended)** | Harmony members appear as actual bridge-managed Matrix room members with their Harmony name/nickname and avatar. Their message bodies have no attribution prefix. |
| **Through one shared bridge account** | All Harmony messages use the bridge account, with the author's name in the body. No new ghost users are added. |

The saved choice overrides the program's own configuration. If saving fails, reload before trying again: a lost response does not prove the server failed to save.

Own Matrix users (ghosts) need the application service's user namespace, which the generated registration holds, and room invite permissions. If these are missing, the bridge reports an error instead of silently switching to the shared account.

A ghost is made when its member first writes in the channel. In a channel with at most 100 eligible members the bridge makes them ahead, so that Matrix people can mention everyone. Nicknames and avatars are set for the individual Matrix room rather than overwriting a user's identity in another community. Custom avatars are mirrored only from Harmony's own avatars storage as bounded, metadata-stripped raster images; default or external pictures may use Matrix's fallback avatar.

Switching to the shared account stops using ghosts and makes the running bridge leave tracked ghost memberships. It does not delete Matrix accounts or rewrite existing messages. A queued retry is not resent under a different identity after a mode change.

## Mention people

### From Harmony

Type `@` and select the Matrix member from Harmony's normal suggestions. The entry identifies Matrix and the full Matrix ID, so two people named Sam on different homeservers remain distinct. Its profile card is a read-only external identity, not a Harmony account.

The bridge turns this structured mention into a proper Matrix mention. Typing an arbitrary display name is not a substitute for selecting a recipient.

### From Matrix with ghosts

Use your client's normal `@` autocomplete and select the Harmony member's ghost. The bridge recognizes the explicit Matrix mention and translates it into a real Harmony user mention and notification, subject to current eligibility.

Allow a member-refresh cycle after setup or membership changes. In a channel with more than 100 eligible members, a member can be mentioned once they have written there. Opted-out or channel-ineligible Harmony members, and those outside a list in the program's configuration, are not provisioned as ghosts.

### From Matrix with a shared relay

Harmony-only users are not Matrix room members in this mode, so Matrix cannot list them in native `@` autocomplete. Use the explicit bridge command:

```text
!mention exact_harmony_username Hello from Matrix
```

It uses the eligible member's exact Harmony username, not an ambiguous display name. This is not Discord's `/mention` command and does not provide portable client-side autocomplete. Unknown or ineligible targets do not become real Harmony mentions.

The bridge does not turn raw `@room`, `@everyone` or display-name-looking text into new notification targets.

## Replies from Matrix

Use the Matrix client's normal Reply action. When the parent was bridged in either direction and remains readable to the bridge, Harmony shows its native reply context. Old Matrix plain/HTML quote fallbacks are removed rather than copied as new text. An unmapped, missing or now-private parent leaves the new reply text without a guessed link. Matrix threads and edits remain unsupported, and Harmony-to-Matrix reply context is not mirrored.

## Images and files

Post an image or file normally in either client. Supported bytes are copied into the destination's own storage, not left as links to the other platform. Captions are retained when Matrix supplies a separate filename. Harmony messages with several attachments become text followed by individual Matrix file events; replies to those events can point back to the original Harmony message. Audio and video travel as downloadable files, without transcoding.

The bridge copies at most **20 files per Harmony message**, each up to **50 MiB**, subject to lower current instance/storage and destination limits. Unsupported, oversized or failed copies show **`[Attachment unavailable: filename]`** instead of silently disappearing; accompanying text is retained. Transient transfer errors are retried before that fallback. A revoked binding, withdrawn consent or encryption transition blocks the delivery rather than publishing a notice for the revoked content.

Harmony attachments must be in private message storage. Files attached from Drive are not relayed. URL-only, legacy and external attachment parts are not downloaded. Active files such as SVG, HTML, scripts and executables, unsupported MIME types and invalid image signatures are refused. Files use the existing media-metadata stripping, not malware scanning; archives and ordinary documents can still contain unsafe content.

Encrypted rooms remain blocked. An encrypted attachment descriptor in a plaintext Matrix room produces a notice without copying ciphertext or keys. Encrypted rooms/media are planned follow-up work, not supported by sending a decryption key or disabling encryption.

## Member privacy

Each Harmony member can open **Server menu → Bridge privacy → Do not forward my messages to Matrix**. Discord has its own independent switch. These preferences are per-member, per-server, and per-platform, not per bridge bot; the administrator's sender-mode choice does not override them. The switch is shown only for a platform the server bridges. A preference outlives leaving and rejoining the server.

Opt-out blocks future bridged message/file delivery and fresh ghost profile exposure. The running worker removes tracked ghost memberships when it sees that the member is no longer eligible. It rechecks consent before queued delivery and profile operations rather than trusting the original message or a cached member list.

This is not retroactive erasure. Previous remote messages/files, Matrix accounts, cached profiles and previously disclosed metadata may remain. Interrupted transfers can leave uploads that were never posted; the bridge adds no media orphan sweeper. A request already in flight cannot be cancelled atomically. Ordinary bots and independent server webhooks are not governed by this bridge preference.

## Privacy of Matrix people

Matrix people decide about their own messages in any paired room:

| Command | Effect |
|---|---|
| `!bridge-privacy opt-out` | From now on the bridge brings none of their messages into this Harmony server |
| `!bridge-privacy opt-in` | Undoes their own opt-out, from then on |
| `!bridge-privacy status` | Says whether they are opted out |
| `!bridge-privacy erase` | Asks first, then deletes what the bridge brought from them into this Harmony server, and opts them out. Their Matrix messages stay |

The commands cover every room bridged to the same Harmony server. Members with Manage Server act for someone under **Bridge privacy** on the Matrix tab, by Matrix ID. What a manager removed, a manager alone can let through again.

## Limits and recovery

- Encrypted or unknown room/channel state blocks relaying and fresh profile/member synchronization. Never disable encryption to make a bridge appear to work.
- The Matrix people suggested after `@` in Harmony are at most 1,000 per room. Profile synchronization and client suggestion caches are periodic, not instantaneous.
- A room list holds at most 500 rooms. Direct chats and spaces are left out. Any room can be named by its address or ID.
- Matrix ghost IDs are stable and reserved to the application service. They are not links to somebody's existing Matrix account.
- Back up the bridge's private data with its configuration and registration. It records ghost ownership and queued sender identities. Losing that state can require operator recovery; the bridge will not adopt an unknown existing account just because its name matches.
- Keep the program running to perform ghost cleanup. Stopping or uninstalling it cannot by itself retract remote memberships or messages.
