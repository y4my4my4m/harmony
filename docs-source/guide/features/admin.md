# Administration

The admin panel (`AdminPanel` view) provides instance-level management for Harmony operators.

## System Overview

The dashboard shows key metrics:

- Total users, servers, and federated instances
- Total posts and messages
- Instance uptime
- System health indicators (database, federation queue, storage, memory)

## User Management

Admins can manage users through `AdminService`:

| Action | Description |
|--------|-------------|
| List users | Paginated user list with search |
| Suspend user | Temporarily disable an account |
| Unsuspend user | Restore a suspended account |
| Export logs | Download admin activity logs |

## Retention

The Retention tab (`RetentionCohorts`) groups local accounts by the UTC month or ISO week they
signed up and shows, per cohort, what share joined a server, joined someone else's server, wrote on
day 1, wrote in days 1–7, 8–30 and 31–90, had their first message answered within 1 h and 24 h,
has push on, and follows anyone. Hovering a cell shows the counts behind the rate.

The data comes from `get_signup_cohorts(p_months, p_period)`, which returns counts per cohort and
no per-account rows. Instance admins and the service role may call it. A window rate counts only
accounts whose window has ended, so the current cohort shows a dash rather than an early low
figure. Server, push and follow figures are current state.

## Federation Management

Federation controls are a major part of the admin panel:

### Instance Directory

- View all known federated instances with filters: all, active, trusted, blocked
- Search instances by domain
- Per-instance stats: user count, post count, last activity

### Instance Actions

| Action | Effect |
|--------|--------|
| **Refresh** | Re-fetch instance metadata and stats |
| **Trust** | Mark as trusted. Today this surfaces as a UI badge plus a filter for trending/instance lists; per-instance delivery priority and rate-limit relaxation aren't yet wired in the federation backend. |
| **Block** | Block all federation with this instance |
| **Unblock** | Resume federation |

### Federation Health

- Endpoint health monitoring with success rates
- Dead endpoint detection
- Key consistency checks and sweep
- Orphan resource cleanup

These maintenance operations are available through `AdminService`:

```typescript
adminService.runKeyGenerationSweep()
adminService.runOrphanCleanup()
adminService.refreshKeyConsistency()
```

## Server Settings

Individual servers have their own settings managed by server owners:

| Section | Component | Features |
|---------|-----------|----------|
| Basic Info | `ServerBasicInfo` | Name, description, icon |
| Newcomer alerts | `ServerNewcomerAlerts` | Alert the owner and moderators on a new member's first message; Manage Server |
| Roles | `RoleManagement` | Role hierarchy with bigint permission bitmasks |
| Audit log | `ServerAuditLog` | 90 days of channel, category, role, override, emoji, invite, bot and settings changes, role assignments, kicks, bans, timeouts and moderator message deletions, filterable by kind and member; the owner and View Audit Log |
| Privacy | `ServerPrivacySettings` | Visibility, join requirements |
| Encryption | `ServerEncryptionSettings` | Encryption mode (disabled/optional/required) |
| Bots | `ServerBotsSettings` | Bot access and configuration |
| Emoji | `ServerEmojiManagement` | Custom emoji upload and management |
| Invites | `InviteManagement` | Invite link creation and revocation |
| Advanced | `ServerAdvancedSettings` | Danger zone (delete server, transfer ownership) |

## Emoji Management

`EmojiImporter` in the admin panel allows:

- Bulk emoji import
- Custom emoji packs per server
- Emoji pack management via `EmojiPackService`
- Emoji indexed in `EmojiIndexedDBCache` for fast lookup

## Bots

The admin panel has no bot section. Any user creates and manages bots under User Settings → My Bots
(`UserBotsManagement`): token issue and reset, connection endpoints, and adding the bot to servers the
user owns. Server owners grant per-server permissions under Server Settings → Advanced → Server Bots
(`ServerBotsSettings`); the owner and members with Manage Server choose the channels each bot uses.
A chosen channel is open to the bot even where @everyone cannot view it or is read-only. See the
[Bot API reference](/bot-api).

## Performance Monitoring

`PerformanceMonitoring` component shows:

- Real-time system performance metrics
- Resource utilization tracking

---

> **Note**: This page is protected from auto-generation. Edit the content in `docs-source/guide/features/admin.md` and run `npm run docs:generate-guide` to update.
