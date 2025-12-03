# Harmony - Technical Debt & Future Improvements

## Connection Management Cleanup (Completed 2024)

We removed over-engineered connection management that was causing issues:
- SessionHeartbeat (disabled - use Supabase Presence instead)
- Custom retry/timeout logic in queries
- Visibility change handlers
- Auth event revalidation for same user

**Philosophy:** Trust Supabase to handle its own connections.

---

## Future Considerations

### 1. Smart Push Notifications
**Current state:** SessionHeartbeat disabled, push notifications not configured.

**When implementing:**
- Use Supabase Presence to track user's current view context
- Backend checks presence before sending push (don't notify if user is viewing that chat)
- NO custom heartbeat needed - presence handles it

### 2. Query Retry Logic
**Current state:** Removed timeouts and retries from CoreMessageService/CorePostService.

**If queries genuinely hang in production:**
- Add simple retry (without aggressive timeouts)
- Consider AbortController for user-initiated cancellation
- Don't add visibility-based recovery

### 3. Offline/Away Status Tracking
**Current state:** ActivityTracker works independently, status updates via presence.

**Working flow:**
1. ActivityTracker detects inactivity → emits `status-should-change`
2. userDataService.handleAutomaticStatusChange() updates status
3. Presence channel broadcasts change
4. On activity resume → handleActivityResumed() restores status

---

## Files Simplified

| File | What was removed |
|------|------------------|
| `SessionHeartbeat.ts` | Periodic RPC calls, device detection, context tracking |
| `supabase.ts` | Connection health tracking, recovery functions |
| `RealtimeConnectionManager.ts` | Visibility handlers, aggressive health checks |
| `userDataService.ts` | Presence throttling, heartbeat presence tracking |
| `CoreMessageService.ts` | Query timeouts, retry with connection refresh |
| `CorePostService.ts` | Query retry wrapper |
| `auth.ts` | Auth event revalidation for same user |

---

## Testing Notes

After these changes, verify:
- [ ] Tab switching doesn't break queries
- [ ] Away/Online status transitions work
- [ ] MFA still enforced for new logins
- [ ] Presence shows correct online/offline status
- [ ] Messages load after being idle

---

## Voice Chat Improvements

### Screenshare Rework (Discord-Style)

**Current state:** Screenshare replaces camera track, automatically shown to all users.

**Discord approach:**
1. **Separate Streams**: Camera and screenshare are independent tracks - user can have both active
2. **Viewer Opt-in**: Others click to "join" and watch a screenshare (not automatic)
3. **Viewer List**: Shows who's currently watching your stream
4. **Quality Selection**: Before sharing, choose settings:
   - Resolution: 720p, 1080p, 4K (Source)
   - Frame rate: 15fps, 30fps, 60fps
   - Preset modes: Gaming (high FPS), Screenshare (high quality/low FPS), Custom
5. **Source Selection**: Application window picker vs entire screen
6. **Stream Controls**: Pause/resume, quality adjustment mid-stream

**Implementation tasks:**
- [ ] Modify LiveKit service to handle multiple video tracks per user (camera + screen)
- [ ] Create screenshare picker UI with quality options
- [ ] Add "Go Live" button and stream announcement
- [ ] Implement viewer subscription system (opt-in to watch)
- [ ] Add viewer list panel showing who's watching
- [ ] Create separate PIP/focus handling for screenshares vs cameras
- [ ] Add stream quality indicator for viewers

**Files to modify:**
- `src/services/livekitWebRTC.ts` - Multi-track handling
- `src/stores/unifiedVoiceChannel.ts` - Screenshare viewer state
- `src/components/voice/UnifiedVoiceOverlay.vue` - Screenshare picker UI
- `src/components/voice/UnifiedVoiceUserCard.vue` - Separate video/screen display
- New: `src/components/voice/ScreensharePicker.vue` - Quality/source selection
- New: `src/components/voice/ViewerList.vue` - Who's watching panel

---

## Federation: Channel Messages (Dec 2025) ✅

**Status: WORKING** - Channel message federation between Harmony instances is functional!

### What's Implemented:
- ✅ **Server Join/Leave** - Users can join remote servers via invite links
- ✅ **Channel Messages** - Create, Edit, Delete federated in real-time
- ✅ **Reactions** - Emoji reactions federated to all server members
- ✅ **Multi-Instance Relay** - When Instance B sends to Instance A (server host), A re-broadcasts to Instance C, D, etc.
- ✅ **Immediate Delivery** - Database triggers queue pg-boss jobs instantly (no sweep delay for new messages)
- ✅ **Sweep Fallback** - pg-boss sweep catches any missed items every 10 seconds

### Required SQL Migrations (run on ALL instances):

```bash
# Run these in order on each Harmony instance's database:
psql -f db_schema/20251203_add_federation_status_to_channels.sql
psql -f db_schema/20251203_fix_remote_server_channels_trigger.sql
psql -f db_schema/20251203_add_channel_message_federation_trigger.sql
psql -f db_schema/20251203_fix_channel_message_federation_trigger.sql
psql -f db_schema/20251203_fix_messages_updated_at_default.sql
psql -f db_schema/20251203_add_channel_message_edit_delete_triggers.sql
```

### Architecture:
```
User sends message → DB Trigger → pgboss.job (immediate)
                          ↓
                    pg-boss worker → DeliveryQueue → Remote instance inbox
                          ↓
                    federation_status = 'completed'
```

### Key Files:
- `federation-backend/src/listeners/ChannelMessageHandler.ts` - Outbound message federation
- `federation-backend/src/activitypub/ServerInboxHandler.ts` - Inbound processing + re-broadcast
- `federation-backend/src/queue/QueueManager.ts` - pg-boss job handling
- `db_schema/20251203_*.sql` - Database triggers for immediate queueing

---

## Federation: Docker Supabase Realtime Issue (Lower Priority Now)

**Current state:** When running in Docker, Supabase Realtime WebSocket connection times out:
```
📡 Realtime subscription status: TIMED_OUT
❌ Database listener timed out
```

**Status (Dec 2025):** This is now a **lower priority** because we added database triggers that immediately queue pg-boss jobs. Federation works WITHOUT Realtime!

**If you want truly hybrid mode (Realtime + pg-boss fallback):**
1. Run `db_schema/20251204_hybrid_federation_triggers.sql` - Changes triggers to NOT queue immediately
2. Fix Supabase Realtime connection in Docker
3. Modify `federation-backend/src/index.ts` to start BOTH DatabaseListener AND QueueManager
4. DatabaseListener handles immediate delivery, pg-boss sweep catches any missed

**Root cause investigation (if desired):**
1. Is `supabase-realtime` container healthy and accepting WebSocket connections?
2. Does the WebSocket URL require authentication headers?
3. Is there a network/DNS issue between federation-backend and supabase-realtime containers?

**Files involved:**
- `federation-backend/src/listeners/DatabaseListener.ts` - Realtime subscription
- `federation-backend/src/config/supabase.ts` - Supabase client setup
- `federation-backend/src/queue/QueueManager.ts` - pg-boss sweep

---

## Federation Backend URL Configuration (Future)

**Current state:** Federation backend is accessed via relative path `/api/federation`, proxied by nginx.

**Simplified approach (Dec 2025):** Removed `VITE_FEDERATION_BACKEND_URL` and `VITE_FEDERATION_URL` env vars. All federation API calls now use `/api/federation/...` which nginx routes to the backend.

**If split-domain hosting is needed later:**
1. Option A: Just configure nginx to proxy `/api/federation` to a different server
2. Option B: Re-add configurable URL via:
   - Instance config in DB (`instance_config` table)
   - Load config on app init, store in a composable/store
   - Use that URL as base for federation calls

**Note:** The `link_preview_backend_url` in `federation_settings` is still needed! Database functions like `fetch_remote_link_preview()` use it for server-to-server HTTP calls (pg_http can't use relative paths). Only the frontend code was simplified to use relative paths.

---

## Federation: Remaining Work (Future)

### Voice Channel Federation
**Status:** Core implementation done (Dec 2025), needs testing and refinement

**What's implemented:**
- ✅ `harmony:VoiceChannelJoin` / `harmony:VoiceChannelLeave` activities
- ✅ `harmony:VoiceChannelJoinAccept` with LiveKit token exchange
- ✅ `voice_channel_participants` table for tracking federated users
- ✅ pg-boss triggers: `federate-voice-join`, `federate-voice-leave`
- ✅ Frontend handling for federated voice (token subscription via Realtime)

**Future optimization - Merge voice presence tracking:**
Currently we have both `user_presence` (with `voice_channel_id`) and `voice_channel_participants`.
Consider merging into a unified approach:
- Add federation columns to `user_presence` instead of separate table
- Federation triggers only fire when server has `federation_enabled = true`
- Non-federated instances stay pure realtime/in-memory for speed

**Files:**
- `federation-backend/src/activitypub/VoiceActivityHandler.ts` - Full handler
- `federation-backend/src/queue/handlers/voiceHandler.ts` - pg-boss job handler
- `src/stores/unifiedVoiceChannel.ts` - Federated voice join flow
- `db_schema/20251204_add_voice_federation_tables.sql` - Voice federation schema

### DM Federation
**Status:** Partially working via standard ActivityPub private visibility

**What's needed:**
- Test DMs between users on different instances
- Ensure E2E encryption works across federation (if enabled)

---

## Server Ownership Transfer (Future)

**Current state:** Server owners cannot leave their own servers. There's no way to transfer ownership.

**Implementation needed:**
1. **Transfer Ownership UI**: In Server Settings, add "Transfer Ownership" option (dangerous action with confirmation)
2. **Transfer Process**:
   - Owner selects a new owner from server members
   - Confirmation dialog explaining the consequences
   - Atomic transfer of `servers.owner` field
   - New owner gets admin role automatically
   - Old owner gets demoted to member (or admin if they had that role)
3. **Federation Considerations**:
   - If server is federated, broadcast ownership change to remote members
   - New owner's federated ID becomes the server's `attributedTo`

**Files to modify:**
- `src/components/settings/ServerAdvancedSettings.vue` - Add transfer UI
- `src/stores/server.ts` - Add `transferOwnership` action
- Database: `servers.owner` field update RPC
- Federation: Update `GroupService.ts` to reflect new owner in AP responses




--- 

Uncategorized:

✓ 1318 modules transformed.
node_modules/@protobufjs/inquire/index.js (12:18): Use of eval in "node_modules/@protobufjs/inquire/index.js" is strongly discouraged as it poses security risks and may cause issues with minification.