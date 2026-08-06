# Changelog

All notable user-facing changes to Harmony will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed
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

## [1.4.0] - 2026-07-06

Covers 1.2.0, 1.3.0 and 1.3.1, which shipped as GitHub releases without
changelog entries. Ninety-one commits since 1.1.0.

### Added
- **Tauri desktop and Android builds** from the same codebase, with release
  signing wired into CI and a version-stamping script.
- **Server and instance rules management**, plus follow requests and public
  instance settings backed by RLS policies.
- **Discord bridge**: attachment relay, bot gateway improvements, and
  puppeting via webhooks.
- **Klipy** GIF integration with attribution watermark.
- **Encryption v2 over LiveKit**, device approval and trust management,
  offline catch-up for fulfilled key requests, and session-share repair.
- `get_user_conversations`, `get_home_timeline_page` and `get_message_page`
  RPCs for paged loading.
- `FEDERATION.md` describing the ActivityPub implementation.

### Changed
- Video chat reworked; floating video placeholder and invite modal settings.
- Design system and component styles reworked for theming; appearance context
  now resolves per route.
- `is_private` removed from the channel model.
- Server icon cache invalidation and realtime server-update propagation.
- Comments across the codebase rewritten as terse declarative notes; emoji
  removed from log output.

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

[Unreleased]: https://github.com/y4my4my4m/harmony/compare/v1.4.0...HEAD
[1.4.0]: https://github.com/y4my4my4m/harmony/compare/v1.1.0...v1.4.0
[1.1.0]: https://github.com/y4my4my4m/harmony/releases/tag/v1.1.0

1.0.1 predates release tagging and has no tag to link to.
