# Changelog

All notable user-facing changes to Harmony will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.6.7] - 2026-10-02

### Added
- **Private calls and presence.** Voice, video and call events travel on
  private channels only the people in the room can join. Online status is
  visible only to people you share a server or conversation with and to
  followers; invisible means offline to everyone. DM calls work across
  instances.
- **QR device pairing.** Link a new device by scanning a code, in either
  direction, instead of typing the recovery phrase. A device can keep a copy of
  its keys so it can link more devices later (opt-in, removable in
  Settings › Encryption).
- **Reactions count as favourites.** Reacting to a post favourites it; removing
  your last reaction removes it. Up to 10 different reactions per person per
  post (instance setting) and 20 different emoji per chat message. Mastodon,
  Misskey and Pleroma each receive reactions in the form they understand.
- **Moderation.** Reports from messages and posts with evidence, forwarding to
  remote instances, a moderator queue; AutoMod rules per server; newcomer
  alerts for owners and moderators.
- **Bots** appear in the member list with a profile card; server owners choose
  which channels a bot may post in.
- **Onboarding.** A suggested welcome server at signup, server welcome screens
  with rules, and discovery categories chosen by the owner.
- **Two-factor authentication** enforced by the server, session management and
  data export.
- **Translations.** German, Spanish, French, Japanese, Korean and Chinese
  cover every string, including the new security, pairing and moderation
  screens.

### Changed
- **Attachments are private.** New chat and DM files are readable only by
  people in that room, through signed links; remote instances get links bound
  to them. Deleted messages' files are removed.
- **Uploads keep the original file**; only files over the size limit are
  shrunk. Images are displayed at the size shown.
- **Discover communities** opens on every click and reopens instantly from
  cache.
- **Unread counts** are computed on read: sending a message no longer slows
  down large servers, and switching servers is much faster.
- The funding heart shows only on phones; desktop uses the sidebar.

### Fixed
- Mentions of users on instances with subdomains, and email addresses turning
  into mentions.
- Chat video and audio uploads were refused.
- Chat jumping while reading history; jumps to a message landing above it.
- The composer and the feed, and the profile page's edges, no longer misalign.
- Ticking a checkbox in Voice & Video settings no longer slides the page.
- Many security fixes across the database, federation and the app.

## [1.6.2] - 2026-10-01

### Added
- **Desktop auto-updates.** The desktop app downloads new releases in the
  background and shows "Update ready" in the server rail; it restarts into the
  new version only when you click. Settings › Advanced shows the version, a
  check button and an auto-download toggle. The Android app shows a notice
  with a link when a new APK is published. This release is the last one to
  install by hand.
- **Voice and video, closer to Discord.** Per-user volume from 0 to 200% with
  a local mute that keeps the level, remembered per user. Screen share opens a
  Go live panel (720p, 1080p or source, 30 or 60 fps); stream audio is its own
  track, so viewers can turn a stream down separately from the voice. Watching
  a stream is opt-in. Tiles gain a menu button, hover volume, live and
  connection badges, grid and focus layouts, a call timer and a reconnecting
  state. Master and input volume sliders now work; master defaults to 100%.
- **Notifications inbox.** The bell opens All, Mentions and Social tabs with
  an unread filter, day groups, inline mark read and remove, and keyboard
  navigation.
- **Today**, rebuilt: announcements, mentions and replies, unread DMs, unread
  channels by server with mark read, active threads, live voice, follow
  requests and top posts from people you follow.
- **Media tab** on every profile, local and remote: a grid of photos and
  videos with sensitive media blurred.
- **Message search filters**, as in Discord: `from:`, `mentions:`, `has:`,
  `in:`, `before:`/`after:`/`during:` and `pinned:`, with suggestions, results
  grouped by channel and jump to message.

### Changed
- DM calls: the call buttons reflect only their own conversation, switching
  calls asks first, callers see ringing tiles, and missed calls say so.
- Spatial audio is off by default and remembers your choice.
- SDR-001 / Neo Kobe 1988 skin reworked: readable red and steel text, square
  frames, fixed icons, lighter scanlines. Existing users get the new
  background after picking the skin again.
