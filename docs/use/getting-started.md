---
title: Getting started
description: Pick a Harmony instance, create an account, set up your profile, join servers with an invite or from the directory, and find your way around the interface.
---
# Getting started

This page is for people new to Harmony. It covers what an instance is, creating an account, setting up your profile, joining servers, and the parts of the interface you use every day. Creating and configuring your own server is covered in [Set up a server](/run/setup).

## Instances and accounts

An instance is one Harmony deployment, reached at its own domain and run by its own operator. https://har.mony.lol is the flagship instance, with its service status at https://status.mony.lol; anyone can run another one ([Self-host](/self-host/)).

Your account lives on one instance. Your handle is your username followed by that instance's domain, for example `@sam@har.mony.lol`. Servers, the communities you chat in, are hosted on an instance too. Instances federate, so from your account you can join a server hosted on another Harmony instance and mention people on other instances ([Join a server on another instance](#join-a-server-on-another-instance)).

## Choose an instance

In a web browser, the instance is the site you open. There is nothing else to choose.

The desktop app and the Android app are one build for every instance. On first launch they show **Welcome to Harmony** and ask which instance to connect to:

1. Type the instance domain, for example `har.mony.lol`. The `https://` prefix is filled in for you. The field may already hold a default domain chosen by whoever built the app.
2. Select **Connect**. The app checks that the instance answers, then reloads on that instance's login page.

If the domain is wrong, or the instance runs a version too old to serve native clients, the picker shows an error and stays open.

To switch instances later, sign out. The login screen of the app shows a bar with the current instance name; select **Change** to reopen the picker. **Keep it** closes the picker without changing anything.

## Create an account

