# Harmony - Known Issues

This file tracks defects in the Harmony codebase, including security findings. It is the canonical "if you ship a Harmony instance, here is what you should know" list.

IDs are stable and cited from code comments. Fixed entries keep their row and carry the month they closed; entries are never renumbered or deleted.

Verdicts below were re-derived against the tree in August 2026. Entries with no verdict line were not re-checked in that pass and stand as previously written.

Locations are given to directory granularity. Exact file and line references are
withheld for unfixed security items; report them through the process in
SECURITY.md and they will be shared with the reporter.

> ⚠️  **Operators / self-hosters:** several items below are exploitable security bugs without further context. If you run a public instance, review the **Critical** and **High → Encryption / Federation SSRF / Auth** sections in detail before opening federation to the wider fediverse. The schema is a single baseline migration plus the migrations after it; apply all of them.

---

## Cross-cutting patterns

### Pattern A - Auth UUID vs Profile UUID confusion

`profiles.id` (`gen_random_uuid()`) and `auth.users.id` (Supabase auth UUID) are different. The July 2026 sweep fixed the ActivityPub service reads (`getTimeline`, `getPublicTimeline`, `getEnhancedPublicTimeline`, `getFederatedTimeline`, `getLocalTimeline`, `getPostWithContext`, `getUserPosts`), the store's home/local feed + `toggleFavorite` existing-favorite lookup, `TrendingService.getTrendingUsers` self-exclusion, and `AdminService.checkAdminOrModPermissions`.

Open. Mixed sites remain: the ActivityPub self-follow guard passes an auth UUID into `follower_id`, which FKs `profiles(id)`, while the corresponding RLS policies key on `get_current_profile_id()`.

Registration writes `profiles.id = auth.users.id` (`src/views/NewProfile.vue` → `ProfileService.createProfile`, which spreads the payload and preserves `id`). The two UUIDs therefore coincide for every account this codebase creates, and the confusion is latent rather than fatal. `CoreProfileService.createProfile` whitelists columns and drops `id`, so the default fires: a registration routed through it mints `id != auth_user_id` rows and breaks every path that conflates them, including recovery-code redemption through `verify_recovery_code`. That path is not wired to registration today.

**Sweep (ongoing):** audit remaining `session?.user?.id` / `user.id` references; replace with `authContextService.getCurrentProfileId()` wherever the destination column FKs to `profiles(id)`.

### Pattern B - Logout / cleanup incompleteness (fixed July 2026)

`auth.ts:logout()` resets voice state, ActivityPub graph, reactions, permission caches, DND interval, and presence cleanup. `useServerUsers.cleanup()` also clears `userProfiles`, `usersInVoiceChannels`, `voiceChannelCallStartTimes`, and `onlineUsers`.

Megolm state is torn down from the `SIGNED_OUT` listener, not from `logout()`: `logout()` nulls `session` before `signOut()`, so the listener takes its second branch and reaches `megolmMessageEncryptionService.lockEncryption()` through `cleanupNotificationSystem()`.

Residuals: `MegolmKeyBackupService.autoBackupTimer` is not cleared by that service's own `cleanup()`, so a trailing backup can fire after logout (it throws "Recovery key not loaded" and the error is swallowed). `MegolmMessageEncryptionService.cleanup()` has no callers - dead code, not a leak, since `initialize()` re-resolves the profile id on next login. L7-L11 still lists uncleaned `spatialAudio` / voice Maps.

### Pattern C - MFA bypass via recovery code

Partially fixed July 2026. The primary password-login path calls the atomic SECURITY DEFINER RPC `redeem_recovery_code_and_disable_mfa`, which verifies AND consumes the code server-side before deleting `auth.mfa_factors`. The RPC now lives in `db_schema/migrations/20260101000000_baseline.sql`; the standalone `20260703_recovery_code_mfa_unenroll_rpc.sql` was folded into it.

**Still open** on three sites (`src/views/` × 2, `src/components/settings/user/` × 1): `verify_recovery_code` followed by a client-side `mfa.unenroll()` from an AAL1 session. `verify_recovery_code` rejects a caller whose `auth.uid()` does not match `p_user_id`, so codes cannot be burned cross-user - the residual boundary is the unenroll and the session admission that follows it. See H8. The settings site surfaces the resulting `insufficient_aal` error to the user; the two `src/views/` sites do not. Migrate all three to the RPC. `validateSessionForMFA()` remains on every session path.