- The instance funding window shows progress toward the goal and leads with
  the donation link.
- Double-click to react fires only on empty space in a message;
  double-clicking a word selects it.
- The code block copy button sits beside the language label, clear of the
  message toolbar.

### Fixed
- **@everyone and role mentions** notified everyone regardless of permission.
  @everyone now requires Mention @everyone, roles not marked mentionable need
  the same permission, and bots need it on their install.
- **Push notifications**: enabling push on one device removed it from others;
  replies, reactions and social pushes were never sent; clicks opened the
  wrong page; subscriptions that expired or rotated were never renewed. Push
  now repairs itself after sign-in without prompting again.
- A closed tab or a phone in the background kept notifications for its last
  channel suppressed indefinitely.
- Quiet hours dropped notifications instead of silencing them.
- Creating a server folder, including dragging one server onto another,
  failed.
- Desktop and Android apps: GIFs, federated server discovery and joining,
  user lookup and post links failed.
- Theme editor: the message box disappeared into the background while
  editing, and many colour swatches could not be clicked.
- The file drop overlay could stay on screen; folder tooltips could stay open;
  right-click menus did not close with Escape.
- Author names on posts showed a heavy highlight on hover; the Appearance
  dropdowns were unstyled.
- Code blocks had a blank line above and below.

### Notes for self-hosters
- Six migrations since 1.6.1 (`20261002000001` to `20261003500001`);
  `bootstrap.sh --migrations-only` applies them. Take a backup first.
  `20261003400001` changes who can ping @everyone and unmentionable roles;
  bots without `mention_everyone` on their install stop pinging @everyone.
- Rebuild the federation backend image (`docker compose up -d --build`); the
  push routes changed.
- Desktop auto-updates are signed with a key held in the release repository's
  secrets; forks that publish their own builds need their own key (see
  `docs/DEVELOPMENT.md`).

## [1.6.1] - 2026-09-30

### Added
- **Per-channel end-to-end encryption.** Channel managers (the owner, admins
  and roles with Manage Channels) turn encryption on per channel; the server
  policy (disabled, optional, required) is the floor. Encrypted channels show
  a lock, mentions still notify with "Encrypted message" as the preview, and
  voice encryption follows the channel. The database rejects unencrypted
  messages in encrypted channels, and encrypted channels do not federate.
- **Floating video player**: touch drag and resize, corner snapping clear of
  the composer and keyboard, docks back when its message scrolls into view,
  one video at a time.
- Pins and threads update immediately: the pin badge, pinned list and thread
  panel no longer wait on the server, and failures roll back with a message.
  The pinned-messages button is always in the channel header.

### Changed
- App-wide visual pass: the accent colour reaches every component, surfaces
  are flat, status colours follow the theme (light themes are readable), and
  column headers share one height. Floating surfaces keep their glass behind
  the Appearance blur toggle.
- Social: trending and suggested follows are compact lists; pinned posts line
  up with the feed.
- Private servers, and channels hidden from @everyone, are served over
  federation only to signed requests from accepted members who can view them.
  Harmony signs its reads of remote servers as the reading member, and retries
  signed when a remote instance requires authorized fetch.
- First load is half the size (1030 kB to 515 kB of JavaScript, gzipped); the
  voice library loads when joining a call.
- Server member lists and the home timeline query in milliseconds on large
  servers.
- Server privacy settings have one discovery choice instead of two controls
  for the same setting.

### Fixed
- **Federation authorization.** Undo, Accept/Reject and fetched documents are
  bound to the actor that signed them: remote servers could delete local
  posts, remove other users' follows, take over a remote actor's key, or
  attribute posts to anyone. Remote members can no longer post into channels
  they cannot view.
- **Database access.** Legacy access rules on existing installs let pending
  members read and post in every channel and let a blocked user keep posting
  in a DM; they are removed. Channel visibility is now enforced on messages,
  threads, reactions, search, live updates and notifications. Notification,
  pin and message-rewrite functions no longer trust caller-supplied identity.
- Message search returned nothing on installs created from the 1.6.0 schema.
- The federation backend retained memory for every authenticated request.
- The bot gateway could deliver the same event twice.
- GoToSocial activities were rejected; unlisted posts appeared
  followers-only elsewhere; Mastodon ignored edits; attachments and alt text
  did not federate.