1. Open the instance and select **Register** below the login form, or go to `/register` on the instance's domain.
2. Enter your **Email** and a **Password** of at least 6 characters.
3. Select **Create account**.
4. If the instance requires email confirmation, Harmony shows a message that it sent a confirmation link and returns you to the login page. Open the link in the email, then log in.
5. Set up your profile ([next section](#set-up-your-profile)).

If the instance publishes terms of service or a privacy policy, links to them appear under the form.

### Sign up with Google, Twitch or GitHub

When the instance operator has enabled them, buttons appear above the email form: **Continue with Google**, **Continue with Twitch** and **Continue with GitHub**. Only providers the operator turned on are shown, and an instance with none shows only the email form. Operators enable them as described in [OAuth sign-in providers](/self-host/oauth).

Signing in with a provider for the first time creates your account. The profile form then starts with the name and picture from that provider and a suggested username, all of which you can change before continuing.

### Instances that limit registration

Each instance chooses who may sign up:

| Registration | What happens |
|---|---|
| Open | Anyone registers as described above. |
| Invite only | Self sign-up is off and the **Create account** form returns an error. An administrator creates an invitation for your email address and sends you the link. It works once: it opens a page where you choose a password, then you log in and set up your profile. |
| Closed | Nobody can sign up, and no invitations are issued. |

Operators switch between these with the `harmony` command ([CLI reference](/self-host/cli)).

## Set up your profile

The first time you sign in, Harmony shows **Set up your profile**:

| Field | Rules |
|---|---|
| **Profile picture** | Optional. You crop the image after picking it, and you can change it later. |
| **Display name** | Required, up to 50 characters. This is the name shown in chats; you can change it any time. |
| **Username** | Required, 3 to 24 characters: lowercase letters, digits and underscores. Capitals are lowered and other characters are dropped as you type. The form tells you whether the name is free. Some names are reserved: `everyone`, `here`, `system`, `harmony`, `admin`, `admins`, `administrator`, `mod`, `mods`, `moderator`, `moderators`, `staff`, `root`, and the parts of the instance's domain before the last (`har` and `mony` on `har.mony.lol`). It cannot be changed later. |
| **About you** | Optional, up to 500 characters. |

Select **Continue**. The line at the bottom of the form shows which email address you are signed in with, and **Sign out** leaves without creating the profile.

If the instance has a welcome server or featured communities, a **Welcome to** page lists them next, each with a **Join** button. **Skip for now** goes straight to the app. This step is skipped when you signed up from an invite link; you return to that invite instead.

## Log in

The **Log in** form takes your **Email** and **Password**.

- **Remember me** keeps you signed in after the browser closes. Clear it on a shared computer: the session then lasts only for that browser tab.
- **Forgot your password?** opens **Reset your password**. Enter your email and select **Send reset link**, then follow the link in the email. This needs the instance to have email configured; if it does not, the dialog says so.
- With two-factor authentication on, Harmony asks for the 6-digit code from your authenticator app, or a recovery code after **Use recovery code instead**. See [Privacy and security](/use/privacy-security).

## Join a server

A server is a community with its own channels, roles and members. You join one with an invite, from the server directory, or by address when it is hosted on another instance.

### Accept an invite link

Invite links look like `https://har.mony.lol/invite/AbCd1234`: the instance domain, `/invite/` and a code.

1. Open the link. If you are signed out, Harmony asks you to log in or register first, then returns to the invite.
2. The invite page shows the server's icon, name, member count and description under **You've been invited to join**.
3. Select **Accept invite**, or **No thanks** to leave.
4. If the server has rules, or the instance has rules you have not yet agreed to on this device, **Before you join** lists them. Select **Agree and join**. Instance rules are shown once per device; server rules are shown for each server.
5. Harmony confirms that you joined and opens the server's default channel.

If you are already a member, the page offers **Open server** instead. An invite that has expired, reached its use limit or been revoked shows **Invite invalid**.

When you are in no servers yet, the chat view shows **You're not in any servers yet** with a **Join with an invite** field. Paste an invite link or only its code there and select **Join**. Links from other Harmony instances work in that field too.

To invite someone else, open the server name menu and choose **Get invite link**, or right-click the server icon and choose **Invite people**. The dialog shows a link to **Copy**. Members allowed to create invites can open **Link settings** to set **Expire after** and **Max uses**; the options are described in [Set up a server](/run/setup).

### Join a server on another instance

A server hosted on another Harmony instance is joined through **Join remote server**. It opens in two ways:

- Click an invite link in Harmony that points at another instance. The dialog opens with the link filled in and looks it up.
- Open **Harmony Portal** at the top of the server rail, or **Browse public servers** in the empty chat view, and select **Join by URL**. Paste an invite link such as `https://other.example/invite/CODE`, a server URL, or a server handle such as `server@other.example`, then select **Discover**.

The preview shows the server's name, the instance that hosts it, its member and channel counts, and for an invite the person who created it, when it expires and any rules. Select **Join server**. A server that approves members first answers with a join request; you get access once the server accepts it.

In the channel sidebar, a server hosted elsewhere shows a globe icon and a **Hosted on** line with its domain. Your messages there are sent to that instance.

### Browse public servers

Select **Harmony Portal**, the first button at the top of the server rail, to open **Discover communities**. It lists the public servers hosted on your instance:

- **Search communities...** filters by name.
- Category buttons narrow the list, starting with **All**.
- **Featured communities**, picked by the people who run the instance, appear above **All communities**.
- **Join** adds you to a server; **Open** switches to one you are already in.

The footer offers **Join by URL** for servers on other instances and **Create your own server**.

## Find your way around

On a desktop-sized window the app has five areas from left to right:

| Area | What it holds |
|---|---|
| Server rail | Harmony Portal, Today, Direct messages, Fediverse, Drive, then your servers and folders. |
| Channel sidebar | The server name menu, categories, text and voice channels, and active threads. |
| Chat area | The channel header, the messages and the message composer. |
| Member list | The server's members, grouped by role and online status. |
| User panel | Bottom left: your avatar, status, notifications bell, **Mute**, **Deafen** and **Settings**. |

On a phone, the chat area fills the screen. **Navigation menu** in the channel header opens the rail and channel list, and **Member list** opens the members.

### Server rail

| Button | What it does |
|---|---|
| **Harmony Portal** | Opens **Discover communities**. |
| **Today** | Opens the Today digest. Shown while the Today dashboard is on ([Today](#today)). |
| **Direct messages** | Opens your direct messages and group chats. A number counts unread mentions. |
| **Fediverse** | Opens the social timeline ([Social](/use/social)). |
| **Drive** | Opens your files ([Drive](/use/drive)). |
| Server icons | Open a server. A pill beside an icon marks unread messages; a number counts mentions. |

Right-click a server icon, or press and hold it on a touch screen, for its menu: **Mark as read**, **Invite people**, **Mute server** (for 15 minutes, 1, 3, 8 or 24 hours, or **Until I turn it back on**), **Notification settings**, **Server settings** or **Overview**, **Move up**, **Move down**, folder actions, **Copy server ID** and **Leave server**. Members who manage channels also see **Create channel** and **Create category**.

### Group servers into folders

- Drag a server onto the middle of another server to put both in a new folder, or choose **Create folder** from a server's menu.
- Drag a server onto a folder to add it, or use **Move to folder** and **Remove from folder** from the server's menu.
- Click a folder to expand or collapse it.
- Right-click a folder for **Mark folder as read**, **Folder settings**, **Move up**, **Move down** and **Ungroup folder**. **Folder settings** sets an optional name of up to 32 characters and a colour.

With a mouse, a drag starts once the pointer moves. On a touch screen, press and hold, then move.

### Channel sidebar

The server name at the top opens a menu. Which items appear depends on your permissions:

| Item | What it does |
|---|---|
| **Server settings** or **Overview** | Server settings for members who manage the server; a read-only overview for others who may view it. |
| **Create category**, **Create channel** | For members who manage channels. A text channel's name is lowercase with `-` for spaces (`release-notes`); a voice channel and a category keep spaces and capitals (`Game Night`). **More options** in **Create channel** sets the description and, for a text channel, slowmode. |
| **Get invite link** | Opens **Invite people**. |
| **Notification settings** | Notification level and mute for this server ([Notifications and apps](/use/notifications-apps)). |
| **Server rules & welcome** | Shown when the server has a welcome screen. |
| **Leave server** | Not shown to the owner. |

Below the menu are the channels, grouped in categories. A `#` marks a text channel and a speaker a voice channel. Next to a channel name, a lock means it is end-to-end encrypted, a crossed-out eye means it is a private channel, and a crossed-out bell means you muted it. A number counts unread mentions. Voice channels list the people in them, and the speech-bubble button beside a voice channel opens its text chat. Active threads are listed under their channel.

### Chat area

The header shows the channel name and description, with buttons for **Pinned messages**, **View all threads**, **Search messages**, **Member list** and **More options**. **More options** holds **Mark as read**, **Mute channel**, the channel's **Notification level** and **Notification settings**, plus **Edit channel** for members who manage channels. On a phone, pinned messages and threads move into **More options**.

The composer at the bottom sends messages. Everything about writing, replying, threads, polls and reactions is in [Messages and threads](/use/messages).

### Direct messages

**Direct messages** in the rail opens the conversation list. **Start a new DM** searches for people by name, or by full handle such as `@user@domain.com` for someone on another instance. **Create group chat** starts a conversation with several people. Calls in direct messages are covered in [Voice and video](/use/voice-video).

### Today

Today is a digest of what happened since your last visit: mentions and replies, unread direct messages and channels, threads you are part of, who is live in voice, and posts from people you follow. Select the sun icon in the server rail to open it.

Today is a beta feature and is on unless you turn it off. The switch is **Today dashboard** under **User settings** → **Advanced** → **Beta features**. The choice is stored per device, so a phone and a desktop each keep their own.

### User panel and settings

The user panel sits at the bottom left. Click your status to change it, use the bell for notifications, and **Mute** and **Deafen** for your microphone and sound. On a phone, and on pages without a channel sidebar, the panel shrinks to your avatar in the rail; select it to open the full panel.

**Settings**, the gear in the user panel, opens **User settings**:

| Group | Sections |
|---|---|
| **User settings** | **My account**, **Security**, **Privacy & safety**, **My bots**, **My emojis** |
| **Settings** | **Announcements**, **Notifications**, **Appearance**, **Voice & video**, **Keybindings**, **Sounds**, **Language**, **Advanced** |
| **Administration** | Shown only to instance administrators and moderators. |
