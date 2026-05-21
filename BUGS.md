# Harmony Codebase — Bug & Issue Audit

**Audit date:** 2026-05-20
**Scope:** Full codebase (~568K LOC across `src/`, `federation-backend/`, `bot-gateway/`, `bot-plugins/`, `webrtc/`, `db_schema/`)
**Method:** 8 parallel read-only investigations, each focused on an independent subsystem.

This document lists **real defects** (not TODOs, not style). Items are grouped by severity, with cross-cutting patterns called out first.

---

## Cross-cutting patterns

Three patterns recur across multiple subsystems and account for ~25% of all findings. Fixing the pattern once eliminates many individual bugs.

### Pattern A — Auth UUID vs Profile UUID confusion (security-critical)

`profiles.id` (`gen_random_uuid()`) and `auth.users.id` (Supabase auth UUID) are **different**. Many call sites pass the wrong one, causing features to silently fail or fail-open.

| Site | File / lines | Effect |
|------|--------------|--------|
| Block/mute load | `src/stores/useActivityPub.ts` | `isBlocked` / `isMuted` always false; blocked content keeps showing |
| Admin permissions check | `src/services/AdminService.ts` (caller `AdminPanel.vue`) | `checkAdminPermissions` always false on direct call |
| Admin audit log | `src/services/AdminService.ts` | `admin_audit_log.admin_id` written with auth UUID where FK expects profile UUID |
| Reports | `src/services/ReportService.ts` | Inserts fail RLS or behave inconsistently; `getMyReports` filters wrong id |
| Invites | `src/services/inviteService.ts`, `src/components/InviteAccept.vue` | Membership inserts with wrong id; FK / RLS failure |
| Global call accept/decline | `src/layouts/BaseLayout.vue` | Breaks `activeCalls.participants` tracking and teardown |
| DM call signal handler | `src/components/dm/DMHeader.vue` | Permission checks query wrong row; self-filter never matches |
| Router admin guard | `src/router/index.ts` | `authStore.user?.id` is always undefined; guard relies on stale client flags |

**Suggested sweep:** Audit every `session?.user?.id` / `user.id` reference. Replace with `authContextService.getCurrentProfileId()` wherever the destination column references `profiles(id)`.

---

### Pattern B — Logout / cleanup incompleteness

`auth.ts:logout()` does not reset numerous in-memory caches/subscriptions. On a shared device, the next user can see/use the previous user's data.

| Resource | File / lines | Effect |
|----------|--------------|--------|
| Voice channel state | `src/stores/unifiedVoiceChannel.ts` | Persisted to global `localStorage`. Next user **auto-rejoins previous user's voice channel** |
| ActivityPub graph | `src/stores/useActivityPub.ts` | `followedUsers`, `blockedUsers`, `mutedUsers`, `followsLoaded` flag retained |
| Server users cache | `src/stores/useServerUsers.ts` | `userProfiles`, `usersInVoiceChannels`, `onlineUsers` Maps retained |
| Reactions | `src/stores/useReactions.ts`, `src/stores/postReactions.ts` | Maps retained; `setInterval(30s)` not stopped |
| Permission cache | `src/composables/useServerPermissions.ts` | Module-level caches survive logout |
| DND interval | `src/stores/useNotification.ts` | Not cleared by `cleanupBroadcastHandlers` |
| `StatusLifecycleDebugger` | `src/services/StatusLifecycleDebugger.ts vs 53-66` | Anonymous listeners can never be removed (refs not stored) |
| Tab-close presence | `src/stores/auth.ts` | `__harmonyPresenceCleanup` referenced but never assigned |

**Suggested sweep:** Extend `auth.ts:logout()` to:
1. `await unifiedVoiceStore.leaveVoiceChannel()` + `clearVoiceChannelState()`
2. `activityPubStore.resetFeedsAndRelationships()`
3. Clear reactions / postReactions Maps + stop reconcile interval
4. Clear `useServerUsersStore` Maps
5. Clear permission/role caches keyed by session id

Also assign a working `__harmonyPresenceCleanup` in `userDataService.init()` that untracks from all presence channels.

---

### Pattern C — MFA bypass paths in `stores/auth.ts`

`validateSessionForMFA()` exists and is sound, but multiple code paths assign `this.session` without invoking it.

| Path | Location | Risk |
|------|----------|------|
| `INITIAL_SESSION` event | `src/stores/auth.ts` | Logged-out tab adopts another tab's AAL1 session on startup |
| Catch-all (`TOKEN_REFRESHED` / unknown) | `src/stores/auth.ts` | Any unhandled event with a stored session becomes "logged in" |
| 5s session cache hit | `src/stores/auth.ts` | Skips re-validation when storage changed in another tab |
| OAuth callback | `src/views/AuthCallbackView.vue` | Sets session directly, bypasses `onAuthStateChange` SIGNED_IN |
| Recovery code login | `src/components/AuthComponent.vue` | `mfa.unenroll` + set AAL1 session = MFA removed by one recovery code |

---

## Critical (security / data corruption — fix ASAP)

### C1. Federation — same-domain signature delegation enables cross-user impersonation

**File:** `federation-backend/src/activitypub/SignatureService.ts`

`verifyActorMatch()` returns true when `activity.actor` and the signing key owner share a hostname. An attacker who can legitimately sign as `https://evil.social/users/alice` can set `activity.actor` to `https://evil.social/users/bob` and pass verification. `processCreate()` then stores posts under the victim's identity.

**Fix:** Require exact actor/signer match for `Person` actors. Only relax for `Group`/`Service` after explicit delegation proof (actor doc lists authorized signers).

---

### C2. Federation — Update/Delete activities don't verify object ownership

**File:** `federation-backend/src/activitypub/ActivityProcessor.ts` (`processUpdate`), `1009-1038` (`processDelete`)

Handlers key on `object.id` / `objectUrl` only. A valid signature as user A is enough to update Bob's profile, edit any post with known `ap_id`, or soft-delete any message with matching `ap_id`.

**Fix:** Require `normalizeActor(activity.actor)` to match the object owner (`object.id` for Person, post `author_id` resolved from `ap_id`). Return 403 on mismatch.

---

### C3. Federation — LiveKit token mints for arbitrary `actorId`

**File:** `federation-backend/src/routes/livekit.ts`

HTTP signature is verified, but `verifyActorMatch(actorId, verification.actorUrl)` is **never called**. An attacker signs as themselves and requests a token for a victim's actor URL.

**Fix:** After `verifySignature`, require `verifyActorMatch(actorId, verification.actorUrl)` (strict for `Person`). Use `verification.actorUrl` as identity source of truth.

---

### C4. Bot gateway — unauthenticated `/bridged-users/:channelId` endpoint

**File:** `bot-gateway/src/index.ts` (public via `dev/nginx-harmony.conf:179-184`)

No authentication. Anyone reachable can enumerate Discord user IDs / usernames / display names / avatars for any Harmony channel ID. `/status` (lines 58–69) similarly leaks connected bot inventory.

**Fix:** Require session / signed token; verify caller may read that channel; do not expose on the public internet without auth.

---

### C5. E2EE — WebRTC "E2EE" keys never agreed between peers

**File:** `src/services/encryption/WebRTCEncryptionService.ts`

When a Signal session exists, each side derives media keys from local `call-key-${Date.now()}`. The `encryptMessage` result is never exchanged over signaling. Temporary-key fallback uses `temp-${participantId}-${Date.now()}`, also local-only. Alice and Bob use **different** AES keys; decrypt fails or media is effectively unprotected while the UI shows E2EE enabled.

**Fix:** Exchange key material over authenticated signaling (derive from a completed Signal session, or use DTLS-SRTP with verified fingerprints). Do not call E2EE "active" until both sides confirm the same key.

---

### C6. E2EE — Signal identity private keys stored on server in plaintext

**Files:**
- `src/services/encryption/MessageEncryptionService.ts`
- `src/components/encryption/KeySetupWizard.vue`

`setupEncryption` passes `identityKeyPair.privateKey` (raw base64) into `initialize_user_encryption` without wrapping with the user password or recovery key. Any DB/RLS leak exposes long-term Signal identity keys for affected users.

**Fix:** Encrypt the private key client-side before RPC (same pattern as `MegolmMessageEncryptionService.encryptPrivateKeyForStorage`), or retire the wizard in favor of Megolm + recovery-key setup and migrate existing rows.

---

### C7. E2EE — hybrid "self" entries store AES content key in plaintext message metadata

**File:** `src/services/encryption/MessageEncryptionService.ts`

For self-recipients, the AES-GCM content key is stored as cleartext inside `encryption_metadata.encrypted_keys`. Any reader of the message row (channel members, server, DB) can decrypt. Defeats E2EE for hybrid legacy messages that include the sender in `encrypted_for`.

**Fix:** Never store cleartext keys in message metadata; always wrap with Signal, or omit the self entry and rely on local/session state.

---

### C8. E2EE — `user_key_pairs` RLS exposes wrapped private keys to every authenticated user

**File:** `db_schema/init/31_rls_policies_extended.sql`

Policy `"Users can view others' public keys for encryption"` is row-wide. PostgreSQL RLS cannot hide columns, so `identity_private_key_encrypted` and `identity_signing_private_key_encrypted` are readable by any logged-in user via direct API queries. Megolm wraps these with recovery-key AES-GCM, but ciphertext is still harvestable for offline attack; legacy Signal rows may be plaintext (C6).

**Fix:** Split public vs private into separate table/view; restrict private columns to `auth.uid() = owner`; or use a `SECURITY DEFINER` RPC that returns only public fields.

---

### C9. Auth — profile privilege escalation via self-update

**Files:**
- `db_schema/init/30_rls_policies.sql`
- `src/services/AdminService.ts` (shows `is_moderator` is client-writable in principle)

`profiles_update_own` allows `UPDATE` on own row with no column restrictions. Any authenticated user can call Supabase with `{ is_admin: true, is_moderator: true }` on their own profile. RLS uses `is_current_user_admin()` / `is_current_user_moderator()` which read these flags → escalation.

