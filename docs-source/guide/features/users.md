# User Management

## Profiles

User profiles are managed through `ProfileService` and `CoreProfileService`:

- **Display name** and **username** (unique handle)
- **Avatar** and **banner** images (stored in Supabase Storage)
- **Bio** with markdown support
- **Custom fields** for links and metadata
- **Privacy settings** per profile

Profile creation happens after registration via `NewProfile` view (onboarding flow). The `useProfile` store handles profile state with actions for fetch, update, and creation.

### Profile Data Access

`userDataService` is the single source of truth for cached user lookups:

- 5-minute TTL cache to reduce database queries
- Request deduplication prevents concurrent identical fetches
- Context-based subscriptions (by server, channel, or DM)
- Presence and status tracking integrated

Components should never query profiles directly from the database -- always go through `userDataService`.

## Presence & Status

### Online Status

Users have four presence states:

| Status | Description |
|--------|-------------|
| **Online** | Actively using the app |
| **Away** | Idle or manually set |
| **Do Not Disturb** | Suppresses notifications |
| **Invisible** | Appears offline to others |

Presence is synced via Supabase Realtime and `SessionHeartbeat` keeps sessions alive with periodic pings. Mobile detection adjusts behavior automatically.

### Custom Status

Users can set a custom status message with:

- Free-text status message
- Optional emoji
- Expiration time (auto-clear after duration)

## User Settings

The settings panel (`UserSettings` view) provides:

| Section | Component | Features |
|---------|-----------|----------|
| Account | `UserAccountSettings` | Profile, avatar, banner, profile fields |
| Security | `SecuritySettings` | Password, two-factor authentication and recovery codes, signed-in devices |
| Privacy | `PrivacySettings` | Encryption, tracking-parameter stripping, data export, blocked and muted users |
| Appearance | `AppearanceSettings` | Theme, colors, layout preferences |
| Notifications | `NotificationSettings` | Desktop, sound, DND schedule |
| Voice & Video | `VoiceVideoSettings` | Device selection, quality settings |
| Language | `LanguageSettings` | Interface language (i18n) |
| Keybinds | `KeybindSettings` | Keyboard shortcuts |
| Audio Themes | `AudioThemeSettings` | Sound theme selection |
| Bots | `UserBotsManagement` | Personal bot management |
| Advanced | `AdvancedSettings` | Desktop app, developer mode, cache, account migration, account deletion |

## Account Migration

Settings → Advanced → Account migration moves followers between a person's accounts, on this
instance or another, the way Mastodon does:

1. On the new account, list the old one under *Moving from another account* (`alsoKnownAs`).
2. On the old account, enter the new one under *Move to another account*. The move is offered once
   the new account lists the old one, and asks for the password (or a recent sign-in) and, with
   two-factor authentication, an authenticator code.

The old profile then shows where the account went and stops offering Follow. Its followers on this
instance follow the new account (a follow request when it is elsewhere), with their list entries,
blocks and mutes, and get a notification; other instances get an ActivityPub `Move` and move their
own followers. A member of a Harmony server who rejoins it from the new account needs no invite and
keeps nickname and roles; a ban of the old account applies to the new one. Posts, messages, DMs,
encryption keys, bots, owned servers and followed accounts stay behind. A second move waits 30 days;
*Cancel redirect* removes the redirect without bringing followers back.

A `Move` from another instance is accepted when it is signed by the moving account and the new
account, fetched at that moment, lists the old one and has not moved itself.

## Muting and Blocking

### User Mutes

The `user_mutes` table uses boolean flags:

- `hide_notifications` - Suppress notifications from the user
- Muted users' messages are still received but can be hidden in the UI

### User Blocks

Blocking a user through `CoreInteractionService`:

- Prevents the blocked user from seeing your content
- Hides their content from your feeds
- Blocks DMs and interactions
- Federated across instances via ActivityPub `Block` activities

## User Profile View

`UserProfileView` displays a full profile page with:

- Banner and avatar
- Follow/unfollow button with follower counts
- User's posts feed
- Mute/block/report actions via context menu
- Federation info for remote users (instance, handle)
- Content tabbing (posts, replies, media)

## Notifications

The notification system tracks:

- Mentions in messages and posts
- Follow requests and new followers
- Reactions on your content
- Replies to your posts
- Server invites
- DM messages
- A new member's first message in a server you own or moderate (`newcomer_message`)
- An account you follow moved, and you now follow its new account (`move`)

When someone who joined in the last 30 days posts in a server for the first time, a newcomer alert
goes to at most ten people: the owner first, then members whose roles carry Administrator, Manage
Server, Kick, Ban or Timeout Members. Opening it jumps to that message. Each recipient can turn it off under
Notifications → New members; a server turns it off under Server Settings → Overview → Newcomer
alerts, and the instance admin sets the default for servers that have not chosen under Admin →
Configuration → General.

Notification preferences are granular with per-category toggles for desktop notifications, sounds, and DND scheduling. See `NotificationSettings` and `ActivityPubNotificationSettings` components.

### Server notification settings

Server menu → Notification settings (also on the server icon's context menu) sets, per server:
a mute (15 minutes to 24 hours, or until turned back on), the notification level (All messages,
Only @mentions, Nothing), Suppress @everyone, Suppress all role @mentions, push notifications,
and overrides for single channels or categories (a level and a mute each). The channel header's
⋮ menu reads and writes the same channel override.

A channel's level is its own override, else its category's, else the server setting, else the
server's default (`server_settings.default_message_notifications`), else Only @mentions:

| Level | Notifies for |
|-------|--------------|
| All messages | every channel message (`channel_message`), mentions, reactions, thread replies |
| Only @mentions | mentions, reactions to your messages, replies in threads you are in |
| Nothing | nothing from the channel; it still shows unread |

A muted server, category or channel notifies only for mentions. A muted channel or category also
hides its unread state and freezes its count; a muted server hides only the server icon's unread
dot. Suppressed @everyone or role mentions notify as plain messages at All messages.

---

> **Note**: This page is protected from auto-generation. Edit the content in `docs-source/guide/features/users.md` and run `npm run docs:generate-guide` to update.
