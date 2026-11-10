# Harmony - Roadmap

What we want to ship next, in priority order. Items are scoped so that contributors can grab one without needing to coordinate the rest.

For the list of **known defects** (not aspirational work), see [BUGS.md](./BUGS.md).
For self-hosting / federation guides, see [docs/](./docs/).

---

## Now (security & data integrity)

These ship before anything else. Each has a corresponding entry in `BUGS.md`.

1. **Validate the last third-party fetch** (`BUGS.md` H15).
   ActivityPub fetches, including the NodeInfo `href` followed by `instanceProbe`, go through `safeFetch`. `KlipyService` fetches an `imageUrl` taken from the Klipy API response with a raw `fetch()` and no address check.

*(WebRTC media-key agreement, the legacy Signal setup wizard, init/migration parity and HTTP-signature replay were resolved in July 2026, recovery-code MFA in November 2026; `messages` left the Realtime publication in 1.8.7. See `BUGS.md`.)*

## Next (correctness & UX)

2. **DM call decline and busy teardown** (`BUGS.md` H7).
   The ring is app-wide and the 30 s timeout leaves the room (`GlobalDMCallListener`). A decline still only shows a toast, so the caller waits out the timeout; `handleRemoteSignal` has no `decline` or `busy` case, and the busy teardown (`abandonOwnRing`) runs only while `DMHeader` is mounted.

3. **Self-assignable roles.**
   Only members with Manage Roles hand out roles, and the bot API has no route to add or remove a member's role, so Discord-style reaction-role bots are impossible. Add a `self_assignable` flag (with an optional group label) on `server_roles`, an RPC that adds or removes the caller's own self-assignable role and refuses any role at or above a permission-granting position, and a role picker in the server menu and member card. Works in encrypted servers and needs no bot. Separately, a bot route for member roles gated by `manage_roles` and role position.

4. **Notify moderators of new reports.**
   `create_report`, `create_federated_report` and `create_federated_server_report` insert the report and notify nobody; only the reporter hears back (`report_update`). The pending count (`get_pending_reports_count`) shows only inside the admin Reports screen. Notify instance staff for instance reports and the server's moderators (`can_current_user_moderate_server_reports`) for server-scoped ones, with a notification type they can mute, and a pending-count badge on the moderation entry.

5. **Warn before posting a sign-in link.**
   Invitation and password-reset links carry a single-use token: whoever opens one first can claim the account, and a self-hoster pasted one into a public support channel. The composer recognises Harmony and GoTrue sign-in links (`/auth/v1/verify?token=…`, `/reset-password?…token_hash=…`) in any message and asks before sending, with "Send anyway" and a short explanation; a link already posted shows a muted "sign-in link" hint instead of a preview.

