---
title: Federation
description: What Harmony shares with other Harmony instances and with Mastodon and other ActivityPub software, what stays local, and the federation controls server owners and instance admins have.
---
# Federation

Harmony instances talk to each other, and to Mastodon and other fediverse software, over ActivityPub. This page explains what crosses between instances and what does not, for people using Harmony, server owners and instance admins. Implementers of other software can find endpoints, signatures and the wire format in the [ActivityPub reference](/federation/reference).

## Two kinds of federation

Harmony has a social side and a chat side, and they federate differently.

- **The social side** (profiles, posts, follows, favourites, boosts, quotes, direct messages) is ordinary ActivityPub. A Mastodon user can follow a Harmony account, read its posts, reply, boost, favourite and quote, and a Harmony user can do the same with Mastodon accounts.
- **The chat side** (servers, channels, threads, voice) uses ActivityPub `Group` actors with Harmony-specific extensions. Only other Harmony instances can join a server or take part in its channels.

## What federates

| Feature | Crosses instances | Reaches |
|---|---|---|
| Profiles: display name, bio, avatar, banner, profile fields, custom emoji | Yes | Any ActivityPub software |
| Profile colour and custom status | Yes, as Harmony extensions | Harmony instances; other software ignores them |
| Posts, replies, edits, deletions, boosts | Yes | Any ActivityPub software |
| Pinned posts (up to 10, public and unlisted) | Yes | Any ActivityPub software |
| Favourites and emoji reactions on posts | Yes, encoded for the receiving software (see [Reactions](#reactions)) | Any ActivityPub software |
| Quote posts | Yes, with quote approvals ([FEP-044f](#quote-posts-and-quote-approvals)) | Any software that reads FEP-044f or the older quote properties |
| Polls in posts | Received and shown; a vote cast here reaches the poll's author, as Mastodon sends one | Software that sends polls (`Question`): Mastodon, Misskey and others |
| Communities (Lemmy, PieFed, Mbin) | Followed like accounts; their posts arrive as the community's boosts, their comments as replies | Inbound only |
| Follows and follow requests | Yes | Any ActivityPub software |
| Blocks | Yes, a `Block` goes to the blocked account's instance | Any ActivityPub software |
| Reports | When the reporter forwards them, as an anonymous `Flag` | Any software that accepts `Flag` |
| Account moves | Yes (`Move`, `alsoKnownAs`) | Any software that supports account migration |
| Direct messages | Yes | Any ActivityPub software |
| Group direct messages | Yes; renames, icons and departures only between Harmony instances | Harmony instances in full |
| Chat servers: channels, messages, reactions, threads, voice messages | Yes | Harmony instances only |
| Voice channels and direct-message calls | Yes, through the LiveKit server of the instance that hosts the channel or places the call | Harmony instances only |
| End-to-end encrypted content | No (see [Encryption](#encryption)) | Nobody |
| Polls in chat messages | No; other instances receive the poll's text | Nobody |
| Typing indicators and presence | No | Nobody |
| Role and permission definitions | No; the hosting instance enforces them | Nobody |

## Servers with members on several instances

A chat server lives on one instance, the one where it was created. That instance is the **host**. Its server appears to other instances as a `Group` actor at `https://<host>/servers/<id>`. Members on other instances join through their own instance, which keeps a local copy of the server's structure and messages so it can show them.

### Joining

- A **public** server with federation enabled can be found by its handle, `slug@host`, shown in **Server settings** → **Privacy settings** → **Server handle**. The handle resolves through WebFinger.
- A **private** server needs an invite link. The joining instance first checks that the invite's server is a genuine `Group` on the same host as the link. The `Join` it sends carries the invite code, and the host checks the code (expiry, use count, revocation) before it accepts.
- The host refuses a `Join` from a suspended account, from a banned account, and from an account that moved from a banned account.

### What travels between instances

| From | To | What |
|---|---|---|
| Joining member's instance | Host | `Join` (with the invite code for a private server), `Leave` |
| Host | Joining member's instance | `Accept` or `Reject` of the `Join` |
| Host | Each instance with a member who can view the channel | Messages, edits, reactions and threads in that channel |
| Member's instance | Host | The member's messages, edits and threads |
| Host | Other member instances | Messages, edits and reactions it accepted from members on other instances |
| Host | Member instances | Channel and category creation, changes and removal; server name, description, icon and banner |
| Member's instance | Host | Voice channel join and leave; the host answers a join with a voice token for its own LiveKit |

The host decides everything that involves permissions. A message from another instance is stored only when its author is an accepted, unbanned member with **Send Messages** in that channel, or **Send Messages in Threads** for a thread. Private channels and private servers are only sent to, and only served to, instances that have a member allowed to view them.

Attachments in channel messages travel as links that name the receiving instance. A link works for as long as that instance still receives the channel.

### What stays on the host

Roles, permission overrides, the audit log, AutoMod rules, server bans and the invite list stay on the host.

### Turning federation off for a server

Server owners control federation per server: **Server settings** → **Privacy settings** → **Enable federation**. The switch appears only when federation is enabled for the instance. With it off, the server rejects new `Join` requests from other instances and stops delivering to and accepting from remote members. Turning it off asks first, naming how many members from other instances it removes. Each of them is removed and told, in their inbox on their own instance, that the server stopped taking members from other instances; the server leaves their list. Turning federation back on brings nobody back: they rejoin with an invite.

A member whose instance missed that notice (its host runs an older Harmony, or the delivery failed) still sees the server. Opening it shows why it is silent, with a **Leave server** button, in place of its messages.

Kicking or banning a member from another instance tells their instance too; the member's inbox names the kick or ban and the reason given.

## Encryption

End-to-end encryption does not federate. Device keys and session keys stay on each instance, and no ActivityPub activity carries them.

- Messages in an encrypted channel are never queued for federation, so remote members do not receive them.
- In a direct message with someone on another instance, Harmony warns before you turn encryption on. Encrypted messages to that person are delivered as ciphertext marked `harmony:encrypted`, which their instance cannot decrypt.

## Interoperability with Mastodon and other software

### What other software sees of Harmony

A Harmony account is a standard `Person` actor. Mastodon and similar software show its display name, bio, avatar, banner, profile fields, custom emoji, pinned posts, whether it approves followers manually, and where it moved to.

A Harmony post is a `Note` written the way Mastodon writes one:

- The text is HTML paragraphs with mentions, hashtags and custom emoji. Markdown is sent as written, not converted to HTML.
- A content warning becomes `summary`, and a sensitive flag becomes `sensitive`.
- Attachments carry their alt text, blurhash and focal point.
- The post's language goes in `contentMap` when it is set.
- Favourite and boost counts are included, and the post advertises who may quote it.

Visibility maps to Mastodon's addressing: public, unlisted, followers only and direct. A post names its thread as its `context` (FEP-7888), which other software can read to fetch the whole conversation.

On another server's web page, a Harmony user who presses that server's remote follow button and enters their Harmony handle is sent to their own instance's `/authorize_interaction` page, which shows the account or post and offers **Follow** or **Open post**.

### What Harmony shows of other software

Harmony shows remote profiles, posts, reply threads, boosts, content warnings, sensitive media, custom emoji, quote posts, account moves and locked accounts. A Mastodon direct post becomes a Harmony direct message. When it is addressed to several Harmony users, it becomes a group conversation. A post from Misskey, Pleroma or Akkoma can carry emoji reactions, and Harmony shows them as reactions.

### Reactions

A Harmony user holds at most one favourite on a post, and an emoji reaction implies that favourite. What Harmony sends depends on the software of the receiving instance:

| Receiving software | Favourite | Emoji reaction |
|---|---|---|
| Mastodon, glitch-soc, Hometown, GoToSocial | `Like` | Not sent |
| Misskey and its forks (Sharkey, Firefish, Iceshrimp, CherryPick and others) | `Like` | `Like` with `_misskey_reaction`, the newest reaction only |
| Pleroma, Akkoma, Harmony, anything else | `Like` | `EmojiReact` ([FEP-c0e0](/federation/reference#feps)) |

Harmony works out the software from the instance's NodeInfo, read again weekly. Without a NodeInfo answer it uses the actor and object documents it has fetched from that instance. A software name read by an admin's **Refresh instance info** in the admin panel is kept as set. Inbound, a `Like` with no emoji or with a heart is a favourite, and any other emoji is a reaction.

### Known limitations

- Chat servers, channels, threads, voice and Harmony's chat extensions only work between Harmony instances. Following a Harmony server from Mastodon does nothing: the server's inbox answers only Harmony membership activities.
- Harmony posts cannot contain polls. Polls from other software show their answers, vote shares, voter count and closing time, and take votes. A vote is final, as on Mastodon, and the shares update when the poll's instance next reports its counts.
- A Lemmy, PieFed or Mbin community can be followed, by its handle (`community@instance`, or `!community@instance`) or its URL. Its posts and comments arrive; its votes and moderation do not, and a reply written in Harmony reaches the post's author, not the community.
- Markdown in a Harmony post reaches other software as plain text.
- Quote approvals are automatic. There is no queue for approving quotes by hand.

## Quote posts and quote approvals

Harmony follows FEP-044f, the quote-approval scheme Mastodon 4.5 uses.

Every Harmony post advertises who may quote it, and Harmony answers quote requests by the same rule:

| Post visibility | Who may quote it |
|---|---|
| Public, unlisted | Anyone the author does not block |
| Followers only | The author's accepted followers |
| Direct | Nobody but the author |

When someone on another instance quotes a Harmony post, their instance sends a `QuoteRequest`. Harmony answers automatically under the table above: an `Accept` carrying a quote authorization, or a `Reject`. Once the quoted post is deleted, its authorizations are no longer served.

When you quote a post from another instance, Harmony publishes the quote and sends the quoted author a `QuoteRequest`. If they accept, Harmony sends your quote again with the authorization attached. If they reject, Harmony records the refusal and your quote stays on Harmony. Quoting another account on your own instance needs no request; Harmony issues the authorization itself under the same rules.

Harmony also reads quotes from software that uses the older `quoteUrl`, `quoteUri` or `_misskey_quote` properties. A quote of a post that is deleted or not public arrives as a plain post. A quote of a post that cannot be fetched shows a link to it.

## Locked accounts and follow requests

To approve followers by hand, turn on **User settings** → **Privacy & safety** → **Require follow approval**. Your actor then advertises `manuallyApprovesFollowers`, and other software shows your account as locked. The how-to is in [Social](/use/social).

- A follow from another instance waits as a request. Harmony sends `Accept` when you approve it and `Reject` when you decline it.
- Turning the setting off accepts every waiting request. People who already follow you stay.
- A follow from an account you block is rejected straight away.
- When you follow a locked account elsewhere, the follow stays pending until that account's instance sends `Accept`. A `Reject` removes it.
- A repeated `Follow` from someone who already follows you, which Mastodon sends after some migrations, is accepted again and does not turn back into a request.

## Moving an account

Harmony supports the same account migration as Mastodon: `alsoKnownAs` aliases and the `Move` activity. Both directions work, between Harmony instances and with other software. The settings are in **User settings** → **Advanced** → **Account migration**, and [Social](/use/social) has the steps.

1. On the new account, list the old one as an alias. In Harmony this is **Moving from another account**; Mastodon calls it an account alias. This sets `alsoKnownAs`.
2. On the old account, start the move under **Move to another account**. Harmony checks that the new account lists the old one and has not moved itself. It also asks for your password or a recent sign-in, and your authenticator code if you use one.
3. The old account's profile points to the new one (`movedTo`). Harmony sends `Move` to the instances of its remote followers and to every instance it shares a chat server with, and moves its followers on this instance to the new account.

| What moves | What stays behind |
|---|---|
| Followers, on this instance and on instances that support account moves | Posts, messages and direct messages |
| Harmony server memberships, roles and nicknames, when the new account joins the server | End-to-end encryption keys |
| | Bots and servers you own |
| | The accounts you follow |

A server ban follows the account too: the host refuses a `Join` from an account that moved from a banned one. After a move, another move is possible after 30 days. **Cancel redirect** removes the redirect; followers who already moved stay with the new account.

When an account elsewhere moves, Harmony checks before following the move. The `Move` must be signed by the old account, and the new account must list the old one in `alsoKnownAs`. The new account must not have moved itself, be suspended, or be on a blocked instance. A second move to a different account within 30 days is ignored. Followers on this instance then follow the new account.

## Account handles across domains (FEP-2c59)

Some Mastodon instances serve their actors on one domain and name their accounts with another, for example actors on `social.example.com` and handles like `@alice@example.com`. Harmony confirms an account's handle the way Mastodon does: it reads the actor's `webfinger` property (FEP-2c59), or else uses `preferredUsername` at the actor's host. It then checks that WebFinger for that handle points back to the same actor. A confirmed account is stored once and shown with its canonical handle; an unconfirmed one is named by its actor's host. Harmony reads this property from other software; its own actors do not publish it.

## Controls for instance admins

Instance admins manage federation in the admin panel under **Federation** and **Anti-spam**. Moderators can view the **Federation** list; trust, limits and blocks are admin-only.

| Control | Where | Effect |
|---|---|---|
| Block an instance | **Federation**, **Block instance** | Defederates the instance: its deliveries are refused and nothing is delivered to it. Harmony does not fetch documents from it, so boosts, replies and quotes cannot import its posts, and signed reads from it are served as if unsigned. Takes effect within five minutes. |
| Limit an instance | **Federation**, **Limit: silence this domain's accounts** | Silences the instance's accounts, including accounts first seen later. **Lift the limit** reverses it. |
| Trust an instance | **Federation**, **Mark as trusted** | A trusted badge on the instance and a trusted-only filter in instance discovery. The federation backend ignores it. |
| Mention and DM spam | **Anti-spam** → **Federation mention spam** | What happens to a remote post or DM that looks like spam: **Do nothing**, **Deliver it and add it to the review queue** (default), **Hold it in the review queue until released**, or **Reject it and add it to the review queue**. A post or DM looks like spam when it mentions at least 15 people (adjustable), or when it comes from a remote account younger than 7 days (adjustable) that nobody on the instance follows and that none of the mentioned users has talked to. Held items wait under **Suspicious activity** until released. |

Harmony has no allowlist mode: every instance that is not blocked can federate.

Two environment settings of the federation backend also apply: `ALLOW_FEDERATED_VOICE` turns federated direct-message calls on or off (on by default), and `REQUIRE_VALID_SIGNATURES` cannot be turned off in production. See [Configuration](/self-host/configuration).
