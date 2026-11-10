---
title: Posts, follows and moving your account
description: Write posts on Harmony's fediverse side, boost, favorite, reply and quote, follow people on Harmony and other servers, handle follow requests, edit your profile and move your account.
---
# Posts, follows and moving your account

This page is for people using Harmony's social side: posts and timelines that federate with Mastodon and other ActivityPub software. It covers writing and answering posts, quote posts, following people here and on other servers, follow requests, your profile, and moving your account between servers.

Open the social side with the **Fediverse** button in the server rail. Its sidebar holds **Explore**, **Feed**, **Profile**, **Mentions**, **Bookmarks** and **Settings**, and under **Your activity** the counts of accounts you follow, your followers and your posts.

## Timelines

**Feed** has one tab per timeline in its header. **Federated** and **Instances** appear only when the instance has federation turned on.

| Tab | Shows |
|---|---|
| **Home** | Posts by the accounts you follow, and your own posts. |
| **Local** | Posts by accounts on this instance. |
| **Federated** | Public and unlisted posts from this instance and from the other servers it knows. |
| **Trending** | Posts that get replies, boosts or favorites, trending hashtags, and people, with filters for time range and source. The source filter suggests the instances with the most posts in the list; type in it to find any other known instance. **Explore** in the sidebar opens this tab. |
| **Instances** | The servers this instance federates with. |

Other views:

- **Mentions**: posts that mention you, including posts from people you do not follow.
- **Bookmarks**: posts you bookmarked. Only you see this list.
- A hashtag page: select a hashtag in a post.
- A profile: select a name or avatar.

A reply in a feed shows the post it answers above its own text: that post's avatar, author and the start of its text, at most two lines. A content warning shows in place of the text, and a post without text names its attachments. Select the preview to open that post's page, with the reply highlighted. A deleted post, a post you may not see and a post this instance has not stored each read as one line; the last links to the post on its own server.

## Write a post

1. Select **New post** in the header. The **Create a post** dialog opens.
2. Type your text. `@` suggests accounts to mention and `:` suggests emoji; Up and Down arrows pick one, Enter or Tab inserts it.
3. Add what the post needs from the row of buttons under the text:
   - **Add images or video** attaches files. You can also drop images or videos onto the text box.
   - **Add GIF** and **Add emoji** open their pickers.
   - **Content warning** adds a warning field (up to 100 characters).
   - **Mark media as sensitive** appears once media is attached. Readers see **Sensitive content** over the media until they select it.
4. Choose who can read the post with the visibility button. It shows the current choice, **Public** for a new post.
5. Select **Post**, or press Ctrl+Enter (Cmd+Enter on a Mac).

The ring beside the button counts characters. The instance sets the character limit (500 when the operator has set none) and the number of attachments per post.

A post with a content warning shows the warning with **Show more** to reveal the text.

### Choose who can read a post

| Option | Who can read it | Boost and quote |
|---|---|---|
| **Public** | Anyone. | Yes |
| **Unlisted** | Anyone. | Yes |
| **Followers only** | Your accepted followers and the people the post mentions. | No |
| **Mentioned people only** | The people the post mentions. The post needs at least one @mention. | No |

**Public** and **Unlisted** differ in how other servers receive them: a public post is addressed to the public, an unlisted one to your followers with the public in copy, the form Mastodon uses for unlisted posts.

A reply starts at the visibility of the post it answers when that one is narrower: a reply to an unlisted post starts as unlisted, a reply to a **Mentioned people only** post stays that way. You can change it before sending.

A post that someone on another server addresses only to the people it mentions arrives in your **Direct messages**, not in a timeline.

### Describe images and video

Each attached image or video has an **ALT** button. It opens **Edit media** with the field **Describe this for people who can't see it** (up to 1500 characters). An attachment without a description shows **No description**. Images also have **Edit**, for cropping and choosing the focal point that thumbnails crop around.

Readers open a description with the **ALT** badge on the image. Screen readers read the description as the image's name. Chat attachments take descriptions too; see [Messages and threads](/use/messages).

### Edit, pin or delete a post

**More options** (the three dots) on your own post offers:

| Item | What it does |
|---|---|
| **Copy link** | Copies the post's address. |
| **Edit** | Opens **Edit post**. The visibility cannot be changed there. An edited post shows **Edited**. |
| **Pin to profile** / **Unpin from profile** | Keeps the post at the top of your profile. |
| **Delete** | Deletes the post after a confirmation. |
| **Delete and redraft** | Deletes the post and puts its content back in the composer. Favorites and boosts on it are lost. |

## Reply, boost, favorite and bookmark

The buttons under each post:

| Button | What it does |
|---|---|
| Reply | Opens a reply box under the post. The reply starts with mentions of the author and of everyone the post mentions, except you. The number beside it opens the post with its replies. In a feed it counts direct replies; on the post's own page it counts every reply below the post that you can see, replies to replies included. |
| **Boost** | Opens a menu with **Boost**, which shares the post with your followers, and **Quote**. Select the button again to undo a boost. **Followers only** and **Mentioned people only** posts cannot be boosted or quoted. |
| **Favorite** | Favorites the post. Removing the favorite also removes your emoji reactions on that post. |
| **Add reaction** | Reacts with an emoji. A heart reaction counts as the favorite. The instance limits how many different emoji one person can put on a post. |
| **Bookmark** | Saves the post to **Bookmarks**. |
| **More options** | Your own post: see above. Someone else's post: **Copy link**, **Mute** and **Block** items that name the author, and **Report post**. |

For a post from another server, **More options** also has **Fetch reactions** and **Refresh replies**, which read the reactions and replies its own server reports.

## Quote a post

1. Select **Boost** under a public or unlisted post, then **Quote**.
2. The **Quote post** dialog shows the post under **Quoting**. Write your comment.
3. Select **Quote**.

When your post is quoted, here or on another server, you are notified; the **Quotes** switches in [your notification settings](/use/notifications-apps#choose-which-alerts-you-get) control it.

Quote approval follows FEP-044f, the scheme Mastodon uses:

- When someone on another server quotes your post, their server asks this instance for approval, and Harmony answers on its own from the post's visibility. **Public** and **Unlisted** posts: anyone may quote. **Followers only**: your accepted followers. **Mentioned people only**: nobody. An account you block is always refused. Harmony has no setting or request list for quote approval; the visibility of each post decides.
- When you quote a post from another server, Harmony asks that server for approval. An approval is attached to your post and sent out again with it. If the author's server refuses, your post stays up without an approval.

## Addresses and handles

Profiles, posts and hashtags have the addresses Mastodon uses, on your instance's domain:

| Address | What it opens |
|---|---|
| `/@name` | A profile on this instance. Visitors who aren't signed in see its public page. |
| `/@name@example.social` | A profile on another server, as this instance knows it. Visitors sign in first. |
| `/@name/ID`, `/@name@example.social/ID` | A post. **Copy link** in a post's menu copies this address. |
| `/tags/tag` | A hashtag. |

Earlier addresses, `/social/profile/…`, `/social/post/…` and `/social/hashtag/…`, open the same pages and change to the new address.

A profile shows the account's full handle, `@name@domain`, accounts on this instance included: the form people on other servers type to find or mention it. **Copy handle**, the copy button beside the handle on a profile and on a profile card, and the item of the same name in the profile card's menu, copies it. People search lists accounts by the same handle. A link to a profile in a message shows a card with the account's name, handle, bio and counts, **Follow** and **Open profile**.

## Follow people

### Follow someone on this instance

Open their profile and select **Follow**. The button then reads **Following**, and **Unfollow** while you point at it; selecting it again unfollows.

### Follow someone on another server

1. In the **Feed** header select **Search**. The **Search users** dialog opens.
2. Type the full handle, such as `@alice@example.social`, and press Enter. Harmony looks the account up on its server. A display name or part of a username searches the accounts this instance already knows.
3. Select the account to open its profile, then select **Follow**.

A follow of an account on another server shows **Requested** until that server accepts it. Selecting **Requested** withdraws the request; it reads **Cancel request** while you point at it.

The follow button names what it sends:

| Button | When |
|---|---|
| **Follow** | The account accepts followers on its own. |
| **Request to follow** | The account approves each follower. Its profile shows a lock labelled **Approves followers manually**. |
| **Send friend request** | The account is on a chat server where every follow is a friendship. |

On the profile of an account from another server, the follower and following lists hold only the accounts this instance knows, with a **Full list on** link to its server.

### Approve followers yourself

To make every new follow a request:

1. Open **User settings** → **Privacy & safety**.
2. Under **Followers**, turn on **Require follow approval**.

People who already follow you stay. Turning the setting off accepts every waiting request. Who asked to follow you, and whom you declined, is visible only to you and that person.

Answer requests in any of these places:

- **Followers** (from **Your activity** in the sidebar), on the **Requests** tab: **Accept** or **Decline**.
- The follow request notification: **Accept** or **Reject**.
- The **Today** page: **Accept** or **Decline**.

**Followers only** posts become readable to a follower once you accept them, including the ones you posted before.

### Remove a follower, mute or block

- **Remove follower**, on your own **Followers** list, ends that person's follow after a confirmation. They lose access to your **Followers only** posts.
- **Mute** hides someone's posts from your feeds without unfollowing.
- **Block** stops them following you or seeing your posts, and hides theirs from you. A block in either direction refuses a follow.

Mute and block are in **More options** on a post and in the menu on a profile. **User settings** → **Privacy & safety** lists the accounts you blocked and muted.

## Edit your profile

Open **User settings** → **My account**, or select **Edit profile** on your own profile page.

| Field | Notes |
|---|---|
| **Avatar** and **Banner** | Select the image to change it; a crop dialog opens. |
| **Display name** | Up to 50 characters. Type `:` to add custom emoji, unless the instance turns them off for names. |
| **Username** | Cannot be changed: other servers identify your account by it. |
| **Bio** | Up to 500 characters. |
| **Display color** | Colors your display name and profile accents. |
| **Profile fields** | Up to 4 label and value pairs, such as a website or another handle, each part up to 255 characters. Every field needs both a label and a value. Other servers receive them with your profile. |

Select **Save** to keep the changes.

## Move your account

**User settings** → **Advanced** → **Account migration** moves your followers between accounts, on this instance or on another fediverse server. It follows Mastodon's account moves: the new account first names the old one as an alias (ActivityPub `alsoKnownAs`), then the old account sends a `Move`.

### Move from this account to a new one

1. On the new account, add this account as an alias. Mastodon calls this an account alias; on Harmony it is **Moving from another account** (see the next section). The **Account migration** panel shows the handle to enter there.
2. Here, under **Move to another account**, type the new account's handle, such as `newname@instance.social`, and select **Check account**.
3. Harmony shows whether the new account lists this one. When it does not, add the alias on the new account and check again. **Move account** stays unavailable until the alias is in place.
4. Read **What moves** and **What stays behind**. **Download your data first** opens **Privacy & safety**, where you can export your data.
5. Select **Move account**. Enter your password, and your authenticator code if two-factor authentication is on. An account without a password needs a sign-in within the last ten minutes.
6. Select **Move my account**.

| What moves | What stays behind |
|---|---|
| Your followers on this instance. | Posts, messages and direct messages. |
| Your followers on servers that support account moves. Their servers move them. | Likes, boosts and bookmarks. |
| Your Harmony server memberships, with your roles and nickname, when the new account joins a server hosted on another instance than its own. It needs no invite; a ban on the old account also applies to the new one. | Your display name, bio, avatar, banner and profile fields. [Copy them](#copy-your-old-profile) on a new Harmony account. |
| | The accounts you follow. [Import them](#import-the-accounts-you-follow) on the new account. |
| | Accounts you blocked or muted. |
| | End-to-end encryption keys. |
| | Bots you own. |
| | Servers you own. Ownership does not move; transfer it first. |

Harmony follows Mastodon here: a move carries followers and tells other servers where you went. Posts and likes are not imported.

Followers on this instance who block, or are blocked by, the new account stay with the old one. People here who blocked or muted the old account block or mute the new one as well. When the new account approves followers manually, moved followers arrive there as follow requests.

After the move, your profile shows **This account has moved** and points to the new account. **Cancel redirect** removes the pointer; followers who already moved stay with the new account. Another move is possible 30 days after the last one, whether or not it was cancelled.

### Move to Harmony from another account

1. Here, under **Moving from another account**, type the old account's handle, such as `username@instance.social`, and select **Add**. The list holds at most ten accounts.
2. On the old server, start the move and give this account as the target. The panel shows the handle to enter: **On the other server, enter this account as the move target**.
3. The old server sends the move. Followers on servers that support moves follow this account; followers on this instance are moved by Harmony.

### Import the accounts you follow

A move leaves your following list behind. **Import the accounts you follow** in **Account migration** follows the accounts on a list from your old account.

1. Get the list. On Mastodon, go to **Preferences** → **Import and export** → **Data export** and download **Follows** as a CSV. On Harmony, use the ZIP from **Privacy & safety** → **Download your data**.
2. On the new account, select **Choose file** and pick `following_accounts.csv`, the ZIP, or `social.json` from the ZIP. Harmony shows how many accounts it found. Only those account addresses leave your device.
3. Select **Start import**. It runs on the server, so you can close the app.

The panel shows how many accounts you now follow, how many got a follow request, how many you already followed, and which could not be followed and why.

- Follows work as they do when you select **Follow**. Locked accounts and accounts on other servers get a request. Accounts that block you, or that you block, are skipped.
- A deleted, suspended or moved account is not followed.
- An account you asked to follow before and that declined stays declined.
- Imports follow at the instance's hourly follow limit, so a long list can take hours. Your own follows do not wait for it. **Stop import** ends it; follows already made stay.
- Mastodon's per-account settings for boosts, notifications and languages are not carried over. Harmony has no such settings on a follow.
- A file can list up to 20,000 accounts, as on Mastodon, and you can start five imports in 24 hours.

### Copy your old profile

Your old profile stays with the old account. Once an account moved to this one, **Copy your old profile** appears in **Account migration**. It needs both sides of the move: the old account points here, and this account lists the old one as an alias. **Cancel redirect** on the old account removes the offer.

1. Tick what to copy: display name, bio, avatar, banner or profile fields.
2. Select **Copy selected**. Harmony lists what is added and what replaces what your profile has now.
3. Select **Copy to this profile**.

Nothing changes before that last step, and replaced values cannot be restored. The avatar and banner are stored again on this instance, so they stay when the old server goes away. An image the old server no longer serves is left out, and the panel says so. Software other than Harmony has no such action.

### When someone you follow moves

When an account you follow on this instance moves, Harmony follows the new account for you and notifies you: **You now follow** the new account, or, when it approves followers, a follow request is sent for you. Lists that held the old account hold the new one. A follow stays on the old account when you block, or are blocked by, the new one.

The old account's profile shows that it has moved, with **Go to new profile**.
