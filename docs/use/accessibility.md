---
title: Accessibility
description: Use Harmony with a keyboard or a screen reader, and set high contrast, reduced motion, zoom and text size.
---
# Accessibility

This page is for people who use Harmony with a keyboard, a screen reader, magnification or reduced motion. It lists the accessibility settings, where they live, and how keyboard and screen reader use works across the app. The full list of keys is in [Keyboard shortcuts](/use/keyboard-shortcuts).

## Accessibility settings

| Setting | Where | What it does |
|---|---|---|
| **Zoom level** | **User settings** → **Appearance**, **Typography** section | Scales the whole app from 50% to 200%, in steps of 10%. |
| **Font size** | **User settings** → **Appearance**, **Typography** section | Sets the size of message text, from 12 to 20 px (15 px by default). |
| **High contrast** | **User settings** → **Appearance**, **High contrast** section | Raises the contrast of text, borders, fields and buttons. Off by default. |
| **Reduce motion** | **User settings** → **Appearance**, **High contrast** section | Turns off animations and transitions. |
| **Screen reader support** | **User settings** → **Appearance**, **High contrast** section | Speaks extra activity and draws a thicker keyboard focus outline. |
| **Announce new messages** | **User settings** → **Appearance**, **High contrast** section | Reads out messages that arrive in the open channel, conversation or thread. On by default. |
| Voice shortcuts | **User settings** → **Keybindings** | Turns each voice shortcut on or off and changes its keys. |

Changes on **Appearance** show at once as a preview. **Save changes** keeps them and **Reset** returns to what was saved. Saved appearance settings belong to your account and follow you to other devices. **Announce new messages** and the keybindings are kept per device and apply at once, without saving.

## Use Harmony with a keyboard

### Move around the app

- **Skip to content** is the first Tab stop on every page. It is hidden until it has focus; Enter moves focus to the main content.
- F6 and Shift+F6 move focus to the next or previous region: servers, channels, messages, members, the voice connection and your account panel. Landing on a region focuses its current item, such as the open server or channel. In a browser that keeps F6 for its address bar, use Ctrl+F6 and Ctrl+Shift+F6. F6 does nothing while a dialog is open.
- **User settings** → **Keybindings** lists these navigation keys at the top.

### Lists

Long lists take one Tab stop, and the arrow keys move inside them:

| List | Keys |
|---|---|
| Channel list | Up and Down, Home and End. Typing letters jumps to the next item whose name starts with them. |
| Message list | Up and Down move one message, Page Up and Page Down a screenful, Home and End to the first and last loaded message, from the message or from any control in it. Up from the first message loads older ones. Tab moves through the controls of the focused message; Escape on one of them returns to the message. |
| Member list | Up and Down, Home and End. |
| Post feeds | Page Down and Page Up, or `j` and `k` outside text fields, move between posts. Ctrl+Home and Ctrl+End leave the feed. |
| Timeline and other tabs | Left and Right, Home and End. Enter or Space opens the focused tab. |
| Emoji picker | Arrow keys move through the grid. From the search field, Down moves to the first emoji and Enter picks it. |

Each server and folder in the server rail is its own Tab stop.

Text fields, sliders, menus and media controls inside a list item keep their own arrow keys.

### Toolbars

A group of related buttons is a toolbar with one Tab stop: Left and Right move between its buttons and wrap at the ends, and Home and End go to the first and last. Toolbars are:

- a message's actions (**Add reaction**, **Reply**, **Create thread**, **Edit message**, **Delete message**, **More actions**) and its reactions; in a message, Up, Down, Home and End still move between messages,
- a post's actions (**Reply**, **Boost**, **Favorite**, **Add reaction**, **Bookmark**, **More options**) and its reactions,
- the voice panel's controls and its call buttons, and the controls of the call view,
- the bar for selected files in Drive.

A toolbar that stays on screen keeps the button used last as its Tab stop.

### Menus and dialogs