**Fix:** Add a `BEFORE UPDATE` trigger on `profiles` rejecting changes to `is_admin`, `is_moderator`, `is_suspended`, `force_sensitive`, `is_silenced` unless `is_current_user_admin()`. Restrict admin updates to `SECURITY DEFINER` RPCs.

---

### C10. Auth — all server invites readable by any authenticated user

**File:** `db_schema/init/30_rls_policies.sql`

`invites_select_all` is `FOR SELECT USING (true)` with no role/server filter. Any logged-in user can `SELECT * FROM invites` and harvest codes, expiration, and `max_uses`.

**Fix:** Restrict SELECT to server members, invite creators, or a dedicated `accept_invite` RPC. Remove public read on `code`.

---

### C11. Auth — MFA bypass paths

See cross-cutting pattern C above. Five distinct entry points where AAL1 session is accepted without `validateSessionForMFA()`.

---

### C12. Frontend — stored XSS in federated profile custom fields

**File:** `src/views/UserProfileView.vue`

`formatFieldValue` strips non-`<a>` tags but does **not** sanitize `href` (allows `javascript:`) or event attributes. A remote profile can deliver `<a href="javascript:...">` or `<a onclick="...">` that executes script when an admin/user views the profile.

**Fix:** Run field HTML through DOMPurify (allowlist `a[href]` with `http:`/`https:` only), or render via a safe linkify helper after escaping all HTML.

---

### C13. Realtime — `onReconnected` gap-fill never runs after online/visibility reconnect

**File:** `src/services/RealtimeConnectionManager.ts`

Gap-fill only fires when `retryCount > 0` at `SUBSCRIBED`. `forceReconnect()` and `forceReconnectAll()` (called on `window.online` and tab visibility) **reset `retryCount` to 0 before reconnecting**, so chat/DM message gap-fill in `useChat.ts` / `useDM.ts` does not run after sleep or network restore. **Users silently lose messages.**

**Fix:** Track `wasDisconnected` flag (or zero `retryCount` only after firing `onReconnected`). Fire `onReconnected` whenever status transitions to `SUBSCRIBED` after any non-intentional disconnect.

---

### C14. Realtime — server presence error recovery stacks duplicate channels

**File:** `src/services/userDataService.ts`

On `CHANNEL_ERROR`, `setupServerPresence()` schedules another `setupServerPresence()` after 5s without `removeChannel` / `unsubscribe` on the failed channel or cancelling prior retries. Every error adds another live Supabase channel; only the latest is stored on `context.channel`.

**Fix:** Before reconnecting, remove the old channel. Debounce retries per `serverId`. Bail if the context was unsubscribed.

---

## High (correctness / leaks / fail-open paths)

### Permissions & calls

| # | Bug | Location |
|---|-----|----------|
| H1 | `permissionsService.getUserPermissions` returns default permissions (including `SEND_MESSAGES`) on RPC error | `src/services/permissionsService.ts` |
| H2 | `useChannelPermissions.canViewChannel` always returns `true` (same for `canAccessChannel`) | `src/composables/useChannelPermissions.ts` |
| H3 | `useServerPermissions.canViewServerSettings` hardcoded `true` | `src/composables/useServerPermissions.ts` |
| H4 | `DMCallPermissions.canReceiveCall` fails open on any error | `src/services/DMCallPermissions.ts` |
| H5 | Federated incoming calls skip permission checks (no `canReceiveCall`) | `src/services/GlobalDMCallListener.ts` |
| H6 | `isUserBusy` checks server voice only — ignores DM/LiveKit calls | `src/services/DMCallPermissions.ts` |
| H7 | Caller never receives accept/decline if DM header unmounts | `src/services/DMCallSignaling.ts` + `src/components/dm/DMHeader.vue` |
| H8 | Recovery-code login disables MFA without AAL2 step-up | `src/components/AuthComponent.vue` |

### Encryption (legacy Signal path)

| # | Bug | Location |
|---|-----|----------|
| H9 | `isTrustedIdentity` always returns `true` (Signal trust-on-first-use disabled) | `src/services/encryption/EncryptionKeyStore.ts`, `EncryptionKeyStoreBrowser.ts` |
| H10 | Password-derived AES key stored extractable in `sessionStorage` | `src/services/encryption/EncryptionKeyStore.ts` |
| H11 | Megolm signing keys are server-authoritative (no client pinning) | `src/services/encryption/MegolmMessageEncryptionService.ts` |
| H12 | Megolm send allowed without per-message signature (v1 downgrade) | `src/services/encryption/MegolmMessageEncryptionService.ts` |

### Federation SSRF

| # | Bug | Location |
|---|-----|----------|
| H13 | `POST /resolve-post` accepts any URL — no SSRF check | `federation-backend/src/activitypub/ActorService.ts` |
| H14 | `POST /fetch-posts` fetches arbitrary `outbox_url` from body | `federation-backend/src/activitypub/ActorService.ts` |
| H15 | Widespread `fetch()` without SSRF on inbox resolution, actor refresh, reply-chain | `federation-backend/src/activitypub/ActivityProcessor.ts`, `ActorService.ts` (8+ sites), `ServerDiscoveryService.ts` |
| H16 | `instanceProbe` follows attacker-controlled NodeInfo `href` | `federation-backend/src/routes/instanceProbe.ts` |
| H17 | Inbox always re-processes activities (never marked `completed`) | `federation-backend/src/activitypub/InboxHandler.ts` |
| H18 | No HTTP `Date` skew check (replay window) | `federation-backend/src/activitypub/SignatureService.ts` |
| H19 | Body integrity not enforced when Digest omitted from signed headers | `federation-backend/src/activitypub/SignatureService.ts` |

### WebRTC / voice

| # | Bug | Location |
|---|-----|----------|
| H20 | P2P ICE candidates added with no queue / no `remoteDescription` check (frequent `InvalidStateError`) | `src/services/unifiedWebRTC.ts` |
| H21 | `AudioContext` leaked on every `setupAudioLevelMonitoring` call | `src/services/unifiedWebRTC.ts` |
| H22 | `updateInputDevice` kills mic on `getUserMedia` failure (old tracks stopped first, nothing restored) | `src/services/unifiedWebRTC.ts` |
| H23 | LiveKit `joinChannel` leaves orphan `Room` + listeners on failure | `src/services/livekitWebRTC.ts` |
| H24 | Call signaling started before voice join (ghost ringing on failure) | `src/components/dm/DMHeader.vue` |
| H25 | Duplicate `RTCPeerConnection` per user (always-create, never-check) | `src/services/unifiedWebRTC.ts` |

### Frontend XSS / URL handling

| # | Bug | Location |
|---|-----|----------|
| H26 | `javascript:` URLs in message links via `v-html` | `src/composables/useContentRenderer.ts` + `src/components/UnifiedContentRenderer.vue` |
| H27 | `javascript:` URLs in component-mode link bindings (raw `:href`) | `src/components/UnifiedMessageContent.vue` |
| H28 | File uploads have no client-side size/MIME limit (incl. SVG with embedded script) | `src/services/fileService.ts`, `src/components/MessageInput.vue` |

### Realtime / store state

| # | Bug | Location |
|---|-----|----------|
| H29 | `RealtimeConnectionManager` "already exists, reusing" ignores new handlers | `src/services/RealtimeConnectionManager.ts` |
| H30 | DM header unsubscribes wrong user on conversation switch | `src/components/dm/DMHeader.vue` |
| H31 | Tab close doesn't untrack Supabase presence (`__harmonyPresenceCleanup` unassigned) | `src/stores/auth.ts` |
| H32 | ActivityPub broadcast handlers dropped on leaving social layout | `src/layouts/SocialLayout.vue` + `src/stores/useActivityPub.ts` |
| H33 | Documented notification `postgres_changes` fallback never implemented | `src/stores/useNotification.ts` |
| H34 | Channel/DM pagination prepends wrong channel's messages (stale-ID guard only on initial load) | `src/stores/useChat.ts`, `src/stores/useDM.ts` |
| H35 | `getSortedConversations` mutates Pinia state in a getter (`.sort()` in place) | `src/stores/useDM.ts` |

### Bot infrastructure

| # | Bug | Location |
|---|-----|----------|
| H36 | Discord→Harmony message ID mapping broken (`result?.message?.id` vs `result?.id`) | `bot-plugins/discord-bridge/src/index.ts` + `bot-gateway/src/api/BotRestAPI.ts` |
| H37 | Unidirectional bridge config disables **both** directions when `bidirectional: false` | `bot-plugins/discord-bridge/src/ChannelMapper.ts` |
| H38 | `editMessage` requires `manage_messages` even for bot's own messages | `bot-gateway/src/api/BotRestAPI.ts` |
| H39 | Harmony WS client reconnects after intentional shutdown (no `shouldReconnect` flag) | `bot-plugins/discord-bridge/src/HarmonyClient.ts` |
| H40 | Any bot can poison bridge cache for arbitrary channels | `bot-gateway/src/gateway/WebSocketGateway.ts` |
| H41 | Discord mention resolution can ping wrong user (username-only cache) | `bot-plugins/discord-bridge/src/index.ts` + `MessageTranslator.ts` |
| H42 | Unresolved plain-text `@mentions` create bogus Harmony mentions | `bot-plugins/discord-bridge/src/MessageTranslator.ts` |

### Lifecycle / leaks

| # | Bug | Location |
|---|-----|----------|
| H43 | `useFloatingVideo.registerVideo` calls `onUnmounted` outside `setup()` (silently no-ops; observers leak per chat message/embed) | `src/composables/useFloatingVideo.ts` + `src/components/UnifiedMessageContent.vue` + `src/components/embeds/ProviderEmbedSwitch.vue` |
| H44 | App-wide haptic listeners never removed (four document.click handlers stack on remount) | `src/App.vue` |
| H45 | ActivityPub user search: `AbortController` created but signal never passed to API | `src/composables/useAutoSuggest.ts` |
| H46 | User search modal: no abort/sequence guard → stale results overwrite newer | `src/components/activitypub/UserSearchModal.vue` |
| H47 | `useMessageSearch` debounce + AbortController not cleared on dispose | `src/composables/useMessageSearch.ts` |