### Pattern D - recovery codes were unenterable (fixed August 2026)

Enrolment has generated 10-character recovery codes since 2026-06-02, stored as a SHA-256 of the full string. Every entry field capped input at 8 characters and every submit guard required exactly 8, so the hash could never match: anyone who enrolled after that date could not use their recovery codes at all, on any path. Bounds now live in `src/utils/mfaConstants.ts`; the minimum matches the RPC's own `length >= 8` guard, so codes issued before 2026-06 still work.

Residual of the same class: the password-reset path submits the typed code verbatim. The other three entry points upper-case it first. Codes are generated as uppercase hex and hashed verbatim, so a lowercase-typed code is rejected on that path only. `text-transform` on the field is cosmetic and never reaches `v-model`.

The doc comment in `src/utils/mfaConstants.ts` claims both `redeem_recovery_code_and_disable_mfa` and `verify_recovery_code` reject inputs under 8 characters. Only the former has a length guard.

### Schema layout

`db_schema/init/` no longer exists. The schema is one baseline migration, `db_schema/migrations/20260101000000_baseline.sql`, plus the migrations after it. There is nothing to keep in parity.

The three 20260520 security migrations are present in the baseline: `prevent_profile_moderation_self_update` and its trigger, the `user_key_pairs` private-column REVOKEs + owner-only policy + `get_my_key_pair()`, and the invites SELECT restriction + `lookup_invite_by_code`. Nothing was lost in the fold.

`db_schema/SURFACE.tsv` and `db_schema/REACHABILITY.tsv` record the published surface and how execution reaches each function; both are generated from a container built from `db_schema/migrations/`.

Stale references: the baseline header credits `scripts/build-baseline-migration.sh`, which does not exist (the script is `scripts/baseline-migrations.sh`), and two in-file comments cite deleted paths (`20260520_user_key_pairs_signing_keys.sql`, `13_functions_rpc_extended.sql`).

---

## Critical (security / data corruption - fix ASAP)

*(C5, C6, C7 - the legacy Signal-Protocol client stack was deleted July 2026 (`MessageEncryptionService`, `SignalProtocolService(Browser)`, `EncryptionKeyStore(Browser)`, `WebRTCEncryptionService`, `FrameEncryptor`, `KeySetupWizard.vue`). The live app is Megolm-only. P2P calls honestly rely on DTLS-SRTP transport encryption; the live badge in `src/components/voice/VoiceEncryptionBadge.vue` says so. LiveKit voice E2EE (Megolm-wrapped room keys) is unaffected. Two residuals: `src/components/encryption/EncryptionIndicator.vue` still returns "end-to-end encrypted using insertable streams" for voice - the component has no importers, so no user sees it, but the file and its text remain; and `@privacyresearch/libsignal-protocol-typescript` is still a declared dependency with zero imports across `src/`, `federation-backend/src/`, and `bot-gateway/src/`.)*

*(C8, C10 - fixed July 2026; verified present in the baseline. `user_key_pairs` private columns are revoked from `anon` and `authenticated`, no later GRANT re-widens them, no view exposes the table, and `get_my_key_pair()` filters on the caller. Invite SELECT is restricted to creator + instance admin, with `lookup_invite_by_code` as the SECURITY DEFINER read path. C11 - recovery-code MFA bypass - is only partially fixed; see Pattern C and H8.)*

| # | Bug | Location |
|---|-----|----------|
| C9 | Profile privilege escalation. Partially fixed July 2026: the BEFORE UPDATE trigger blocks self-elevation of the moderation flags, and the update policy reuses USING as WITH CHECK so `auth_user_id` cannot be re-pointed. **INSERT is not covered.** The insert policy tests only that `auth_user_id` matches the caller; no column allowlist, no column-level GRANT, and no BEFORE INSERT trigger clamps the moderation flags. The profile row is built client-side from a caller-controlled payload, so a registering account can assert admin, and `is_current_user_admin()` reads the flag directly. An existing user can delete their own row and re-insert, at the cost of their cascaded content. No test covers the INSERT path. | `db_schema/migrations/`, `src/services/`, `src/views/` |

