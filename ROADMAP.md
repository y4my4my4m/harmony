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

*(Follow-up to the Broadcast migration: once every client build is on
`message_event`, delete the `onInsert`/`onUpdate`/`onDelete` config from
`useDM`/`useChat` and run `ALTER PUBLICATION supabase_realtime DROP TABLE
public.messages;`. Until then both transports run and dedupe by message id.)*

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

11. **Group encryption: forward secrecy and membership changes.**
    Each sender has its own session key, with a distinct key per message, rotated every 100 messages or 7 days. Its gaps are no forward secrecy within a session, no post-compromise security, key distribution over static ECDH, and a re-share to every member on each membership change. See *Interoperable end-to-end encryption* under v2.0.

## Community features

12. **Forum channels.**
    A channel whose posts are threads, each with a title and tags, listed by activity. Standalone threads (`create_channel_thread`) already give threads a parent of their own; a forum channel type, tag definitions per channel and a post list view remain.

13. **Scheduled events.**
    Server events with a start time, location (voice channel or text) and RSVPs, with reminders through notifications. Federate as ActivityPub `Event` so Mobilizon and Gancio users can see and join them.

14. **Followable announcement channels.**
    A channel other servers (and fediverse accounts) can follow; its posts are relayed into the follower's chosen channel. The channel is an ActivityPub actor with an outbox, so Mastodon users can follow it directly.

*(Outgoing webhooks, push for the official Android app from any instance and reactions on public post pages, previously items 15 to 17, shipped in 1.9.0.)*

## v2.0 (under discussion)

Scoped for discussion; nothing here is committed. Each item names the public specification it depends on and the condition for shipping.

- **Interoperable end-to-end encryption (MLS).** Messaging Layer Security (RFC 9420) for direct and group conversations, following the W3C Social Web CG draft [Messaging Layer Security in ActivityPub](https://swicg.github.io/activitypub-e2ee/), including conversations with people on other instances and other fediverse software. The protocol is chosen per conversation, advertised through the actor's `keyPackages`, and never downgraded silently. The current scheme stays for existing rooms and channels. Ships behind a flag until the draft stabilises and interoperability with another implementation is shown. Before that, the open encryption items in `BUGS.md` are fixed.
- **Bluesky through Bridgy Fed.** A per-account setting, off by default, that opts public posts into [Bridgy Fed](https://fed.brid.gy/docs). Chat, direct messages and non-public posts are never bridged.
- **Bridges beyond Discord.** Bridge v2 relayed authors generalised beyond Discord, and a per-member opt-out in bridged servers. Then a Matrix bridge (application service) in relay mode.
- **Account portability.** Import and export of follows, blocks and mutes in Mastodon's CSV formats, and of posts as ActivityStreams. Later, copying posts between servers with [LOLA](https://swicg.github.io/activitypub-data-portability/lola) (W3C Social Web CG draft), which requires Harmony to act as an OAuth authorization server.
- **Feedback.** GitHub Discussions for ideas, and an instance setting for the in-app report link. With forum channels (item 12), a public feedback forum on a Harmony server that anyone on a federating instance can join.
- **Signed objects, then portable identity.** Ed25519 keys under `assertionMethod` (FEP-521a) and integrity proofs (FEP-8b32) on activities a Group relays. Portable objects with DID-based ids and several gateways ([FEP-ef61](https://codeberg.org/fediverse/fep/src/branch/main/fep/ef61/fep-ef61.md)) remain research, aimed at chat servers that outlive their host instance.

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
