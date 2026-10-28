---
title: Privacy and security
description: Protect your Harmony account with two-factor authentication, manage signed-in devices, use end-to-end encryption and link new devices, and block or mute people.
---
# Privacy and security

This page is for people using Harmony. It covers two-factor authentication, the devices signed in to your account, end-to-end encryption for channels and direct messages, linking a new device to your encrypted messages, blocking and muting people, and exporting or deleting your account.

The settings live in two tabs of **User settings**: **Security** holds your password, two-factor authentication and signed-in devices; **Privacy & safety** holds encryption, blocked and muted users, and your data export.

## Two-factor authentication

Two-factor authentication (2FA) asks for a 6-digit code from an authenticator app every time you sign in, on every device, including the desktop and Android apps. Any app that supports TOTP codes works, such as Aegis, 2FAS, Google Authenticator or 1Password. Harmony offers no SMS codes or security keys.

### Turn on two-factor authentication

1. Open **User settings** → **Security** → **Two-factor authentication**.
2. Click **Set up two-factor authentication**.
3. **Scan**: scan the QR code with your authenticator app. If you cannot scan it, type the setup key shown under it into the app (time-based, 6 digits). Click **Next**.
4. **Verify**: enter the 6-digit code your app shows and click **Turn on**.
5. **Save codes**: save the ten recovery codes with **Copy codes** or **Download .txt**, tick **I saved my recovery codes**, and click **Done**.

Turning 2FA on signs out your other sessions; sign in there again with a code.

### Recovery codes

Recovery codes let you sign in when you lose your authenticator. Each looks like `ABCDE-12345` and works once. Harmony shows them only once, right after setup or after you generate new ones, and stores only a hash of each.

The **Recovery codes** row shows how many are left, for example "7 of 10 unused". **Generate new codes** asks for a code from your authenticator and replaces the whole set; the old codes stop working.

::: warning A recovery code turns two-factor off
Signing in with a recovery code turns two-factor authentication off for your account and deletes the remaining codes. Harmony shows "Signed in with a recovery code. Two-factor authentication is now off; set it up again." Set it up again with your new authenticator right away.
:::

### Sign in with two-factor authentication

After your password (or after signing in with an external provider), Harmony asks for the 6-digit code from your authenticator app. Click **Use recovery code instead** to enter a recovery code. Resetting a forgotten password also asks for the code before the new password is set.

After five wrong recovery codes, Harmony refuses further attempts for 15 minutes.

### What two-factor protects

With 2FA on, Harmony's server refuses every request from a session that has not entered a code: knowing your password alone gives no access to your messages, files or settings. Such a session appears in your device list as **Two-factor not completed**, and the app signs it out with "Sign in again and enter your authenticator code."

A few actions ask for a fresh code even in a signed-in session:

| Action | Where |
|---|---|
| Generate new recovery codes | **Security** → **Two-factor authentication** |
| Turn off two-factor authentication | **Security** → **Two-factor authentication** (a recovery code also works) |
| Delete your account | **Advanced** → **Danger zone** |
| Move your account to another instance | See [Social](/use/social) |

Changing your password asks for your current password, not a code. It signs out every other device.

### Turn off two-factor authentication

1. Open **User settings** → **Security** → **Two-factor authentication**.
2. Next to **Turn off two-factor authentication**, click **Turn off**.
3. Enter a code from your authenticator, or click **Lost your authenticator? Use a recovery code** and enter one. Click **Turn off**.

## Signed-in devices

**User settings** → **Security** → **Devices** lists every place your account is signed in. Each entry shows the browser or app, the IP address the sign-in came from, when it was last active and when it signed in. **This device** marks the one you are using, and **Push** marks devices that receive push notifications.

- **Sign out** next to a device signs it out. It has to sign in again, and its push notifications stop.
- **Sign out all other devices** signs out everything except the device you are using.

Harmony also sends you a security notice for a new sign-in, for two-factor turned on or off, for a recovery code used or replaced, and for a password change.

## End-to-end encryption

End-to-end encryption keeps message text readable only on the devices of the people in the channel or conversation. The server stores ciphertext it cannot read.

### How it works

