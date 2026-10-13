---
title: Notifications and apps
description: Choose what notifies you per server, category, channel and conversation, and install Harmony on Windows, macOS, Linux, Android or as a web app.
---
# Notifications and apps

This page is for people using Harmony. The first half explains how notification levels and mutes work and where to change them. The second half covers the desktop app, the Android app and installing Harmony from the browser as a web app. Instance operators who need to set up push delivery should read [Push notifications](/self-host/push).

## How notification levels work

Every channel in a server has one of three levels:

| Level | You are notified for |
|---|---|
| **All messages** | Every message in the channel, plus everything below. |
| **Only @mentions** | Mentions of you, your roles, @everyone and @here, reactions to your messages, and replies in threads you are in. |
| **Nothing** | Nothing from this channel, mentions included. |

The level that applies is the first one set in this order:

1. The channel's own level.
2. The level of the channel's category.
3. Your level for the whole server.
4. The server's default, marked **Server default** in the list. A server without its own default uses **Only @mentions**.

A level changes notifications only. Unread dots and counts are not affected by levels; they are affected by mutes.

You are never notified about the channel or conversation you are looking at, or about people you blocked.

## Set a server's notifications

Open **Notification settings** for a server in any of these ways:

- Right-click (or long-press) the server's icon in the server list.
- Open the menu under the server's name at the top of the channel list.
- In a channel, click **More options** in the header.

The window holds every setting for that server:

