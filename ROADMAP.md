# Harmony - Roadmap

What we want to ship next, in priority order. Items are scoped so that contributors can grab one without needing to coordinate the rest.

For the list of **known defects** (not aspirational work), see [BUGS.md](./BUGS.md).
For self-hosting / federation guides, see [docs/](./docs/).

---

## Now (security & data integrity)

These ship before anything else. Nothing is open.

*(WebRTC media-key agreement, the legacy Signal setup wizard, init/migration parity and HTTP-signature replay were resolved in July 2026, recovery-code MFA in November 2026; `messages` left the Realtime publication in 1.8.7; the last unguarded third-party fetch (Klipy images) and the call-signal sender checks in 1.9.8.)*

## Next (correctness & UX)

2. **DM call decline and busy teardown.**
   The ring is app-wide and the 30 s timeout leaves the room (`GlobalDMCallListener`). A decline still only shows a toast, so the caller waits out the timeout; `handleRemoteSignal` has no `decline` or `busy` case, and the busy teardown (`abandonOwnRing`) runs only while `DMHeader` is mounted.

3. **DM call membership the server records (1.9.9).**
   Who is in a direct-message call comes from Realtime presence on `dm-call:<conversation>`, whose key the client chooses, so a participant can show another as joined (`BUGS.md` L21). A `dm_call_participants` table readable by participants, join, heartbeat (about 20 s) and leave RPCs, a pg_cron sweep that announces rows unseen for about 60 s as left, and a trigger broadcasting membership on `dm-call:`; `DMCallSignaling` reads membership from them instead of presence, and `can_track_on_topic` drops `dm-call:`.

4. **Warn before posting a sign-in link.**
   Invitation and password-reset links carry a single-use token: whoever opens one first can claim the account, and a self-hoster pasted one into a public support channel. The composer recognises Harmony and GoTrue sign-in links (`/auth/v1/verify?token=…`, `/reset-password?…token_hash=…`) in any message and asks before sending, with "Send anyway" and a short explanation; a link already posted shows a muted "sign-in link" hint instead of a preview.

