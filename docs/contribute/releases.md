---
title: Release process
description: How a Harmony release is versioned, tagged and built, what it publishes (desktop installers, the Android APK, container images), and how each kind of install receives it.
---

# Release process

This page describes how a Harmony release is cut and what it produces. It is for maintainers who tag releases, and for contributors who want to know how a merged change reaches users. Operators updating an instance should read [Update and back up](/self-host/update-backup).

## Versions

Harmony uses [Semantic Versioning](https://semver.org/spec/v2.0.0.html). A release is a git tag `vX.Y.Z` on `master`, annotated `Harmony X.Y.Z`. Work for a release accumulates on one branch (`batch/X.Y.Z` or `release/X.Y.Z`) that is merged into `master` as one pull request; the tag goes on that merge commit.

[`scripts/set-version.mjs`](https://github.com/y4my4my4m/harmony/blob/master/scripts/set-version.mjs) writes one version into every file that carries it. It accepts `X.Y.Z`, with or without a leading `v`.

```bash
npm run set-version -- 1.8.0
```

| File | Field |
| --- | --- |
| `package.json` | `version`; the web app's build version, shown in its settings |
| `src-tauri/tauri.conf.json` | `version` of the desktop and Android apps; release asset names come from it |
| `src-tauri/Cargo.toml`, `src-tauri/Cargo.lock` | The `app` package version |
| `VERSION` | Read by `self-host/configure.sh` when the install is not a git checkout |
| `federation-backend/src/config/index.ts` | Default of `VERSION`, reported in NodeInfo and `/health` |
| `src-tauri/gen/android/app/tauri.properties` | `versionName`, and `versionCode` = X × 1,000,000 + Y × 1,000 + Z, when the file exists |

The release workflow runs `set-version.mjs` with the tag before it builds the native apps, so installers always carry the tag's version. The container images are built from the tagged tree as committed, so the web app and the federation backend in them report whatever version is committed.

## Changelog

[`CHANGELOG.md`](https://github.com/y4my4my4m/harmony/blob/master/CHANGELOG.md) follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). New entries go under `## [Unreleased]`; a release moves them under `## [X.Y.Z] - YYYY-MM-DD`. Each version has these subsections, as needed:

| Subsection | Contents |
| --- | --- |
| Added | New features |
| Changed | Changes to existing behaviour |
| Fixed | Bug fixes |
| Removed | Features taken out |
| Notes for self-hosters | What an operator must know or do: configuration changes, new services, migrations to watch |

Entries describe what users or operators see, not how the code changed.

The notes users read are the body of the GitHub release for each tag: a one-sentence summary of the release, then `##` sections by area (for example Chat, Social, Bots and the Discord bridge), each a list of user-facing changes. The site's [Changelog](/changelog) links to them.

## Cut a release

1. **Commit the version on the release branch.** Run `npm run set-version -- X.Y.Z`, move the `[Unreleased]` entries in `CHANGELOG.md` under a dated `[X.Y.Z]` heading, and commit the result as `release: X.Y.Z`. This commit is what gives the container images and NodeInfo the new version.
2. **Merge the release branch** into `master`. The CI and Database workflows must be green on the pull request.
3. **Tag the merge commit and push the tag.**

   ```bash
   git tag -a vX.Y.Z -m "Harmony X.Y.Z"
   git push origin vX.Y.Z
   ```

   The tag starts [`release.yml`](https://github.com/y4my4my4m/harmony/blob/master/.github/workflows/release.yml) and [`images.yml`](https://github.com/y4my4my4m/harmony/blob/master/.github/workflows/images.yml).
4. **Wait for the draft.** `release.yml` creates a draft GitHub release named `Harmony X.Y.Z` and uploads every build to it.
5. **Write the notes and publish.** Add the release notes below the draft's first line ("Download the installer for your platform below."), then publish the draft. Publishing is the rollout: installed desktop apps and the Android app look only at the newest published release.

To rebuild an existing tag, run the Release workflow by hand (**Actions** → **Release** → **Run workflow**) with the tag. It reuses the tag's release and replaces assets of the same name. A manual run builds the tag's tree but takes the helper scripts from the workflow's own commit, so tags that predate a script still build.

## What release.yml does

| Job | Runs after | Does |
| --- | --- | --- |
| Draft release | | Stamps the tag's version, names the assets with `scripts/name-artifact.sh`, finds or drafts the release with `scripts/github-release.mjs`, and deletes any `latest.json` left on it |
| desktop (Windows, macOS) | Draft release | Builds the Windows NSIS installer and the universal macOS app with `tauri-action`, and uploads them, with updater payloads and signatures when signing is configured |
| linux | Draft release | Builds the deb and the AppImage on the CEF runtime, checks that the deb's dependencies resolve on a clean Ubuntu 24.04, runs the smoke test on both, and uploads the AppImage, its signature and the deb |
| Updater manifest | Draft release, desktop, linux | Writes `latest.json` from the uploaded payloads and signatures; skipped when updater signing is not configured |
| android | desktop | Builds the aarch64 APK and attaches it to the draft |

`latest.json` is written once, after every desktop and Linux build has uploaded. It fails without uploading when a payload or signature is missing, so a release carries a manifest for every desktop platform or none. `node --test scripts/github-release.test.mjs` tests the release script against a stand-in for the GitHub API; CI runs it with the unit tests.

### Secrets and variables

| Name | Kind | Used for | Without it |
| --- | --- | --- | --- |
| `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | Secret | Minisign signatures for the updater and `latest.json` | Installers ship without updater files; installed apps are not offered the release |
| `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD` | Secret | Release signing of the APK | A debug-signed APK, named with `_debug` |
| `ANDROID_GOOGLE_SERVICES_JSON_BASE64` | Secret | Firebase Cloud Messaging in the APK | The APK receives push through UnifiedPush only |
| `TEST_SUPABASE_URL`, `TEST_SUPABASE_ANON_KEY` | Secret | Supabase values built into the frontend | Placeholders; native apps choose their instance at runtime |
| `DEFAULT_INSTANCE_URL` | Variable | Pre-fills the instance picker of the native apps | The field starts empty |

The updater also needs the matching public key in `plugins.updater.pubkey` of `src-tauri/tauri.conf.json`; while it holds the placeholder `HARMONY_UPDATER_PUBKEY`, releases skip updater files and the apps disable the updater. The workflow does not code-sign or notarize the Windows and macOS installers.

## Release assets

Every asset name comes from `scripts/name-artifact.sh`: `Harmony_<Platform>_V<version>` plus the file's extension.

| Platform | Files |
| --- | --- |
| Windows | `Harmony_Windows_VX.Y.Z.exe` (NSIS installer) and its `.sig` |
| macOS | `Harmony_macOS_VX.Y.Z.dmg` (universal), `Harmony_macOS_VX.Y.Z.app.tar.gz` (updater payload) and its `.sig` |
| Linux | `Harmony_Linux_VX.Y.Z.AppImage` and its `.sig`, `Harmony_Linux_VX.Y.Z.deb` |
| Android | `Harmony_Android_VX.Y.Z.apk` (aarch64) |
| All desktop | `latest.json`, the updater manifest |

## Container images

`images.yml` builds three images for `linux/amd64` and `linux/arm64` and pushes them to GitHub Container Registry:

| Image | Built from |
| --- | --- |
| `ghcr.io/y4my4my4m/harmony-web` | `self-host/web.Dockerfile`: the web app served by nginx; instance values come from the container environment at start |
| `ghcr.io/y4my4my4m/harmony-federation` | `federation-backend/Dockerfile`; `FEDERATION_MODE` selects server, worker or unified |
| `ghcr.io/y4my4my4m/harmony-bot-gateway` | `bot-gateway/Dockerfile` |

| Trigger | Tags pushed |
| --- | --- |
| Tag `vX.Y.Z` | `X.Y.Z`, `X.Y` and `latest` |
| Push to `master` | `edge` and `sha-<short sha>` |
| Pull request | None: built for both platforms, not pushed |

Base images use the Node version in `.nvmrc`. Forks build the images but do not push them into this namespace.

## Test builds

[`tauri.yml`](https://github.com/y4my4my4m/harmony/blob/master/.github/workflows/tauri.yml) builds the native apps from any branch, on manual dispatch only (**Actions** → **Tauri** → **Run workflow**), with a choice of platforms and of the `release` or `debug` profile:

```bash
gh workflow run tauri.yml --ref my-branch \
  -f windows=false -f macos=false -f android=true -f linux=false -f profile=debug
```

Each build is uploaded as a workflow artifact named `Harmony_<Platform>_V<version>_dev-<branch>-<sha7>` (`_debug-` for the debug profile). The Android job also runs the push plugin's Robolectric tests, and the Linux job runs the same dependency check and smoke test as a release. Runs on `master` keep the CEF and AppImage tool caches warm for release builds.

## How installs receive a release

| Install | How it updates |
| --- | --- |
| Self-hosted instance | The operator runs `harmony update`. A checkout on a release tag moves to the newest release and runs images tagged with that version; a checkout on `master` follows `edge`. The update applies new migrations before recreating containers. See [Update and back up](/self-host/update-backup). |
| Web app | Served by each instance, so it changes when the instance updates. |
| Desktop app (Windows, macOS, Linux AppImage) | `tauri-plugin-updater` reads `releases/latest/download/latest.json`, which resolves to the newest published release, and verifies the payload against the committed public key. |
| Linux deb | Does not update itself; install the new deb. |
| Android app | Checks the newest published GitHub release at most once a day and shows a notice linking to its APK. |
