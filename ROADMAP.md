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

## 1.9.8 (from the 1.9.7 review)

- **A live relay that loses to a history import is stored quietly.** When an import inserts a Discord message before the live relay of it (`BotRestAPI` 23505 on `messages_channel_discord_message_id_unique`), the relay answers with the imported row: no realtime insert, unread, notification or federation. Needs a relay delayed past the import's recency margin.
- **The mirror worker drops a link queued while it downloads.** `bridge_mirror_finish` deletes the queue row after a failed compare-and-swap, so an edit requeued during the download is never mirrored; its Discord link expires after about a day.
- **The mirror quota adds up every mirrored file of the server per upload.** `bridge_mirror_server_bytes` sums the server's objects channel by channel before each file; keep a running total per server.
- **An import whose bridge is gone stays "Cancelling".** A running job leaves that state only through its bridge or the stale-job pause another start triggers (never with `bridge_import_max_running` 0). Managers need a way to stop it, and paused jobs a per-channel resume.
- **Stickers and sounds a manager deletes, and emojis an instance admin purges, come back at the next bridge sync.** Emojis a moderator removes carry `bridge_removed_at`; stickers (`delete_sticker`, a hard delete), sounds (`server_sounds_delete_manager`) and purged emojis (`admin_purge_emoji`, a hard delete) leave no mark the import respects, so a purged offensive emoji is downloaded again from Discord.
- **A blocked account can read who blocks it.** RLS policy `user_blocks_check_if_blocked` and `is_blocked_by()` answer it, while DM refusals word a block like a setting.
- **A blocked account can still edit its earlier direct messages.** `a_messages_dm_block_guard` runs on insert only; edits reach the blocker live.
- **One dead link stops a message's other files from being mirrored.** `mirrorWorker` downloads nothing while any candidate part of the message needs re-signing; a link Discord no longer signs (a deleted attachment) holds the rest until the row fails.
- **The admin's mirror page adds up every mirrored file every 30 s.** `BridgeImportAdmin` polls `bridge_mirror_status()`, which runs `bridge_mirror_server_bytes` for every server; with the running total above it reads one row.
- **A history batch can leave mirrored files behind.** Cleanup is keyed by Discord id, so a batch carrying one id twice, or a preparation that throws partway, leaves files until the daily `message_media` sweep.
- **Member searches can answer into a reopened view.** Kick/ban's member picker and **Server settings** → **Roles** keep a search in flight when the dialog closes or the server changes; a late answer lists the previous server's members until the next one lands.
- **A remote account's public page scans `profiles`.** The remote branch of `public_profile_page` filters on `lower(username)` and `lower(domain)`, which no index covers; `publicPageLimiter` bounds the rate.
- **A remote account that drops all its emojis keeps them on its profile.** The profile emoji resolver (`emojiResolvers.ts`) writes `bio_emojis` and `display_name_emojis` only when it finds some, so an Update(Person) without emojis leaves the old ones.
- **Undoing a channel reaction can miss a copy's emoji.** `inboundEmojiRowId` prefers a plain row of the image; an Undo that arrives after such a row appears looks there, not at the copy row the reaction holds.
- **Linking an imported channel's replies is one statement.** `bridge_import_link_replies` links every reply of the channel in one call; a channel with a very long history may reach the statement timeout. Batch it like the message inserts.
- **A deleted imported thread comes back on the next import, empty.** Its `discord_bridge_threads` mapping goes with the thread, so `bridge_import_thread` creates it again. Skipping it needs its own answer from the import route (not `409 import_not_running`, which ends the bridge's job) and a matching bridge release; record only a moderator's deletion, not a channel's, a server's or an emptied thread's.
- **Watch together trusts a peer's playback until the next control.** A participant who may control the run can send a state one revision ahead with playing off, or a `position_at` far in the future, and others stay paused or at 0: the database's polls answer a lower revision and do not apply. The other way, a broadcast landing after an honest peer's newer state steps it back briefly. Confirming a peer revision within a bound (and keeping `position_at` near the server clock) ends both.
- **An erase batch already running finishes after an opt-in or a Restore.** Only the next batch stops; locking the opt-out row for the batch would order them.
- **The per-author link-refresh limit can leave a busy author's images broken for a while.** 30 messages a minute per Discord author (`discordLinkRefresh.ts`); the client asks again only after its 30 s window, on a later render.
- **Roles → Add member can list no one.** It asks `search_server_members` for 30 matches and drops those who hold the role; exclude them in the query.
- **Queued quick replies are not tied to an account.** The service worker's queue survives sign-out and posts as whoever is signed in next.
- **A host Group can rename all of a copy's emojis on every update.** Inserts have an hourly budget; renames and image changes do not, and each fires a realtime broadcast. Skip an unchanged list, or budget changed rows as inserts are.
- **A thread someone starts on an opted-out member's Discord message arrives under that member's words.** Discord titles the thread from the message, and only the thread starter's opt-out is consulted (`bot_create_thread`, `bridge_import_thread`); the gateway is not told the starter message's author.
- **Any account can tell whether a Discord user opted out of a server's bridge.** `a_messages_bridge_optout_guard` runs before `a_messages_client_write_guard`, and `a_reactions_bridge_optout_guard` before `a_reactions_client_write_guard`, so each answers `BRIDGE_AUTHOR_OPTED_OUT` to a client insert carrying `metadata.discord_user`; refuse reserved metadata first.
- **An admin's removal of a copy emoji lapses when that admin's account is deleted.** The sync tells an admin's removal by `deleted_by`, which `ON DELETE SET NULL` clears; mark the sync's own drops in a column instead, as the bridge does with `bridge_removed_at`.
- **Instances with duplicate cached rows of one image split a copy's reaction pills.** The sync takes over the oldest row; `inboundEmojiRowId` answers the others. Merge duplicates (re-point reactions) once.
- **Update(Group) collapsing can drop one change when the listener and the worker run on hosts with skewed clocks.** The job id comes from the listener's 5 s window and completed jobs are kept; key the window on the database clock.
- **A re-import after a purge does not rebuild bridged threads.** A purge keeps a thread's starter as an empty deleted row without its Discord id, and the thread's `discord_bridge_threads` mapping stays: the re-imported starter arrives as a separate message and the replies land in the old thread, named **Thread**. A thread emptied by the purge leaves its notice behind, and the re-import posts a second one. Clear the server's thread mappings in a purge, or re-attach the starter by its Discord id.
- **A thread started on an AutoMod alert keeps its title after an erase.** The alert stays as an empty row under the thread; the thread and its notice keep the title, which an API client may have taken from the alert. Rename them with the author's threads. The web client offers no thread on system rows.
- **The Discord emoji import has no download timeout.** `discordEmojiImport.ts` fetches without one; the sound and sticker imports stop at 15 s.
- **A live post in a Discord thread started before its author opted back in keeps the thread's old title.** `bot_create_thread` does not receive the thread's creation time; history import (`bridge_import_thread`) renames such a thread **Thread**.
- **Starting an import again while it is being cancelled reports it started, and it ends cancelled.** `discord_bridge_import_start_internal` leaves a running job's `cancel_requested` set; clear it there or answer that the job is stopping.
- **Erasing the member who started an import can deadlock with that import.** `bridge_privacy_erase_core` clears `requested_by_remote` on the job row while it holds the member's lock; `bridge_import_thread` and a batch writing into a thread the erase renames hold the job row and wait for that lock. Postgres aborts one side; a retry succeeds. Clear the field with `SKIP LOCKED`, or lock the starter before the job row.
- **A bridge's history import shares one rate-limit bucket for reading and writing a job.** `BotAuthMiddleware` keys buckets by route path without the method or the id, so `GET` and `PATCH /bridge/v2/imports/:id` share 100 a minute; a fast import of small threads waits out 429s.
- **A Discord bridge can still change who an opted-out member's message is attributed to.** `PATCH /messages/{id}/metadata` on the bridge's own message accepts `discord_user`; the opt-out guard runs on content only.
- **A cursor update can land after a purge reset it.** `discord_bridge_import_update` takes cursor keys on a failed job; a bridge batch that commits before the purge and reports after it writes the old cursor back. Accept cursor keys only while the job runs.

## Next (correctness & UX)

2. **DM call decline and busy teardown** (`BUGS.md` H7).
   The ring is app-wide and the 30 s timeout leaves the room (`GlobalDMCallListener`). A decline still only shows a toast, so the caller waits out the timeout; `handleRemoteSignal` has no `decline` or `busy` case, and the busy teardown (`abandonOwnRing`) runs only while `DMHeader` is mounted.

3. **Self-assignable roles.**
   Only members with Manage Roles hand out roles, and the bot API has no route to add or remove a member's role, so Discord-style reaction-role bots are impossible. Add a `self_assignable` flag (with an optional group label) on `server_roles`, an RPC that adds or removes the caller's own self-assignable role and refuses any role at or above a permission-granting position, and a role picker in the server menu and member card. Works in encrypted servers and needs no bot. Separately, a bot route for member roles gated by `manage_roles` and role position.

4. **Warn before posting a sign-in link.**
   Invitation and password-reset links carry a single-use token: whoever opens one first can claim the account, and a self-hoster pasted one into a public support channel. The composer recognises Harmony and GoTrue sign-in links (`/auth/v1/verify?token=…`, `/reset-password?…token_hash=…`) in any message and asks before sending, with "Send anyway" and a short explanation; a link already posted shows a muted "sign-in link" hint instead of a preview.

*(Notifications of new reports to instance staff and a server's moderators, and custom emoji in announcements, shipped in 1.9.7.)*

*(Discord bridge issues, including mention resolution (`BUGS.md` H41, H42), are tracked in [harmony-discord-bridge](https://github.com/y4my4my4m/harmony-discord-bridge).)*

## Later (scale & polish)

5. **First-class instance asset packs.**
    Admins upload, list, rename and import single instance emoji in **Admin** → **Emoji**. Background images (`public/backgrounds/{login,404,offline}/`) and emoji packs (`public/assets/emojis/<pack>/`) are still folders the build picks up. Make packs a feature: a manifest recording each pack's name, license and credit line, upload and listing by pack in the admin panel, and an `/about` page that renders the attributions non-permissive packs require.

6. **Channel sidebar virtualisation.**
    Servers with hundreds of channels render every row. `@tanstack/vue-virtual` already virtualises the message list and the followers view.

7. **Group DMs across instances.**
    Local and remote participants in one group DM are wired through DB triggers and `federation-backend` listeners, specified in `docs/federation/reference.md`, with authorization unit tests. No federation round-trip case covers a mixed group DM.

8. **Admin instance discovery.**
    Currently uses `fediverse.observer`. Optional: add `instances.social`, `fediverse.info`, or a unified list view.

9. **Group encryption: forward secrecy and membership changes.**
    Each sender has its own session key, with a distinct key per message, rotated every 100 messages or 7 days. Its gaps are no forward secrecy within a session, no post-compromise security, key distribution over static ECDH, and a re-share to every member on each membership change. See *Interoperable end-to-end encryption* under v2.0.

10. **Compact sign-in providers on phones.**
    With three or more sign-in providers (Google, Twitch, GitHub and an instance's custom ones), the full-width buttons push the email form and Log in below the fold on a 375×812 screen. Show the built-in providers as one row of icon buttons with accessible names, custom providers one line each, and keep the email form in view.

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

- **Interoperable end-to-end encryption (MLS).** Messaging Layer Security (RFC 9420) for direct and group conversations, following the W3C Social Web CG draft [Messaging Layer Security in ActivityPub](https://swicg.github.io/activitypub-e2ee/), including conversations with people on other instances and other fediverse software. The protocol is chosen per conversation, advertised through the actor's `keyPackages`, and never downgraded silently. The current scheme stays for existing rooms and channels. Ships behind a flag until the draft stabilises and interoperability with another implementation is shown. Before that, the open encryption items in `BUGS.md` are fixed.
- **Bluesky through Bridgy Fed.** A per-account setting, off by default, that opts public posts into [Bridgy Fed](https://fed.brid.gy/docs). Chat, direct messages and non-public posts are never bridged.
- **Bridges beyond Discord.** Bridge v2 relayed authors generalised beyond Discord, and a per-member opt-out in bridged servers. Then a Matrix bridge (application service) in relay mode.
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

The full performance breakdown is in `BUGS.md` ("Performance addendum").

- **Bot-gateway message ingest** - 1 s `setInterval` poll on `messages` should switch to `NOTIFY` / Supabase Realtime, falling back to polling only when the subscription is unhealthy (`P-γ`).

---

*Update this file when you close, defer, or pick up an item. Open a PR with the change in the same diff that ships the work.*