### Found in the August 2026 triage (no ID assigned)

- **Megolm session shares admit banned and pending members.** The share INSERT policy requires sender and recipient to satisfy `is_room_member`, which resolves a channel to its server and tests for a `user_servers` row **by existence only**. `user_servers.status` is `pending | accepted | banned`; message SELECT and the realtime topic gate both require `accepted`. A member can wrap a room's current session key to a banned account, which reads it back under the share SELECT policy and holds the key for every message in that session, including ones sent after the ban. Exploiting it needs a separate ciphertext source. The same primitive gates Megolm key requests and one further policy. Directory: `db_schema/migrations/`.
- **`is_room_member` is an unauthenticated membership oracle.** It is SECURITY DEFINER, takes `p_user_id` as a parameter with no caller binding, and `SURFACE.tsv` records it as executable by `anon`. The baseline GRANTs it to `authenticated` only; Supabase's default privileges attach the `anon` grant at CREATE time, and a `REVOKE ... FROM PUBLIC` does not remove it. The same mechanism leaves `verify_recovery_code`, `save_recovery_codes`, `redeem_recovery_code_and_disable_mfa`, and `claim_session_share` anon-executable; those self-guard on `auth.uid()` and are inert. Directory: `db_schema/migrations/`.

---

## High

### Permissions & calls

*(H2/H3 resolved July 2026: the dead `canViewChannel`/`canAccessChannel` stubs were deleted; `canViewSettings: true` is documented as intentional - the settings view doubles as a read-only server overview, with every mutation gated individually.)*

| # | Bug | Location |
|---|-----|----------|
| H6 | `isUserBusy` only queries server voice; ignores DM/LiveKit. The store excludes DM calls from the map the gate reads, and `federated_voice_calls` is written only by the federation backend and never consulted here. Both directions are affected: the caller's pre-flight check and the callee's inbound gate run the same query. The local inbound branch has no `isConnected` short-circuit; the federated branch does | `src/services/`, `src/stores/`, `src/components/dm/` |
| H7 | DM call **decline**: partially fixed. The incoming-call ring is now app-wide - the modal and its listener live in `BaseLayout`, rendered on every non-auth route, so ringing no longer depends on `DMHeader` being mounted, and the ringtone is keyed on the modal's own prop. **Still open:** the decline handler stops the caller's ringback interval and its 45 s cap and shows a toast; it performs no teardown. The 30 s call-timeout handler finalizes the message and clears call state but never leaves the voice room, and its `timeout` signal goes to a conversation channel built without self-broadcast, so the caller never receives its own timeout. After a decline the caller stays in the LiveKit room until manual hangup, with no bound. `handleRemoteSignal` has no `decline` or `busy` case. Adjacent dead path: the `initiate` case in `DMHeader` is unreachable (no producer puts `initiate` on the conversation channel), so the second `IncomingCallModal` in `DMView` never fires | `src/services/`, `src/components/dm/`, `src/views/` |
| H8 | Recovery-code login on the OAuth-callback and password-reset paths (= C11). Both call `verify_recovery_code`, then `mfa.unenroll()` from an AAL1 session, and neither checks the unenroll result. `unenroll` is rejected below AAL2, so the net effect is: the code is consumed, the factor survives, and the callback adopts the session and clears the pending-MFA flag regardless. A third site in settings runs the same sequence but surfaces the `insufficient_aal` error; its TOTP branch steps up first. The target user id is **not** caller-supplied - `verify_recovery_code` raises `42501` unless `p_user_id` matches `auth.uid()` | `src/views/`, `src/components/settings/user/` |

### Encryption

*(H9/H10 resolved July 2026: the files were part of the deleted Signal stack.)*

| # | Bug | Location |
|---|-----|----------|
| H11 | Megolm signing keys are server-authoritative (no client pinning). On a fingerprint change the pin is overwritten, the event raised is advisory and non-blocking, and own-key rotation is suppressed entirely. The server remains the key source | `src/services/encryption/` |
| H12 | ~~Megolm send allowed without per-message signature (v1 downgrade)~~ - fixed August 2026: `megolm_v1` throws on decrypt, an unknown or absent `algorithm` throws, and every decrypt caller routes through the single public entry point that performs the check. Nothing in `federation-backend/src/` or `bot-gateway/src/` writes `encryption_metadata`. Residual, not a defect: `CoreMessageService` forwards caller-supplied `encryption_metadata` to the insert without validating `algorithm` | `src/services/encryption/` |

