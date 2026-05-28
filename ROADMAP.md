# Harmony - Roadmap

What we want to ship next, in priority order. Items are scoped so that contributors can grab one without needing to coordinate the rest.

For the list of **known defects** (not aspirational work), see [BUGS.md](./BUGS.md).
For self-hosting / federation guides, see [docs/](./docs/).

---

## Now (security & data integrity)

These ship before anything else. Most have a corresponding entry in `BUGS.md`.

1. **WebRTC media-key agreement** (`BUGS.md` C5).
   Wire DTLS-SRTP fingerprints (or a Signal-derived key exchange) so both ends of a call use the same AES key before the UI claims E2EE is on.

2. **Retire the legacy Signal setup wizard** (`BUGS.md` C6, C7).
   New users already onboard through the Megolm + recovery-key flow. Remove the legacy path that uploads unwrapped identity keys, and migrate any rows still using it.

3. **Port the May-2026 security migrations into `db_schema/init/`** (`BUGS.md` C8, C9, C10).
   Fresh installs should not need a manual second pass.

4. **Recovery-code MFA hardening** (`BUGS.md` C11 / H8).
   Either require an AAL2 step-up before `mfa.unenroll`, or rotate to a fresh enrollment instead of unenrolling.

5. **SSRF lockdown for admin-triggered fetches** (`BUGS.md` H13-H16, M56).
   Centralise on `safeFetch` for `resolve-post`, `fetch-posts`, NodeInfo follow, and the client-side image fetcher.

6. **HTTP signature replay & body integrity** (`BUGS.md` H17-H19).
   Add a `Date` skew window, mark `ap_activities` completed in the inbox handler, require Digest when a body is present.

## Next (correctness & UX)

7. **Permission fail-closed pass.**
   `useChannelPermissions.canViewChannel` / `canAccessChannel` and `useServerPermissions.canViewServerSettings` currently return `true` unconditionally (`BUGS.md` H2, H3). The server-side checks are correct; the client-side hardcodes are misleading and need to mirror them.

8. **Notifications behaviour & UX audit.**
   DM noise when already in the conversation, click-to-navigate edge cases, push vs in-app duplication, missing `notification_preferences` honouring per type.
   *Files:* `src/stores/useNotification.ts`, `src/services/NotificationFormatter.ts`, `src/composables/usePushNotifications.ts`, the `send_notification` DB triggers.

9. **DM call lifecycle when `DMHeader` unmounts.**
   The remote `accept` path was lifted to a global handler; `decline` and ring-cancellation still depend on the sender's `DMHeader` being mounted (`BUGS.md` H7).

10. **Bridge mention resolution.**
    Discord → Harmony bridge currently caches by username only and emits `unresolved-${username}` mentions when it can't match (`BUGS.md` H41, H42). Fix the cache key and drop unresolved parts back to plain text.

## Later (scale & polish)

10b. **First-class instance asset packs.**
    Today, instance operators can drop background images into
    `public/backgrounds/{login,404,offline}/` and emoji folders into
    `public/assets/emojis/<pack>/` and the build picks them up. Make this
    a real feature: an admin-panel UI for uploading/listing emoji packs,
    a manifest format that records pack metadata (name, license, credit
    line), and an `/about` page that auto-renders the required
    attributions for non-permissive packs (e.g. Mutant Standard
    CC-BY-NC-SA).



11. **Mobile layout pass on `BaseLayout.vue`.**
    Several stale `// TODO` comments mark profile / nav affordances that don't fit on small screens.

12. **Channel sidebar virtualisation.**
    Servers with hundreds of channels render every row; consider `vue-virtual-scroller` (in-tree TODO already flags this).

13. **Group DMs across instances.**
    Local + remote participants in the same group DM are wired through DB triggers and `federation-backend` listeners, but lack integration tests and a documented behaviour spec.

14. **Admin instance discovery.**
    Currently uses `fediverse.observer`. Optional: add `instances.social`, `fediverse.info`, or a unified list view.

15. **Sender Keys for group encryption.**
    `SignalProtocolService.ts` uses a per-member encrypt path that does not scale. Sender Keys (Signal style) is the standard answer for group chat at scale.

## Public-release follow-ups

These were uncovered while preparing the public release and are in flight:

- **Account self-deletion.** The Advanced Settings "Delete Account" button is currently disabled with a "Coming soon" badge. Implementing it requires an AAL2 step-up flow + a `delete_user_account` RPC that cascades through `profiles`, `messages`, encryption keys, and federation actor records.
- **Hardware-acceleration override.** Currently disabled in the UI; the toggle exists but there is no read site. Wire it to the Tauri WebView HW-acceleration API (web has no equivalent) and persist via `userStorage`.
- **Email digests / summaries.** UI is disabled with "Coming soon"; needs an email backend + the `email_*` columns on `notification_preferences` (already present) wired through `send_notification`.
- **DM permission gates.** "Allow direct messages from server members" / "Allow direct messages from people you follow" toggles currently render as "Coming soon" placeholders. They need columns on `notification_preferences` + server-side enforcement in the DM-send path.
- **Trusted-instance behavior.** `federated_instances.is_trusted` is currently a UI badge + a list filter. Federation-backend gating (queue priority, relaxed rate limits, lighter content sanitization) is documented as a roadmap goal but not yet implemented.

## Code-quality & technical debt

- Prefer the structured `debug` logger over raw `console.*` in app code; periodic audits help.
- Sweep `TODO` / `FIXME` comments in `src/`; many are small and area-grouped.
- Tighten `User` vs `Profile` type usage in auth/profile code (some historical conflation may remain).

## Performance hot spots

The full performance breakdown is in `BUGS.md` ("Performance addendum"). The two highest-leverage wins:

- **`AdminPanel.vue` route-level code splitting** - currently ~6 800 lines, eagerly imported (`PC2`).
- **Bot-gateway message ingest** - 1 s `setInterval` poll on `messages` should switch to `NOTIFY` / Supabase Realtime, falling back to polling only when the subscription is unhealthy (`P-γ`).

---

*Update this file when you close, defer, or pick up an item. Open a PR with the change in the same diff that ships the work.*