- Light themes: unreadable toasts, grey dialogs and hashtag chips.

### Notes for self-hosters
- Eight migrations since 1.6.0 (`20260930000002` to `20261001200003`);
  `bootstrap.sh --migrations-only` applies them. Take a backup first.
  `20261001200001` converges RLS policies to the canonical set and prints each
  create, keep and drop. `20261001000001` turns encryption on for channels
  that already hold encrypted messages.
- Apply `20261001100001` before starting the new federation backend, and
  rebuild its image (`docker compose up -d --build`); `up -d` alone keeps the
  old image.

## [1.6.0] - 2026-09-30

### Added
- **Onboarding**: invite links survive login, registration and profile setup
  and open the invited server afterwards. Profile setup is a single form with
  the username prefilled from the email or OAuth profile. The no-servers page
  takes a pasted invite link or code, local or remote.
- **Bot developer panel**: bot ID, gateway and REST URLs, token reset with a
  shown-once dialog, and "Add to server". Bot creation and token rotation run
  as single server-side transactions (`create_bot`, `rotate_bot_token`).
- **Social**: alt text on attachments, an "N new posts" queue while scrolled,
  skeleton and error states, Requested/Unfollow follow states, and connected
  threads.
- Escape cancels the reply being composed.

### Changed
- Server discovery shows only real data: actual member counts, featured
  servers only when featured, no activity indicator on every card. Search
  matches the browse results and tolerates punctuation.
- Social timelines, tabs and post cards are flatter and labelled; one header
  per page; "Boost" throughout.
- Design-system buttons are flat fills; emoji used as icons are replaced with
  icons; auth and onboarding screens drop decorative animation.
- Server bot settings offer only the permissions the gateway enforces.
- Messages are delivered over Broadcast with authorised topics.

### Fixed
- **Profiles could be created with moderator or admin flags set.** The insert
  path accepted `is_admin` and related columns from the client; they are now
  forced to false on insert.
- **A bot could change the displayed author of other messages** in channels
  it could post in, through the message metadata route.
- The last server and channel were not remembered between sessions.
- Server custom emoji failed to load when the app opened on DMs or Social.
- On Android 15 and later the keyboard covered the message input.
- Server creation could produce a duplicate server after a partial failure.
- Invite previews showed 0 members to people outside the server.
- A temporary network error sent existing users into profile creation.
- Emoji reactions that federated back to their origin split into two chips;
  existing duplicates are repaired.
- Several listener, timer and media leaks; DM messages dropped by the
  conversation channel are recovered.

### Removed
- Settings that were marked "Coming soon" and did nothing, and an admin chart
  of hard-coded request numbers.
- The unreachable admin bot management page.

### Notes for self-hosters
- Four migrations since 1.5.0; `bootstrap.sh --migrations-only` applies them.
  `20260821000001` deletes federated duplicates of reactions and rewrites
  their shortcodes; take a backup first.
- The federation worker no longer inherits the image healthcheck, which
  reported it unhealthy while it processed jobs.

## [1.5.0] - 2026-08-06

### Added
- **Server and instance rules management**, plus follow requests and public
  instance settings backed by RLS policies.
- **ActivityPub favorites and reblogs** surfaced in notifications.
- Floating video placeholder and invite-modal settings.

### Changed
- Server icon cache invalidation and realtime server-update propagation.
- Comments across the codebase rewritten as terse declarative notes; emoji
  removed from log output.
- Documentation consolidated: `docs/FEDERATION.md` rewritten to describe the
  Node/Express federation backend it actually has, duplicate guides merged,
  `ROADMAP.md` reconciled against the open set in `BUGS.md`.
- `COPYRIGHT`, `TRADEMARK.md` and `LICENSE-ADDITIONAL-TERMS.md` completed and
  made consistent.
- `VERSION` corrected to match `package.json`.

### Fixed
- **MFA recovery codes were unusable.** Enrolment has produced 10-character
  codes since 1.2.0, but every entry field capped input at 8 characters, so
  the stored hash could never match. Anyone who enrolled after 2026-06-02 and
  lost their authenticator could not recover.