### Federation SSRF / signature integrity

| # | Bug | Location |
|---|-----|----------|
| H15 | Many hot paths now use `safeFetch`; some legacy `fetch()` sites remain | `federation-backend/src/activitypub/` |
| H16 | `instanceProbe` follows attacker-controlled NodeInfo `href` | `federation-backend/src/routes/` |

*(H17 fixed July 2026: `claim_ap_activity`/`complete_ap_activity` RPCs gate processing on both the user and server inboxes; redeliveries are acknowledged without re-running side effects. H13/H14 fixed July 2026: `/resolve-post` validates the URL upfront via `validateExternalUrl`; `/fetch-posts` requires `outbox_url` to match the stored remote profile row. H18 fixed: ±5 min Date-header skew window in `SignatureService.verifySignature`. H19 fixed: requests with a body must carry a signature-covered, matching Digest header.)*

### Federation server-inbox authorization (Discord-clone path) - FIXED July 2026

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
| H24 | Call signaling starts before voice join (ghost ringing on failure). Both the local and federated initiators ring first and join second; each failure branch toasts and returns without sending a cancel. The local ring is bounded at 30 s by the timeout signal, which reaches the receivers' user channels. The federated timeout handler dispatches only to local listeners and sends nothing to the remote instance, so a remote callee's ring is bounded only by their own client's 45 s watchdog. Asymmetry: the federated timeout reaches the caller's own header (direct dispatch, so it leaves voice); the local one does not (broadcast, no self-echo) | `src/components/dm/`, `src/services/` |
| H25 | Duplicate `RTCPeerConnection` per user. `createPeerConnection` constructs unconditionally and overwrites the map entry without closing the old connection or its remote audio - contrast the leave handler, which does both. The join handler calls it with no existence check; the offer handler does check. P2P is the fallback mode (entered when SFU join fails and the channel does not require E2EE), not the primary path | `src/services/` |

### Frontend

| # | Bug | Location |
|---|-----|----------|
| H28 | ~~File uploads have no client-side size/MIME limit~~ Fixed July 2026: `fileService` pre-validates via `validateImageUpload` and rejects SVG outright. Residual: audit other upload entry points (`MessageInput.vue` drag/drop paths that bypass `fileService`) | `src/services/` |

### Realtime / store state

| # | Bug | Location |
|---|-----|----------|
| H33 | Documented notification `postgres_changes` fallback never implemented | `src/stores/` |

### Bot infrastructure

| # | Bug | Location |
|---|-----|----------|
| H41 | Discord mention resolution can ping wrong user (username-only cache) | `bot-plugins/discord-bridge/src/` |
| H42 | Unresolved plain-text `@mentions` create bogus Harmony mentions (`unresolved-${username}`) | `bot-plugins/discord-bridge/src/` |

### Lifecycle / leaks

| # | Bug | Location |
|---|-----|----------|
| H47 *(unverified)* | `useMessageSearch` debounce + AbortController not cleared on dispose | `src/composables/useMessageSearch.ts` |

*(H43 fixed July 2026: caller-owned cleanup + per-element WeakMap bookkeeping in `useFloatingVideo`. H44 fixed July 2026: single delegated haptic click handler, removed on unmount. H45: stale-query guard now also covers the error path. H46 fixed: monotonic sequence guard in `UserSearchModal`.)*

### Reports / IDs

| # | Bug | Location |
|---|-----|----------|
| H48 | Invite usage update blocked for accepter by RLS - `max_uses` not enforced atomically | `src/services/inviteService.ts`, `db_schema/migrations/` |

---

## Medium

### Encryption

*(M1, M3 no longer apply: both were in `MessageEncryptionService`, deleted with the Signal stack - see C5/C6/C7 above.)*