Your account holds encryption keys protected by a 12-word recovery phrase that only you have; the phrase is never sent to the server. Each encrypted channel or conversation uses session keys that are shared with every member. A session key changes after 100 messages, after 7 days, and when the member list changes, so someone who left cannot read messages sent after they left. Messages are encrypted with AES-256-GCM and signed by the sending device.

Your keys are backed up to the server encrypted with your recovery phrase, so any device that has the phrase, or is linked from one of your devices, can read your earlier encrypted messages.

### Set up encryption

You need encryption set up before you can read or send in an encrypted channel or conversation.

1. Open **User settings** → **Privacy & safety** → **Encryption settings** and click **Set up encryption**. Encrypted channels also show **Set up now** under the message box.
2. Read the introduction, then let Harmony generate your 12-word recovery key.
3. Save it: **Copy**, **Download**, or show it as a QR code. Note the 6-character **Verification code** too; it confirms later that you typed the right phrase.
4. Type the words at the three positions Harmony asks for.

Store the phrase somewhere safe, such as a password manager. You need it if you lose every signed-in device or clear your browser data.

### Encrypt a channel

Encryption is set per channel, within limits the server owner chooses.

| Server encryption mode | Channels |
|---|---|
| **Disabled** | Channels can't turn on encryption. |
| **Optional** | Channel managers turn encryption on per channel. New channels start unencrypted. |
| **Required** | Every channel is encrypted and can't be turned off. |

Only the server owner changes the mode, in **Server settings** → **Privacy settings** → **Server encryption policy**. The same page sets **Voice & video encryption**: **Per channel**, where each voice channel decides whatever the message mode, or **Required for every voice channel**.

In **Optional** mode, the server owner and anyone with **Manage Channels** can turn encryption on or off for a channel:

1. Right-click the channel and choose **Edit channel**.
2. On **General**, under **Encryption**, turn on **End-to-end encrypt messages**. Voice channels also have **End-to-end encrypt voice and video**, available in every mode unless the server requires it.

An encrypted channel also has **New members can read earlier messages**, set by the same people in the same place:

| Setting | A member who joins later reads |
|---|---|
| **All messages** (default) | everything sent before they joined |
| **Pinned messages only** | the pinned messages from before they joined, nothing else from before |
| **None** | only what is sent after they joined |

Direct messages and group conversations always work like **None**: someone added to a group conversation reads only what is sent after they were added. Changing the setting applies to keys handed over from then on. Keys a member already received stay with them: switching to a stricter setting, unpinning a message or removing someone does not take back what they could already read.

New channels can start encrypted with **End-to-end encryption** in the create channel dialog. Encryption applies to messages sent after it is turned on. Turning it off keeps earlier messages encrypted, sends new ones as plaintext, and posts a notice in the channel naming who turned it off. Encryption settings exist only for servers on your own instance.

