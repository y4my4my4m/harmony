# Changelog

All notable user-facing changes to Harmony will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