| Setting | What it does |
|---|---|
| **Mute** (server name), with **Mute for** | Mutes the server for a set time. See [Mute a server, channel or conversation](#mute-a-server-channel-or-conversation). |
| **Server notification settings** | Your level for the whole server. **Use the server default** clears your choice. |
| **Suppress @everyone and @here** | "@everyone and @here mentions in this server do not notify you." |
| **Suppress all role @mentions** | "Mentions of your roles do not notify you. Mentions of you still do." |
| **Push notifications** | Sends this server's notifications to your phone and browsers while you are away. On by default. |
| **Notification overrides** | Levels and mutes for single channels and categories. |

Click **Done** to close the window; changes save as you make them.

## Set a channel's level

1. Open the channel and click **More options** in the header.
2. Under **Notification level**, pick **All messages**, **Only @mentions** or **Nothing**.

**Default (...)** removes the channel's own level; the brackets show the level it then inherits.

## Set a category's level

1. Open **Notification settings** for the server.
2. Under **Notification overrides**, open **Select a channel or category** and pick the category.
3. In the new row, pick a level, or tick **Mute**.

Channels in the category follow it unless they have their own level. The same table lists channel overrides; the remove button at the end of a row deletes the override.

## Mute a server, channel or conversation

| What | How | How long |
|---|---|---|
| Server | Right-click the server icon → **Mute server**, or the switch at the top of **Notification settings** | **For 15 minutes**, **For 1 hour**, **For 3 hours**, **For 8 hours**, **For 24 hours** or **Until I turn it back on** |
| Channel | **More options** in the channel header → **Mute channel** | Until you unmute it |
| Category | **Notification settings** → **Notification overrides** → **Mute** in the category's row | Until you unmute it |
| Direct or group conversation | **More options** in the conversation header → **Mute conversation** | Until you unmute it |

A timed server mute shows "Muted until" followed by the end time. When a channel is muted through its category, the channel menu offers **Unmute category** instead.

What a mute does:

| Muted | Notifications | Unread indicators |
|---|---|---|
| Server | Only mentions get through. | The server icon is dimmed and loses its unread dot; the mention count stays. |
| Channel or category | Only mentions get through. | The channel is dimmed with a crossed-out bell and has no unread dot; the mention count stays. |
| Conversation | Only mentions get through. Calls arrive without a ringtone or pop-up. | The conversation is dimmed with a crossed-out bell; its unread count stays. |

A mute lets mentions through, but the level **Nothing** does not. To silence a channel completely, set it to **Nothing**.

Direct messages have no levels: they always notify unless you mute the conversation or turn off **Direct messages** in your notification settings.

## Choose which alerts you get

**User settings** → **Notifications** decides how alerts reach you on this device and which kinds you get.

| Section | Settings |
|---|---|
| **Do not disturb** | A switch, then **Quiet hours**: a daily start and end time in your local time. During quiet hours sounds, pop-ups and push are silenced; notifications still reach your inbox. |
| **Enable desktop notifications** (**Enable notifications** on phones) | **Grant permission** asks the browser or system to allow notifications. |
| **Chat & Messages** | A main switch, then a desktop switch and a sound switch for **Chat messages**, **Mentions**, **Direct messages**, **Replies** and **Reactions**, plus **New members** for servers you own or moderate. **Reactions** is off by default. |
| **ActivityPub and federation** | The same switches for **Follows**, **Mentions**, **Replies**, **Favorites**, **Reblogs** and **Follow requests**. |
| **Sound settings** | **Master volume** and **Voice activity sounds**. |
| **Push notifications** | Push to this device and your other devices. See [Push notifications](#push-notifications). |
| **Haptic feedback** | Devices that can vibrate only: vibration for messages, reactions, navigation, voice and other actions. |
| **Test notifications** | **Test all notifications** and **Reset to defaults**. |

Setting your status to **Do not disturb** also stops push notifications, and makes direct message calls to you fail with "This user is in Do Not Disturb mode".

## Push notifications

Push reaches a device when Harmony is closed. A notification is pushed only when all of these hold:

- **Push to my devices** is on, and the server's **Push notifications** switch is on.
- The kind of notification is switched on under **Chat & Messages** or **ActivityPub and federation**. Mentions and direct messages also need their **Mentions** and **Direct messages** push switches.
- It is not quiet hours and your status is not **Do not disturb**.
- You are not looking at that channel or conversation.
- With **Only when I’m away** on (the default), Harmony is not open and in use on another of your devices.

### Turn on push in a browser

1. Open **User settings** → **Notifications** → **Push notifications**.
2. Click **Turn on for this device** and allow notifications when the browser asks.
3. Click **Test push** to check it.

On iPhone and iPad, push works only after you add Harmony to the Home Screen (Share → Add to Home Screen); see [Install Harmony as a web app](#install-harmony-as-a-web-app). If the browser blocks notifications for the site, allow them in the browser's site settings and reload.

**Subscribed devices** lists every device that receives push. The remove button next to one stops push to it.

Where the browser supports it, a pushed message offers **Reply**, **Mark as read** and **Dismiss**.

## Desktop app

The desktop app runs Harmony in its own window, with a tray icon, system notifications and automatic updates.

| System | Download |
|---|---|
| Windows (64-bit) | Installer, `.exe` |
| macOS 11 or later (Intel and Apple silicon) | `.dmg` |
| Linux (x86-64) | `.AppImage` or `.deb` |

Download the file for your system from the [GitHub releases](https://github.com/y4my4my4m/harmony/releases) page.

::: warning macOS first launch
The macOS build is not notarized by Apple. The first time you open it, right-click the app and choose **Open**.
:::

### Connect to your instance

On first launch the app shows **Welcome to Harmony** and asks for the **Instance domain** of the instance you use, such as `har.mony.lol`. Click **Connect**. To switch instances later, click **Change** in the bar at the top of the sign-in screen.

### Tray and window

- Closing the window hides Harmony to the tray; it keeps running and notifying you.
- Click the tray icon to show or hide the window. Its menu has **Show Harmony** and **Quit**.
- Opening Harmony again while it runs brings the existing window forward.

On Linux desktops without a system tray, such as GNOME without the AppIndicator extension, there is no tray icon and closing the window quits.

### Notifications

The desktop app shows system notifications while its window is hidden or not focused. A focused window shows them inside the app instead. The **Push notifications** section in its settings reads **Push to other devices** and manages push to your phone and browsers.

### Updates

The app checks for updates 20 seconds after it starts and every 6 hours after that, and downloads new versions in the background. When one is ready, an **Update ready** indicator appears in the server list; click it and choose **Restart to update**, or **Later**.

**User settings** → **Advanced** → **Updates** shows your version, has **Check for updates**, and a **Download updates automatically** switch. With it off, Harmony still checks and asks before downloading.

On Linux, only the AppImage updates itself. Update a `.deb` install by installing the newer `.deb`.

### Desktop settings

**User settings** → **Advanced** → **Desktop app**:

| Setting | What it does |
|---|---|
| **Launch at startup** | Starts Harmony when you log in, minimized to the tray. |
| **Game activity (rich presence)** | Shows the game you are playing as your status. Detection runs on your computer; only the game name is shared. |
| **In-game voice overlay** | Floating, click-through voice tiles over your game during calls. Ctrl+Shift+O switches between click-through and clickable. |

## Android app

The Android app needs Android 7.0 or later on a 64-bit ARM device. Download the `.apk` from the [GitHub releases](https://github.com/y4my4my4m/harmony/releases) page and install it. Like the desktop app, it asks for your **Instance domain** on first launch.

The app checks once a day for a newer release and shows "Harmony (version) is available." with a **Download** link to the new APK.

### Choose how push reaches your phone

Open **User settings** → **Notifications** → **Push notifications**. The **Push on this device** card shows the current service and offers:

| Option | Delivery |
|---|---|
| **Automatic** | A push service you picked, else Google, else the only UnifiedPush app installed. |
| **Google (FCM)** | Through Google's Firebase Cloud Messaging. Needs Google Play Services, a build that includes it, and an instance that has it configured. |
| **UnifiedPush via** (app name) | Through a UnifiedPush distributor app on your phone. Listed once one is installed. |
| **Off** | Notifications only while Harmony runs. |

If notifications are not allowed, the card shows **Allow notifications** (or **Open notification settings** once Android has refused). **Send test push** checks the setup.

A UnifiedPush distributor is a separate app, such as ntfy or NextPush, that receives push messages for other apps without Google services; your instance sends Harmony's notifications to it as Web Push. The card suggests one: "To receive push without Google services, install a UnifiedPush distributor such as ntfy, then pick it here." The instance must also support UnifiedPush; if it does not, the option reads "Not configured on this server".

With neither service, the app shows notifications only while it is running.

### Notification categories and sounds

The app creates three Android notification categories, which you can tune in Android's settings for Harmony: **Direct messages**, **Mentions and replies**, and **Reactions and social**.

Alert sounds follow the phone's ringer: silent when the phone is on vibrate, silent or Do Not Disturb. On vibrate, mentions, direct messages, replies and incoming calls vibrate instead. Sounds for your own actions, such as muting or joining voice, play as media.

## Install Harmony as a web app

In a browser that supports installing web apps, Harmony can run in its own window like an app, with push notifications.

- A banner offers **Install Harmony** with an **Install** button. Closing it hides it for 30 days.
- **User settings** → **Advanced** → **Install app** has the same button, with instructions when the browser offers no install prompt.
- On iPhone and iPad, tap Share, then **Add to Home Screen**.

The installed app opens in its own window, with shortcuts to **Direct Messages** and **Notifications** where the system shows app shortcuts. Installed from a Chromium-based desktop browser, its **Install app** section also offers **Start Harmony when you sign in**.

When a new version of Harmony is published on your instance, the installed app shows **Update available** with **Update now**.
