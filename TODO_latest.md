# Harmony - TODO & Technical Debt

**Last Updated:** December 2024  
**Analysis Date:** Full codebase scan completed

---

## 🚨 Critical Priority

### 1. Notification System Overhaul

**Status:** 🔴 Buggy / Inconsistent

The notification system has multiple interconnected issues that need a comprehensive fix:

#### Current Problems:
- **DM Spam**: Sometimes generates multiple notifications for a single DM
- **Missing Notifications**: Some events don't trigger notifications when they should
- **Broken Click Navigation**: Clicking notifications doesn't always navigate to the correct location
  - `handleNotificationClick()` in `useNotification.ts` has edge cases where `navData` is undefined
  - Service worker click handling may not sync with main app routing
- **Push/Desktop Conflict**: Logic to prevent duplicate push+desktop notifications is fragile
- **Preferences Not Respected**: Some notification types ignore user's `notification_preferences` settings

#### Files Involved:
```
src/stores/useNotification.ts           - Core notification store (1298 lines)
src/composables/usePushNotifications.ts - Push subscription management
src/services/ServiceWorkerManager.ts    - Service worker push handling
src/services/NotificationFormatter.ts   - Notification formatting & navigation
src/components/NotificationBell.vue     - UI dropdown
src/components/settings/user/NotificationSettings.vue - User preferences
```

#### What Needs To Be Done:
1. **Audit notification creation sources**
   - Database triggers creating notifications
   - Realtime subscription handlers
   - ActivityPub incoming activities
   - Ensure deduplication logic (using `lastNotificationTime` Map)

2. **Fix navigation data extraction**
   - `NotificationFormatter.getNavigationData()` must handle all notification types
   - Ensure `data.location`, `data.sender`, `data.message` are properly structured
   - Add fallback URLs for malformed notification data

3. **Unify push + desktop notification logic**
   - Currently checks `pushSubscription` to skip desktop, but timing issues cause duplicates
   - Consider server-side "notification sent" flag to prevent race conditions

4. **Respect ALL preference settings**
   - `push_offline_only` - Only push when user is inactive
   - `desktop_mentions`, `desktop_dms`, `desktop_reactions`, etc.
   - ActivityPub-specific settings: `activitypub_desktop_follows`, etc.

5. **Improve session heartbeat integration**
   - `SessionHeartbeat.ts` exists but isn't fully integrated
   - Smart push should only fire when user is truly offline/inactive

---

### 2. User Blocking Not Working

**Status:** 🟡 Code disabled, RLS ready

**File:** `src/services/DMCallPermissions.ts`

```typescript
// TEMPORARILY DISABLED due to RLS permissions on user_blocks table
// TODO: Add RLS policies then re-enable
```

**Reality:** RLS policies ARE configured in `db_schema/init/30_rls_policies.sql`:
```sql
CREATE POLICY "user_blocks_select_own" ON public.user_blocks FOR SELECT USING (blocker_id = auth.uid());
CREATE POLICY "user_blocks_insert_own" ON public.user_blocks FOR INSERT WITH CHECK (blocker_id = auth.uid());
CREATE POLICY "user_blocks_delete_own" ON public.user_blocks FOR DELETE USING (blocker_id = auth.uid());
```

**Fix:** Uncomment the block check code - the RLS is properly configured.

---

### 3. Mute/Block API Not Implemented

**Status:** 🔴 Placeholder only

**File:** `src/stores/useActivityPub.ts`

```typescript
// TODO: Implement mute API call
// TODO: Implement block API call
```

Users cannot actually mute or block other users from the ActivityPub UI. The database tables exist but the service layer is incomplete.

**Required:**
- `muteUser(userId)` - Insert into `user_mutes` table
- `unmuteUser(userId)` - Delete from `user_mutes`
- `blockUser(userId)` - Insert into `user_blocks` + unfollow
- `unblockUser(userId)` - Delete from `user_blocks`

---

## ⚠️ High Priority

### 4. Lists Feature Incomplete

**Status:** 🔴 Placeholder

**File:** `src/views/ListsView.vue`

```typescript
// TODO: Implement actual loading logic
```

Lists view exists but:
- `loadLists()` is empty
- `loadMoreLists()` doesn't exist in store
- No database table for lists (needs `user_lists` table)
- Mastodon users expect this feature

---

### 5. Mobile Layout Issues

**Status:** 🟡 Partially broken

**File:** `src/layouts/BaseLayout.vue`