For encrypted voice and video, see [Voice, video and calls](/use/voice-video#encrypted-voice-channels).

### Encrypt a direct message conversation

1. Open the conversation and click **More options** in the header.
2. Choose **Enable encryption**. **Disable encryption** turns it off again.

Any participant can switch it, once encryption is set up and unlocked on their device. Encrypted messages are not sent to other instances, so a person on another instance does not receive them; Harmony warns you before you enable it in such a conversation.

Once a conversation is encrypted, Harmony refuses to store an unencrypted message in it. If your keys are locked or not set up, Harmony asks before sending one unencrypted.

Calls in an encrypted conversation are end-to-end encrypted as well, except with people on another instance. See [Direct message calls](/use/voice-video#direct-message-calls).

### What is and isn't encrypted

| Encrypted | Not encrypted |
|---|---|
| Message text, links and embeds | Who sent a message and when |
| Attachment links, file names and file types | The attached files themselves |
| Edits | Mentions: the server reads them to send mention notifications |
| Messages in threads of an encrypted channel | Reactions |
| | Channel, server and profile names and pictures, member lists |

Notifications and push for encrypted messages read "Encrypted message" instead of a preview.

Some features do not work in encrypted channels and conversations: polls, webhooks, server-side search and moderation of message content. Bots and bridges cannot read encrypted messages or post in encrypted channels; the channel's settings warn when the server has some. Encrypted messages are never sent to other instances.

### What you see in an encrypted channel

- A lock next to the channel name; hovering it reads "End-to-end encrypted" (or "Voice and video are end-to-end encrypted" for encrypted calls).
- A status line under the message box: "End-to-end encrypted" when you can read and send. "This channel is end-to-end encrypted. Unlock encryption to read and send messages." with **Unlock** when your device has not unlocked your keys yet. "This channel is end-to-end encrypted. Set up encryption to read and send messages." with **Set up now** when you have no keys.
- Messages your device cannot read yet show as scrambled characters; click one to retry ("Click to decrypt").
- A message encrypted with a key your account no longer has stays scrambled, with a lock, and cannot be recovered.
- **Unverified author** next to a message that decrypted but whose sender's device signature could not be checked.

### Unlock encryption on a new device

When you sign in on a new device, your encrypted messages stay locked until you link the device or enter your recovery phrase. Click **Unlock** in an encrypted channel, or **Unlock message history** in **Privacy & safety** → **Encryption settings**. The **Restore encryption** window has two tabs.

**Another device** (recommended) links the new device from one that is already unlocked:

1. On the new device, choose **Another device**. It shows a QR code, valid for 10 minutes.
2. Your other devices show **New login** with the device's name. On one that is unlocked, choose **Yes, scan its code** and scan the code. You can also start from **Privacy & safety** → **Encryption settings** → **Link a device** on the unlocked device.
3. Check the details and click **Link this device**.
4. The new device shows "This device is linked. Your encrypted messages are unlocking."

If a camera is not available, either side can show the code instead, or you can paste the code or scan it from an image. A code shown by the signed-in device is valid for 5 minutes. If the prompt was not you, choose **Not me**.

The linking device needs your keys in a form it can hand over. It has them right after you set up encryption, entered the phrase or linked it, or when it keeps a copy for linking; otherwise it asks for your recovery phrase first. **Link devices from here later without the recovery phrase**, ticked by default when you link, keeps that copy. Anyone able to run code in Harmony on that device could copy it; remove it under **Keys kept for linking** in **Encryption settings**.

**Recovery phrase** unlocks the device by typing your 12 words. Either way the device can read your earlier encrypted messages.

### Read messages sent before you joined

When you cannot decrypt a message, your app asks for its key. The sender's app, or the app of any member who can already read the message, hands it over automatically while it is open, but only while you and they are both members of that channel or conversation and only as far as the channel's **New members can read earlier messages** setting allows. The sender does not need to be online, or still a member. Until one of them opens Harmony, the message stays locked.

Under **Pinned messages only**, a pinned message from before you joined arrives with a key that opens that message alone; the messages around it stay locked. Messages from before you joined a group conversation stay locked.

Your app tries a key handed over by anyone other than the sender on the message itself before keeping it. A key that does not open the message is discarded and your app asks again.

These rules are kept by the apps and the server together, and they protect against other members' apps, not against the server or the people in the room. The server decides who is a member, when they joined, what is pinned and which setting a channel has; a server run by someone who wants to read your history could change those answers. Anyone who can read a message can also copy it out of Harmony, and an app modified by its owner can ignore the setting for the messages it holds.

### If you lose your recovery phrase

A device that keeps a copy of your keys for linking (**Keys kept for linking** in its **Encryption settings**) can still link new devices without the phrase. Harmony cannot show the phrase again.

With no unlocked device and no phrase, the only option is **Reset** under **Danger zone** in **Encryption settings**, which creates new keys. You will not be able to read any previously encrypted messages.

**Export backup file** in **Encryption settings** saves an encrypted copy of your keys to a file; importing it later also needs your recovery phrase.

### Your encryption devices

**Privacy & safety** → **Encryption settings** → **Your devices** lists the devices that hold your encryption keys, each with a label such as **Verified**, **History unlocked**, **New messages only** or **Limited**.

- **Rename** gives a device a name you recognise.
- **Sign out** removes the device from encryption: messages it signs afterwards are not verified. It does not end the device's sign-in; use **Security** → **Devices** for that.
- Devices waiting to be linked show **Scan code** and **Deny**.

## Block or mute someone

Right-click a member and choose **Block** or **Mute user**. Profiles and the menus of posts offer **Block** too.

| | Block | Mute user |
|---|---|---|
| Notifications from them | Stopped | Stopped |
| Their calls to you | Refused | Arrive without a ringtone or pop-up |
| Their messages in server channels | Collapsed into "1 blocked message" with **Show message** | Shown |
| Direct messages | They cannot send messages in any conversation you are in | Shown |
| Reactions to your messages | They cannot add them | Allowed |
| Posts | Hidden from each other; you stop following them | Shown |

A block is also sent to other instances as an ActivityPub block. A block does not stop the other person reading what you post in servers you share.

To undo either, open **User settings** → **Privacy & safety** and click **Unblock** under **Blocked users** or **Unmute** under **Muted users**.

## Links to other sites

A masked link shows its own text in place of its address: `[text](https://…)` typed in a message or post, or a link from another instance whose text is not its address. Opening one shows **Leaving Harmony** first, with the whole address and its site in bold, **Copy link**, **Cancel** and **Open link**. A link that shows its address opens at once. Links to your own instance (invites, posts, profiles, Drive links) never ask.

- Tick **Trust _site_ from now on** before **Open link**, and links to that site open without asking on every device you sign in to. Its subdomains and other ports still ask.
- **User settings** → **Privacy & safety** → **Outside links** lists your trusted sites; **Remove** takes one off.
- **Ask before opening any outside link** shows the check for every link to another site. Off by default.
- In a browser, a middle click or Ctrl/⌘-click on a masked link shows the check too, and **Open link** opens a new tab. The browser's own right-click **Open link in new tab** does not ask.

## Photo and video details

Photos and videos usually carry details the camera wrote into the file: where they were taken (GPS), the camera or phone model, its serial number, and editing software. Harmony removes these on your device, before the file is uploaded, for every photo and video you attach to a message, a direct message, a thread or a post, and for files you upload to Drive. Encrypted conversations are no exception: the attachment itself is not encrypted, so its details are removed the same way.

- An attachment that carries details shows **Keep photo details (location, camera)**, off by default. Tick it to upload the file as it is.
- A file that carries a location also shows **Location removed**, or **Includes location** while **Keep photo details** is ticked.
- In Drive, uploading photos or videos that carry details first lists them, each with its own **Keep photo details**, before **Upload**.
- A Drive file kept with its details shows the same box when you attach it to a message or post it. Unless you tick it there too, Harmony sends a copy without the details; the file in your Drive stays as it is. Files uploaded to Drive before Harmony 1.9.2 are checked when you attach them.
- Bots and bridges cannot keep details either: files the instance copies for them are stored without.
- **User settings** → **Privacy & safety** → **Keep photo details by default** ticks the box for every new attachment. It follows your account to every device. Off by default.
- Profile pictures, banners, server and group icons, emoji and stickers never keep their details.
- Photos stay upright: their orientation is kept.

Removed: Exif (GPS, camera, dates), XMP and IPTC from JPEG, PNG, WebP, GIF, HEIC and AVIF; location, camera and other metadata boxes from MP4 and MOV. Nothing is re-encoded. Other formats are uploaded as they are.

## Other privacy settings

**User settings** → **Privacy & safety** also has:

| Setting | What it does |
|---|---|
| **Require follow approval** | New followers send a request you accept or reject. See [Social](/use/social). |
| **Strip tracking parameters from URLs** | Removes tracking parameters from YouTube, X/Twitter, TikTok, Instagram and Facebook links in your messages. On by default. |
| **Download your data** | **Request my data** builds a ZIP of your profile and settings, the messages you sent, your posts, follows, blocks, uploaded files and signed-in devices. Other people's messages are not included. One request every ten minutes, five a day. Encrypted messages are exported as ciphertext. |

## Delete your account

1. Open **User settings** → **Advanced** → **Danger zone** and click **Delete account**.
2. Enter your password, and an **Authenticator code** if two-factor is on. An account without a password needs a sign-in within the last ten minutes.
3. Type `DELETE` and confirm.

Deletion cannot be undone. Messages and posts you wrote stay visible as "Deleted User"; delete any you want gone first. Your profile, login, devices, encryption keys, follows, blocks and bots are removed, and other instances that know your account are told it is gone. If you own a server with other members, transfer it or delete it first.
