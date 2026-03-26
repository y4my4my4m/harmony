# Harmony - Technical Debt & Future Improvements

> **Canonical roadmap:** use **[TODO_latest.md](./TODO_latest.md)** for the current technical-debt list and priorities. This file keeps older “completed work” notes and historical context.

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

### 4. Federation Security Model

**How federated authentication works (ActivityPub standard):**

1. **HTTP Signatures** - Every ActivityPub request is signed with the sender's private key
2. **Public Key Verification** - We fetch the actor's public key from their server (over HTTPS) and verify the signature
3. **Actor Matching** - The `actor` in the activity must match the signing key's owner (prevents impersonation)
4. **Digest Verification** - Body hash in `Digest` header must match actual body content

**Two authentication domains:**

| Domain | Authentication | Identity Column | Used By |
|--------|----------------|-----------------|---------|
| Local Users | Supabase Auth JWT | `profiles.auth_user_id` | Frontend → Supabase (RLS policies use `auth.uid()`) |
| Federated Users | HTTP Signatures | `profiles.federated_id` | Remote Server → Federation Backend (service_role bypasses RLS) |

**Key points:**
- `profiles.id` = UUID, exists for ALL users (local and federated)
- `profiles.auth_user_id` = Only for LOCAL users (links to `auth.users`)
- `profiles.federated_id` = ActivityPub actor URL (e.g., `https://remote.server/users/alice`)
- RLS policies with `auth.uid()` ONLY apply to direct Supabase client calls
- Federation backend uses `service_role` key → bypasses RLS entirely
- Federation handlers look up users by `federated_id`, not `auth_user_id`

**Config:**
- `REQUIRE_VALID_SIGNATURES=true` (default) - Reject unsigned/invalid signature activities
- `REQUIRE_VALID_SIGNATURES=false` - Development mode, accept all (DANGEROUS in production!)

**Files:**
- `federation-backend/src/activitypub/SignatureService.ts` - Sign outgoing, verify incoming
- `federation-backend/src/activitypub/InboxHandler.ts` - Entry point, signature verification
- `federation-backend/src/config/index.ts` - REQUIRE_VALID_SIGNATURES setting

---

### 5. Rich Presence / Activity Status (Future Enhancements)

**Current state (Dec 2025):** Basic custom status with activity types implemented.
- ✅ Custom status text + emoji + expiration
- ✅ Manual activity types: playing, listening, watching, competing, streaming, custom
- ✅ Federation via ActivityPub actor attachments
- ✅ Database persistence with `profiles.custom_status` JSONB column

**Future enhancements (require additional work):**

#### A. OAuth-Based Integrations (PWA-Compatible)
*Fetch "now playing" from external services via their APIs:*
- **Spotify Integration**: User connects Spotify account, fetch currently playing track
- **Last.fm Integration**: Scrobbling history / currently listening
- **YouTube Music / Apple Music**: If APIs available
- **Implementation**: Store OAuth tokens in DB, background fetch/webhook for "now playing"

#### B. Tauri-Based Automatic Detection (Desktop App Only)
*Requires Tauri desktop client for OS-level access:*
- **Game/App Detection**: Enumerate running processes, match against game database
- **Discord-style Automatic "Playing X"**: Detect games via:
  - Steam integration (requires Steam API)
  - Running process names (fuzzy match against known games)
  - Window titles
- **Local Media Players**: Detect Spotify desktop, VLC, etc.
- **Streaming Detection**: Detect OBS/Streamlabs running
- **Implementation**: Tauri Rust sidecar for process enumeration, IPC to frontend

#### C. Enhanced Status Display
- **Elapsed Time**: "Playing for 2h 30m"
- **Party Info**: "In a party with @user1, @user2"
- **Invite Links**: "Join Game" buttons for supported games
- **Rich Assets**: Game icons, album art, etc.

**Files involved:**
- `src/services/userDataService.ts` - setRichPresence(), getUserCustomStatus()
- `src/types.ts` - CustomUserStatus, RichPresenceStatus types
- `db_schema/20251207_add_custom_status.sql` - Database schema
- Future: `src/services/SpotifyIntegration.ts`, `src-tauri/src/activity_detector.rs`

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

## Voice/Video Chat E2EE (End-to-End Encryption)

**Status:** ❌ NOT ACTIVE - Infrastructure exists but E2EE is not enabled

### Current Situation

Both P2P and LiveKit modes have E2EE infrastructure code, but it's **not actually enabled**:

**P2P Mode (`unifiedWebRTC.ts`):**
- ✅ `WebRTCEncryptionService` exists with AES-GCM frame encryption
- ✅ Insertable Streams support (`encodedInsertableStreams` option)
- ✅ Participant encryption add/remove hooks
- ❌ `encryptionEnabled` flag is always `false`
- ❌ No key exchange mechanism implemented
- ❌ Uses "temporary keys" fallback (not real E2EE)

