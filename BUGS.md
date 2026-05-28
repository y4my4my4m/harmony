# Harmony - Known Issues

This file tracks **unfixed defects** in the Harmony codebase, including security findings. It is the canonical "if you ship a Harmony instance, here is what you should know" list.

Items previously listed as fixed have been removed; this list reflects the state of `master` after the most recent audit pass (May 2026). The full historical audit (including items now resolved) lives in the [archive repository](https://github.com/y4my4my4m/harmony-archive).

> ⚠️  **Operators / self-hosters:** several items below are exploitable security bugs without further context. If you run a public instance, please review the **Critical** and **High → Federation SSRF / Encryption / Auth** sections in detail before opening federation to the wider fediverse, and consider applying the migrations referenced under "Init / migration parity" before standing up a fresh database.

---

## Cross-cutting patterns

### Pattern A - Auth UUID vs Profile UUID confusion

`profiles.id` (`gen_random_uuid()`) and `auth.users.id` (Supabase auth UUID) are different. Most call sites have been migrated to `authContextService.getCurrentProfileId()`, but at least one remains:

| Site | File / lines | Effect |
|------|--------------|--------|
| `checkAdminOrModPermissions` | `src/services/AdminService.ts:1184-1188` | Filters by `id` instead of `auth_user_id`; callers passing the auth UUID get a false-negative permission check |

**Sweep:** audit every `session?.user?.id` / `user.id` reference; replace with `authContextService.getCurrentProfileId()` wherever the destination column FKs to `profiles(id)`.

### Pattern B - Logout / cleanup incompleteness

`auth.ts:logout()` now resets voice state, ActivityPub graph, reactions, permission caches, DND interval, and presence cleanup. One known gap remains:

| Resource | File / lines | Effect |
|----------|--------------|--------|
| Server users cache | `src/stores/useServerUsers.ts:258-277` | `cleanup()` tears down channels but does **not** clear `userProfiles`, `usersInVoiceChannels`, or `onlineUsers` Maps/Sets - previous user's profiles/voice membership leak to the next session on a shared device |

### Pattern C - MFA bypass via recovery code

`validateSessionForMFA()` is now invoked on every session-cache, INITIAL_SESSION, TOKEN_REFRESHED, and OAuth callback path. The remaining bypass:

| Path | Location | Risk |
|------|----------|------|
| Recovery-code login | `src/components/AuthComponent.vue:682-685` | `supabase.auth.mfa.unenroll()` is called with an AAL1 session; one recovery code disables MFA without an AAL2 step-up |

### Init / migration parity

Several security migrations under `db_schema/migrations/20260520_*` are **not** mirrored in `db_schema/init/`. Fresh databases bootstrapped from `db_schema/init/init.sql` are missing these fixes until they are ported:

- `20260520_user_key_pairs_restrict_private_columns.sql` (see C8)
- `20260520_profile_admin_escalation_trigger.sql` (see C9)
- `20260520_invites_restrict_select_to_owner_and_rpc.sql` (see C10)

**Action:** apply those migrations after `init.sql` on any fresh deploy until they are inlined.

---

## Critical (security / data corruption - fix ASAP)

### C5. E2EE - WebRTC media keys never agreed between peers

**File:** `src/services/encryption/WebRTCEncryptionService.ts:109-147`

When a Signal session exists, each side derives media keys from local `call-key-${Date.now()}`. The `encryptMessage` result is never exchanged over signaling. Temporary-key fallback uses `temp-${participantId}-${Date.now()}`, also local-only. Alice and Bob therefore use **different** AES keys; decrypt fails or media is effectively unprotected while the UI shows E2EE enabled.

**Fix:** exchange key material over authenticated signaling (derive from a completed Signal session, or use DTLS-SRTP with verified fingerprints). Do not call E2EE "active" until both sides confirm the same key.

### C6. E2EE - Signal identity private keys stored on server in plaintext

**Files:**
- `src/services/encryption/MessageEncryptionService.ts:162-167`
- `src/components/encryption/KeySetupWizard.vue:236-243`

`setupEncryption` passes `identityKeyPair.privateKey` (raw base64) into `initialize_user_encryption` without wrapping with the user password or recovery key. Any DB/RLS leak exposes long-term Signal identity keys for affected users.

**Fix:** encrypt the private key client-side before RPC (mirror `MegolmMessageEncryptionService.encryptPrivateKeyForStorage`), or retire the wizard in favor of Megolm + recovery-key setup and migrate existing rows.

### C7. E2EE - hybrid "self" entries store AES content key in plaintext message metadata

**File:** `src/services/encryption/MessageEncryptionService.ts:348-354`

For self-recipients the AES-GCM content key is stored as cleartext inside `encryption_metadata.encrypted_keys`. Any reader of the message row (channel members, server, DB) can decrypt. Defeats E2EE for hybrid legacy messages that include the sender in `encrypted_for`.

**Fix:** never store cleartext keys in message metadata; always wrap with Signal, or omit the self entry and rely on local/session state.

### C8. E2EE - `user_key_pairs` RLS exposes wrapped private keys (init only)

**File:** `db_schema/init/31_rls_policies_extended.sql:1036-1045`

Init still has a row-wide SELECT policy. Postgres RLS cannot hide columns, so `identity_private_key_encrypted` and `identity_signing_private_key_encrypted` are readable by any logged-in user via direct API queries. Megolm wraps these with recovery-key AES-GCM, but ciphertext is harvestable for offline attack; legacy Signal rows may be plaintext (see C6).

**Fix landed in:** `db_schema/migrations/20260520_user_key_pairs_restrict_private_columns.sql` - needs to be ported to init.

### C9. Auth - profile privilege escalation via self-update (init only)

**File:** `db_schema/init/30_rls_policies.sql:29-30`

`profiles_update_own` allows `UPDATE` on own row with no column restrictions. Any authenticated user can call Supabase with `{ is_admin: true, is_moderator: true }` on their own profile.

**Fix landed in:** `db_schema/migrations/20260520_profile_admin_escalation_trigger.sql` (`prevent_profile_moderation_self_update_trigger`). Needs to be ported to init.

### C10. Auth - server invites readable by any authenticated user (init only)

**File:** `db_schema/init/30_rls_policies.sql:675`

`invites_select_all` is `FOR SELECT USING (true)`. Any logged-in user can `SELECT * FROM invites` and harvest codes, expiration, and `max_uses`.

**Fix landed in:** `db_schema/migrations/20260520_invites_restrict_select_to_owner_and_rpc.sql` (restricts SELECT, adds `lookup_invite_by_code` RPC; client already uses RPC at `inviteService.ts:122-123`). Needs to be ported to init.

### C11. Auth - recovery-code login disables MFA

See Pattern C above. One recovery code currently removes MFA without AAL2 step-up.

---

## High

### Permissions & calls

| # | Bug | Location |
|---|-----|----------|
| H2 | `useChannelPermissions.canViewChannel` / `canAccessChannel` always return `true` | `src/composables/useChannelPermissions.ts:53-60` |
| H3 | `useServerPermissions.canViewServerSettings` hardcoded `true` | `src/composables/useServerPermissions.ts:328-331` |
| H6 | `isUserBusy` only queries server voice; ignores DM/LiveKit | `src/services/DMCallPermissions.ts:184-196` |
| H7 | DM call **decline** path only toasts; ring/teardown still tied to `DMHeader` mount | `src/services/GlobalDMCallListener.ts:196-198`, `src/components/dm/DMHeader.vue:608-621` |
| H8 | Recovery-code login disables MFA without AAL2 step-up (= C11) | `src/components/AuthComponent.vue:682-685` |

### Encryption (legacy Signal path)

| # | Bug | Location |
|---|-----|----------|
| H9  | `isTrustedIdentity` always returns `true` (Signal TOFU disabled) | `src/services/encryption/EncryptionKeyStore.ts:230-237` |
| H10 | Password-derived AES key stored extractable in `sessionStorage` | `src/services/encryption/EncryptionKeyStore.ts:119-169` |
| H11 | Megolm signing keys are server-authoritative (no client pinning) | `src/services/encryption/MegolmMessageEncryptionService.ts:590-595` |
| H12 | Megolm send allowed without per-message signature (v1 downgrade) | `src/services/encryption/MegolmMessageEncryptionService.ts:682-695` |

### Federation SSRF / signature integrity

| # | Bug | Location |
|---|-----|----------|
| H13 | `POST /resolve-post` accepts arbitrary URL; no upfront SSRF check | `federation-backend/src/activitypub/ActorService.ts:442-497` |
| H14 | `POST /fetch-posts` accepts arbitrary `outbox_url` from body | `federation-backend/src/activitypub/ActorService.ts:513-534` |
| H15 | Many hot paths now use `safeFetch`; admin endpoints H13/H14 and some legacy `fetch()` sites remain | `federation-backend/src/activitypub/ActorService.ts` (multiple) |
| H16 | `instanceProbe` follows attacker-controlled NodeInfo `href` | `federation-backend/src/routes/instanceProbe.ts` |
| H17 | Inbox always re-processes activities (never marked `completed`; no dedup against `was_updated`) | `federation-backend/src/activitypub/InboxHandler.ts:411-413` |
| H18 | No HTTP `Date` skew check (signature replay window) | `federation-backend/src/activitypub/SignatureService.ts:228-345` |
| H19 | Body integrity not enforced when Digest omitted from signed headers | `federation-backend/src/activitypub/SignatureService.ts:262-271` |

### WebRTC / voice

| # | Bug | Location |
|---|-----|----------|
| H24 | Call signaling started before voice join (ghost ringing on failure) | `src/components/dm/DMHeader.vue:940-942` |
| H25 | Duplicate `RTCPeerConnection` per user (always-create, never-check) | `src/services/unifiedWebRTC.ts:1499-1535` |

### Frontend

| # | Bug | Location |
|---|-----|----------|
| H28 | File uploads have no client-side size/MIME limit (incl. SVG with embedded script) | `src/services/fileService.ts`, `src/components/MessageInput.vue` |

### Realtime / store state

| # | Bug | Location |
|---|-----|----------|
| H33 | Documented notification `postgres_changes` fallback never implemented | `src/stores/useNotification.ts:666-737` |

### Bot infrastructure

| # | Bug | Location |
|---|-----|----------|
| H41 | Discord mention resolution can ping wrong user (username-only cache) | `bot-plugins/discord-bridge/src/MessageTranslator.ts:308-313` |
| H42 | Unresolved plain-text `@mentions` create bogus Harmony mentions (`unresolved-${username}`) | `bot-plugins/discord-bridge/src/MessageTranslator.ts:166-174` |

### Lifecycle / leaks

| # | Bug | Location |
|---|-----|----------|
| H43 | `useFloatingVideo.registerVideo` calls `onUnmounted` outside `setup()` (silently no-ops; observers leak per chat message/embed) | `src/composables/useFloatingVideo.ts:95-97` |
| H44 | App-wide haptic listeners never removed (four `document.click` handlers stack on remount) | `src/App.vue:105-112` |
| H45 *(unverified)* | ActivityPub user search: `AbortController` created but signal never passed to API | `src/composables/useAutoSuggest.ts` |
| H46 *(unverified)* | User search modal: no abort/sequence guard → stale results overwrite newer | `src/components/activitypub/UserSearchModal.vue:208-269` |
| H47 *(unverified)* | `useMessageSearch` debounce + AbortController not cleared on dispose | `src/composables/useMessageSearch.ts` |

### Reports / IDs

| # | Bug | Location |
|---|-----|----------|
| H48 | Invite usage update blocked for accepter by RLS - `max_uses` not enforced atomically | `src/services/inviteService.ts:190-196` + `db_schema/init/30_rls_policies.sql:691-692` |

---

## Medium

### Encryption

- **M1.** Hybrid encrypt marks message encrypted even when some recipients have no key - `MessageEncryptionService.ts:377-380`
- **M2.** Megolm encrypt proceeds after `ensureSessionShared` failures (new members get undecryptable messages) - `MegolmMessageEncryptionService.ts:652-660`
- **M3.** Prekey rotation: delete-then-upload TOCTOU window - `MessageEncryptionService.ts:205-210`
- **M5.** `messageDecryption` overloads `sender_verified: false` on any decrypt error - `src/utils/messageDecryption.ts:114-137`
- **M6.** No replay resistance for Megolm v2 at application layer

### Realtime / stores

- **M7-M10.** `PostReactionsRealtime` refCount mismatch, typing-indicator subscription gap, `UserEventChannel` reconnect, `userDataService` user-list update skip *(some unverified)*
- **M14.** `useServerChannel` server-structure channel has no reconnect on error
- **M15.** Logout/presence ordering: Redis offline before Supabase teardown
- **M16-M18.** Concurrent `fetchMultiplePostReactions` race; `toggleReaction` mutates shared optimistic objects; `reactionsByPost` / `lastFetched` grow without eviction
- **M20.** `verify2FA` timeout doesn't cancel in-flight MFA verify
- **M21.** `loadBlockingData()` not awaited on some login paths - `src/stores/auth.ts:397, 441`
- **M22.** `StatePersistence.STATE_VERSION` defined but never persisted/checked

### WebRTC

- **M23.** P2P screen-share stop doesn't renegotiate after `removeTrack`
- **M24.** LiveKit disconnect doesn't recover or refresh token
- **M25.** Group DM outbound calls: no per-receiver permission check
- **M26.** Mic test early stop leaves mic/camera hot
- **M27.** P2P signaling has no sender authentication (broadcast trust)
- **M28.** Double-ringing on multiple devices (no "answered elsewhere" cancel)

### Federation

- **M29.** Server inbox has no `ap_activities` dedup layer
- **M30.** Race: duplicate posts on concurrent identical Create deliveries
- **M31.** Inbox rate limit keyed by IP only, not remote instance
- **M32.** 10 MB JSON body limit on inbox (should be ≤1 MB for AP)
- **M33.** Reply-chain fetch cap without cycle detection
- **M34.** Follow replay spams Accept to follower inbox
- **M35.** `backfill-posts.ts` blindly overwrites post content
- **M36.** Private keys stored plaintext PEM in DB

### Bot

- **M37.** Bot rate-limit fails open on RPC error (race fixed via atomic RPC)
- **M38-M49.** Unused rate-limit dep; unenforced WS-per-bot cap; bridge 429 handling; unbounded message-id Maps; gateway/bridge hygiene; reactions bridged as bot, not user *(several unverified)*

### Frontend / Vue

- **M50-M63.** Debounce cleanup; `FilePreview` index keys; SSRF in `fileUpload.downloadAndUploadImage`; `BaseModal` focus restore; `image/svg+xml` allowed for avatars; etc. *(most unverified, see archive for details)*

### Auth

- **M65.** Registration sets session before email verification - `src/stores/auth.ts` register flow
- **M66.** `AuthContextService` cache not cleared from auth store on logout
- **M67.** `AdminService` direct table writes depend entirely on RLS

---

## Low

- **L1.** Debug logging may leak encryption metadata fragments - `MessageEncryptionService.ts:501`
- **L2.** HKDF ratchet uses fixed all-zero salt - `MegolmService.ts`
- **L4.** Thread views lack `onReconnected` gap-fill - `ThreadFullView.vue`
- **L5.** `MonyFeed.vue` calls dead `initializeRealtime`/`cleanupRealtime` API (cast `as any`) - `src/components/activitypub/MonyFeed.vue:347-356`
- **L7-L11.** `useUndoRedo` pointer drift; notification getter re-entrancy; `spatialAudio` / voice Maps not cleared on logout; etc. *(unverified)*
- **L12.** `http:` allowed in `validateExternalUrl` - `federation-backend/src/utils/ssrfProtection.ts:92-93`
- **L13.** Inbox GET exposes stored remote activities without auth - `federation-backend/src/activitypub/InboxHandler.ts:60+`
- **L14.** SHA-256 token hashing (DB docs say bcrypt) - `bot-gateway/src/auth/BotAuthMiddleware.ts:34`
- **L15.** Dev error responses may leak internal messages - `bot-gateway/src/index.ts:88-93`
- **L16.** Verbose logging of message metadata/content - `bot-gateway/src/api/BotRestAPI.ts:105-106`
- **L17.** Bridge shutdown doesn't clear periodic user-refresh interval
- **L18.** Supabase session persisted in `localStorage` (XSS-readable refresh token) - `src/supabase.ts`
- **L19.** `userScopedStorage` falls back to global keys when no user is set - `src/utils/userScopedStorage.ts:121-131`
- **L20.** `SessionHeartbeat` is fully disabled - no server-side invalidation signal - `src/services/SessionHeartbeat.ts`

---

## Performance addendum

The full performance audit (cross-cutting patterns P-α ... P-η plus per-area items PC1 ... PL15) lives in the archive repository. The dominant patterns still present today:

- **P-α** - array linear scans on hot reactive paths (post-interaction realtime, notifications, voice users, autosuggest)
- **P-β** - per-render content pipeline (regex compile, DOMPurify, `JSON.parse`, date format) in `useContentRenderer`, `markdownParser`, `MessageDisplay`, `ProviderEmbedSwitch`
- **P-γ** - long-lived `setInterval` polling (notably the bot-gateway 1 s message ingest poll and 2 s edits/deletes scan)
- **P-δ** - sequential `await` in loops where `IN(...)` / `Promise.all` would batch (federated mention resolution, follower inbox collection, Megolm session sharing)
- **P-ε** - unbounded Maps in long-running services (Discord ↔ Harmony id map, fediverse embed cache, federation L1 cache promotion)
- **P-ζ** - per-request crypto signer / public-key parse on the federation hot path; missing `https.Agent({ keepAlive: true })` for outbound delivery
- **P-η** - main-thread crypto: insertable-stream frame encryption (PC3 moved this to a worker but the keying issue C5 is independent), Megolm signature verify per decrypt, HRTF panners, 100k PBKDF2 iterations on weak devices

The two sharpest user-facing wins are still **PC2** (route-level code splitting for `AdminPanel.vue`, ~6 800 lines, eagerly imported) and **P-γ** (replacing the bot-gateway 1 s poll with `NOTIFY` / Realtime).

---

*This file is updated whenever an item is fixed or a new defect lands. PRs that close items should remove them here in the same commit.*
