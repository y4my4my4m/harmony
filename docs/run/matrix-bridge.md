---
title: Matrix bridge
description: Bridge plaintext messages, mentions, replies and attachments with Matrix ghosts or an attributed relay.
---

# Matrix bridge

The experimental Matrix application service connects explicitly paired Harmony channels and Matrix rooms. Messages from Matrix have their sender's name, avatar and Matrix badge in Harmony. Harmony members can appear in Matrix as individual bridge-managed users, or under one shared bridge account with attribution.

This is a **plaintext bridge**, not an encrypted participant. Text, mentions, images and ordinary files flow both ways; Matrix replies can retain native Harmony reply context. Edits, reactions, deletions and threads are not mirrored. Existing Discord integration remains separate.

## Initial operator setup

The bridge runs as the separate [harmony-matrix-bridge](https://github.com/y4my4my4m/harmony-matrix-bridge) service; its runtime is not bundled with Harmony. A Harmony manager installs a dedicated scoped read/send bot and registers its channel bindings with `configure_matrix_bridge`. A Matrix homeserver operator installs the generated application-service registration, including the exclusive ghost-user namespace. The bridge account must be in each Matrix room and able to invite users for ghost mode.

The service's configuration holds the initial one-to-one room/channel pairs, directions and explicit user allowlists. These remain additional restrictions: member opt-out does not grant access to an unallowlisted account. Existing configurations without a sender mode retain shared-relay behavior; the example configuration explicitly selects ghosts for new installations.

The standalone service's [README](https://github.com/y4my4my4m/harmony-matrix-bridge#readme) documents configuration, registration, containers and verification. This Harmony guide covers operator responsibilities and member-facing settings. Do not put either platform's credentials in messages, screenshots or public avatar links. Installing the application service is not a Discord-style OAuth authorization and cannot be completed by a room moderator without the appropriate homeserver operator.

## Choose how Harmony authors appear in Matrix

With **Manage Server**, open **Server settings → Matrix Bridge**. Each registered pair has its own sender-mode choice:

| Choice | Effect |
|---|---|
| **Individual bridged users — recommended** | Harmony members appear as actual bridge-managed Matrix room members with their Harmony name/nickname and avatar. Their message bodies have no attribution prefix. |
| **Shared bridge account** | All Harmony messages use the bridge account, with the author's name in the body. No new ghost users are added. |

The saved manager choice overrides the initial service configuration. If saving fails, reload before trying again: a lost response does not prove the server failed to save.

Ghost mode requires the updated application-service namespace and room invite permissions. If these are missing, the service reports an error instead of silently switching to relay mode. The settings page stores the choice; it does not prove the Matrix homeserver has accepted it. Check the service's health/logs and send a test message after changing setup.

The worker periodically synchronizes eligible, explicitly allowlisted members. Nicknames and avatars are set for the individual Matrix room rather than overwriting a user's identity in another community. Custom avatars are mirrored only from Harmony's own avatars storage as bounded, metadata-stripped raster images; default or external pictures may use Matrix's fallback avatar.

Switching to shared relay stops using ghosts and makes the running service leave tracked ghost memberships. It does not delete Matrix accounts or rewrite existing messages. A queued retry is not resent under a different identity after a mode change.

## Mention people

### From Harmony

Type `@` and select the Matrix member from Harmony's normal suggestions. The entry identifies Matrix and the full Matrix ID, so two people named Sam on different homeservers remain distinct. Its profile card is a read-only external identity, not a Harmony account.

The bridge turns this structured mention into a proper Matrix mention. Typing an arbitrary display name is not a substitute for selecting a recipient.

### From Matrix with ghosts

Use your client's normal `@` autocomplete and select the Harmony member's ghost. The bridge recognizes the explicit Matrix mention and translates it into a real Harmony user mention and notification, subject to current eligibility.

Allow a member-refresh cycle after setup or membership changes. Opted-out, unallowlisted or channel-ineligible Harmony members are not provisioned as ghosts.

### From Matrix with a shared relay

Harmony-only users are not Matrix room members in this mode, so Matrix cannot list them in native `@` autocomplete. Use the explicit bridge command:

```text
!mention exact_harmony_username Hello from Matrix
```

It uses the eligible member's exact Harmony username, not an ambiguous display name. This is not Discord's `/mention` command and does not provide portable client-side autocomplete. Unknown or ineligible targets do not become real Harmony mentions.

The bridge does not turn raw `@room`, `@everyone` or display-name-looking text into new notification targets.

## Replies from Matrix

Use the Matrix client's normal Reply action. When the parent was bridged in either direction and remains readable to the bridge, Harmony shows its native reply context. Old Matrix plain/HTML quote fallbacks are removed rather than copied as new text. An unmapped, missing or now-private parent leaves the new reply text without a guessed link. Matrix threads and edits remain unsupported, and Harmony-to-Matrix reply context is not mirrored.

## Images and files

Post an image or file normally in either client. Supported bytes are copied into the destination's own storage, not left as links to the other platform. Captions are retained when Matrix supplies a separate filename. Harmony messages with several attachments become text followed by individual Matrix file events; replies to those events can point back to the original Harmony message. Audio and video travel as downloadable files, without transcoding.

The bridge copies at most **20 files per Harmony message**, each up to **50 MiB**, subject to lower current instance/storage and destination limits. Unsupported, oversized or failed copies show **`[Attachment unavailable: filename]`** instead of silently disappearing; accompanying text is retained. Transient transfer errors are retried before that fallback. A revoked binding, withdrawn consent or encryption transition blocks the delivery rather than publishing a notice for the revoked content.

Harmony attachments must be in private message storage, including currently owned Drive files attached to the message. URL-only, legacy and external attachment parts are not downloaded. Active files such as SVG, HTML, scripts and executables, unsupported MIME types and invalid image signatures are refused. Files use the existing media-metadata stripping, not malware scanning; archives and ordinary documents can still contain unsafe content.

Encrypted rooms remain blocked. An encrypted attachment descriptor in a plaintext Matrix room produces a notice without copying ciphertext or keys. Encrypted rooms/media are planned follow-up work, not supported by sending a decryption key or disabling encryption.

## Member privacy

Each Harmony member can open **Server menu → Bridge privacy → Do not forward my messages**. This is a per-member, per-server preference; the administrator's sender-mode choice does not override it.

Opt-out blocks future bridged message/file delivery and fresh ghost profile exposure. The running worker removes tracked ghost memberships when it sees that the member is no longer eligible. It rechecks consent before queued delivery and profile operations rather than trusting the original message or a cached member list.

This is not retroactive erasure. Previous remote messages/files, Matrix accounts, cached profiles and previously disclosed metadata may remain. Interrupted transfers can leave uploads that were never posted; the bridge adds no media orphan sweeper. A request already in flight cannot be cancelled atomically. Ordinary bots and independent server webhooks are not governed by this bridge preference.

## Limits and recovery

- Encrypted or unknown room/channel state blocks relaying and fresh profile/member synchronization. Never disable encryption to make a bridge appear to work.
- The Matrix room membership snapshot is bounded to 1,000 members. Profile synchronization and client suggestion caches are periodic, not instantaneous.
- Matrix ghost IDs are stable and reserved to the application service. They are not links to somebody's existing Matrix account.
- Back up the private SQLite database with the bridge's configuration and registration. It records ghost ownership and queued sender identities. Losing that state can require operator recovery; the bridge will not adopt an unknown existing account just because its name matches.
- Keep the service running to perform ghost cleanup. Stopping or uninstalling it cannot by itself retract remote memberships or messages.
