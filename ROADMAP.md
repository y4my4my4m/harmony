# Harmony - Roadmap

What we want to ship next, in priority order. Items are scoped so that contributors can grab one without needing to coordinate the rest.

For the list of **known defects** (not aspirational work), see [BUGS.md](./BUGS.md).
For self-hosting / federation guides, see [docs/](./docs/).

---

## Now (security & data integrity)

These ship before anything else. Most have a corresponding entry in `BUGS.md`.

1. **Finish the recovery-code MFA hardening** (`BUGS.md` C11 / H8).
   The password-login path now redeems through the atomic `redeem_recovery_code_and_disable_mfa` RPC. `AuthCallbackView` and `ResetPasswordView` still verify the code and call `mfa.unenroll()` client-side from an AAL1 session. Route both through the same RPC.

2. **Finish the SSRF lockdown** (`BUGS.md` H15, H16).
   Hot paths use `safeFetch`; legacy `fetch()` sites remain in the ActivityPub backend, and `instanceProbe` still follows an attacker-controlled NodeInfo `href`.

*(WebRTC media-key agreement, the legacy Signal setup wizard, init/migration parity and HTTP-signature replay - previously items 1, 2, 3 and 6 here - were resolved in July 2026. See `BUGS.md`.)*

## Next (correctness & UX)

3. **Notifications behaviour & UX audit.**
   DM noise when already in the conversation, click-to-navigate edge cases, push vs in-app duplication, missing `notification_preferences` honouring per type.
   *Files:* `src/stores/useNotification.ts`, `src/services/NotificationFormatter.ts`, `src/composables/usePushNotifications.ts`, the `send_notification` DB triggers.

4. **DM call lifecycle when `DMHeader` unmounts.**
   The remote `accept` path was lifted to a global handler; `decline` and ring-cancellation still depend on the sender's `DMHeader` being mounted (`BUGS.md` H7).

5. **Bridge mention resolution.**
    Discord → Harmony bridge currently caches by username only and emits `unresolved-${username}` mentions when it can't match (`BUGS.md` H41, H42). Fix the cache key and drop unresolved parts back to plain text.

## Later (scale & polish)

6. **First-class instance asset packs.**
    Today, instance operators can drop background images into
    `public/backgrounds/{login,404,offline}/` and emoji folders into
    `public/assets/emojis/<pack>/` and the build picks them up. Make this
    a real feature: an admin-panel UI for uploading/listing emoji packs,
    a manifest format that records pack metadata (name, license, credit
    line), and an `/about` page that auto-renders the required
    attributions for non-permissive packs.



7. **Mobile layout pass on `BaseLayout.vue`.**
    Several stale `// TODO` comments mark profile / nav affordances that don't fit on small screens.

8. **Channel sidebar virtualisation.**
    Servers with hundreds of channels render every row; consider `vue-virtual-scroller` (in-tree TODO already flags this).

9. **Group DMs across instances.**
    Local + remote participants in the same group DM are wired through DB triggers and `federation-backend` listeners, but lack integration tests and a documented behaviour spec.

10. **Admin instance discovery.**
    Currently uses `fediverse.observer`. Optional: add `instances.social`, `fediverse.info`, or a unified list view.

11. **Sender Keys for group encryption.**
    Megolm shares one session per member on join. Sender Keys (Signal style) is the standard answer for group chat at scale.

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