**LiveKit Mode (`livekitWebRTC.ts`):**
- ✅ `ExternalE2EEKeyProvider` imported from livekit-client
- ✅ `enableE2EE()` / `disableE2EE()` methods exist
- ❌ E2EE options commented out in Room creation
- ❌ `enableE2EE()` is never called anywhere
- ❌ No shared key generation/exchange

### Current Security Level

| Mode | Transport Security | Server Visibility | True E2EE |
|------|-------------------|-------------------|-----------|
| **P2P** | ✅ DTLS-SRTP | N/A (no server) | ❌ Not active |
| **LiveKit SFU** | ✅ DTLS-SRTP | ⚠️ Server can decode | ❌ Not active |

**Note:** WebRTC always encrypts media in transit (DTLS-SRTP). The issue is that without E2EE, the LiveKit SFU server can technically access the media.

### Implementation Tasks

**Phase 1: P2P E2EE (simpler, no server trust issue)**
- [ ] Add `enableEncryption()` method to `UnifiedWebRTCService`
- [ ] Implement proper key derivation using existing Signal Protocol infrastructure
- [ ] Exchange encryption keys via signaling channel (encrypted with Signal session)
- [ ] Actually call encryption setup when `encryptionEnabled = true`
- [ ] Add UI toggle in Voice Settings panel

**Phase 2: LiveKit E2EE (requires all clients to support it)**
- [ ] Uncomment and configure E2EE in Room creation
- [ ] Generate shared room key (could use room ID + server secret as seed)
- [ ] Distribute room key to participants via secure channel
- [ ] Call `enableE2EE(sharedKey)` when joining room
- [ ] Handle key renegotiation when participants join/leave
- [ ] Add E2EE indicator in voice overlay (lock icon)

**Phase 3: Federation-aware E2EE**
- [ ] Key exchange across instances for federated voice
- [ ] Consider how to handle mixed E2EE/non-E2EE participants

### Key Files

- `src/services/unifiedWebRTC.ts` - P2P WebRTC service
- `src/services/livekitWebRTC.ts` - LiveKit SFU service  
- `src/services/encryption/WebRTCEncryptionService.ts` - Frame encryption (exists but unused)
- `src/services/encryption/SignalProtocolService.ts` - Could be used for key exchange
- `src/components/voice/VoiceSettingsPanel.vue` - Needs E2EE toggle
- `src/stores/unifiedVoiceChannel.ts` - Voice state management

### References

- [LiveKit E2EE Documentation](https://docs.livekit.io/realtime/client/e2ee/)
- [WebRTC Insertable Streams](https://developer.mozilla.org/en-US/docs/Web/API/RTCRtpScriptTransform)
- Existing `WebRTCEncryptionService.ts` uses AES-256-GCM with counter-based IV

---

## Federation: Server Actor for Signing (Future)

**Current state:** Server-level ActivityPub activities (accepts, re-broadcasts, voice tokens) are signed using the **server owner's** keypair.

**Why this works but isn't ideal:**
- When Bob joins a voice channel on Alice's server, the `VoiceChannelJoinAccept` is signed by Alice
- This is semantically odd: the *server* is accepting, not Alice personally
- Same pattern for message re-broadcasts, membership accepts, etc.

**Better approach - Dedicated Server Actor:**
Like Mastodon's "instance actor", each server would have its own AP identity:
- `https://example.com/servers/{uuid}` as the actor URL
- Own public/private keypair stored in `servers` table
- Server-level activities signed by the server itself, not the owner

**Implementation:**
1. Add `public_key`, `private_key` columns to `servers` table
2. Generate keypair on server creation
3. Create `ServerActorService.ts` to handle server-level signing
4. Update `DeliveryQueue` to accept server ID and use server keys when appropriate
5. Modify all server-level activity creation to use server actor as `actor`

**Benefits:**
- Semantically correct: server actions come from the server
- Owner can transfer without breaking signatures
- Clearer audit trail (user actions vs server actions)
- Matches ActivityPub Group semantics better

**Files to modify:**
- `db_schema/` - Add keypair columns to servers table
- `federation-backend/src/services/ServerActorService.ts` (new)
- `federation-backend/src/activitypub/DeliveryQueue.ts` - Support server signing
- `federation-backend/src/activitypub/VoiceActivityHandler.ts` - Use server actor
- `federation-backend/src/activitypub/ServerInboxHandler.ts` - Use server actor

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

---

Federated reactions in chat (just like everywhere else) as ephemeral, we should find a proper solution to make them permanent.

---

RLS permission for select and stuff, we can't allow users to fetch more than they should be able to (could be kind of DDoS attacked that way)

---

Some settings (like audio/video preferences or privacy) are only saved in localStorage, we should move them to the database.

---

Clean tables/views

federation_health (table)
federation_health_metrics (view)
federation_stats (view)
performance_metrics (table)
performance_metrics_hourly (view)
slow_queries (table)

Also some of those are probably already available via supabase, are we being redundant?