### Reports / IDs

| # | Bug | Location |
|---|-----|----------|
| H48 | Invite usage update blocked for accepter by RLS — `max_uses` not enforced atomically | `src/services/inviteService.ts` + `db_schema/init/30_rls_policies.sql` |
| H49 | `verify_recovery_code` has no caller binding — DoS another user's codes | `db_schema/init/13_functions_rpc_extended.sql` (callers: `AuthComponent.vue`, `ResetPasswordView.vue`) |
| H50 | Permission caches survive logout (shared device) | `src/composables/useServerPermissions.ts` + `src/stores/auth.ts` logout flow |

---

## Medium

### Encryption

- M1. Hybrid encrypt marks message encrypted even when some recipients have no key — `MessageEncryptionService.ts`
- M2. Megolm encrypt proceeds after `ensureSessionShared` failures (new members get undecryptable messages) — `MegolmMessageEncryptionService.ts`
- M3. Prekey rotation: delete-then-upload TOCTOU window (concurrent setups fail) — `MessageEncryptionService.ts`
- M4. `resetEncryption` doesn't clear signing keys in IndexedDB — `MegolmMessageEncryptionService.ts`
- M5. `messageDecryption` overloads `sender_verified: false` on any decrypt error — `src/utils/messageDecryption.ts`
- M6. No replay resistance for Megolm v2 at application layer — `src/services/encryption/MessageSigner.ts` `SignedMessageFields`

### Realtime / stores

- M7. `PostReactionsRealtime` global refCount vs per-post Set mismatch — `src/services/PostReactionsRealtime.ts`
- M8. `useTypingIndicator` can skip subscription after context change — `src/composables/useTypingIndicator.ts`
- M9. `UserEventChannel` has no online/visibility reconnect — `src/services/UserEventChannel.ts` (whole file)
- M10. `subscribeToContext` skips user-list updates for existing context — `src/services/userDataService.ts`
- M11. `setupDndCheck` interval not cleared on logout — `src/stores/useNotification.ts`
- M12. `StatusLifecycleDebugger.stopDebugging` doesn't remove listeners added in `startDebugging` (refs not stored) — `src/services/StatusLifecycleDebugger.ts vs 53-66`
- M13. `GlobalDMCallListener` uses `unsubscribe()` without `removeChannel` — `src/services/GlobalDMCallListener.ts`
- M14. `useServerChannel` server-structure channel has no reconnect on error — `src/stores/useServerChannel.ts`
- M15. Logout/presence ordering: Redis offline before Supabase teardown — `src/stores/auth.ts` + `src/layouts/BaseLayout.vue`
- M16. `fetchMultiplePostReactions` drops concurrent post ID sets — `src/stores/postReactions.ts`
- M17. `toggleReaction` mutates shared optimistic objects — `src/stores/postReactions.ts`
- M18. `reactionsByPost` / `lastFetched` grow without eviction (post reactions have no TTL/size cap) — `src/stores/postReactions.ts`
- M19. `useReactions` 30s cleanup interval never stopped — `src/stores/useReactions.ts`
- M20. `verify2FA` timeout doesn't cancel in-flight MFA verify — `src/stores/auth.ts`
- M21. `loadBlockingData()` not awaited on login — `src/stores/auth.ts`
- M22. `StatePersistence.STATE_VERSION` constant defined but never persisted/checked — `src/services/StatePersistence.ts`

### WebRTC

- M23. P2P screen-share stop doesn't renegotiate after `removeTrack` — `src/services/unifiedWebRTC.ts vs 663-677`
- M24. LiveKit disconnect doesn't recover or refresh token — `src/services/livekitWebRTC.ts`
- M25. Group DM outbound calls: no per-receiver permission check — `src/components/dm/DMHeader.vue`
- M26. Mic test early stop leaves mic/camera hot (only timeout path stops them) — `src/components/voice/VoiceSettingsPanel.vue`, `src/components/settings/user/VoiceSettingsInline.vue`
- M27. P2P signaling has no sender authentication (broadcast trust) — `src/services/unifiedWebRTC.ts`
- M28. Double-ringing on multiple devices (no "answered elsewhere" cancel) — `src/services/DMCallSignaling.ts`

### Federation

- M29. Server inbox has no `ap_activities` dedup layer — `federation-backend/src/activitypub/GroupService.ts`
- M30. Race: duplicate posts on concurrent identical Create deliveries — `federation-backend/src/activitypub/ActivityProcessor.ts`
- M31. Inbox rate limit keyed by IP only, not remote instance — `federation-backend/src/middleware/rateLimit.ts`
- M32. 10 MB JSON body limit on inbox (should be ≤1 MB for AP) — `federation-backend/src/server.ts`
- M33. Reply-chain fetch cap without cycle detection — `federation-backend/src/activitypub/ActivityProcessor.ts`
- M34. Follow replay spams Accept to follower inbox — `federation-backend/src/activitypub/ActivityProcessor.ts`
- M35. `backfill-posts.ts` blindly overwrites post content — `federation-backend/backfill-posts.ts`
- M36. Private keys stored plaintext PEM in DB (no application-layer encryption) — `federation-backend/src/activitypub/SignatureService.ts`

### Bot

- M37. Rate-limit check is racy and fails open — `bot-gateway/src/auth/BotAuthMiddleware.ts`
- M38. `express-rate-limit` dependency unused — no IP/auth limits on HTTP surface — `bot-gateway/package.json:31`
- M39. `WS_MAX_CONNECTIONS_PER_BOT` configured but never enforced — `bot-gateway/src/config/supabase.ts`, `WebSocketGateway.ts`
- M40. No Discord/API 429 handling in bridge REST calls — `bot-plugins/discord-bridge/src/HarmonyClient.ts` (all `fetch`)
- M41. Unbounded in-memory message ID maps (memory leak) — `bot-plugins/discord-bridge/src/index.ts`
- M42. Event dispatcher leaks `setInterval` for `pollEditsAndDeletes` on shutdown — `bot-gateway/src/gateway/EventDispatcher.ts`
- M43. Gateway restart skips messages created during downtime — `bot-gateway/src/gateway/EventDispatcher.ts`
- M44. `getUser` has no server-scoped authorization — `bot-gateway/src/api/BotRestAPI.ts`
- M45. Discord channels not validated against configured guild — `bot-plugins/discord-bridge/src/index.ts`
- M46. Bull Board Basic auth breaks on passwords containing `:` — `bull-board/server.js`
- M47. Unhandled promise rejections don't exit (inconsistent w/ uncaught exceptions) — `bot-gateway/src/index.ts`
- M48. Concurrent async handlers → out-of-order bridging — `bot-plugins/discord-bridge/src/index.ts` (`messageCreate` paths)
- M49. Reactions bridged as the Harmony bot, not the Discord user — `bot-plugins/discord-bridge/src/index.ts`, `bot-gateway/src/api/BotRestAPI.ts`

### Frontend / Vue

- M50. `useDebounce` / `useDebouncedSearch` no unmount cleanup — `src/composables/useDebounce.ts`
- M51. `AudioThemeManager` `setInterval(5000)` never cleared — `src/components/settings/AudioThemeManager.vue`
- M52. `FilePreview` uses index keys during mutable upload list (wrong file removed on click) — `src/components/FilePreview.vue`
- M53. Upload progress simulated interval not cleared in `try/finally` — `src/services/fileService.ts`
- M54. Background upload mutates state after unmount — `src/components/MessageInput.vue`
- M55. Pixel-art upscale can OOM on decompression bombs — `src/services/emojiService.ts`
- M56. `downloadAndUploadImage` fetches arbitrary URLs client-side (SSRF/privacy) — `src/utils/fileUpload.ts`
- M57. `BaseModal` doesn't restore focus on close — `src/components/common/BaseModal.vue`
- M58. `UnifiedModal` focus trap is partial — `src/components/shared/UnifiedModal.vue`
- M59. Extension-based media detection (`isImageUrl`) is spoofable — `src/components/UnifiedMessageContent.vue`
- M60. `useAutoSuggest` debounce timer not cleared on scope dispose — `src/composables/useAutoSuggest.ts`
- M61. `UserSearchModal` debounce not cleared on unmount — `src/components/activitypub/UserSearchModal.vue`
- M62. `fileUpload.ts` allows `image/svg+xml` for avatars — `src/utils/fileUpload.ts`
- M63. `MessageSearchModal` recent searches use index keys — `src/components/search/MessageSearchModal.vue`

### Auth (medium)

- M64. Session cache path can skip MFA re-validation — `src/stores/auth.ts`
- M65. Registration sets session before email verification — `src/stores/auth.ts`
- M66. `AuthContextService` cache not cleared from auth store on logout — `src/services/AuthContextService.ts`
- M67. `AdminService` direct table writes depend entirely on RLS — multiple sites
- M68. `ReportService.updateReportStatus` sets `resolved_by` to auth UUID (pattern A) — `src/services/ReportService.ts`

---

## Low (notable but lower impact)