- Enter, the context menu key or Shift+F10 on a message opens its **Message options** menu. The context menu key and Shift+F10 open the menu of a server, channel, member or voice participant too, and on a reaction they list who reacted.
- In a menu, Up and Down move (and wrap), Home and End go to the ends, and typing letters jumps to an item. Right opens a submenu; Left or Escape closes it.
- A dialog takes focus when it opens. Tab and Shift+Tab stay inside it, and the page behind it does not respond.
- Escape closes the topmost dialog, menu or drawer, and focus returns to where it was before it opened.

### Reorder without dragging

Alt+Up and Alt+Down move the focused server or folder in the server rail. In the channel list they move the focused channel or category, when you own the server or have the **Manage Channels** permission.

### Focus outline

Controls show a focus outline when they are reached with the keyboard, not when they are clicked. **Screen reader support** makes the outline 3 px thick.

## Use Harmony with a screen reader

### Page structure

- Regions are labelled: **Servers**, **Channels** (or **Direct messages**), **Members**, **Your account**, and on the social side **Social navigation** and **Trends and suggestions**.
- The browser tab title names the current view and the instance, with the unread count in front, such as "(3) #general – Book Club – Harmony" for a channel.
- After you move to another view, its title is announced. If the move left focus nowhere, focus goes to the new view's first heading.
- Buttons that show only an icon have a name, and toggle buttons report whether they are pressed.
- Post times are read as the full date and time, while the screen shows a short form such as "5m". A message's time is read as the time of day; the day headings and each message's name carry the date.
- A field's placeholder never repeats its label; where a field shows one, it says what to type, such as "Name or username".
- On phones, **Navigation menu** and **Member list** open the side drawers.

### Messages

The message list is labelled with where you are, such as "Messages in #general". Each message is one item, named by its author, its text, the message it replies to, then its time, its state and its date: "Sam, Yes, it went up this morning, Replying to Alex Is the new build out yet?, 6:10 PM, edited, October 23, 2026". The date comes last, so moving on cuts it off.

With **Announce new messages** on, messages that arrive in the open channel, conversation or thread are read out politely; your own are not. A single message is read as the author and its text, cut at 160 characters. Several messages arriving together are summarized, for example "3 new messages from Alice, Bob". Spoilers and encrypted message text are never read out; attachments are named by their kind and their description.

### What is always announced, and what needs Screen reader support

| Always announced | Only with **Screen reader support** on |
|---|---|
| Someone joining or leaving your voice channel | Who starts speaking in a voice call |
| Someone starting or stopping a stream | Who is typing |
| Connecting, connected, reconnected and disconnected | Upload progress of an attachment |
| Your own mute, deafen and camera changes | A rise in your unread notification count |
| The number of results in the emoji picker | |

### Voice shortcuts and browse mode

Screen readers in browse mode take single letters for navigation. **Toggle mute** and **Toggle deafen** therefore default to Ctrl+Shift+M and Ctrl+Shift+D. When they are set to single keys, **User settings** → **Keybindings** shows a note and a button that switches them to the Ctrl+Shift pair. In a text field, only push to talk and shortcuts that include Ctrl, Alt or Meta fire.

## High contrast

**High contrast** is off by default and the regular colors do not change while it is off. Turned on, it:

- makes text white or near white and darkens panel backgrounds,
- thickens the borders of fields and buttons and makes button labels and author names bold,
- darkens colored fills behind white text, such as primary and danger buttons, until the text reaches a contrast ratio of at least 4.5:1,
- hides the decorative backgrounds of skins.

## Reduce motion

**Reduce motion** stops animations and transitions across the app, including spinners, dialog animations and the animated backgrounds of skins. Harmony also follows the operating system's reduced motion preference when the setting is off.

## Zoom and text size

**Zoom level** scales everything: text, icons, panels and menus. In the desktop app it zooms the window content the way browser zoom does. In a browser, the installed web app and the Android app it scales the page itself. At any level, settings, chat and menus stay inside the window. A screen reader announces the new level as you change it.

**Font size** changes only message text.

## Image descriptions

Images and videos can carry a description (alt text) that screen readers read in place of the picture.

- For chat attachments, see [Messages and threads](/use/messages).
- For posts, select **ALT** on an attachment in the post composer and fill in **Describe this for people who can't see it**. A post image without one is read as "Image without description". See [Posts, follows and moving your account](/use/social#describe-images-and-video).