```typescript
// TODO: fix for mobile
```

- User profile section hidden on mobile with no alternative
- Some components don't adapt properly to small screens

---

### 6. Voice Channel Efficiency

**Status:** 🟡 Works but inefficient

**File:** `src/stores/unifiedVoiceChannel.ts`

```typescript
// FIXME: highly inefficient way to get channel name
// This should be optimized to avoid fetching all channels every time
```

---

## 📋 Medium Priority

### 7. Thread Features Incomplete

**Files:** `src/components/ChannelSidebar.vue`

```typescript
// TODO: Implement thread editing modal
// TODO: Implement split view functionality
```

- Thread editing modal not implemented
- Split view for threads not implemented

---

### 8. Group DM Federation Not Implemented

**File:** `src/stores/useDM.ts`

```typescript
// TODO: Implement ActivityPub private group message federation
debug.warn('🚧 Group DM federation not yet fully implemented')
```

Has structure but no actual federation logic for multi-recipient DMs.

---

### 9. Instance Discovery Not Implemented

**File:** `src/services/AdminService.ts`

```typescript
// TODO: Integrate with:
// - instances.social API
// - fediverse.info API
```

Admin panel can't discover new instances to federate with.

---

### 10. Group Encryption Simplified

**File:** `src/services/encryption/SignalProtocolService.ts`

```typescript
debug.warn('⚠️ Group encryption using simplified 1:1 approach')
```

Should use Sender Keys for proper group encryption performance.

---

## 🧹 Code Quality

### 11. Console.log Cleanup

**Count:** 77 instances across 25 files

Files with most console statements:
- `RoleManagement.vue` - 7
- `ThreadView.vue` - 6
- `ThreadFullView.vue` - 5
- `PerformanceMonitoring.vue` - 5
- `UnifiedVoiceOverlay.vue` - 4

Should use `debug` utility instead for production.

---

### 12. TODO Comments in Code

**Count:** 74 instances across 48 files

Major ones:
- `useActivityPub.ts` - 7 TODOs
- `ChannelSidebar.vue` - 2 TODOs
- `layouts/` - 2 TODOs (mobile fixes)

---

### 13. Type Confusion

**File:** `src/types.ts`

```typescript
// TODO: FIXME! User is NOT profile (user is the auth user, profile is the user's profile)
```

`User` and `Profile` types are conflated throughout the codebase.

---

### 14. Awkward Export Pattern

**File:** `src/services/ProfileService.ts`

```typescript
// TODO: export these directly
```

Service exports need cleanup.

---

## 🗑️ Files To Consider Removing

| File | Reason |
|------|--------|
| `src/components/encryption/EncryptionSettings.legacy` | Legacy file |
| `src/services/encryption/*.ts.node-only` | Node-only files in browser project |
| `docs/refactor-history/*` | Historical documentation, not user-facing |

---

## 📁 Core Services Incomplete

**File:** `src/services/core/index.ts`

```typescript
// - Post operations (coming in Phase 1B)
// - Profile operations (coming in Phase 1C)  
// - Interaction operations (coming in Phase 1D)
```

Only `CoreMessageService` is complete. The modular core service architecture is unfinished.

---

## 🔧 Database Schema Notes

### Tables Exist But Underutilized:
- `user_blocks` - Has RLS, code disables checks
- `user_mutes` - Needs service layer implementation

### Missing From Init Schema:
- `user_lists` table for Lists feature
- Some functions/triggers may only exist in old migration files

### Files Not Yet Applied:
- `db_schema/NOTYETAPPLIED_READ_TODO_20251204_hybrid_federation_triggers.sql`

---

## ✅ Recently Completed

- [x] Documentation cleanup (HOW_TO_SELF_HOST.md consolidated)
- [x] LiveKit token generation via pgjwt (voice without VPS)
- [x] Federation settings in Admin Panel now save to database
- [x] UI guards for federation-disabled instances
- [x] Federation RPC functions added to init schema

---

## Priority Order for Fixing

### Phase 1: User Safety & Core UX
1. Fix notification system (comprehensive)
2. Re-enable user blocking
3. Implement mute/block API
4. Fix mobile layout

### Phase 2: Feature Completion
5. Complete Lists feature
6. Thread editing modal
7. Instance discovery integration

### Phase 3: Performance & Polish
8. Voice channel efficiency
9. Console.log cleanup
10. Type refactoring (User vs Profile)

---

*This document should be updated as issues are resolved or new ones discovered.*

