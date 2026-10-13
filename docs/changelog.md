---
title: Changelog
description: Where Harmony's release notes and version history live.
---

# Changelog

Harmony's version history lives in the repository, not on this site.

| Source | What it holds |
| --- | --- |
| [GitHub releases](https://github.com/y4my4my4m/harmony/releases) | One release per version tag (`vX.Y.Z`), with the Windows, macOS and Linux desktop builds and the Android APK attached. The desktop app's updater reads its manifest from here. |
| [CHANGELOG.md](https://github.com/y4my4my4m/harmony/blob/master/CHANGELOG.md) | User-facing changes per version in [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) format, with notes for self-hosters where an update needs action. |
| [Tags](https://github.com/y4my4my4m/harmony/tags) | Every version tag and the commit it points at. |

Container images for self-hosting are published to GitHub Container Registry as `ghcr.io/y4my4my4m/harmony-web`, `harmony-federation` and `harmony-bot-gateway`. A self-hosted instance follows the version of its checkout; see [Update, backup, restore](/self-host/update-backup) for how to move to a new one.

Harmony uses [semantic versioning](https://semver.org/spec/v2.0.0.html). How a version is cut is described in [Release process](/contribute/releases).