- L1. Debug logging may leak encryption metadata fragments — `MessageEncryptionService.ts`
- L2. HKDF ratchet uses fixed all-zero salt — `MegolmService.ts`
- L3. `useProfilePresence.ts` is empty — imports of `useProfilePresence` would fail
- L4. `ThreadFullView` / thread overlays lack `onReconnected` gap-fill — `src/views/ThreadFullView.vue`
- L5. `MonyFeed.vue` calls non-existent store methods (dead component) — `src/components/activitypub/MonyFeed.vue`
- L6. `RealtimeConnectionManager` health check ignores "stuck connecting" without `lastErrorAt` — `src/services/RealtimeConnectionManager.ts`
- L7. `useUndoRedo` pointer not adjusted when trimming from the front — `src/composables/useUndoRedo.ts`
- L8. `useNotification` getters call `useNotificationStore()` inside the store (re-entrancy) — `src/stores/useNotification.ts`
- L9. `spatialAudio` / voice Maps not cleared on logout — `src/stores/spatialAudio.ts`, `src/stores/unifiedVoiceChannel.ts`
- L10. `useFloatingVideo.startResize` may leak document listeners if torn down mid-resize — `src/composables/useFloatingVideo.ts`
- L11. `acceptCall` no-op if `activeCalls` entry missing (race) — `src/services/DMCallSignaling.ts`
- L12. `http:` allowed in `validateExternalUrl` — `federation-backend/src/utils/ssrfProtection.ts`
- L13. Inbox GET exposes stored remote activities without auth — `federation-backend/src/activitypub/InboxHandler.ts`
- L14. SHA-256 token hashing (DB docs say bcrypt) — `bot-gateway/src/auth/BotAuthMiddleware.ts` + `src/utils/botUtils.ts`
- L15. Dev error responses may leak internal messages — `bot-gateway/src/index.ts`
- L16. Verbose logging of message metadata/content — `bot-gateway/src/api/BotRestAPI.ts`
- L17. Bridge shutdown doesn't clear periodic user-refresh interval — `bot-plugins/discord-bridge/src/index.ts`
- L18. Supabase session persisted in `localStorage` (XSS-readable refresh token) — `src/supabase.ts`
- L19. `userStorage` falls back to global keys when no user is set — `src/utils/userScopedStorage.ts`
- L20. `SessionHeartbeat` is fully disabled — no server-side invalidation signal — `src/services/SessionHeartbeat.ts`

---

## What looked solid (worth noting)

- Megolm v2 verify-before-decrypt + signature binding to `sender_user_id` is correct
- `CoreMessageService` / `ThreadService` fail-closed on plaintext without explicit `allowPlaintextFallback`
- `get_user_prekey_bundle` atomic consumption with `FOR UPDATE SKIP LOCKED`
- Federation `DeliveryQueue` + `LinkPreviewService` use `validateExternalUrl`
- `voiceRecordingService.cleanup()` correctly stops tracks and closes contexts
- BullMQ federation worker has proper `attempts` / `backoff` / `removeOnComplete`
- `RealtimeConnectionManager.unsubscribe()` removes from map **before** `removeChannel` to avoid CLOSED-driven reconnect loops
- `moderate_user`, `kick_server_member`, `ban_server_member` use `SECURITY DEFINER` RPCs with server-side admin checks
- `set_instance_config` / `batch_set_instance_config` in `90_federation_functions.sql` correctly resolve admin via `auth.uid()`
- WebRTC frame encrypt/decrypt fail-closed (drops frames) — good
- Spatial audio `setupSpatialForUser` calls `removeUser` first — no node accumulation
- PTT release delay implemented in `useKeybinds.ts`
- Most `useEncryptionFallbackPrompt` paths require explicit `window.confirm`; `ENCRYPTION_REQUIRED` cannot be overridden

---

## Suggested fix order

1. **Auth UUID vs profile UUID sweep** (pattern A) — kills ~10 bugs at once, security-critical
2. **C-tier security set** (C1–C14) — federation impersonation, MFA bypass, RLS gaps, XSS in profile fields, message loss
3. **Logout cleanup sweep** (pattern B) — shared-device data leakage
4. **Permission fail-open fixes** (H1–H8) — UI fail-open patterns
5. **WebRTC lifecycle/leak fixes** (H20–H25, H43)
6. **Bridge bug fixes** (H36–H40) — broken in production today
7. **Pagination/state mutation** (H34–H35)
8. **SSRF lockdown** (H13–H16, M56) — central `safeFetch` helper
9. **E2EE remediation** (C5–C8, H9–H12) — design work needed; some may require migration

---

## Counts

| Severity | Count |
|----------|-------|
| Critical | 14 |
| High | 50 |
| Medium | 68 |
| Low | 20 |
| **Total** | **~152** |

Cross-cutting patterns (A/B/C) overlap with ~25 of the individual entries above.

---

# Performance addendum (added 2026-05-20)

**Method:** 8 parallel read-only investigations focused on **performance only** (CPU, memory, bundle, latency, scale ceilings). Items already documented above (notably H21–H25, H43–H47, M50–M55, M37–M49) are not re-listed unless there is an additional perf-at-scale dimension worth restating. Highest-impact claims (file sizes, polling intervals, hot-path linear scans, frame-rate crypto, RLS join cost, init-script vs dev-backup index drift) were spot-checked against the actual code; lower-confidence items are marked `[?]`.

This is **not** a load-test report. It is a code-level audit identifying patterns that will hurt at scale or already cost CPU/RAM today. Treat thresholds (e.g. "noticeable at 1k users") as informed estimates, not measured numbers — see `BENCHMARKING.md` for the layered measurement plan.

---

## Cross-cutting performance patterns

Six patterns recur across the codebase and account for the majority of high-severity findings. Fixing each pattern once removes many individual items.

### Pattern P-α — Array linear scans where a `Map<id, T>` would be O(1)

The dominant pattern. Hot paths repeatedly do `arr.find(x => x.id === id)`, `arr.findIndex(...)`, or `arr.filter(...)` over collections that have a natural primary key. Each scan is O(n); when reactive subscribers fire on every realtime event the cost is O(events × collections × n).

| Site | File / lines | Cost surface |
|------|--------------|--------------|
| `useActivityPub` post-interaction realtime | `src/stores/useActivityPub.ts` | 4 feeds × `find()` per favourite/reblog/reply event |
| `useNotification` filter/sort getters | `src/stores/useNotification.ts` | 5+ filter scans + a fresh sort allocation on every notification mutation |
| `unifiedVoiceChannel.allUsers` lookups | `src/stores/unifiedVoiceChannel.ts` | `findIndex` per join/leave/mute update during a call |
| `useChat.messageCache` cleanup | `src/stores/useChat.ts` | `forEach` outer + `findIndex` inner on delete/update |
| `useServerChannel` categories | `src/stores/useServerChannel.ts` | `Object.keys(categoryChannels)` allocates per category op |
| `useAutoSuggest` user filter | `src/composables/useAutoSuggest.ts` | Full server-user scan per keystroke, no prefix index |
| Bot gateway channel→server, channel→permissions | `bot-gateway/src/gateway/EventDispatcher.ts` | Two DB roundtrips per message (no caching) |

**Suggested sweep:** Introduce `Map<id, T>` (or a `byId` projection ref) wherever a collection has a stable id and is read more than written. For Pinia getters, cache the `sorted`/`filtered` result behind a `computed()` that tracks only the mutation, not the read.

### Pattern P-β — Per-render content pipeline (regex compile, DOMPurify, JSON.parse, date format)

Message rendering re-runs the full markdown → mention → emoji → linkify → sanitize chain on every reactive tick. Several pieces compile regexes inline, run DOMPurify per render rather than at parse time, and call `format(new Date(...))` directly in templates. With 50 visible messages × 60 fps reactivity bursts during scroll, the cost is meaningful.

| Site | File / lines |
|------|--------------|
| Markdown parser inline `new RegExp(...)` | `src/utils/markdownParser.ts` |
| Unicode emoji regex per render | `src/composables/useContentRenderer.ts` |
| `DOMPurify.sanitize` called per render | `src/composables/useContentRenderer.ts` |
| `JSON.parse` in message display hot path | `src/components/MessageDisplay.vue`, `src/components/UserProfileModal.vue` |
| Date formatted inside `<template>` expressions | `src/views/ThreadFullView.vue`, `src/components/threads/ThreadView.vue` |
| Provider/embed detection regex per render | `src/components/embeds/ProviderEmbedSwitch.vue` |
| Mention regex with backtracking risk | `src/utils/unifiedContentProcessing.ts` |

**Suggested sweep:** Hoist regex constants to module scope. Sanitize **once** when constructing message parts, store the resulting HTML on the parsed object, and render via `v-html` of the cached string. Use `computed()` for formatted timestamps. Memoize content renderer output by `(message_id, edited_at, content_hash)`.

### Pattern P-γ — Long-lived `setInterval` polling where a subscription would do

Polling intervals run unconditionally regardless of user state. Most are short and individually cheap, but they add CPU + DB pressure 24/7 and prevent the tab from sleeping.

| Interval | Period | File / lines |
|----------|--------|--------------|
| Bot gateway message ingest | **1s** | `bot-gateway/src/gateway/EventDispatcher.ts` |
| Bot gateway edits/deletes scan | 2s | `bot-gateway/src/gateway/EventDispatcher.ts` |
| Discord bridge user-list refresh | 5min | `bot-plugins/discord-bridge/src/index.ts` |
| Reaction optimistic-state cleanup | 30s | `src/stores/useReactions.ts` |
| DND status recheck | 1min | `src/stores/useNotification.ts` |
| Audio theme refresh | 5s | `src/components/settings/AudioThemeManager.vue` |

**Suggested sweep:** The bot gateway 1s poll is the biggest win — switch to Postgres `NOTIFY/LISTEN` or Supabase Realtime on `messages`, falling back to polling only when the subscription is unhealthy. The DND check should be reactive on `dnd_enabled` + a single `setTimeout` aligned to the next boundary, not a 60s tick.

### Pattern P-δ — Sequential `await` in loops; missing `Promise.all` / `IN(...)` batches

| Site | File / lines | Effect |
|------|--------------|--------|
| Federated mention resolution | `src/utils/unifiedContentProcessing.ts` | One DB query per remote `@user@domain` in a message |
| Follower inbox collection | `federation-backend/src/activitypub/DeliveryQueue.ts` | Per-follower SELECT; batched IN would do |
| `formatMessage` author lookup | `bot-gateway/src/gateway/EventDispatcher.ts` (called twice per dispatch) | Two DB roundtrips per message author |
| Megolm `share_session` over recipients | `src/services/encryption/MegolmMessageEncryptionService.ts` | Batched key fetch good, but ECDH/encrypt loop is serial |
| Bridge data registration channel validation | `bot-gateway/src/gateway/WebSocketGateway.ts` | One-by-one in loop after a batch lookup |

