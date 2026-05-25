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
| Account | `UserAccountSettings` | Email, password, 2FA, account deletion |
| Privacy | `PrivacySettings` | Profile visibility, DM permissions, activity tracking |
| Appearance | `AppearanceSettings` | Theme, colors, layout preferences |
| Notifications | `NotificationSettings` | Desktop, sound, DND schedule |
| Voice & Video | `VoiceVideoSettings` | Device selection, quality settings |
| Language | `LanguageSettings` | Interface language (i18n) |
| Keybinds | `KeybindSettings` | Keyboard shortcuts |
| Audio Themes | `AudioThemeSettings` | Sound theme selection |
| Bots | `UserBotsManagement` | Personal bot management |
| Advanced | `AdvancedSettings` | Debug options, data export |

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

Notification preferences are granular with per-category toggles for desktop notifications, sounds, and DND scheduling. See `NotificationSettings` and `ActivityPubNotificationSettings` components.

---

> **Note**: This page is protected from auto-generation. Edit the content in `docs-source/guide/features/users.md` and run `npm run docs:generate-guide` to update.