- **M2.** Megolm encrypt proceeds after `ensureSessionShared` failures (new members get undecryptable messages). Every failure path returns `void` and the message ships. The session-share INSERT policy makes this worse: a share to a non-member is now rejected by RLS, which surfaces as a logged error on the same swallow path - `MegolmMessageEncryptionService.ts`
- **M5.** `messageDecryption` overloads `sender_verified: false` on any decrypt error - `src/utils/messageDecryption.ts`
- **M6.** No replay resistance for Megolm v2 at application layer. The only index check is `messageIndex < firstKnownIndex`; no seen-index set exists

### Realtime / stores

- **M7-M10.** `PostReactionsRealtime` refCount mismatch, typing-indicator subscription gap, `UserEventChannel` reconnect, `userDataService` user-list update skip *(some unverified)*
- **M14.** `useServerChannel` server-structure channel has no reconnect on error
- **M15.** Logout/presence ordering: Redis offline before Supabase teardown
- ~~**M16-M18.**~~ Fixed July 2026 in `src/stores/shared/reactionEngine.ts`: concurrent batch fetches serialize instead of dropping ids; `toggle` layers on existing optimistic state; LRU-style eviction caps the cache at 500 entities
- **M20.** `verify2FA` timeout doesn't cancel in-flight MFA verify. `Promise.race` abandons the loser, but the loser completes inside `@supabase/auth-js`, which saves the session on the MFA verify path and notifies subscribers. A "timed out" verify still writes the AAL2 session to storage, and the next `INITIAL_SESSION` adopts it
- **M21.** `loadBlockingData()` not awaited on some login paths - `src/stores/`
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

- **M64.** No entry. The ID is cited from `src/stores/auth.ts` alongside C11 and has never appeared in this file; the citing comments should drop it or the entry should be written
- **M65.** Registration sets session before email verification - `src/stores/auth.ts` register flow
- **M66.** `AuthContextService` cache not cleared from auth store on logout
- **M67.** `AdminService` direct table writes depend entirely on RLS

---

## Low

*(L1 no longer applies: it was in `MessageEncryptionService`, deleted with the Signal stack.)*

- **L2.** HKDF ratchet uses fixed all-zero salt - `MegolmService.ts`
- **L4.** Thread views lack `onReconnected` gap-fill - `ThreadFullView.vue`
- ~~**L5.**~~ Resolved July 2026: `MonyFeed.vue` was dead (never routed/imported, referenced nonexistent child components) and was deleted.
- **L7-L11.** `useUndoRedo` pointer drift; notification getter re-entrancy; `spatialAudio` / voice Maps not cleared on logout; etc. *(unverified)*
- ~~**L12.**~~ Fixed July 2026: `http:` in `validateExternalUrl` now allowed only when `NODE_ENV !== 'production'`
- ~~**L13.**~~ Fixed July 2026: both the metadata and paginated inbox GET branches require the owner (or an admin); others get an empty collection, and responses are `Cache-Control: private`.
- ~~**L14.**~~ Resolved July 2026 (docs): SHA-256 is deliberate - bot tokens carry 256 bits of entropy, so a slow hash adds nothing and the digest doubles as the lookup key. The misleading bcrypt comment was removed.
- **L15.** Dev error responses may leak internal messages - `bot-gateway/src/index.ts`
- **L16.** Verbose logging of message metadata/content - `bot-gateway/src/api/BotRestAPI.ts`
- **L17.** Bridge shutdown doesn't clear periodic user-refresh interval
- **L18.** Supabase session persisted in `localStorage` (XSS-readable refresh token) - `src/supabase.ts`
- **L19.** `userScopedStorage` falls back to global keys when no user is set - `src/utils/userScopedStorage.ts`
- **L20.** `SessionHeartbeat` is fully disabled - no server-side invalidation signal - `src/services/SessionHeartbeat.ts`

### Found in the August 2026 triage (no ID assigned)

- `purge_stale_invites` is SECURITY DEFINER with no auth guard and is published to `anon`. Its cron entry is the intended caller. An unauthenticated caller can force the daily cleanup early; the DELETE is bounded to invites already expired or exhausted for over 30 days. Directory: `db_schema/migrations/`.

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

*This file is updated whenever an item is fixed or a new defect lands. A PR that closes an item marks the row fixed here in the same commit. Rows are not deleted and IDs are not reused: code comments cite them.*