**Note:** `DeliveryQueue.processBatch` is intentionally sequential *within* a single remote domain (politeness — avoid hammering one instance). Don't parallelize that. The improvement is the *follower inbox collection* before delivery starts, not the delivery itself.

### Pattern P-ε — Unbounded caches / Maps grown for the life of the process

Long-running services (federation worker, bot gateway, Discord bridge) accumulate Maps with no eviction. Individually small, but combined with `>1 week` uptime they become RSS-multiplying.

| Cache | File / lines | Risk |
|-------|--------------|------|
| Discord↔Harmony message-id maps | `bot-plugins/discord-bridge/src/index.ts` | Already listed as **M41** above; perf framing: O(messages × bridge-runtime) memory, lookup degrades |
| Fediverse post embed cache | `src/components/embeds/ProviderEmbedSwitch.vue` | Module-level Map, never pruned |
| Federation L1 cache promotion w/o eviction | `federation-backend/src/utils/cache.ts` `[?]` | L2 hits promoted to L1 with no LRU cap |
| `messageVersions` / `processedMessageIds` in bot gateway | `bot-gateway/src/gateway/EventDispatcher.ts` | Has 10k cap (good), but cap-by-slicing-Set is O(n) on every overflow |
| Permission cache (already H50 above) | restated for completeness | Survives logout |

### Pattern P-ζ — Per-request heavy setup (crypto signer, Supabase client, no HTTP keepalive)

The federation backend does work on every request that could be amortized. With outbound delivery fan-out + signature verification on inbound, this is in the hot path.

| Site | File / lines | Suggested fix |
|------|--------------|---------------|
| New `crypto.createSign('SHA256')` per outbound sign | `federation-backend/src/activitypub/SignatureService.ts` | Use async `crypto.sign` (libuv pool) and/or `KeyObject` reuse |
| Public-key PEM parse per inbound verify | `federation-backend/src/activitypub/SignatureService.ts` | Cache parsed `KeyObject` keyed by `keyId`, TTL 1h, invalidate on `Update` |
| `safeFetch` without keepalive agent | `federation-backend/src/activitypub/DeliveryQueue.ts` | Pass an `https.Agent({ keepAlive: true, maxSockets: ... })`; saves TCP+TLS handshake per delivery |
| Per-job Supabase client creation `[?]` | multiple queue handlers | Move to a singleton; SDK already supports it |
| Bot rate-limit DB roundtrip per API call | `bot-gateway/src/auth/BotAuthMiddleware.ts` | Sliding window in Redis (or in-process w/ shared lock) |

### Pattern P-η — Main-thread work that should be off-thread

Anything that runs in a hot loop on the renderer thread costs frames; anything that runs in the federation API thread costs latency for unrelated requests.

| Site | File / lines | Why it hurts |
|------|--------------|--------------|
| Insertable-stream frame encryption | `src/services/encryption/WebRTCEncryptionService.ts` | 50 Hz audio × N peers + 30 Hz video × N peers, all `await crypto.subtle` on main thread |
| Megolm signature verify per decrypt | `src/services/encryption/MegolmMessageEncryptionService.ts` | ECDSA P-256 verify in front of every visible message decrypt |
| Spatial-audio HRTF panners | `src/services/spatialAudio.ts` | HRTF is CPU-heavy; fine for ≤4 users, painful at 8+ |
| PBKDF2 100k iterations for temp keys | `src/services/encryption/MegolmMessageEncryptionService.ts` | Hundreds of ms on weak devices |
| Pixel-art emoji upscale on `<canvas>` | `src/services/emojiService.ts` | Already **M55**; reframe — also blocks main thread for >100 ms on big emoji |
| Synchronous keypair generation | `federation-backend/src/activitypub/SignatureService.ts` `[?]` | If called on registration path, stalls the event loop |

---

## Critical perf (user-visible slow or scaling cliff)

### PC2. Vue render-graph: three files dominate the main bundle and the type-check

**Files:**
- `src/views/AdminPanel.vue` — **6 793 lines**, eagerly imported route component
- `src/components/MessageDisplay.vue` — **4 003 lines**, present on every chat view
- `src/stores/useActivityPub.ts` — **3 714 lines**, single Pinia store

These three files alone are ~14 kLoC of Vue+TS that ship in the main chunks and force `vue-tsc --build --force` to rebuild large slices on any change. HMR latency, time-to-interactive, and the bundle's parse cost all suffer. `vue-docgen` and `typedoc` similarly choke on these files.

**Fix:**
- `AdminPanel.vue`: split into `views/admin/<Tab>.vue` files lazy-loaded via the admin sub-router. Tabs are independent enough that ~10 chunks of 700 lines each is straightforward.
- `MessageDisplay.vue`: extract the reaction picker, attachment grid, reply preview, and thread badge into siblings so the parent shrinks and reactivity is scoped.
- `useActivityPub.ts`: this is several stores in a trench coat — posts, follows, blocks, mutes, feed cursors. Split into `useActivityPubFeeds`, `useActivityPubGraph`, `useActivityPubInteractions`. Each becomes independently watchable and easier to optimise.

---

<!-- PC3 fixed; entry removed from open list. See "Fixes applied" -> round-5 section below. -->

---

---

## High perf (significant cost; degrades at 100–1 000 users)

### Database / RLS

| # | Finding | File / lines | Fix |
|---|---------|--------------|-----|
| PH2 | `messages_select_channel_member` RLS does a 3-table join per row | `db_schema/init/30_rls_policies.sql` | Wrap in `SECURITY DEFINER` `can_read_channel(channel_id, profile_id)` with `STABLE` and indexed lookups; cache at app layer for the duration of a request |
| PH3 | `posts` RLS does two `EXISTS` subqueries (follow + block) per row | `db_schema/init/30_rls_policies.sql` | Single combined predicate via a helper function returning a boolean; or precompute a "visible posts" materialized view if read-heavy |
| PH4 | `profiles` and `posts` are `REPLICA IDENTITY FULL` on wide rows | `db_schema/init/02_tables_core.sql`, `03_tables_social.sql` | Change to `REPLICA IDENTITY DEFAULT` (uses PK); needed only if any realtime subscriber depends on old-row payloads |
| PH5 | `OFFSET` pagination on timeline / inbox / outbox / group | `db_schema/init/12_functions_rpc.sql`, `federation-backend/src/activitypub/InboxHandler.ts`, `OutboxHandler.ts`, `GroupService.ts` | Keyset cursor on `(created_at, id)` with composite index |
| PH6 | `get_current_profile_id()` and related helpers not marked `STABLE` | `db_schema/init/10_functions_core.sql` | Add `STABLE` so Postgres caches the result across calls within a query — RLS that calls them per-row currently re-executes |
| PH7 | `message_search_index.search_vector` lacks a `GIN` index `[?]` | dev backup grep needed to confirm | If absent, `CREATE INDEX ... USING GIN(search_vector)` — sequential `to_tsvector` matching does not scale |

### Frontend reactivity & data flow

| # | Finding | File / lines | Fix |
|---|---------|--------------|-----|
| PH8 | `ServerSidebar` computed maps/filters/sorts the whole server list on every reactive tick | `src/components/ServerSidebar.vue` | Cache derived order in a `computed` keyed only on the inputs that change (folder layout / server set) |
| PH9 | Auto-suggest scans the full server-user list per keystroke | `src/composables/useAutoSuggest.ts` | Build a `prefixIndex: Map<string, User[]>` on user-list change; reset on context switch |
| PH11 | Date formatted inside templates via `format(new Date(...))` | `src/views/ThreadFullView.vue`, `src/components/threads/ThreadView.vue`, many others | Pre-compute `displayedAt` in the parent or in `parseMessage`; render the string |
| PH12 | `MessageDisplay` and `UnifiedMessageContent` watch with `{ deep: true }` on message props | `src/components/MessageDisplay.vue`, `src/components/UnifiedMessageContent.vue` | Watch the specific reactive sub-paths that actually drive re-render (e.g., `() => msg.reactions.length`, `() => msg.editedAt`) |
| PH13 | `ResizeObserver` created per `MonyHeader` / `PostsContainer` instance | `src/components/activitypub/MonyHeader.vue`, `src/components/common/PostsContainer.vue` | Singleton observer service (`useSharedResizeObserver`) — one ResizeObserver scales to thousands of targets |

### Federation backend

| # | Finding | File / lines | Fix |
|---|---------|--------------|-----|
| PH14 | Activity processor / actor service use `SELECT *` then discard most columns | `federation-backend/src/activitypub/ActorService.ts`, `GroupService.ts`, `OutboxHandler.ts` | Project the columns you actually need; the JSONB columns on these tables are large |
| PH17 | WebFinger fetched on every actor resolution `[?]` | `federation-backend/src/activitypub/ActorService.ts` | Check the local `actors` table first; only WebFinger when the actor URL is unknown or stale |
| PH18 | Verbose `JSON.stringify` logs in hot federation paths | `federation-backend/src/activitypub/ActivityProcessor.ts`, `routes/reactionHandler.ts` | `logger.debug` with a lazy formatter (`() => JSON.stringify(...)`) so the work skips at INFO/WARN |

### WebRTC / voice

| # | Finding | File / lines | Fix |
|---|---------|--------------|-----|
| PH19 | Per-peer `AudioContext` + `AnalyserNode` for audio-level monitoring | `src/services/unifiedWebRTC.ts` (and **H21** above for the cleanup half) | One shared `AnalyserNode` chain; route remote streams via `MediaStreamAudioSourceNode` into a single graph with per-peer gain taps |
| PH20 | New `Uint8Array(256)` per RAF tick per peer for level sampling | `src/services/unifiedWebRTC.ts`, `src/services/spatialAudio.ts` | Pre-allocate one buffer per peer (or one global), reuse |
| PH21 | Spatial-audio HRTF `PannerNode` per remote user | `src/services/spatialAudio.ts` | Auto-fallback to `StereoPannerNode` when participants > N (configurable, default 4) |
| PH22 | Megolm verify on the decrypt hot path | `src/services/encryption/MegolmMessageEncryptionService.ts` | Verify in a worker; cache verify-result by `(senderId, sessionId, messageIndex)` |
| PH23 | PBKDF2 100 000 iterations on main thread for temp session keys | `src/services/encryption/MegolmMessageEncryptionService.ts` | Move to a worker; consider HKDF instead of PBKDF2 if the input is already high-entropy |

