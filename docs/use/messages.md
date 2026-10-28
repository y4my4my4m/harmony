---
title: Messages and threads
description: Send, edit and delete messages in Harmony; attach files, play music links, reply, start threads, post polls, react with emoji, hide spoilers, describe images, mention people and format text with markdown.
---
# Messages and threads

This page is for people chatting in Harmony's text channels and direct messages. It covers writing and managing messages, attachments and music links, replies, threads, polls, reactions, spoilers, image descriptions, mentions, pins and search, and ends with the formatting reference. Voice messages are covered in [Voice and video](/use/voice-video); end-to-end encrypted channels in [Privacy and security](/use/privacy-security).

## Send a message

Type in the composer at the bottom of the channel and send:

| Device | Send | New line |
|---|---|---|
| Desktop | Enter | Shift+Enter |
| Phone or tablet | The send button | Enter |

- The instance sets the maximum message length, 2000 characters by default. A counter appears when you are close to the limit and turns red past it. A message over the limit is not sent; your draft stays in the composer.
- When a channel has slowmode, a clock beside the composer shows the seconds left before you can send again.
- If your roles do not allow sending in a channel, the composer is replaced by a notice.
- Ctrl+B and Ctrl+I (Cmd on macOS) wrap the selection in bold or italic markers. Ctrl+Z undoes and Ctrl+Y or Ctrl+Shift+Z redoes.
- Typing `/` at the start of an empty composer lists commands: `/gif`, `/sticker` and `/poll`, plus `/clip`, `/meme` and `/aiemoji` when the instance enables them, and `/kick` and `/ban` for members with those permissions.

## Attach files, GIFs and stickers