5. **Connected accounts (1.9.9).**
   An account gains a sign-in provider (Discord, Google, GitHub, Twitch or an instance's own) only through a first sign-in whose verified address equals the account's, where the provider shares the default linking domain (`PROVIDER_LINKING_DOMAINS`). With another address that sign-in makes a second account, and a connection is neither shown nor removable. **User settings** lists the account's providers, connects one whatever its address (`linkIdentity`) and removes one (`unlinkIdentity`), the last way to sign in excepted. GoTrue takes both calls only with `GOTRUE_SECURITY_MANUAL_LINKING_ENABLED`, which the self-host stack sets on update. To settle: a provider identity that belongs to another account, accounts made through a provider kept apart (`is_sso_user`), the return from the provider in the desktop and Android apps, and whether connecting asks for a second factor.

*(Notifications of new reports to instance staff and a server's moderators, and custom emoji in announcements, shipped in 1.9.7.)*

*(Self-assignable roles, role menus, the role for new members and compact sign-in providers on phones shipped in 1.9.8.)*

*(Discord bridge issues, including mention resolution, are tracked in [harmony-discord-bridge](https://github.com/y4my4my4m/harmony-discord-bridge).)*

## Later (scale & polish)

6. **First-class instance asset packs.**
    Admins upload, list, rename and import single instance emoji in **Admin** → **Emoji**. Background images (`public/backgrounds/{login,404,offline}/`) and emoji packs (`public/assets/emojis/<pack>/`) are still folders the build picks up. Make packs a feature: a manifest recording each pack's name, license and credit line, upload and listing by pack in the admin panel, and an `/about` page that renders the attributions non-permissive packs require.

7. **Channel sidebar virtualisation.**
    Servers with hundreds of channels render every row. `@tanstack/vue-virtual` already virtualises the message list and the followers view.

8. **Group DMs across instances.**
    Local and remote participants in one group DM are wired through DB triggers and `federation-backend` listeners, specified in `docs/federation/reference.md`, with authorization unit tests. No federation round-trip case covers a mixed group DM.

9. **Admin instance discovery.**
    Currently uses `fediverse.observer`. Optional: add `instances.social`, `fediverse.info`, or a unified list view.

10. **Group encryption: forward secrecy and membership changes.**
    Each sender has its own session key, with a distinct key per message, rotated every 100 messages or 7 days. Its gaps are no forward secrecy within a session, no post-compromise security, key distribution over static ECDH, and a re-share to every member on each membership change. See *Interoperable end-to-end encryption* under v2.0.

11. **Project news through the fediverse.**
    Releases and funding drives are posted by the official Harmony fediverse account, which any user can follow, not pushed into self-hosted instances' announcements. Optionally, a "What's new in Harmony" panel in the admin dashboard for instance admins only.

12. **Lemmy interop against a real server** (maybe; low priority).
    Community follows, FEP-1b12 announces, comments and replies carrying the community as `audience` are tested only against the round trip's simulated Lemmy Group (`e2e/federation/cases/remoteInteractions.ts`). A local Lemmy server would check follows, posts, comments, replies, votes, edits and deletes in both directions, and what Lemmy makes of a Harmony post that mentions `!community@host`.

13. **Media on a CDN subdomain.**
    Uploaded media is addressed through the API host's storage path. Avatars, banners, emoji, Drive files and attachments are stored in the database and sent to other instances as `https://<instance>/storage/v1/object/public/<bucket>/<path>` (`getPublicUrl`), resized images as `/storage/v1/render/image/public/...`, message media as `/storage/v1/object/authenticated/message_media/...`; every such link shows the storage API's layout and bucket names in the open. Serve media from a subdomain of its own (`cdn.<domain>`, set per instance, the main host by default for self-hosters): new URLs carry the subdomain and a path without `/storage/v1`, the subdomain fronts the storage backend (R2 on production) with its own cache rules, and `/storage/v1/...` links keep resolving, since rows written before and copies on other instances hold them.

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

- **Interoperable end-to-end encryption (MLS).** Messaging Layer Security (RFC 9420) for direct and group conversations, following the W3C Social Web CG draft [Messaging Layer Security in ActivityPub](https://swicg.github.io/activitypub-e2ee/), including conversations with people on other instances and other fediverse software. The protocol is chosen per conversation, advertised through the actor's `keyPackages`, and never downgraded silently. The current scheme stays for existing rooms and channels. Ships behind a flag until the draft stabilises and interoperability with another implementation is shown. MLS credentials bind each member's signing key, replacing Megolm's server-held signing keys (`BUGS.md` H11), and a message key deleted after one use rejects replays on every device (`BUGS.md` M6).
- **Encrypted ActivityPub signing keys.** `user_private_keys.private_key` holds each local actor's PEM in plain text, as Mastodon's `accounts.private_key` does, so every database dump carries them (`BUGS.md` M36). Envelope encryption under a key the instance generates and keeps outside the database, created on upgrade with no operator step, with rotation and a documented backup of that key.
- **Bluesky through Bridgy Fed.** A per-account setting, off by default, that opts public posts into [Bridgy Fed](https://fed.brid.gy/docs). Chat, direct messages and non-public posts are never bridged.
- **Matrix bridge parity.** The [Matrix bridge](https://github.com/y4my4my4m/harmony-matrix-bridge) relays messages, replies and files of channels without end-to-end encryption; channels are paired in **Server settings** → **Bridges** → **Matrix**. Remaining, as the Discord bridge has them: edits, deletions and reactions in both directions, threads, a privacy command for Matrix people (Discord's `/bridge-privacy`), choosing a pair's Matrix room there instead of in the service's configuration, and encrypted rooms.
- **Platform-neutral ids for synced emoji, sounds and stickers.** `emojis.discord_emoji_id`, `server_sounds.discord_sound_id` and `stickers.discord_sticker_id` name one platform. With asset sync for a second bridge (Matrix), each becomes a platform and remote id pair, as `bridge_remote_optouts` is keyed. No client reads the three columns: the change is in the database and bot-gateway, and the bridge API field names stay, so released bridges keep working.
- **Account portability.** Following import (Mastodon's `following_accounts.csv` or a Harmony export) and a JSON export of posts, follows, blocks and mutes exist. Remaining: importing blocks and mutes from Mastodon's CSVs, exporting in Mastodon's CSV formats, posts as ActivityStreams, and later copying posts between servers with [LOLA](https://swicg.github.io/activitypub-data-portability/lola) (W3C Social Web CG draft), which requires Harmony to act as an OAuth authorization server.
- **Feedback.** GitHub Discussions for ideas, and an instance setting for the in-app report link. With forum channels (item 14), a public feedback forum on a Harmony server that anyone on a federating instance can join.
- **Signed objects, then portable identity.** Ed25519 keys under `assertionMethod` (FEP-521a) and integrity proofs (FEP-8b32) on activities a Group relays. Portable objects with DID-based ids and several gateways ([FEP-ef61](https://codeberg.org/fediverse/fep/src/branch/main/fep/ef61/fep-ef61.md)) remain research, aimed at chat servers that outlive their host instance.

## Deferred features

*(Who may start a conversation, everyone, people you know or people you follow, shipped in 1.9.5.)*

- **Email digests.** `notification_preferences` has `email_*` columns that nothing reads; the settings UI was removed. Needs an email backend and `send_notification` wiring.
- **Trusted-instance behaviour.** `federated_instances.is_trusted` is a badge, a list filter and a trending input. Federation-backend gating (queue priority, relaxed rate limits) is absent.

## Code-quality & technical debt

- Prefer the structured `debug` logger over raw `console.*` in app code; periodic audits help.
- Sweep `TODO` / `FIXME` comments in `src/`; many are small and area-grouped.
- Tighten `User` vs `Profile` type usage in auth/profile code (some historical conflation may remain).

## Performance hot spots

The performance notes (`P-α` … `P-η`) are in `BUGS.md`.

- **Bot-gateway message ingest** - 1 s `setInterval` poll on `messages` should switch to `NOTIFY` / Supabase Realtime, falling back to polling only when the subscription is unhealthy (`P-γ`).

---

*Update this file when you close, defer, or pick up an item. Open a PR with the change in the same diff that ships the work.*