### Bot infrastructure

| # | Finding | File / lines | Fix |
|---|---------|--------------|-----|
| PH25 | Bot gateway `processedMessageIds` overflow trim is O(n) | `bot-gateway/src/gateway/EventDispatcher.ts` | Use a ring buffer or a real LRU — current code does `Array.from(set).slice(-10000); new Set(arr)` |

---

## Medium perf

### Stores / reactivity
- PM1. `useReactions` and `postReactions` `JSON.parse(JSON.stringify(...))` for optimistic clones — use `structuredClone` or shallow spread — `src/stores/useReactions.ts`, `src/stores/postReactions.ts`
- PM2. `unifiedVoiceChannel` writes to `localStorage` on every volume change — debounce 250 ms — `src/stores/unifiedVoiceChannel.ts`
- PM3. `useChat` message merge does `[...older, ...realtime]` on every page — `splice` in place or use a circular buffer — `src/stores/useChat.ts`
- PM4. `useEmojiCache` debug logs use `Object.keys(resolved).length` instead of `Map.size` — `src/stores/useEmojiCache.ts`
- PM5. `useDM.getSortedConversations` re-sorts on every read (already **H35** above; perf framing — cache and invalidate on conversation add/update)

### Frontend services / composables
- PM6. `useMessageSearch` filter watchers fire immediately without debounce — 300 ms `useDebounceFn` — `src/composables/useMessageSearch.ts`
- PM7. `userDataService` schedules a separate `setTimeout` per server presence sync — batch into one tick — `src/services/userDataService.ts`
- PM8. `useAutoSuggest` bridged-users cache prunes via full sort — keep a min-heap of `(expiresAt, key)` — `src/composables/useAutoSuggest.ts`
- PM9. `requestDeduplicator` cache cleaned only when `clearCache()` is called — add a periodic sweep or TTL on entry — `src/utils/requestDeduplicator.ts`
- PM10. `unifiedContentProcessing` emoji lookups serial: cache → DB → unified pack, per emoji — pre-load server emoji into the cache on server enter; batch DB lookup for misses — `src/utils/unifiedContentProcessing.ts`

### Federation backend
- PM11. JSON-LD `@context` not bundled; re-parsed every activity — bundle the standard contexts and resolve locally — multiple files
- PM12. Rate limit middleware falls back to in-memory store under Redis outage — always require Redis in prod, fail closed — `federation-backend/src/middleware/rateLimit.ts`
- PM13. No default `LIMIT` on internal queries — add a project-wide guard `[?]` — multiple files
- PM14. Reply-chain fetch uses sequential awaits — `Promise.all` with concurrency cap — `federation-backend/src/activitypub/ActivityProcessor.ts` (also **M33** above for the cycle-detection angle)

### Bot
- PM16. Avatar URL string concat on every message — pre-build template, cache by profile — `bot-gateway/src/gateway/EventDispatcher.ts`, `bot-gateway/src/api/BotRestAPI.ts`
- PM17. Discord member username cache uses lowercase keys with case-sensitive cleanup — pick one — `bot-plugins/discord-bridge/src/index.ts`

### WebRTC
- PM18. ICE-candidate queue cap of 100 has no time-based eviction — drop stale candidates > 30 s — `src/services/unifiedWebRTC.ts`
- PM19. Full SDP renegotiation on every track add/remove — prefer `sender.replaceTrack()` for device switches — `src/services/unifiedWebRTC.ts`
- PM20. `signalingState === 'stable'` waited via 100 ms polling — listen to `signalingstatechange` instead — `src/services/unifiedWebRTC.ts`
- PM21. `voiceRecordingService` creates a separate `AudioContext` even while the main one exists — share — `src/services/voiceRecordingService.ts`
- PM22. LiveKit simulcast not explicitly configured — set layer resolutions/bitrates appropriate for a 4–8 person voice room — `src/services/livekitWebRTC.ts`

### Content rendering / utilities
- PM23. `new URL(href)` in `embedDetection` thrown for many invalid inputs; exception throw is expensive — pre-validate with a simple regex — `src/utils/embedDetection.ts`
- PM24. `isImageUrl` extension check called per render (already noted as spoofable in **M59**); also a perf smell — compute once at parse time — `src/components/UnifiedMessageContent.vue`
- PM25. `file_size` formatting recalculated per render — memoize by byte value — `src/composables/useContentRenderer.ts`

### Build / bundle
- PM26. `vue-easy-lightbox` eagerly imported in `main.ts` — lazy load on first media open — `src/main.ts`
- PM27. `@privacyresearch/libsignal-protocol-typescript` listed in `optimizeDeps` — only load when encryption setup actually runs — first-paint matters more than encryption setup time
- PM28. `livekit-client` (~500 kB) ships even for users who never join voice — dynamic-import on `joinChannel` — multiple files
- PM29. No `preconnect` hints in `index.html` for Supabase, federation backend, image proxy — add `<link rel="preconnect">` for the three most-used origins
- PM30. `date-fns` imported across 15+ files — already tree-shakeable, but verify Vite's tree-shaking isn't bundling `format` + locale data twice; consider a single `src/utils/datetime.ts` re-export with the exact functions used

---

## Low perf

- PL1. Inline arrow `@click` handlers in many list components — fine in Vue 3 (event delegation) but creates closures per render
- PL2. `MessageDisplay` mixes `v-show` and `v-if` for overlay/dropdown content — call out a few specific overlays where `v-if` would let GC reclaim — `src/components/MessageDisplay.vue`
- PL3. Audio constraint object recreated each device update — cache the static base, override `deviceId` only — `src/services/unifiedWebRTC.ts`
- PL4. Audio element not pooled — small win, but creates an `HTMLAudioElement` per peer — `src/services/unifiedWebRTC.ts`
- PL5. Spatial-audio `ConvolverNode` normalize on — disable if not used — `src/services/spatialAudio.ts`
- PL6. Trig (`sin`/`cos`/`atan2`) called per spatial-audio update — cheap individually, but lookup-tables on a quantized grid help at high update rate — `src/services/spatialAudio.ts`
- PL7. Federation `crypto.generateKeyPair` is sync — async variant releases the event loop — `federation-backend/src/activitypub/SignatureService.ts` `[?]`
- PL9. Bot gateway WS broadcast does `JSON.stringify` per recipient even when payload identical — stringify once, send the buffer — `bot-gateway/src/gateway/WebSocketGateway.ts`
- PL10. Bull Board basic-auth `split(':')` is also a parsing perf wart in addition to the password-with-colon bug (**M46**) — use `indexOf` + `slice`
- PL11. `MessageInput` `MutationObserver` re-attached on every editor reset — keep observer alive across resets if possible
- PL12. `FilePreview` index-keyed `v-for` (already **M52** but visible perf-wise: Vue reconciles + re-mounts wrong rows on remove)
- PL13. `userStorage` falls back to global keys (already **L19**) — small perf concern: extra storage reads on auth changes
- PL14. Emoji shortcode resolution scans the full Unicode set per message `[?]` — verify; if true, build a `Map<shortcode, codepoint>` once
- PL15. `Object.keys(...)` to count items in several places — `Object.entries(...).length` and `Map.size` both faster than the keys allocation

---

## Suggested perf fix order

1. **PH22 + PH23 — Move Megolm verify and PBKDF2 off the main thread (worker).** Same pattern as PC3.
2. **PH2, PH3 — Replace expensive RLS with `SECURITY DEFINER` helpers**, then **PH6** (mark helpers `STABLE`).
3. **PM27/PM28 — Lazy load LiveKit + Signal Protocol; PM29 preconnects.** Cold-start win for the web client.
4. **PC2 deeper splits** — `MessageDisplay.vue` (extracted reply-reference; further extractions are cycle-time wins, not runtime perf) and `useActivityPub.ts` (multi-day refactor across 60+ call sites). Both deferred.
5. Remaining highs, then mediums and lows as background hygiene.

---

## Counts

Historical snapshot counts were removed because they became stale after round-1 through round-4 fixes. Treat the open lists above as the current source of truth.

---

## Fixes applied (round 1, 2026-05-20, branch `perf/round-1-fixes`)

### Status table

