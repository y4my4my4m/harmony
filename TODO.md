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

