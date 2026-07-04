# Harmony - Known Issues

This file tracks **unfixed defects** in the Harmony codebase, including security findings. It is the canonical "if you ship a Harmony instance, here is what you should know" list.

Items previously listed as fixed have been removed; this list reflects the state of the tree after the July 2026 professionalization pass (`chore/professionalize` branch). The full historical audit (including items now resolved) lives in the [archive repository](https://github.com/y4my4my4m/harmony-archive).

> ⚠️  **Operators / self-hosters:** several items below are exploitable security bugs without further context. If you run a public instance, please review the **Critical** and **High → Federation SSRF / Encryption / Auth** sections in detail before opening federation to the wider fediverse, and consider applying the migrations referenced under "Init / migration parity" before standing up a fresh database.

---

## Cross-cutting patterns

### Pattern A - Auth UUID vs Profile UUID confusion

`profiles.id` (`gen_random_uuid()`) and `auth.users.id` (Supabase auth UUID) are different. The July 2026 sweep fixed the ActivityPub service reads (`getTimeline`, `getPublicTimeline`, `getEnhancedPublicTimeline`, `getFederatedTimeline`, `getLocalTimeline`, `getPostWithContext`, `getUserPosts`), the store's home/local feed + `toggleFavorite` existing-favorite lookup, `TrendingService.getTrendingUsers` self-exclusion, and `AdminService.checkAdminOrModPermissions`.

**Sweep (ongoing):** audit remaining `session?.user?.id` / `user.id` references; replace with `authContextService.getCurrentProfileId()` wherever the destination column FKs to `profiles(id)`.

### Pattern B - Logout / cleanup incompleteness

`auth.ts:logout()` now resets voice state, ActivityPub graph, reactions, permission caches, DND interval, and presence cleanup. `useServerUsers.cleanup()` now also clears `userProfiles`, `usersInVoiceChannels`, `voiceChannelCallStartTimes`, and `onlineUsers` (fixed July 2026). No known gaps remain; re-audit when adding new long-lived stores.

### Pattern C - MFA bypass via recovery code

Fixed July 2026: recovery-code login now calls the atomic SECURITY DEFINER RPC `redeem_recovery_code_and_disable_mfa` (migration `20260703_recovery_code_mfa_unenroll_rpc.sql`, also in init), which verifies AND consumes the code server-side before deleting `auth.mfa_factors`. The client-side `verify_recovery_code` + AAL1 `mfa.unenroll()` flow is gone. `validateSessionForMFA()` remains on every session path.

### Init / migration parity

All three 20260520 security migrations are now mirrored in `db_schema/init/` (C8/C9 were already inlined; C10 - invites SELECT restriction + `lookup_invite_by_code` - was ported July 2026). Keep new security migrations mirrored into init in the same commit.

---

## Critical (security / data corruption - fix ASAP)

*(C5, C6, C7 - resolved July 2026: the legacy Signal-Protocol client stack was deleted outright (`MessageEncryptionService`, `SignalProtocolService(Browser)`, `EncryptionKeyStore(Browser)`, `WebRTCEncryptionService`, `FrameEncryptor`, `KeySetupWizard.vue`). The live app is Megolm-only. P2P calls now honestly rely on DTLS-SRTP transport encryption — the dormant, broken frame-encryption layer and its false E2EE indicator are gone. LiveKit voice E2EE (Megolm-wrapped room keys) is unaffected.)*

*(C8, C9, C10 - init/migration parity - and C11 - recovery-code MFA bypass - were fixed July 2026; see the Pattern C / Init parity notes above.)*

---

## High

### Permissions & calls

*(H2/H3 resolved July 2026: the dead `canViewChannel`/`canAccessChannel` stubs were deleted; `canViewSettings: true` is now documented as intentional — the settings view doubles as a read-only server overview, with every mutation gated individually.)*

| # | Bug | Location |
|---|-----|----------|
| H6 | `isUserBusy` only queries server voice; ignores DM/LiveKit | `src/services/DMCallPermissions.ts:184-196` |
| H7 | DM call **decline** path only toasts; ring/teardown still tied to `DMHeader` mount | `src/services/GlobalDMCallListener.ts:196-198`, `src/components/dm/DMHeader.vue:608-621` |
| H8 | Recovery-code login disables MFA without AAL2 step-up (= C11) | `src/components/AuthComponent.vue:682-685` |

### Encryption

*(H9/H10 resolved July 2026: the files were part of the deleted Signal stack.)*

| # | Bug | Location |
|---|-----|----------|
| H11 | Megolm signing keys are server-authoritative (no client pinning) | `src/services/encryption/MegolmMessageEncryptionService.ts:590-595` |
| H12 | Megolm send allowed without per-message signature (v1 downgrade) | `src/services/encryption/MegolmMessageEncryptionService.ts:682-695` |

### Federation SSRF / signature integrity

| # | Bug | Location |
|---|-----|----------|
| H15 | Many hot paths now use `safeFetch`; some legacy `fetch()` sites remain | `federation-backend/src/activitypub/ActorService.ts` (multiple) |
| H16 | `instanceProbe` follows attacker-controlled NodeInfo `href` | `federation-backend/src/routes/instanceProbe.ts` |

*(H17 fixed July 2026: `claim_ap_activity`/`complete_ap_activity` RPCs (migration `20260705_ap_inbox_idempotency.sql`) gate processing on both the user and server inboxes; redeliveries are acknowledged without re-running side effects. H13/H14 fixed July 2026: `/resolve-post` validates the URL upfront via `validateExternalUrl`; `/fetch-posts` requires `outbox_url` to match the stored remote profile row. H18 fixed: ±5 min Date-header skew window in `SignatureService.verifySignature`. H19 fixed: requests with a body must carry a signature-covered, matching Digest header.)*

### Federation server-inbox authorization (Discord-clone path) — FIXED July 2026

The server inbox authenticates the sender but **allowed same-domain delegation**, so any authenticated remote user could act as any other user on their host. The microblog path (`ActivityProcessor`) had C1/C2 ownership guards; the server path (`ServerInboxHandler`) did not. Fixed by gating each mutating handler on the actor's standing in the server:

| # | Was | Fix |
|---|-----|-----|
| C1b | `processReactionActivity` accepted reactions from non-members | require accepted `user_servers` membership |
| C2b | `processDeleteActivity` soft-deleted **any** message by ap_id | require author ownership **or** owner/admin/`MANAGE_MESSAGES` |
| C2c | `processUpdateActivity` (Note) rewrote **any** message | require author ownership (author-only, even mods can't) |
| C2d | `processAddActivity` / `Remove` / `Update` channel-CRUD ungated | require host Group actor (strict) or owner/admin/`MANAGE_CHANNELS` |
| C2e | `processRemoveActivity` user-kick ungated | self-removal, or owner/admin/`KICK_MEMBERS` |
| C1c | `Create`/`Update` `ChatThread` routed to `handleThreadActivity` before any check | require accepted `user_servers` membership before routing |

Helpers `actorIsAcceptedMember` / `actorIsServerModerator` / `actorOwnsMessage` in `ServerInboxHandler.ts` (unit-tested in `src/__tests__/serverInboxAuthz.test.ts`).

Not a bug (checked): `processBlock` / `processFlag` take `actor` straight from the activity, but they run only on the **user** inbox, which enforces strict `verifyActorMatch(actor, signer)` (no same-domain delegation) with `REQUIRE_VALID_SIGNATURES` defaulting to `true`. The signer is therefore bound to `actor`; no per-handler re-check needed.

Also fixed (same pass):
- **Follow Accept/Reject no-op:** `processAccept`/`processReject` matched `follows.ap_activity_id` (nonexistent column); the write uses `ap_id`. Corrected to `ap_id`, so remote Accept/Reject now resolves.
- **`manually_approves_followers` ignored:** inbound Follow was always auto-accepted. Now stored `pending` (no Accept emitted) when the target requires approval.
- **Unescaped PostgREST `.or()` on attacker URLs:** `fetchAndCreateRemotePost` / `relinkPendingChildren` interpolated raw `ap_id`/`url` into `.or(...)` filter trees. Now quoted via `utils/postgrestFilter.ts::pgrstOrValue`.

### WebRTC / voice

| # | Bug | Location |
|---|-----|----------|
| H24 | Call signaling started before voice join (ghost ringing on failure) | `src/components/dm/DMHeader.vue:940-942` |
| H25 | Duplicate `RTCPeerConnection` per user (always-create, never-check) | `src/services/unifiedWebRTC.ts:1499-1535` |

### Frontend

| # | Bug | Location |
|---|-----|----------|
| H28 | ~~File uploads have no client-side size/MIME limit~~ Fixed July 2026: `fileService` now pre-validates via `validateImageUpload` and rejects SVG outright. Residual: audit other upload entry points (`MessageInput.vue` drag/drop paths that bypass `fileService`) | `src/services/fileService.ts` |

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
| H47 *(unverified)* | `useMessageSearch` debounce + AbortController not cleared on dispose | `src/composables/useMessageSearch.ts` |

*(H43 fixed July 2026: caller-owned cleanup + per-element WeakMap bookkeeping in `useFloatingVideo`. H44 fixed July 2026: single delegated haptic click handler, removed on unmount. H45: stale-query guard now also covers the error path. H46 fixed: monotonic sequence guard in `UserSearchModal`.)*

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
- ~~**M16-M18.**~~ Fixed July 2026 in `src/stores/shared/reactionEngine.ts`: concurrent batch fetches serialize instead of dropping ids; `toggle` layers on existing optimistic state; LRU-style eviction caps the cache at 500 entities
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

*(M29/M31/M32 fixed July 2026: server inbox now stores + claims activities through the same idempotency RPCs as the user inbox; a second inbox limiter is keyed by the sending actor's domain (IP as aggregate cap, per-limiter Redis key prefixes so limiters no longer share buckets); AP inbox bodies are capped at 1 MB.)*

- **M30.** Race: duplicate posts on concurrent identical Create deliveries
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
- ~~**L5.**~~ Resolved July 2026: `MonyFeed.vue` was dead (never routed/imported, referenced nonexistent child components) and was deleted.
- **L7-L11.** `useUndoRedo` pointer drift; notification getter re-entrancy; `spatialAudio` / voice Maps not cleared on logout; etc. *(unverified)*
- ~~**L12.**~~ Fixed July 2026: `http:` in `validateExternalUrl` now allowed only when `NODE_ENV !== 'production'`
- ~~**L13.**~~ Fixed July 2026: both the metadata and paginated inbox GET branches require the owner (or an admin); others get an empty collection, and responses are `Cache-Control: private`.
- ~~**L14.**~~ Resolved July 2026 (docs): SHA-256 is deliberate — bot tokens carry 256 bits of entropy, so a slow hash adds nothing and the digest doubles as the lookup key. The misleading bcrypt comment was removed.
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
- **P-η** - main-thread crypto: Megolm signature verify per decrypt (the Signal-based insertable-stream frame encryption and its worker were removed in July 2026), HRTF panners, 100k PBKDF2 iterations on weak devices

The two sharpest user-facing wins are still **PC2** (route-level code splitting for `AdminPanel.vue`, ~6 800 lines, eagerly imported) and **P-γ** (replacing the bot-gateway 1 s poll with `NOTIFY` / Realtime).

---

*This file is updated whenever an item is fixed or a new defect lands. PRs that close items should remove them here in the same commit.*
