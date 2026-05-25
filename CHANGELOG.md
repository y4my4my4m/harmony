# Changelog

All notable user-facing changes to Harmony will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- `COPYRIGHT`, `LICENSE-ADDITIONAL-TERMS.md`, `TRADEMARK.md` — explicit
  copyright statement, AGPL §7 attribution requirement, and common-law
  trademark policy for the "Harmony" name and polar-bear logo.
- Self-hosting documentation for instance-customizable assets
  (background images, additional emoji packs).

### Changed
- The repo now ships a small default set of background images
  (5 login, 2 404, 2 offline) instead of the full collection. Instance
  operators can drop more `.webp` files into
  `public/backgrounds/{login,404,offline}/` and the build picks them up.
- Standardized on `npm` as the package manager (removed `bun.lockb`).

### Removed
- `db_schema/latest_dev_backup.sql` (reference dump no longer needed).
- `db_schema/archives/` (legacy migration folder; canonical history is
  `db_schema/init/` + `db_schema/migrations/`).
- Mutant Standard emoji pack (CC-BY-NC-SA 4.0; incompatible with
  commercial AGPL forks). Instance operators may opt back in by placing
  the pack under `public/assets/emojis/mutant_emojis_svg/` (gitignored).

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

[Unreleased]: https://github.com/y4my4my4m/harmony/compare/v1.0.1...HEAD
[1.0.1]: https://github.com/y4my4my4m/harmony/releases/tag/v1.0.1