### Removed
- Deployment configs carrying real hostnames and certificate paths; only the
  `dev/*.template.conf` files ship now.

### Notes for self-hosters
- Android release APKs are signed again. The signing step decoded its keystore
  with `base64 -d`, which rejects the input outright on a stray carriage return
  or wrapped line, so every build since 1.4.0 silently fell back to a debug APK.

## [1.4.0] - 2026-07-06

Covers 1.2.0, 1.3.0 and 1.3.1, which shipped as GitHub releases without
changelog entries. Ninety-one commits since 1.1.0.

### Added
- **Tauri desktop and Android builds** from the same codebase, with release
  signing wired into CI and a version-stamping script.
- **Discord bridge**: attachment relay, bot gateway improvements, and
  puppeting via webhooks.
- **Klipy** GIF integration with attribution watermark.
- **Encryption v2 over LiveKit**, device approval and trust management,
  offline catch-up for fulfilled key requests, and session-share repair.
- `get_user_conversations`, `get_home_timeline_page` and `get_message_page`
  RPCs for paged loading.
- `FEDERATION.md` describing the ActivityPub implementation.

### Changed
- Video chat reworked.
- Design system and component styles reworked for theming; appearance context
  now resolves per route.
- `is_private` removed from the channel model.

### Fixed
- Federation no longer drops inbound activities; reactions and counters
  propagate in realtime.
- Optimistic update reconciliation, multi-span message rendering, thread
  reply realtime, mobile composer, and media error handling.
- Recovered stranded link-preview and media commits.

### Notes for self-hosters
- The federation backend surfaces its version via `/health` and
  `/.well-known/nodeinfo`.

## [1.1.0] - 2026-05-27

First post-public-release iteration. Focus: a new visual skin, mobile/PWA
polish, federation backend cleanup, and getting the documentation site
honest about the BullMQ migration.

### Added
- **SDR-001 skin** - a noir-cyberpunk visual theme with its own pixel-art
  icon set (MIT-licensed), CRT scanline / HUD-badge decorative toggles,
  dynamic accent-color system, and matching **Neo Kobe** audio theme
  (8 new sound assets: `camera_on`, `dm`, `invite`, `mic_off`, `reaction`,
  `reply`, `screenshare_on/off`).
- **Disable backdrop-blur** toggle in Appearance settings for low-end
  devices.
- **Per-skin decorative options** persisted across sessions.
- **NoRe Sans Pixel Pro v2** font family and specimen.
- **File size** for custom emojis: new `emojis.file_size` column, captured
  during upload, displayed conditionally in `ServerEmojiManagement`.
- **Quick reply queue** in the service worker - replies typed into push
  notifications are now persisted to IndexedDB and drained on auth /
  visibility, so they survive `postMessage` races and closed-tab scenarios.
- Inline formatting toggles (bold, italic) in the rich text editor.
- Image-specific context-menu actions (copy / save image).
- `COPYRIGHT`, `LICENSE-ADDITIONAL-TERMS.md`, `TRADEMARK.md` - explicit
  copyright statement, AGPL §7 attribution requirement, and common-law
  trademark policy for the "Harmony" name and polar-bear logo.
- Self-hosting documentation for instance-customizable assets
  (background images, additional emoji packs).
- **Self-hosting docs route**: `https://docs.mony.lol/self-hosting`
  (previously the website linked to a 404 path). The old
  `/HOW_TO_SELF_HOST` URL now meta-refresh redirects to the canonical
  route.

### Changed
- **MessageContextMenu** surfaces add-reaction, reply, edit, and
  start-thread as primary actions for better discoverability; destructive
  actions are grouped separately.
- **NotificationBell** moved into its own dedicated slot in
  `UserProfileComponent`, with outside-click suppression so the panel
  doesn't immediately close.
- **UserProfileComponent** shows the full ID-card profile bar at every
  width on the SDR-001 skin (improves mobile usability).
- **Push notifications** strip emoji shortcodes from sender names and
  resolve avatar URLs to absolute paths so they render correctly across
  all platforms.