| ID | Title | Status | Files touched |
|----|-------|:------:|---------------|
| PC1 | Bot gateway: cache channel→server, bot perms, and authors per message | ✅ | `bot-gateway/src/gateway/EventDispatcher.ts`, `bot-gateway/src/utils/TTLCache.ts` (new) |
| PC2 | Split AdminPanel.vue (6 793) / MessageDisplay.vue (4 003) / useActivityPub.ts (3 714) | ⏸️ deferred | — |
| PC3 | Move WebRTC frame crypto off main thread | ⏸️ deprioritized (P2P is SFU fallback) | — |
| PC4 | useActivityPub realtime: single-pass `_findPostRefs`, skip DB SELECT when no feed refs | ✅ | `src/stores/useActivityPub.ts` |
| PC5 | Notification store: single-pass `notificationCounts` getter; all per-type/per-channel/per-server unread counts read from it | ✅ | `src/stores/useNotification.ts` |
| PH1 | Port verified-needed indexes to init.sql + fix `reset_at`/`resets_at` column drift; **deployed envs run two migration files** in the Supabase SQL editor (both transactional, both safe to paste-and-run in one shot) | ✅ | `db_schema/init/14_indexes_perf.sql` (new), `db_schema/init/08_tables_bots_extended.sql`, `db_schema/migrations/20260520_perf_round1_bot_rate_limits_columns.sql` (new), `db_schema/migrations/20260520_perf_round1_indexes.sql` (new) |
| PH10 | Batch federated mention resolution (replace per-pair `.eq().eq().maybeSingle()` with single `.or()`) | ✅ | `src/utils/unifiedContentProcessing.ts` |
| PH15 | HTTP keep-alive for federation outbound (undici dispatcher, 30 s idle, 50 conn/origin) | ✅ | `federation-backend/src/utils/ssrfProtection.ts`, `federation-backend/package.json` |
| PH16 | In-memory LRU cache for parsed public keys (fronts the existing DB caches) | ✅ | `federation-backend/src/activitypub/SignatureService.ts` |
| PH24 | Bounded LRU for Discord-bridge message-id Maps (drop-in replacement for unbounded `Map`s) | ✅ | `bot-plugins/discord-bridge/src/utils/BoundedMap.ts` (new), `bot-plugins/discord-bridge/src/index.ts` |
| PM15 | Cache author lookups in bot gateway (rolled into PC1) | ✅ | `bot-gateway/src/gateway/EventDispatcher.ts` |
| Pattern P-β | Hoist regex constants to module scope in markdownParser, urlTrackerStripper, unifiedContentProcessing | ✅ | three files |
| Pattern P-ε | TTL + LRU cap for module-level Fediverse post-embed cache (was unbounded) | ✅ | `src/components/embeds/ProviderEmbedSwitch.vue` |
| Pattern P-γ | Reaction-store dead `setInterval` removed; DND check skips polling when DND disabled | ✅ | `src/stores/useReactions.ts`, `src/stores/useNotification.ts` |
| PC2 (partial) | `AdminPanel.vue` is already lazy-routed (`src/router/index.ts`); `MessageDisplay.vue` reply-reference extracted to a sibling component | ✅ partial | `src/components/messages/MessageReplyReference.vue` (new), `src/components/MessageDisplay.vue`, `src/router/index.ts` (no change required) |
| PC3 | WebRTC frame crypto moved to a `DedicatedWorker`. `RTCRtpScriptTransform` is preferred (frames never touch the main thread); falls back to `createEncodedStreams()` + transferable `ReadableStream`/`WritableStream` to the worker. Key material is transferred (not copied) so the main thread no longer retains the symmetric key. | ✅ | `src/services/encryption/FrameEncryptor.ts` (new), `src/services/encryption/webrtcFrameCryptoWorker.ts` (new), `src/services/encryption/WebRTCEncryptionService.ts` |
| Encryption fallback UX (post-perf round) | Three real bugs reported via the screenshot dialog: (1) the prompt was a native `window.confirm` instead of a styled Vue modal; (2) it fired even when encryption was *optional* on the server and the user had never set up encryption; (3) pressing Cancel left a phantom "failed" optimistic message in the timeline so it looked like the message had been sent. Fixed by routing all three send paths (channel / DM / thread) through `useEncryptionFallbackPrompt`, replacing the default `window.confirm` with a singleton `UnifiedConfirmationModal` mounted at the App level, switching `CoreMessageService`/`ThreadService` to silent-plaintext for optional+no-recovery-key (the user never opted in), and removing — not marking-failed — the optimistic on encryption-policy throws. Input text is preserved when the user declines so the message can be retried/edited. | ✅ | `src/composables/useEncryptionFallbackPrompt.ts`, `src/components/EncryptionFallbackModal.vue` (new), `src/App.vue`, `src/services/core/CoreMessageService.ts`, `src/services/ThreadService.ts`, `src/stores/useChat.ts`, `src/stores/useDM.ts`, `src/components/ChatComponent.vue`, `src/views/DMView.vue`, `src/composables/__tests__/useEncryptionFallbackPrompt.test.ts`, `src/services/core/__tests__/CoreMessageService.policy.test.ts` |
| DM input cleared before fallback resolved | After the encryption-fallback rework, the DM path in `ChatComponent.sendChannelOrDMWithEncryptionPolicy` was still `emit`-ing to `DMView` and returning `'ok'` synchronously — so the input + draft were cleared before `DMView` even attempted the send. If the user then declined the fallback prompt that `DMView` showed, the typed text was already gone and only a toast remained. Fixed by moving the actual DM `sendDMMessage` call into `ChatComponent` so it can `await runWithEncryptionFallback` directly; `DMView.handleSendMessage` is now a notification-only forwarder that just re-emits to its parent. The input is preserved on decline for both channels and DMs. | ✅ | `src/components/ChatComponent.vue`, `src/views/DMView.vue` |
| Icon wrapper symbolic-size crash | Earlier batch type-fix replaced `:size="size"` with `:size="Number(size)"` across every lucide wrapper (`AcceptIcon`, `Bell`, `Camera`, …). The wrappers' props are typed `number \| string`, and the generic `<Icon>` component supports symbolic sizes (`xs`/`sm`/`md`/`lg`/`xl`); `Number('sm')` is `NaN`, which would have broken icon rendering for any caller passing a symbolic size. Fixed by introducing `src/utils/iconSize.ts` (`resolveIconSize`), mirroring the lookup table used in `Icon.vue`, and rewriting all 32 wrappers to use it. | ✅ | `src/utils/iconSize.ts` (new), `src/utils/__tests__/iconSize.test.ts` (new), 32 files in `src/components/icons/*.vue` |

### Index drift — investigation summary

A parallel read-only agent enumerated every `CREATE INDEX` in `db_schema/latest_dev_backup.sql` (412) and compared against `db_schema/init/*.sql` (159). Of the 248 indexes present in prod but absent from init:

| Verdict | Count | Example | Action |
|---------|------:|---------|--------|
| **NEEDED** (clear code consumers) | 19 | `idx_messages_bot_id`, `idx_reactions_user_message`, `idx_posts_federated_timeline`, `idx_ap_activities_federation_status`, `idx_posts_reply_count` | Ported to `init/14_indexes_perf.sql` |
| **LIKELY-NEEDED** (partial usage; verify) | 31 | `idx_ap_actor_cache_expires`, `idx_follows_unique`, `idx_messages_thread_id`, `idx_hashtags_trending_rank` | Not ported this round — verify hot-path usage first |
| **LIKELY-LEGACY** (no consumers) | 194 | pgboss `j[hash]_i*` runtime tables, `_realtime.*` Supabase internals, `archive_i1`, abandoned analytics tables | Leave out of init; can be dropped from prod with `DROP INDEX CONCURRENTLY` |

Confirmed the "dev backup has legacy stuff" intuition — the bulk of the drift is pgboss runtime objects that recreate themselves and should not live in init.

Also discovered (not strictly an index issue): `bot_rate_limits.reset_at` (init) vs `resets_at` (prod + `bot-gateway/src/auth/BotAuthMiddleware.ts`). Fresh installs would silently break bot rate-limiting. Fixed.

### Round-2 fixes (post code-review, 2026-05-20)

Findings from the code-reviewer pass on the round-1 changes were addressed in the same branch. Status:

| ID | Title | Status |
|----|-------|:------:|
| **B1** | `bot_rate_limits` schema in init was wrong on more columns than just `resets_at` — `request_count`, `window_start`, `window_duration_seconds`, `max_requests`, `metadata` were also missing. The gateway's `checkRateLimit` would fail-open on every fresh install. Reshaped init/08 to match prod verbatim; extended the migration to add the new columns and drop the obsolete ones, idempotently and state-aware | ✅ |
| **H1** | `setupDndCheck` short-circuit silently broke DND when toggled on mid-session — no caller re-invoked it after preference changes. Wired `loadPreferences` (always) and `updatePreferences` (only when `dnd_*` fields change) to call `setupDndCheck()` | ✅ |
| **H2** | `_findPostRefs` didn't scan `bookmarks: TimelinePost[]`, so realtime favourite/reblog/reply count updates were silently skipped for the bookmarks view. Added the scan | ✅ |
| **H3** | `EventDispatcher` lookup caches poisoned on transient Supabase errors (cached `null` / `[]` for the full TTL on a network blip). Now distinguish PGRST116 "no rows" (cacheable) from any other error (returns null but does NOT cache) for all three caches | ✅ |
| **H4** | Migration's `NOTIFY pgrst, 'reload schema'` was after the 30+ minute CONCURRENT index block — PostgREST would serve stale schema for that whole window. Moved an explicit NOTIFY between Part 1 (column reconciliation) and Part 2 (CONCURRENT indexes) | ✅ |
| **H5** | `idx_profiles_auth_user_id` was a redundant duplicate of the implicit btree from the `auth_user_id uuid UNIQUE` column constraint. Removed from both `init/14_indexes_perf.sql` and the migration; documented why | ✅ |
| **M1** | Dead `invalidate*` helpers in `EventDispatcher` (defined but never called from anywhere). Removed | ✅ |
| **M2** | `undici` was in `federation-backend/package.json` but not in the lockfile, meaning Docker builds would silently lose the keep-alive dispatcher and fall back to default-fetch's 4 s keep-alive. Ran `npm install --package-lock-only`; lockfile now pins `undici@6.25.0` | ✅ |
| **M3** | Per-key unread Maps used `??` (single-source coalesce) instead of `||` semantics (count both sources when both present), changing observable behaviour for notifications carrying both `data.X` and `data.location.X`. Restored the disjunction semantics with an explicit two-branch bump | ✅ |
| **M4** | Three more inline regexes in `unifiedContentProcessing.ts` (`preUrlRegex`, `urlRegex`, `combinedEmojiRegex`, `combinedRegex`) were missed by the round-1 hoist. Hoisted to module scope with `lastIndex = 0` resets at every `.exec`-loop call site | ✅ |
| L1 | Stale comment in `useReactions.ts` referenced a non-existent `reconcileReaction`. Fixed | ✅ |
| L2 | `import { BoundedMap }` in `bot-plugins/discord-bridge/src/index.ts` was mid-file. Moved to the top-of-file import block | ✅ |
| L3 | Defensive `(this.userFeeds as any).values` cast in `_findPostRefs` — `userFeeds` is initialised to `new Map()` and is always present. Removed the defensive check and the cast | ✅ |
| H6 | `setInterval(async pollMessages, 1000)` can race when a poll takes >1 s. Pre-existing in the bot gateway; **not** addressed in this round | ⏸️ deferred |
| M5 | Three timeline-index variants in `init/14_indexes_perf.sql` use three different "alive post" predicate forms; planner only uses the one matching the query's WHERE shape. Not addressed; needs a broader audit of query predicates before consolidating | ⏸️ deferred |
| M6 | Public-key cache invisible to multi-node async profile updates. Acceptable for current single-node deployments; deferred | ⏸️ deferred |
| L9 | Three other unbounded `Map`s in `discord-bridge/index.ts` (`webhookCache`, `discordMemberCache`, `discordMemberDetails`). Pre-existing; would benefit from the same `BoundedMap` treatment in a follow-up | ⏸️ deferred |
| L10 | `processedMessageIds.add` overflow trim in `EventDispatcher` is O(n). Pre-existing; not addressed | ⏸️ deferred |

