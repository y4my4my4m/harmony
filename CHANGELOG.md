# Changelog

All notable user-facing changes to Harmony will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [1.1.0] - 2026-05-27

First post-public-release iteration. Focus: a new visual skin, mobile/PWA
polish, federation backend cleanup, and getting the documentation site
honest about the BullMQ migration.

### Added
- **SDR-001 skin** — a noir-cyberpunk visual theme with its own pixel-art
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
- **Quick reply queue** in the service worker — replies typed into push
  notifications are now persisted to IndexedDB and drained on auth /
  visibility, so they survive `postMessage` races and closed-tab scenarios.
- Inline formatting toggles (bold, italic) in the rich text editor.
- Image-specific context-menu actions (copy / save image).
- `COPYRIGHT`, `LICENSE-ADDITIONAL-TERMS.md`, `TRADEMARK.md` — explicit
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
  for `USE_BULLMQ_QUEUE` — old `.env` files continue to work.
- Service worker bumped to v3.3.

### Fixed
- **EmojiPopup z-index** raised to `99999` so it stacks above modals when
  triggered from inside one. `usePopupPositioning` now accepts a
  configurable `zIndex` option (default `1050`).
- **NotificationSettings** has a `min-height` so the panel doesn't jump
  around between tabs.
- 12 bug-bash items from the public-release polish pass (see
  commit `a2c82b7`): chat input bug, voice UI inconsistencies, Escape
  no longer failing to close settings, and others.
- **Docs build no longer fails on dead links**: `docs/BOT_API.md` and
  `docs/DEVELOPMENT.md` referenced `../LICENSE`, `../COPYRIGHT`,
  `../TRADEMARK.md`, `../SECURITY.md`, `../ROADMAP.md`, `../BUGS.md`
  via VitePress relative links — VitePress can't render files outside
  `docs/`. Replaced with absolute GitHub URLs. (Without this fix,
  `npm run docs:build` exited non-zero and the docs site could not be
  redeployed.)

### Removed
- `db_schema/latest_dev_backup.sql` (reference dump no longer needed).
- `db_schema/archives/` (legacy migration folder; canonical history is
  `db_schema/init/` + `db_schema/migrations/`).
- Mutant Standard emoji pack (CC-BY-NC-SA 4.0; incompatible with
  commercial AGPL forks). Instance operators may opt back in by placing
  the pack under `public/assets/emojis/mutant_emojis_svg/` (gitignored).

### Notes for self-hosters
- No data migration required.
- Existing `USE_PGBOSS_QUEUE=true` env vars continue to work via the
  backward-compat shim. Update to `USE_BULLMQ_QUEUE=true` at your
  convenience.
- Audio assets were updated (`b4b54ca`); browsers will refetch on the
  service-worker version bump.

## [1.0.1] - 2026-05-25

### Initial public release

This is the first public release of Harmony. The codebase has been developed
privately up to this point; the full pre-release history is preserved in the
[`harmony-archive`](https://github.com/y4my4my4m/harmony-archive) repository.

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

[Unreleased]: https://github.com/y4my4my4m/harmony/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/y4my4my4m/harmony/compare/v1.0.1...v1.1.0
[1.0.1]: https://github.com/y4my4my4m/harmony/releases/tag/v1.0.1