*(Discord bridge issues, including mention resolution (`BUGS.md` H41, H42), are tracked in [harmony-discord-bridge](https://github.com/y4my4my4m/harmony-discord-bridge).)*

## Later (scale & polish)

6. **First-class instance asset packs.**
    Today, instance operators can drop background images into
    `public/backgrounds/{login,404,offline}/` and emoji folders into
    `public/assets/emojis/<pack>/` and the build picks them up. Make this
    a real feature: an admin-panel UI for uploading/listing emoji packs,
    a manifest format that records pack metadata (name, license, credit
    line), and an `/about` page that auto-renders the required
    attributions for non-permissive packs.

7. **Channel sidebar virtualisation.**
    Servers with hundreds of channels render every row. `@tanstack/vue-virtual` already virtualises the message list and the followers view.

8. **Group DMs across instances.**
    Local and remote participants in one group DM are wired through DB triggers and `federation-backend` listeners, specified in `docs/federation/reference.md`, with authorization unit tests. No federation round-trip case covers a mixed group DM.

9. **Admin instance discovery.**
    Currently uses `fediverse.observer`. Optional: add `instances.social`, `fediverse.info`, or a unified list view.

10. **Group encryption: forward secrecy and membership changes.**
    Each sender has its own session key, with a distinct key per message, rotated every 100 messages or 7 days. Its gaps are no forward secrecy within a session, no post-compromise security, key distribution over static ECDH, and a re-share to every member on each membership change. See *Interoperable end-to-end encryption* under v2.0.

11. **Compact sign-in providers on phones.**
    With three or more sign-in providers (Google, Twitch, GitHub and an instance's custom ones), the full-width buttons push the email form and Log in below the fold on a 375×812 screen. Show the built-in providers as one row of icon buttons with accessible names, custom providers one line each, and keep the email form in view.

12. **Project news through the fediverse.**
    Releases and funding drives are posted by the official Harmony fediverse account, which any user can follow, not pushed into self-hosted instances' announcements. Optionally, a "What's new in Harmony" panel in the admin dashboard for instance admins only.

13. **Lemmy interop against a real server** (maybe; low priority).
    Community follows, FEP-1b12 announces, comments and replies carrying the community as `audience` are tested only against the round trip's simulated Lemmy Group (`e2e/federation/cases/remoteInteractions.ts`). A local Lemmy server would check follows, posts, comments, replies, votes, edits and deletes in both directions, and what Lemmy makes of a Harmony post that mentions `!community@host`.

## Community features

14. **Forum channels.**
    A channel whose posts are threads, each with a title and tags, listed by activity. Standalone threads (`create_channel_thread`) already give threads a parent of their own; a forum channel type, tag definitions per channel and a post list view remain.

15. **Scheduled events.**
    Server events with a start time, location (voice channel or text) and RSVPs, with reminders through notifications. Federate as ActivityPub `Event` so Mobilizon and Gancio users can see and join them.

16. **Followable announcement channels.**
    A channel other servers (and fediverse accounts) can follow; its posts are relayed into the follower's chosen channel. The channel is an ActivityPub actor with an outbox, so Mastodon users can follow it directly.

17. **Federated Drive sharing.**
    "Share with @user@other.instance" sends a direct message carrying the Drive file; the remote server fetches it as it fetches a federated DM attachment (signed fetch, domain admitted by the room rules). Per-user privacy is the remote server's to honour, as for DMs. "Anyone with the link" already reaches fediverse users.

*(Outgoing webhooks, push for the official Android app from any instance and reactions on public post pages shipped in 1.9.0.)*

## v2.0 (under discussion)

Scoped for discussion; nothing here is committed. Each item names the public specification it depends on and the condition for shipping.

- **Interoperable end-to-end encryption (MLS).** Messaging Layer Security (RFC 9420) for direct and group conversations, following the W3C Social Web CG draft [Messaging Layer Security in ActivityPub](https://swicg.github.io/activitypub-e2ee/), including conversations with people on other instances and other fediverse software. The protocol is chosen per conversation, advertised through the actor's `keyPackages`, and never downgraded silently. The current scheme stays for existing rooms and channels. Ships behind a flag until the draft stabilises and interoperability with another implementation is shown. Before that, the open encryption items in `BUGS.md` are fixed.
- **Bluesky through Bridgy Fed.** A per-account setting, off by default, that opts public posts into [Bridgy Fed](https://fed.brid.gy/docs). Chat, direct messages and non-public posts are never bridged.
- **Bridges beyond Discord.** Bridge v2 relayed authors generalised beyond Discord, and a per-member opt-out in bridged servers. Then a Matrix bridge (application service) in relay mode. An experimental plaintext development relay lives in [`matrix-bridge/`](./matrix-bridge/README.md), with generalized Discord/Matrix authors and native per-member opt-out. In-client Matrix setup and encrypted, revocable-participant support remain open; the current relay uses one Matrix sender and does not implement virtual-user profile mirroring.
- **Account portability.** Import and export of follows, blocks and mutes in Mastodon's CSV formats, and of posts as ActivityStreams. Later, copying posts between servers with [LOLA](https://swicg.github.io/activitypub-data-portability/lola) (W3C Social Web CG draft), which requires Harmony to act as an OAuth authorization server.
- **Feedback.** GitHub Discussions for ideas, and an instance setting for the in-app report link. With forum channels (item 14), a public feedback forum on a Harmony server that anyone on a federating instance can join.
- **Signed objects, then portable identity.** Ed25519 keys under `assertionMethod` (FEP-521a) and integrity proofs (FEP-8b32) on activities a Group relays. Portable objects with DID-based ids and several gateways ([FEP-ef61](https://codeberg.org/fediverse/fep/src/branch/main/fep/ef61/fep-ef61.md)) remain research, aimed at chat servers that outlive their host instance.

## Deferred features

- **Email digests.** `notification_preferences` has `email_*` columns that nothing reads; the settings UI was removed. Needs an email backend and `send_notification` wiring.
- **DM permission gates.** "Allow direct messages from server members" and "from people you follow": no columns, no UI, no enforcement in the DM-send path.
- **Trusted-instance behaviour.** `federated_instances.is_trusted` is a badge, a list filter and a trending input. Federation-backend gating (queue priority, relaxed rate limits) is absent.

## Code-quality & technical debt

- Prefer the structured `debug` logger over raw `console.*` in app code; periodic audits help.
- Sweep `TODO` / `FIXME` comments in `src/`; many are small and area-grouped.
- Tighten `User` vs `Profile` type usage in auth/profile code (some historical conflation may remain).

## Performance hot spots

The full performance breakdown is in `BUGS.md` ("Performance addendum").

- **Bot-gateway message ingest** - 1 s `setInterval` poll on `messages` should switch to `NOTIFY` / Supabase Realtime, falling back to polling only when the subscription is unhealthy (`P-γ`).

---

*Update this file when you close, defer, or pick up an item. Open a PR with the change in the same diff that ships the work.*
