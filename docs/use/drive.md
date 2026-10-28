---
title: Drive
description: Find, organise, share and keep the files you send in Harmony; storage limits, temporary files and who can open your files.
---
# Drive

This page is for people using Harmony. Drive is your account's file storage on the instance: every file you send in a channel, thread or direct message, and every file you attach to a fediverse post, is in your Drive, and you can upload files to it directly. The page covers finding and organising files, storage and temporary files, attaching files from Drive, who can open your files, and sharing them. Instance operators set the storage limits; see [Configuration reference](/self-host/configuration#drive-storage).

## Open Drive

Select **Drive** in the server rail, below **Fediverse**. On a phone, **Open Drive navigation** shows the sidebar.

The sidebar lists these views:

| View | Shows |
|---|---|
| **My Drive** | Your folders, and the files that are in no folder. Files you send in chats land here. |
| **Recent** | All your files in one list, newest first. |
| **Temporary** | Your temporary files, each with the days it has left. See [Storage and temporary files](#storage-and-temporary-files). |
| **Shared with me** | Files other people on this instance shared with you, with a server you are in or with a channel you can see. A number counts them. |
| **Where you sent them** | Your files grouped by where you sent them: each server (select it to list its channels), **Direct messages** (select it to list your conversations) and **Fediverse posts**. |
| **Trash** | Files you moved to the trash. |

The bottom of the sidebar shows how much of your storage you use, and how much your temporary files take.

## Find a file

- **Search your Drive** matches file names. From **My Drive** it searches all your files; in another view it searches that view.
- The chips **All**, **Images**, **Videos**, **Audio** and **Documents** filter by type.
- **Sort by** offers **Newest first**, **Oldest first**, **Name** and **Largest first**.
- **Grid** and **List** switch the layout. Harmony remembers the layout on this device.

Click a file to select it; Ctrl+click (Cmd+click on macOS) adds to the selection and Shift+click extends it. With one file selected, **Details** opens beside the list: a preview, the name, type, size and date added, **Where it's used**, **Sharing**, and buttons for the file. **Where it's used** lists the messages and posts that send the file; select one to jump to it.

Double-click a file, or press Enter, to open it full size. **Previous file** and **Next file**, or the Left and Right arrow keys, move through the files of the view. Right-click a file for its menu: **Open**, **Download**, **Rename**, **Share**, **Move**, **Keep in Drive** for a temporary file, and **Move to trash**.

## Upload and organise files

- **Upload**, or dropping files on the page, adds files to the folder you are in. Both work in **My Drive** and **Recent**.
- **New folder**, in **My Drive**, creates a folder inside the one you are in. A folder name is 1 to 120 characters without slashes, and differs from the other folders beside it. An account holds up to 1000 folders.
- To rename a file, select its name in **Details**, choose **Rename** from its menu, or press F2. Right-click a folder to rename it.
- To move files or folders, choose **Move** and pick a folder, or drag them onto a folder in the list or in the sidebar. Drag onto **My Drive** to move them out of every folder.
- **Delete folder**, in a folder's menu, moves its files to the trash and deletes its subfolders.

With several files selected, a bar above the list offers **Move**, **Move to trash** and **Clear selection**; in **Trash** it offers **Restore** and **Delete forever**.

### Keyboard

| Key | Action |
|---|---|
| Arrow keys, Home, End | Move between files and folders |
| Enter | Open the file or folder |
| Space | Select or deselect; Shift+Space extends the selection |
| Ctrl+A (Cmd+A on macOS) | Select everything in the view |
| Delete or Backspace | Move the selection to the trash; in **Trash**, delete it forever after a confirmation |
| F2 | Rename |
| Escape | Clear the selection |

## Trash and delete

| Action | Effect |
|---|---|
| **Move to trash** | Moves the file to **Trash**. A temporary file is deleted at once instead. |
| **Restore** | Puts a file from the trash back in its folder, or in **My Drive** when the folder was deleted. |
| **Delete forever** | Deletes the file now. Messages and posts that use it show it as removed. This cannot be undone. |
| **Empty trash** | Deletes every file in the trash forever. |

Files in the trash count toward your storage. Files that have been in the trash for 30 days are deleted.

## Storage and temporary files

Each account has a storage limit. The instance sets it by role:

| Account | Default limit |
|---|---|
| Instance admins | 102400 MB |
| Instance moderators | 25600 MB |
| Everyone else | 1024 MB |

An instance admin can set a different limit for one account.

Files kept in your Drive and files in the trash count toward the limit. Files whose contents are identical count once, after the server has checked their contents. Temporary files do not count. Profile pictures and banners, server icons and banners, group chat icons, emoji and soundboard sounds are stored apart from Drive and do not count either.

Apart from storage, each file has a size limit: your upload limit, 50 MB unless the instance's admins set another one by role or for your account. A larger file is refused before it is sent, in Drive as in the composer, with the limit named; see [Upload limits](/self-host/configuration#upload-limits).

### Temporary files

A temporary file is deleted a number of days after it was uploaded or marked temporary: 30 unless the instance sets another number. An upload is temporary when:

- it would take you past your storage limit, or
- you mark the attachment temporary in the composer ([below](#mark-an-attachment-temporary)).

Temporary files show an hourglass and the days left, such as **Deleted in 12 days**. To keep one, select **Keep in Drive** in its **Details** or its menu. Harmony keeps the files that fit in your storage, those closest to deletion first; when some do not fit it says how many it kept.

While your storage is full, the sidebar reads "Your Drive is full. New uploads are temporary and are deleted after 30 days." You can then upload up to 2048 MB of temporary files in any 24 hours, counting every temporary upload of those 24 hours; the instance can set another amount. Past that, uploads are refused until older uploads leave the 24-hour window or you free space.

## Attach files from Drive

1. In the composer, select **Add an attachment or poll** and choose **From Drive**.
2. In **Choose from Drive**, search or pick a folder (**All files**, **My Drive** or one of your folders), and select the files.
3. Select **Attach**. The files appear above the composer marked **From Drive**; nothing is uploaded again.

Files of fediverse posts cannot be attached this way; files you sent in chats or uploaded to Drive can.

When you attach a file from your device whose contents are already kept in your Drive, Harmony sends the stored file instead of uploading it again. The attachment shows **In your Drive**.

### Mark an attachment temporary

Each new attachment in the composer has a clock button, **Make temporary: deleted after 30 days** (with the instance's number of days). Select it to make the file temporary; the attachment then shows **Temporary, 30 days**. Select it again to keep the file in your Drive. Attachments marked **From Drive** or **In your Drive** have no clock button. While your storage is full the button stays on, with the hint "Your Drive is full: uploads are temporary".

## Who can open your files

A file you sent in a chat can be opened by:

- you;
- the people who can read a channel, thread or conversation where a message that sends the file still exists;
- the people, servers and channels you share it with, and anyone with its link ([Share a file](#share-a-file));
- everyone who can see a voice channel, while you play the file there ([Watch or listen together](/use/voice-video#watch-or-listen-together));
- the people who handle a report about a message that sends it.

A Drive file outlives the messages that send it. Deleting a message keeps the file in your Drive, but the people in that room can no longer open it unless another message there still sends it, or you share it with them.

When the file is in your trash or gone, messages that sent it show why to everyone else:

| Message shows | Why |
|---|---|
| "This file is unavailable" | Its owner moved it to the trash. Restoring it makes it readable again. |
| "This file was deleted" | Its owner deleted it, or it stayed in the trash for 30 days. |
| "This file expired" | It was temporary and its time ran out. |
| "This file was removed by the moderators" | The instance's administrators or moderators removed it. |

Files you send in an end-to-end encrypted channel or conversation reach your Drive without their names, because the name travels only inside the encrypted message. They show as **Unnamed file** until you rename them. The file contents are not encrypted; see [Privacy and security](/use/privacy-security#what-is-and-isn-t-encrypted).

## Share a file

You can share files you sent in chats or uploaded to Drive. Files of fediverse posts are public already and have no **Share**.

1. Select the file and select **Share** in **Details**, or choose **Share** from its menu.
2. In **Share**, set any of:
   - **Link**: the file's address, `https://chat.example.com/d/` followed by a code, and **Copy link**. **Copy link** in the file's menu and in **Details** copies the same address.
   - **General access**: **Restricted** opens the link only for people who can already open the file, after they sign in. **Anyone with the link** opens it for everyone, without an account; it adds **Link expires** (**Never**, **In 1 day**, **In 7 days** or **In 30 days**) and **Show my name on the link page**, off at first.
   - **Reset link**: gives the file a new address. The old one stops working for everyone, also where it was already posted.
   - **People and places**: type in **Add people on this instance** and pick an account, or choose a server under **Choose a server**, then **Whole server** or one of its text channels, and select **Share**. Only servers hosted on your instance are offered.
3. Remove a share with the cross beside it.

A share with a server reaches its members; a share with a channel reaches everyone who can see the channel. The people it reaches find the file under **Shared with me**.

Someone who can open the file sees it in Harmony at its link. While **General access** is **Anyone with the link**, everyone else sees a page that needs no account: the file's name and size, the expiry, a preview of images, video and audio, **Download**, and "Powered by Harmony on" your instance. Your name, with a link to your profile, shows only while **Show my name on the link page** is on. Link previews in other apps show the file's name and type only while the file is public.

The address stays the same until you select **Reset link**. Setting **General access** back to **Restricted**, or the expiry passing, closes the public page; people who can open the file still can. The public page also closes while the file is in the trash or deleted, and while the instance has link sharing turned off, when **Anyone with the link** cannot be chosen. Links of the form `https://chat.example.com/drive/file/` followed by a code, from earlier versions, open the file's current address.