The round-2 fixes added a vue-tsc workaround: dependent getters that read `this.notificationCounts.X` use a `(this as any).notificationCounts` cast because vue-tsc/Pinia surface a method-form getter as its raw `() => T` function type when referenced from another method-form getter. Runtime behaviour is correct (Pinia unwraps via `computed`). The cast sites carry a comment explaining the limitation.

### Round-3 follow-ups (post production-deploy attempt, 2026-05-20)

After the migration was attempted on prod, two issues surfaced and were addressed:

1. **`CREATE INDEX CONCURRENTLY cannot run inside a transaction block` (25001)** — the combined migration file was wrapped in a single transaction by the deploy tooling, which Postgres rejects for `CONCURRENTLY`. First attempt at a fix split the file in two; the indexes-half still failed in the Supabase SQL editor because that editor sends multi-statement pastes as a single implicit-transaction simple-query batch, and CONCURRENTLY rejects implicit transactions just as readily as explicit ones. Final structure:
   - `db_schema/migrations/20260520_perf_round1_bot_rate_limits_columns.sql` — transactional column reconciliation.
   - `db_schema/migrations/20260520_perf_round1_indexes.sql` — same 19 indexes, but **non-CONCURRENT** `CREATE INDEX IF NOT EXISTS` inside a single `BEGIN`/`COMMIT`. Pastes and runs in the SQL editor in one shot. The trade-off (a brief ACCESS EXCLUSIVE lock per table, sub-second-to-seconds on hobby-scale data) is documented in the file's header along with the CONCURRENT path for anyone who later needs zero-downtime: swap `CREATE INDEX` for `CREATE INDEX CONCURRENTLY`, drop the transaction wrapper, and run via direct `psql`.

2. **Dev-backup deadcode audit** — the project framing is that `init/*.sql` is the canonical "intended" schema and the production dump (`latest_dev_backup.sql`) may carry legacy. A second-pass code-consumer audit of the 22 originally-ported indexes found **3 with no real consumer**:

   | Dropped index | Original justification | Reality |
   |---------------|------------------------|---------|
   | `idx_messages_encrypted` | "Encrypted-only paths" | No `.eq('encrypted', true)` filter in `src/`, `federation-backend/`, or `bot-gateway/`. The column is only set/read via `SELECT *`. |
   | `idx_messages_megolm_session` | "Megolm session inbound lookup" | No `.eq('megolm_session_id', ...)` filter anywhere. |
   | `idx_reactions_metadata` (GIN) | "for federation reactionHandler.ts" | That file does not exist. The only `.contains('metadata', ...)` query in the codebase is on `messages`, not `reactions`. |

   Removed from both `init/14_indexes_perf.sql` and the migration file. Net ported: **19 indexes**, not 22.

### B1 reconciliation (round 4): atomic RPC instead of schema swap

Per project framing (init = newer cleaned schema, dev backup = may carry legacy), there were two candidate B1 paths:

- **Schema A** — keep the dev-backup shape (`request_count`/`window_start`/...) that prod and the running code already use.
- **Schema B** — restore the init shape (`limit_max`/`remaining`/`violations`/`last_violation_at`) and refactor `BotAuthMiddleware.checkRateLimit` to use it.

Picked **Schema A + a proper atomic RPC**. Rationale:

1. **Schema B would require a destructive prod migration** — `DROP COLUMN request_count`, `DROP COLUMN window_start`, etc. — which loses in-flight rate-limit state for every bot. Net risk > net gain.
2. **The schemas are cosmetic; the real bug is the access pattern**, not the column names. The previous `checkRateLimit` did a SELECT → conditional → UPDATE in three round trips, which is racy (BUGS.md M37): two concurrent requests can both read `count = N`, both pass the threshold, both write `count = N + 1`, letting through ~2× the allowed burst. Either schema breaks under that.
3. **An atomic UPSERT-and-return RPC fixes M37 in one statement** and reduces the per-check cost from 2-3 DB round trips to 1. After this refactor, the column names matter only inside the SQL function, so the "which schema is cleaner" debate is moot.

What landed:

| Change | Where |
|--------|-------|
| Atomic `check_and_increment_bot_rate_limit(bot_id, bucket, limit, window_seconds) RETURNS boolean` — `INSERT … ON CONFLICT DO UPDATE` with window-reset logic in the SET clause, returns true iff the post-increment count exceeds the limit. Exclusive row lock means concurrent calls serialise correctly. | `db_schema/init/13_functions_rpc_extended.sql` (for fresh installs), `db_schema/migrations/20260520_perf_round1_rate_limit_atomic_rpc.sql` (for prod) |
| `BotAuthMiddleware.checkRateLimit` rewritten to a single `supabase.rpc('check_and_increment_bot_rate_limit', ...)` call. Reads the `config.rateLimit.windowMs` / `maxRequests` env-based defaults instead of hardcoding 60 s / 100 like before. Fail-open behaviour on RPC error is preserved (matches pre-existing M37/L11 stance). | `bot-gateway/src/auth/BotAuthMiddleware.ts` |

What this also closes:

- **M37** (rate-limit racy + fails open) — now atomic.
- The hardcoded-60s / hardcoded-100 limitation that the previous code carried (it never read `max_requests` from `config.rateLimit`).

What it does NOT change:

- The `bot_rate_limits` schema. Prod stays as-is. Init.sql keeps the Schema-A shape (round-2 B1 fix).
- The previously-committed Part 1 migration (`20260520_perf_round1_bot_rate_limits_columns.sql`) still applies first, ensuring deployed envs have all the columns the RPC needs (it was already running prior to this round 4 addendum, so no replay risk).

Deploy order for prod (Supabase SQL editor — paste each file, click Run):

1. Run `20260520_perf_round1_bot_rate_limits_columns.sql` first. (If already applied, skipping is fine — every step is idempotent.)
2. Run `20260520_perf_round1_rate_limit_atomic_rpc.sql` second. Defines the function. `NOTIFY pgrst` at the end refreshes PostgREST so the new RPC is callable immediately.
3. Run `20260520_perf_round1_indexes.sql` last. Pastes and runs in one shot inside a single transaction. Each table gets a brief ACCESS EXCLUSIVE lock during its index build (sub-second-to-seconds on hobby-scale data) — the bot gateway / federation worker / frontend will see a brief query stall during that window.
4. Deploy the gateway code. The new `checkRateLimit` now needs the RPC to exist; if the gateway is deployed before step 2, every bot request fail-opens (matches the prior buggy behaviour, so no degradation), but rate-limiting won't actually trigger until the RPC is in place.

### Notes on what was NOT done

- **PC2 (file splitting)** — `AdminPanel.vue` 6 793 lines, `MessageDisplay.vue` 4 003, `useActivityPub.ts` 3 714. Deferred: each is a multi-day refactor with no obvious clean split, and the user-visible win is mostly cycle-time / HMR rather than runtime perf. Plan: do these in their own dedicated PRs.
- **PC3 (P2P frame crypto on main thread)** — explicitly deprioritized by user since P2P is a fallback path; LiveKit (SFU) is the primary voice/video transport. Worth revisiting if/when SFU usage degrades or for users without TURN reachability.
- **PC4 full Map refactor** — replacing per-feed array storage with a canonical `Map<post_id, Post>` would touch 30+ insertion sites across `useActivityPub.ts`. This round did the minimal refactor: a single `_findPostRefs` helper used by both realtime update paths, plus an early-exit that skips the DB roundtrip when the post isn't in any visible feed. A future round can layer the canonical Map on top of this.
- **PH22 / PH23 (Megolm verify, PBKDF2 in worker)** — design work needed (whole crypto stack would move to a worker). Not in scope for round 1.
- **Index drift: the 31 LIKELY-NEEDED** — not ported this round. They warrant individual verification (some, like `idx_messages_thread_id`, look obvious but the init script already has `idx_messages_thread` on the same column — duplicates would just bloat WAL with no benefit).

### Verification

Re-verified after round-2 fixes:

- Frontend type-check (`npm run type-check`): only pre-existing errors remain in files I didn't touch (`UnifiedProfileCard.vue`, `NotificationsView.vue`, icon components, plus the `DEFAULT_PREFERENCES` mismatch in `useNotification.ts` which has existed for several commits — line numbers shift with my insertions but the error sites are unchanged code). No round-1 or round-2 change introduces a new error. The vue-tsc cross-getter inference limitation noted in the round-2 table is documented at the `(this as any)` cast sites.
- Federation type-check: pre-existing TS7030 warnings in route handlers only.
- Bot gateway / Discord bridge `tsc --noEmit`: clean for the edited files.
- Frontend unit tests: `urlTrackerStripper` (16), `markdownParser` (21), `useNotification` (5) — all 42 green.
- Federation tests: `ssrfProtection` (60), `signatureService` (21), `activityProcessor` (19) + others — all 199 green. Test logs confirm the new undici dispatcher initialises: `🔗 safeFetch: undici keep-alive dispatcher initialized (30s idle, 50 conn/origin)`.
- Pre-existing failures (unrelated): `inviteService.acceptInvite > rejects unknown invite codes`, four `useTheme` tests (missing mock for `audioThemeService.ensureCustomPacksLoaded`), three federation route suites that can't load (`supertest` not in `devDependencies`).
