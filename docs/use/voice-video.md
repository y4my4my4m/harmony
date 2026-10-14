---
title: Voice, video and calls
description: Join voice channels, place direct message calls, share your screen, watch or listen together, play soundboard sounds, send voice messages and set up your microphone and camera in Harmony.
---
# Voice, video and calls

This page is for people using Harmony. It covers voice channels, direct message calls, camera and screen sharing, watching or listening together, spatial audio, the soundboard, live reactions, voice messages and your voice settings. Server owners who want to set up voice channels or add soundboard sounds should read [Set up a server](/run/setup); instance operators who need to set up the voice server should read [Voice and TURN](/self-host/voice).

## How calls connect

Every call on an instance uses the same transport, chosen by the instance's voice configuration:

| Badge in the call bar | Meaning |
|---|---|
| **SFU** | Audio and video go through the instance's voice server (LiveKit). |
| **P2P** | Participants connect to each other directly, without a voice server. |

The badge sits next to the channel name in the call bar while you are connected. Some features need the voice server and are absent on **P2P**:

| Feature | SFU | P2P |
|---|---|---|
| Voice, camera, screen share, soundboard | Yes | Yes |
| Choosing which streams to watch (**Watch stream**) | Yes | No, every stream is received |
| Live reactions | Yes | No |
| End-to-end encrypted voice and video | Yes | No |

If you cannot join, Harmony shows a **Could not join voice** notice with the reason. Two reasons come from the instance's setup rather than from you:

- "This instance requires its voice server (SFU), which is not configured." The instance has not finished setting up voice. Tell its operator.
- "The voice server settings could not be loaded. Try again in a moment."

You can be in one call at a time, in one browser tab. Joining from a second tab fails with "You are already in a voice channel in another tab".

## Join a voice channel

1. Click a voice channel in the channel list. Harmony connects and the call bar appears at the bottom of the window.
2. Talk. Your microphone is live unless you muted it before joining or use push to talk.

On a phone, tapping a voice channel opens a preview of who is in it, with **Join voice**, a **Join muted** button and **Open chat**.

Voice channels also have a text chat. Clicking the voice channel you are already in opens that chat.

Joining another voice channel leaves the one you are in. Starting or joining a direct message call while you are in another call asks **Switch calls?** first; choose **Switch** to leave the current call.

Voice channels in servers hosted on another Harmony instance work the same way. The call runs on that instance's voice server.

Whether you can join and talk depends on the server's roles: joining needs the **Connect** permission and talking needs **Speak**. See [Roles and permissions](/run/roles-permissions).

::: tip Browser blocked the sound
Browsers can refuse to play audio until you interact with the page. When that happens the call bar shows "Your browser paused call audio." Click **Enable audio**.
:::

## Use the call bar

The call bar holds the controls for the call you are in. Hover a button to see its name.