- Select **Add an attachment or poll** (the plus button) and choose **Upload file**, drag files onto the composer, or paste them. The file picker offers images, video, audio, PDF, `.doc`, `.docx`, `.txt`, `.zip` and `.rar` files. Each file may be up to your upload limit, which the instance's admins set (50 MB unless they change it); a larger file is refused before it is sent, with the limit named.
- **From Drive**, in the same menu, attaches files already in your [Drive](/use/drive) without uploading them again.
- Attached files appear above the composer. Each one has buttons to describe it ([Describe an image](#describe-an-image)), mark it as a spoiler ([Spoilers](#spoilers)) and remove it. The placeholder changes to **Add a comment...** for text sent with the files.
- Location, camera and other details are removed from photos and videos before they are uploaded. **Keep photo details (location, camera)** on an attachment sends it as it is. See [Photo and video details](/use/privacy-security#photo-and-video-details).
- Every file you send is kept in your Drive and counts toward your storage. The clock button on an attachment makes it temporary instead: it is deleted after a number of days the instance sets, 30 by default. When your Drive is full, every upload is temporary. See [Storage and temporary files](/use/drive#storage-and-temporary-files).
- **GIF picker** opens tabs for **GIFs**, **Stickers** and **Emoji**, plus **Clips**, **Memes** and **AI Emoji** when the instance enables them. GIFs and stickers come from KLIPY. Hover a GIF or sticker in a message and select the star to add it to your favourites. The **Stickers** tab also lists the server's, the instance's and your own custom stickers above KLIPY's; see [Stickers](/use/stickers). **Emoji picker**, beside it, inserts emoji into your message.

## Music links

A link to a music service plays in that service's own player inside the message, in place of the preview card:

| Service | Links that play |
|---|---|
| Spotify | Tracks, albums, playlists, artists, podcast episodes and shows |
| Apple Music | Songs, albums, playlists, music videos and stations |
| SoundCloud | Tracks and playlists (sets) |
| Deezer | Tracks, albums, playlists, artists, podcast episodes and shows |
| TIDAL | Tracks, albums, playlists and videos |
| Bandcamp | Pages where the instance's link preview finds a player |

Short share links play once the instance's link preview resolves them to the full address. Each player is the service's own page, loaded from its site when the message comes into view. To play music for everyone in a voice call, see [Watch or listen together](/use/voice-video#watch-or-listen-together).

## Posts from X, Instagram and Bluesky

A link to a post on X, Instagram or Bluesky shows the post: its author, text and date, every photo, its videos and GIFs playing in the message, and the post it quotes. Photos and videos open in the media viewer.

An X video plays in the message in Safari and the Apple apps. In Chrome, Firefox, the Windows, Linux and Android apps, X serves its video files only to its own pages, so the video shows its still, a play button and its length; the play button loads X's own embedded post in its place, which plays the video from X. Nothing is loaded from X before that click. An instance can stream X video itself instead (`EMBED_RELAY_ENABLED`, see [Configuration](/self-host/configuration)).

**User settings** → **Appearance** → **Links you send** rewrites such links in what you send to a mirror site, which shows the post's photos and videos in previews on Discord and other apps. Harmony still shows the whole post; people reading the link outside Harmony see the mirror's address. Each site has its own switch and a choice of mirrors:

| Site | Default | Mirrors |
|---|---|---|
| X | On, fixupx.com | fixupx.com, vxtwitter.com, fxtwitter.com |
| Instagram | Off | kkinstagram.com, eeinstagram.com |
| Bluesky | Off | fxbsky.app, bskye.app |

Only links to a post are rewritten, in messages, direct messages, threads and posts, also when you edit them. Links inside code, links to profiles and links already on a mirror are left alone. A rewritten link stays on that mirror for good, including after the mirror closes.

## Reply to a message

1. Hover the message and select **Reply**, or right-click it and choose **Reply**. On a touch screen, press and hold the message to show its actions.
2. The composer shows **Replying to** and the author's name. Select the close button or press Escape to cancel.
3. Send your message. It shows the original above it; select that line to jump to the original.

## Edit a message

Only the author edits a message.

1. Hover your message and select **Edit message**, or right-click it and choose **Edit message**. With the composer empty, the Up arrow edits your last message in the channel.
2. Change the text. Attachments are listed under the text; select the cross on one to remove it.
3. Press Enter to save or Escape to cancel.

An edited message shows **(edited)** after its text. Polls cannot be edited.

## Delete a message

1. Hover the message and select **Delete message**, or right-click it and choose **Delete message**.
2. Confirm.

Hold Shift while selecting **Delete message** to skip the confirmation. A message that started a thread always asks, because deleting it deletes the thread and all its replies (**Delete message and thread**).

You can delete your own messages. In server channels, members with the **Manage Messages** permission and the instance's administrators and moderators can delete anyone's. On a server hosted on another instance you can delete only your own.

## Threads

A thread is a side conversation inside a text channel, with its own messages, members and notifications. Starting one needs the **Create Public Threads** or **Create Private Threads** permission in the channel.

### Start a thread from a message

1. Hover the message and select **Create thread**, or right-click it and choose **Create thread**.
2. The thread panel opens, named after the first 50 characters of the message, with the hint **Send a message to start this thread**.
3. Send the first reply. The thread is created then, and the message shows the reply count, the time of the last reply and **View Thread**.

### Start a standalone thread

A standalone thread starts from a name instead of an existing message.

1. In the channel header, select **View all threads**.
2. Select **New thread**.
3. Enter a **Thread name** of 1 to 100 characters and select **Create**.

The channel shows a "started a thread" notice, and the new thread opens.

### Open a thread

- Active threads are listed under their channel in the channel sidebar. Select one to open it in the full chat area. Right-click it and choose **Open in split view** to open it in a panel beside the channel.
- **View all threads** in the channel header lists every thread in the channel, including closed ones. Threads you joined come first; the rest are under **Older threads**. **Search for thread name** filters the list.
- A thread drops off the sidebar list after 24 hours without a new message, or when it is closed. It stays in **View all threads**.

### Join, mute or leave a thread

Sending a message in a thread makes you a member. Members are notified of new replies, within the notification level of the channel ([Notifications and apps](/use/notifications-apps)).

The thread panel's **Thread options** menu, and the right-click menu of a thread in the sidebar, hold:

| Item | What it does |
|---|---|
| **Join thread**, **Leave thread** | Add or remove yourself as a member. |
| **Mute thread**, **Unmute thread** | Stop or resume reply notifications for this thread. |
| **Copy link**, **Copy thread ID** | Copy a link to the thread or its ID. |

### Manage a thread

Members with the **Manage Channels** permission also see:

| Item | What it does |
|---|---|
| **Edit thread** | Rename the thread (up to 100 characters), lock it or archive it. |
| **Close thread**, **Reopen thread** | Closing archives the thread: it leaves the sidebar but can still be read. |
| **Lock thread**, **Unlock thread** | Locking prevents new messages. |
| **Delete thread** | Deletes the thread and its replies. |

## Polls

Polls work in server channels and direct messages, except end-to-end encrypted ones.

### Create a poll

1. Select **Add an attachment or poll** and choose **Create poll**, or type `/poll`.
2. In **Create a poll**, fill in:

   | Field | Rules |
   |---|---|
   | **Question** | 1 to 300 characters. |
   | **Answers** | 2 to 10 answers of up to 100 characters each, all different. **Add answer** adds a row. |
   | **Duration** | 1 hour, 4 hours, 8 hours, 24 hours (the default), 3 days or 1 week. |
   | **Allow multiple answers** | Off: each person picks one answer. On: each person picks any number. |

3. Select **Post poll**.

Slowmode, timeouts and AutoMod apply to polls as to any message. A posted poll cannot be edited.

### Vote

- Select an answer to vote. In a single-answer poll, selecting another answer moves your vote. In a multiple-answer poll, each selection adds or removes that answer.
- **Remove vote** withdraws your vote.
- Results stay hidden until you vote or the poll ends. **Show results** shows them before you vote, and **Hide results** hides them again.

Each answer shows the percentage of voters who chose it, and the footer shows the number of votes and the time left. In a multiple-answer poll the percentages can add up to more than 100. Nobody, the author included, sees who voted for which answer: Harmony shows only the counts and your own choice.

The author can select **End poll** to close it early. A closed poll shows **Poll closed** and takes no more votes.

Bots, bridges and other instances receive a poll as plain text: the question followed by its numbered answers.

## Reactions

- Hover a message and select **Add reaction**, or right-click it. The right-click menu starts with a row of your frequently used emoji and **More reactions** for the full picker.
- Select a reaction under a message to add yours, and again to remove it. The plus button after the reactions adds another.
- Hover a reaction to see who reacted. Right-click it, press and hold it, or focus it and press the context menu key or Shift+F10 for the full list. **View reactions** in the message's right-click menu shows all of them.
- A message holds at most 20 different emoji. Once it has 20, you can still add yourself to one of them.

The emoji picker has a **Search emojis...** field, then **Frequently used**, then custom emoji grouped by server with the current server first, then the standard categories from **People** to **Flags**. Emoji you uploaded yourself are grouped under **My Emoji**; manage them in **User settings** → **My emojis**. Upload them there (PNG, GIF, WebP, APNG or JPEG, up to 1 MB) and use them in any server or conversation. The instance sets how many personal emoji each person keeps, AI-generated ones included; the count beside the list shows yours against that limit.

### Quick react

**User settings** → **Appearance** → **Quick react** → **Double-tap to quick react** reacts with one chosen emoji when you double-click empty space in a message on desktop, or double-tap a message on a touch screen. **Quick react emoji** picks the emoji.

## Spoilers

Spoilers hide text or media until the reader chooses to see them.

- **Text**: wrap it in two vertical bars on each side: `||the butler did it||`. It shows as a covered bar; select it, or focus it and press Enter, to reveal it. Notifications and reply previews show spoiler text as a row of blocks.
- **Images and videos**: in the composer, select **Mark as spoiler** on the attachment. The media is covered by a **Spoiler** label until someone selects it. **Remove spoiler** undoes the mark before sending. A file whose name starts with `SPOILER_` is treated as a spoiler.

## Describe an image

A description (alt text) tells people who cannot see an image what it shows. Screen readers read it in place of the image, in the message and in the full-size viewer.

1. Attach the image.
2. Select the pencil button on it (**Add description**).
3. Write the description in the field labelled **Describe this for people who can't see it**, up to 1500 characters.
4. Select **Save**, or press Ctrl+Enter.

The attachment shows an **ALT** badge once it has a description. An image sent without one is announced as "Image, no description"; Harmony never uses the file name instead.

## Mentions

Type `@` to open suggestions, then pick a person or a role. Roles are listed first.

| Mention | How to write it | Who is notified |
|---|---|---|
| A person on your instance | `@username`, or pick from the list | That person. |
| A person on another instance | `@username@instance.example`, or pick from the list | That person. A typed handle works when your instance already knows the account. |
| A role | Pick it from the list | Members holding the role. |
| `@everyone` | Pick it from the list | Every member who can see the channel. |
| `@here` | Pick it from the list | Members who can see the channel and are online, **Idle** or **Do not disturb**. Members shown as **Invisible** or offline are left out. |
| A channel | `#channel-name`, or pick after typing `#` | Nobody. It becomes a link to the channel. Server channels only. |

`@everyone`, `@here`, and roles not marked as mentionable require the **Mention @everyone** permission in the channel. Without it they are left out of the suggestions; written anyway, they show in the message but notify nobody. Any member can mention a role marked as mentionable.

- In server channels, a message that mentions you, a role you hold, `@everyone` or `@here` is highlighted.
- A message notifies each person once, even when it names them in several ways.
- Text inside code or inside a link is never a mention.
- Each server's **Notification settings** can **Suppress @everyone and @here** and **Suppress all role @mentions** for you ([Notifications and apps](/use/notifications-apps)).

## Pin messages

In a server channel, right-click a message and choose **Pin message**, or **Unpin message** to remove it. This needs the **Pin Messages** or **Manage Messages** permission. The pin button in the channel header opens **Pinned messages** and shows how many there are.

## Search messages

**Search messages** in the channel header searches the whole server; in a direct message it searches that conversation. Type words, and narrow the search with filters:

| Filter | Finds messages |
|---|---|
| `from:@user` | Sent by a person. |
| `mentions:@user` | That mention a person. |
| `has:link`, `has:embed`, `has:file`, `has:image`, `has:video`, `has:sound` | With that kind of content. |
| `in:#channel` | In a channel. |
| `before:DATE`, `after:DATE`, `during:DATE` | Before or after a day, or during a day, month or year. |
| `pinned:true`, `pinned:false` | That are pinned, or not. |

`DATE` is `YYYY-MM-DD`, `YYYY-MM`, `YYYY`, `today` or `yesterday`, in your local time. Put a value with spaces in double quotes: `from:"Display name"`. Results sort by **Newest**, **Oldest** or **Most relevant**. Words also match the names of files attached to unencrypted messages. Encrypted messages are searched on your device only, among the messages already loaded.

## Message actions

Hovering a message, or focusing it with the keyboard, shows a toolbar with **Add reaction**, **Reply**, **Create thread**, **Edit message** and **Delete message** where they apply, and **More actions**. The toolbar is one Tab stop; Left and Right move between its buttons. **More actions**, a right-click, or Enter on a focused message opens the full menu:

| Item | Shown |
|---|---|
| Quick reactions, **Add reaction**, **View reactions** | Always; **View reactions** when the message has reactions. |
| **Reply**, **Create thread** | Not on system messages. |
| **Edit message** | Your own messages. |
| Copy text | When the message has text. |
| Copy image, Save image, Save video, Save audio | When the message has that media. |
| Copy message link | Always. Pasted in a channel of the same server, the link shows as the channel name and jumps to the message. |
| **Remove embeds**, **Show embeds** | On messages with link previews: for the author, and for members with **Manage Messages**. |
| **Pin message**, **Unpin message** | With the pin permission. |
| **Delete message** | See [Delete a message](#delete-a-message). |
| Report message | Messages by other people. Opens the report form; [Moderation](/run/moderation) covers what moderators do with reports. |

## Formatting reference

Messages use Discord-style markdown. The composer keeps the markers as you type; the sent message shows the result.

| You type | Result |
|---|---|
| `**bold**` | **bold** |
| `*italic*` or `_italic_` | *italic* |
| `__underline__` or `++underline++` | underlined text |
| `~~strikethrough~~` | ~~strikethrough~~ |
| `` `inline code` `` | `inline code` |
| `\|\|spoiler\|\|` | Covered text, revealed on selection. |
| `> quote` | One quoted line. Consecutive `> ` lines form one quote. |
| `>>> quote` | Quotes this line and every line after it. |
| `>text` | Greentext: the line in green, when the **Greentext** setting is on. |
| `:shortcode:` | An emoji by name. Type `:` and part of a name for suggestions. |
| `https://example.com` | A link, with a preview card when the site provides one. |
| `<https://example.com>` | A link without a preview. |
| `[text](https://example.com)` | The text, linked to the address; text naming another site shows the address instead. Opening it asks first: see [Links to other sites](/use/privacy-security#links-to-other-sites). |

Rules worth knowing:

- `>` needs a space after it to quote; `>` followed directly by text is greentext, or plain text with **Greentext** off. `>>>` also needs a space and some text after it.
- Single `_underscores_` italicise only at word boundaries, so `snake_case_names` stay as typed. A single `*` next to a letter or digit, as in `2*3*4`, stays as typed.
- Headings (`#`), lists and tables are not formatted; they show as typed.

### Code blocks

Put three backticks on a line, optionally followed by a language name, then the code, then three backticks on their own line:

````text
```python
print("hello")
```
````

The block shows the language name and a **Copy** button on hover. Long lines wrap. These language names get syntax highlighting:

| Language | Names |
|---|---|
| JavaScript | `javascript`, `js` |
| TypeScript | `typescript`, `ts` |
| Python | `python`, `py` |
| Shell | `bash`, `shell`, `sh` |
| HTML, CSS, JSON | `html`, `css`, `json` |
| SQL | `sql` |
| Vue, XML | `vue`, `xml` |

Any other name is shown as the label, and the code is shown without highlighting. Text inside a code block is never formatted, linked or turned into mentions.

### Emoticons

Two switches in **User settings** → **Appearance** → **Message display** handle text emoticons such as `:)`, `:D` and `<3`. Both are on unless you turn them off:

| Setting | Effect |
|---|---|
| **Convert emoticons I send** | Replaces emoticons with emoji when you send or edit a message. Code, links and email addresses are left alone. |
| **Show emoticons others send as emoji** | Displays emoticons in received messages as emoji. The original text is kept. |

The **Greentext** switch, also on unless you turn it off, is in the same section.
