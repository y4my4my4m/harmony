# Security Policy

Harmony is a federated chat platform that handles end-to-end encrypted messages, voice/video, and ActivityPub federation. Security issues - especially in the federation backend, encryption stack, or Supabase RLS policies - can affect every instance and every connected fediverse server, so we take them seriously.

## Reporting a Vulnerability

**Please do not open a public GitHub issue for security problems.**

Instead, use one of these private channels (in order of preference):

1. **GitHub private vulnerability reporting** - go to the [Security tab](https://github.com/y4my4my4m/harmony/security/advisories/new) on this repo and file an advisory. This keeps the report private until a fix ships.
2. **DM the maintainer** on the canonical Harmony instance: <https://har.mony.lol> (handle: `@y4my4m`).
3. As a last resort, email the address listed on <https://mony.lol>.

Please include:

- A clear description of the issue and its impact
- Steps to reproduce (or proof-of-concept)
- Affected version / commit SHA
- Any suggested mitigation, if you have one

You should expect an initial acknowledgement within **72 hours**. We aim to ship a fix or mitigation within **14 days** for high-severity issues, longer for issues that require coordinated disclosure with other fediverse implementations.

## Scope

In scope:

- This repository (frontend, `federation-backend/`, `bot-gateway/`, `bot-plugins/`, `webrtc/`)
- Supabase schema (`db_schema/`) - RLS bypasses, privilege escalation, etc.
- Tauri desktop builds (`src-tauri/`)
- The canonical instance at <https://har.mony.lol> (please be reasonable; no DoS testing)

Out of scope:

- Self-hosted instances run by third parties (report to the operator)
- Issues that require physical access to a user's unlocked device
- Outdated browsers / dependencies that already have published advisories
- DoS / volumetric attacks against `har.mony.lol`
- Social engineering or phishing of community members

## Coordinated Disclosure

We follow a **90-day coordinated disclosure** window by default. Researchers who follow this policy will be credited in the advisory and `CHANGELOG.md` (unless they prefer to remain anonymous).

If a vulnerability is being actively exploited in the wild, we may disclose and patch faster, with credit.

## Encryption-Specific Notes

Chat E2EE uses a Megolm-style scheme (per-room session keys, non-extractable `CryptoKey`s persisted to IndexedDB). When reporting issues in the encryption stack, please include the relevant files under `src/services/encryption/` and an indication of whether the issue is a:

- protocol-level flaw (ratcheting, key sharing, recovery key derivation),
- implementation flaw (storage, lifecycle, race conditions), or
- side-channel / metadata leak.

**Secrecy properties (please don't report these as bugs).** Each message is encrypted under a distinct key derived from the room session key and the message index, so no two messages reuse a key. This is intentionally *not* Signal-style forward secrecy: per-message keys are derived deterministically from the long-lived session key, so anyone who obtains a session key can derive the keys for every message in that session (past and future) until the session rotates. Session rotation (every 100 messages or 7 days) bounds the blast radius. Sender authenticity for current messages is provided by per-message ECDSA signatures (`megolm_v2_signed` and later), verified before decryption.

**Voice/video.** LiveKit rooms support media E2EE: the room media key is generated client-side, wrapped for each recipient via the Megolm message path, and exchanged over signaling (`livekitWebRTC.ts`), so the SFU never sees it. Peer-to-peer (non-LiveKit) calls are protected by standard WebRTC transport encryption (DTLS-SRTP) only — there is no additional application-layer media E2EE on that path, and the UI does not claim otherwise. (An earlier Signal-Protocol-based client stack, including a non-functional P2P frame-encryption layer, was removed in July 2026.)

## Federation-Specific Notes

The ActivityPub layer sits in `federation-backend/`. Common concern areas:

- HTTP signature verification & actor/signer matching
- `Update` / `Delete` activity ownership checks
- LiveKit token minting (must be tied to the verified actor)
- SSRF in remote object fetching (helpers under `federation-backend/src/utils/safeFetch*`)

If your finding involves cross-instance behavior, please mention which other fediverse software (Mastodon, Misskey, Pleroma, …) is involved - we may need to coordinate with their maintainers as well.

## Hall of Fame

Researchers who responsibly disclose serious issues will be listed here (with their permission).

*(empty - be the first!)*