- **Federation User-Agent** now reads from `config.VERSION` (single
  source of truth in `federation-backend/src/config/index.ts`). Previously
  the User-Agent was hard-coded to `Harmony/1.0.0` because
  `config.VERSION` was referenced but never declared in the env schema.
- `/health` and `/.well-known/nodeinfo` (2.0 + 2.1) now report
  `config.VERSION` instead of a hard-coded string.
- The repo now ships a small default set of background images
  (5 login, 2 404, 2 offline) instead of the full collection. Instance
  operators can drop more `.webp` files into
  `public/backgrounds/{login,404,offline}/` and the build picks them up.
- Standardized on `npm` as the package manager (removed `bun.lockb`).
- **CI workflow**: `e2e-tests` no longer references `secrets` in a job-level
  `if:` (GitHub Actions rejects this). Secret presence is hoisted into a
  job-level `env` and read via `env.HAS_TEST_SUPABASE` in each step's `if`.
- **Documentation cleanup**: all references to the legacy pg-boss queue
  backend in `docs-source/guide/`, `docker-compose.{prod,full}.yml`,
  `dev/docker-compose.yml`, and `scripts/install.sh` have been updated
  to reflect that **BullMQ (Redis-backed)** has been the actual job
  backend since the March 2026 migration. The `USE_PGBOSS_QUEUE`
  environment variable is still accepted as a backward-compat alias
  for `USE_BULLMQ_QUEUE` - old `.env` files continue to work.
- Service worker bumped to v3.3.

### Fixed
- **EmojiPopup z-index** raised to `99999` so it stacks above modals when
  triggered from inside one. `usePopupPositioning` now accepts a
  configurable `zIndex` option (default `1050`).
- **NotificationSettings** has a `min-height` so the panel doesn't jump
  around between tabs.
- 12 bug-bash items from the public-release polish pass: chat input bug,
  voice UI inconsistencies, Escape no longer failing to close settings,
  and others.
- **Docs build no longer fails on dead links**: `docs/bot-api.md` and
  `docs/DEVELOPMENT.md` referenced `../LICENSE`, `../COPYRIGHT`,
  `../TRADEMARK.md`, `../SECURITY.md`, `../ROADMAP.md`, `../BUGS.md`
  via VitePress relative links - VitePress can't render files outside
  `docs/`. Replaced with absolute GitHub URLs. (Without this fix,
  `npm run docs:build` exited non-zero and the docs site could not be
  redeployed.)

### Removed
- `db_schema/latest_dev_backup.sql` (reference dump no longer needed).
- `db_schema/archives/` (legacy migration folder; canonical history is
  `db_schema/init/` + `db_schema/migrations/`).

### Notes for self-hosters
- No data migration required.
- Existing `USE_PGBOSS_QUEUE=true` env vars continue to work via the
  backward-compat shim. Update to `USE_BULLMQ_QUEUE=true` at your
  convenience.
- Audio assets were updated; browsers will refetch on the service-worker
  version bump.

## [1.0.1] - 2026-05-25

### Initial public release

First tagged release. Development started in January 2024; commits before this
point are in this repository's history and predate any published release.

Key features at this snapshot:

- Discord-style servers with channels, categories, threads, roles, and permissions
- Direct messages, group DMs, and reactions
- ActivityPub federation: timelines, follows, posts, and inbox/outbox
- Multi-instance servers (members from different Harmony domains in one server)
- End-to-end encryption (Megolm-style) for chat, with cross-device key sharing
- LiveKit-based voice and video for both DMs and server channels
- Bot gateway and plugin system
- Tauri desktop app and web app from the same codebase
- Self-hosting via Docker Compose; install script under `scripts/install.sh`

[Unreleased]: https://github.com/y4my4my4m/harmony/compare/v1.6.0...HEAD
[1.6.0]: https://github.com/y4my4my4m/harmony/compare/v1.5.0...v1.6.0
[1.5.0]: https://github.com/y4my4my4m/harmony/compare/v1.4.0...v1.5.0
[1.4.0]: https://github.com/y4my4my4m/harmony/compare/v1.1.0...v1.4.0
[1.1.0]: https://github.com/y4my4my4m/harmony/releases/tag/v1.1.0

1.0.1 predates release tagging and has no tag to link to.