| Control | What it does |
|---|---|
| **Mute** | Turns your microphone off or on. |
| **Deafen** | Stops all call audio for you. Deafening also mutes your microphone. |
| **Camera** | Turns your camera on or off. |
| **Share screen** | Opens the screen share panel. See [Share your screen](#share-your-screen). |
| **React** | Sends a live reaction. Shown only when someone has video or a stream on, on an SFU call. |
| **Watch or listen together** | Starts an activity, or adds to the running one. Shown in voice channels of servers on your own instance. See [Watch or listen together](#watch-or-listen-together). |
| **Soundboard** | Opens the soundboard. Shown only where you may play sounds. |
| **Spatial audio** | Opens the spatial audio panel. |
| **Voice settings** | Opens **Voice & video settings** for devices and audio processing. |
| **Participants** | Lists everyone in the call. |
| **Open call view** | Expands the call to the full call view with video tiles. |
| **Minimize voice panel** | Shrinks the call bar to a small panel you can drag. |
| **Leave voice** | Hangs up. |

The full call view adds **Grid view** and **Focus view** layouts, **Full screen**, **Minimize call view** and **Close call view**, and shows the call duration.

The **Mute** and **Deafen** buttons in your user panel at the bottom of the sidebar work outside calls too. A state set before you join applies when you connect.

A shield next to the channel name shows whether the call is end-to-end encrypted. See [Encrypted voice channels](#encrypted-voice-channels).

## Change how loud someone is

Right-click a participant's tile, or use its **More options** button, to open their menu:

- **User volume** sets their microphone level from 0 to 200%.
- **Mute** silences them for you only.
- When they are streaming, **Stream volume** and **Mute stream** do the same for their stream's sound.

The menu notes "Only changes what you hear": nobody else is affected. Harmony remembers these levels per person on this device.

## Turn on your camera

Click **Camera** in the call bar. Pick the camera, resolution and frame rate under **User settings** → **Voice & video** → **Video**. The defaults are 720p at 30 FPS.

In a direct message, **Start video call** starts a call with your camera on.

## Share your screen

1. Click **Share screen** in the call bar. The **Share your screen** panel opens.
2. Pick a **Stream quality**: 720p, 1080p or **Source** (the size of what you share), each at 30 or 60 fps. The default is 720p at 30 fps.
3. Pick the **Stream audio** bitrate: 64, 96, 128, 192 or 256 kbps. The default is 128 kbps.
4. Click **Go live**. Your browser or operating system asks what to share.

To change quality while live, click **Share screen** again; the panel reads **Stream settings**. Click **Stop streaming** to end the stream.

Higher settings need more upload bandwidth.

### Stream sound

Stream sound is a separate track from your voice, so viewers can turn your stream down without turning you down. Whether sound can be included is decided by the share picker of your browser or operating system: the panel reminds you "To include sound, turn on audio sharing in the browser picker." Harmony does not capture system audio itself in any of its apps. A stream shared without sound shows "This stream has no audio" in a viewer's stream volume menu.

On the Linux desktop app in a Wayland session, the picker is the system's screen-sharing portal.

### Watch a stream

On an **SFU** call, a stream starts as a **Live** tile and you receive nothing until you click **Watch stream**. **Stop watching** stops receiving it. To receive every stream as soon as it starts, turn on **Watch streams automatically** under **User settings** → **Voice & video**.

A watched stream can be focused, taken **Full screen**, or **Pop out** into a floating player you can move around the window.

## Watch or listen together

An activity plays a video or music for everyone in a voice channel at the same moment. Activities work in voice channels of servers on your own instance, not in direct message calls or in servers hosted on other instances. Anyone in the voice channel can start one.

1. Click **Watch or listen together** in the call bar.
2. Paste a link and click **Watch together** or **Listen together**. Or click **Choose from your Drive**, pick a video or audio file and click **Play together**.

| Source | What plays |
|---|---|
| YouTube | A video link, YouTube Music included. A start time in the link (`t=`) is kept. |
| SoundCloud | A track or playlist link. |
| Spotify | A track, album, playlist, podcast episode or show link. Spotify plays full tracks for listeners signed in to Spotify in Harmony; others hear previews. |
| A media file | An `https` link to a file ending in `.mp4`, `.m4v`, `.webm`, `.mov`, `.mkv`, `.ogv`, `.mp3`, `.m4a`, `.aac`, `.ogg`, `.oga`, `.opus`, `.wav` or `.flac`. |
| Your Drive | A video or audio file of your own [Drive](/use/drive). Everyone who can see the voice channel can open the file while it plays. |

While an activity runs, the call bar shows a small player with its title, **Play** or **Pause**, the position and **End the activity**. **Open the activity** opens the call view, where the player takes the main area and the participants move to a strip:

| Control | What it does |
|---|---|
| **Play**, **Pause**, **Position** | Play, pause or seek for everyone. On the position slider, the arrow keys move 5 seconds and Shift+arrow 30 seconds. |
| **Mute the activity**, **Activity volume** | Your own level. Harmony remembers the volume on this device. |
| **Queue** | Shows what plays next. |
| **Next in queue** | Skips to the next item. |
| **Only I control it**, **Let everyone control it** | Shown to the host. See [Who controls an activity](#who-controls-an-activity). |
| **End the activity** | Ends it for everyone. |
| **Stop for me** | Stops the player on your device only; the others keep playing. |

If your browser blocks autoplay, the player shows **Click to play**.

Under the voice channel in the channel list, everyone who can see the channel reads **Watching** or **Listening to** followed by the title.

### Queue

Clicking **Watch or listen together** while an activity runs opens **Add to the activity**: **Add to queue** puts the link or file at the end of the queue, and **Play now** starts a new activity in its place, with an empty queue. In the call view, **Queue** lists up to 50 items, each with **Play now**, which plays it and keeps the rest of the queue, and **Remove from queue**. When an item ends, the next one plays.

An activity ends when someone clicks **End the activity**, when the last item ends with nothing queued, or when the last person leaves the voice channel.

### Who controls an activity

Everyone in the call controls an activity unless its host restricts it. The host is the person who started it. **Only I control it** leaves the host as the only one who can play, pause, seek, skip, change the queue, start something else or end it, as long as they are in the voice channel. **Let everyone control it** lifts the restriction. When the host leaves the call, everyone can control the activity again.

## Use spatial audio

Spatial audio places each participant around you on a 2D map, so voices come from a direction and fade with distance. It changes only what you hear and is off until you turn it on.

1. Click **Spatial audio** in the call bar.
2. Click **Off** in the panel header so it reads **On**.
3. Drag avatars on the map to move people closer or farther. With the keyboard, focus an avatar and use the arrow keys; hold Shift to move farther.

**Reset** resets all positions and **Randomize** scatters them. Open **Spatial audio settings** in the panel to tune it:

| Setting | Default | Range or options |
|---|---|---|
| **Max distance** | 300 | 50 to 500 |
| **Rolloff factor** | 1 | 0.1 to 3 |
| **Distance model** | Inverse | Linear, Inverse, Exponential |
| **Panning model** | HRTF | Equal power, HRTF |
| **Enable reverb** | Off | |
| **Room size** | 0.5 | 0.1 to 2 |

Harmony remembers whether spatial audio is on. Stream sound is not positioned.

## Call someone from direct messages

1. Open the conversation.
2. Click **Start voice call** (the phone) or **Start video call** (the camera) in the conversation header.

The other person sees **Incoming voice call** or **Incoming video call** with **Decline** and **Accept**; a video call also offers **Video** to answer with the camera on. **Minimize** shrinks the ring to a small card that keeps ringing. You hear a ringback tone while you wait.

If nobody answers within 30 seconds the call ends. The conversation records the call: the caller sees **No answer** and the other person sees "You missed a voice call from" the caller. A call that took place shows how long it lasted. While a call is live, its message, the conversation list and the header show **Join call**.

### Group calls

In a group conversation, the same buttons ring every member on your instance; they see "{name} started a voice call". Members on other instances are not rung. A call to someone on another instance is always one-to-one.

### When a call does not ring

| What you see | Why |
|---|---|
| "You cannot call this user" or "You have blocked this user" | One of you blocked the other. |
| "This user is in Do Not Disturb mode" | Their status is **Do not disturb**. |
| "User is busy" | They are in another direct message call. A voice channel does not count. |
| "This user has disabled call notifications" | They turned off both **Chat & Messages** notifications and **Voice activity sounds**. |

If someone muted your conversation, or muted you, the call reaches them without a ringtone or pop-up. Their conversation list still shows the live call with **Join call**.

## Play a sound from the soundboard

1. In a voice channel, click **Soundboard** in the call bar.
2. Click a sound to play it for everyone in the channel. The preview button next to a sound plays it for you only.

The soundboard lists this server's sounds, then the **Default sounds** (Ding, Tada, Rimshot, Sad trombone, Boing, Whoosh, Air horn, Crickets, Golf clap and Quack), then sounds that your other servers share. Use **Search sounds** to filter.

| Rule | Detail |
|---|---|
| Who can play | Members with **Use Soundboard** and **Speak** in the channel. Without them the button is hidden. |
| Other servers' sounds | Need **Use External Sounds** in the channel; otherwise those sections show a lock. |
| Where | Voice channels of servers on your own instance. Not in direct message calls or in servers on other instances. |
| Cooldown | 3 seconds between your plays. |
| Overlap | Up to 4 sounds play at once. |
| Deafened | "You can't play sounds while deafened." |

When someone plays a sound, the call bar shows "{user} played {sound}". To stop hearing other people's sounds, turn on **Mute soundboard** under **User settings** → **Voice & video** → **Soundboard**, which also has **Soundboard volume**. Muting does not stop others hearing what you play.

## Send a live reaction

Live reactions are emoji that float over a camera or stream tile for everyone in the call. Nothing is saved.

1. Click **React** in the call bar, or on a tile.
2. Pick one of the six emoji in the row (your most-used ones first), or **More emoji** for the full picker.

**React** appears only on SFU calls while someone has a camera or stream on. You can send 5 reactions every 2 seconds; past that Harmony shows "Slow down a little". To hide reactions others send, turn off **Show live reactions** under **User settings** → **Voice & video**.

## Record a voice message

Voice messages work in channels, direct messages and threads.

1. With the message box empty, click **Record voice message** (the microphone). Allow microphone access if asked.
2. Talk. A timer and waveform show the recording.
3. Click the send arrow to send it, or the bin to throw it away.

A recording stops at 15 minutes; during the last 30 seconds the timer shows how much is left. The microphone button is unavailable while the message box has text in it.

The player shows the length and a waveform. Its speed button cycles 1x, 1.5x and 2x.

## Encrypted voice channels

A voice channel can encrypt its calls end to end, so audio and video are encrypted before they reach the voice server. The server owner or someone with **Manage Channels** turns this on: right-click the channel → **Edit channel** → **General** → **Encryption** → **End-to-end encrypt voice and video**. A server can also require it for every voice channel.

To join such a channel you need encryption set up and unlocked on your device. Without it Harmony refuses the join with **End-to-end encryption required**. See [Privacy and security](/use/privacy-security). Encrypted voice needs the SFU transport.

Direct message calls are not end-to-end encrypted. The shield in the call bar reads "End-to-end encrypted" or "Not end-to-end encrypted" when you hover it.

## Set up your microphone, speakers and camera

Open **User settings** → **Voice & video**, or click **Voice settings** in the call bar during a call. Settings are saved on this device for your account.

| Section | Setting | Default |
|---|---|---|
| **Input mode** | **Voice activity** (transmit when you speak) or **Push to talk** (hold a key) | Voice activity |
| **Audio devices** | **Input device**, **Output device** | System default |
| | **Input volume**, **Output volume**, 0 to 200% | 100% |
| | **Test microphone** shows a live level meter | |
| **Audio quality** | **Echo cancellation** | On |
| | **Noise suppression** ("Filters background noise") | On |
| | **Automatic gain control** | On |
| **Stream settings** | **Watch streams automatically** | Off |
| | **Show live reactions** | On |
| **Soundboard** | **Soundboard volume**, 0 to 100% | 100% |
| | **Mute soundboard** | Off |
| **Video** | **Camera** | |
| | **Video quality**: 480p, 720p or 1080p | 720p |
| | **Frame rate**: 15, 30 or 60 FPS | 30 FPS |

Double-click a volume slider to reset it.

### Use push to talk

1. Under **Input mode**, choose **Push to talk**.
2. Click the **Push to talk shortcut** field and press the key or mouse button you want. The default key is V.
3. Set **Release delay**, 0 to 500 ms (default 200 ms), so the end of a word is not cut off.

Where the key works depends on the app:

| App | Push to talk key |
|---|---|
| Browser | Only while the Harmony tab is focused. |
| Desktop app | System-wide, even while Harmony is in the background. Under Wayland, or without the needed permissions, only while Harmony is focused. |
| Phone | Hold the on-screen **Hold to talk** button in the call bar. Tap it to stay on until the next tap. |

Other voice shortcuts, such as mute and deafen, are listed in [Keyboard shortcuts](/use/keyboard-shortcuts).

## Show call tiles over a game

The desktop app can float small, click-through voice tiles over other windows while you are in a call. Turn on **In-game voice overlay** under **User settings** → **Advanced** → **Desktop app**. Press Ctrl+Shift+O to switch the overlay between click-through and clickable.

On Android, a call keeps running when you switch to another app.
