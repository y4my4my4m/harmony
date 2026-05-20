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
