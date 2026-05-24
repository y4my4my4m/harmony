# Harmony - TODO & technical debt

**Canonical roadmap.** Older notes: [`TODO.md`](./TODO.md).

**Last updated:** March 2026 (verified against repo)

---

## Critical

### 1. Notifications (behavior & UX)

Several flows still need a full audit (DM noise when already in conversation, click navigation edge cases, push vs in-app duplication, some types vs `notification_preferences`).

**Main files:** `src/stores/useNotification.ts`, `src/services/NotificationFormatter.ts`, `src/composables/usePushNotifications.ts`, `src/services/ServiceWorkerManager.ts`, DB triggers that call `send_notification`.

**Note:** `SessionHeartbeat` / view context **is** wired (`useViewContext`, `BaseLayout.vue`); remaining work is product logic and deduplication, not “missing heartbeat integration.”

---

## High priority

### 2. Mobile layout (`BaseLayout.vue`)

Comments still mark mobile fixes as TODO (profile / nav affordances on small screens). Needs a focused pass and removal of stale comments once fixed.

---

## Medium priority

### 3. Channel sidebar scale

`ChannelSidebar.vue` - consider virtualizing channel/category lists for very large servers (TODO in file).

### 4. Group DMs & ActivityPub

Group DMs: delivery is largely driven by DB + `federation-backend` listeners; end-to-end behavior for mixed local/remote participants still deserves integration tests and docs, not a single “not implemented” flag in the store.

### 5. Admin: instance discovery

`AdminService` uses **fediverse.observer** (`api.fediverse.observer`) for discovery hints - not `instances.social` / `fediverse.info` as older notes assumed. Optional follow-up: add more sources or unify UX.

### 6. Group encryption (Signal / DM groups)

`SignalProtocolService.ts` still uses a simplified per-member encrypt path; a Sender Keys style path would scale better for large groups.

---

## Code quality

### 7. Logging

Prefer `debug` over raw `console.*` in app code; occasional audits help.

### 8. TODO comments

Periodic grep of `TODO`/`FIXME` in `src/`; many are small; prioritize by feature area.

### 9. Types: `User` vs `Profile`

Some historical conflation may remain; tighten over time when touching auth/profile code.

---

## Recently completed (verified March 2026)

- [x] **Call blocking** - `DMCallPermissions.ts` uses `user_blocks` with RLS; block checks are active (no longer “disabled pending RLS”).
- [x] **Mute / block from ActivityPub UI** - `useActivityPub` mute/block/unmute/unblock call `InteractionService` / DB (`user_mutes`, `user_blocks`).
- [x] **Lists** - `user_lists` + `loadLists` / CRUD in `useActivityPub`; `ListsView` loads via store.
- [x] **Thread edit UI** - `ThreadEditModal` wired from `ChannelSidebar.vue`.
- [x] **Voice channel name resolution** - prior “fetch all channels” FIXME in `unifiedVoiceChannel.ts` is gone; names come from `serverChannelStore` / channel objects.
- [x] **Core service split** - `src/services/core/index.ts` exports CoreMessage, CorePost, CoreProfile, CoreInteraction services (module comment updated to match).
- [x] **Docs / self-host** - Compose reflects `federation-server`, `federation-worker`, Redis, profiles (`docker-compose.prod.yml` / `docker-compose.full.yml`).

---

## Parking lot / federation standards

- Channel/category “double refresh” (realtime + client) - investigate if still reproducible.
- Thread list caching parity with channels.
- FEP / `harmony:ChatServer` / `/.well-known/harmony-instance` - see [`docs/ACTIVITYPUB_EXTENSIONS.md`](docs/ACTIVITYPUB_EXTENSIONS.md).

---

*Update this file when you close or reopen an item.*
