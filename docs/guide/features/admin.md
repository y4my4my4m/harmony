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
| **Trust** | Mark as trusted (higher delivery priority) |
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
| Roles | `RoleManagement` | Role hierarchy with bigint permission bitmasks |
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

## Bot Administration

`BotManagement` provides:

- View registered bots
- Manage bot permissions
- Monitor bot activity
- Bot gateway health status

## Performance Monitoring

`PerformanceMonitoring` component shows:

- Real-time system performance metrics
- Resource utilization tracking

---

> **Note**: This page is protected from auto-generation. Edit the content in `docs-source/guide/features/admin.md` and run `npm run docs:generate-guide` to update.
