# Harmony - Known Issues

Open defects and documented limitations of the Harmony codebase, security findings included: what an
operator should know before running an instance.

Every entry was checked against the tree for 1.9.8 (November 2026). Fixed entries are removed; the
CHANGELOG and git history record each fix. IDs are stable and never reused.

Report security issues through the process in SECURITY.md, not here.

---

## Open defects

### L21 - A DM participant can appear in a call as someone else

Who is in a direct-message call comes from Realtime presence on `dm-call:<conversation>`, and
Realtime lets a client choose its own presence key. A participant of the conversation can therefore
show another participant as joined. Presence decides nothing else: rings stop only on answers the
database names (`send_signal`), and call signals carry a database-set sender. Only participants of
that conversation can do this.

The fix replaces presence with membership the server records: a participants table, join, heartbeat
and leave RPCs, a sweep for crashed clients, and a trigger that broadcasts changes. About two to three
days, with slower crash detection (about a minute instead of seconds) as its cost. Planned for 1.9.9
(`ROADMAP.md`, Next).

---

## Documented limitations

Design-level gaps that ship knowingly. Each has a planned replacement in `ROADMAP.md` under v2.0.

### H11 - Megolm signing keys come from the server

Encrypted conversations take each sender's Ed25519 signing key from the database
(`src/services/encryption/`). The client pins the first key it sees per sender and device (trust on
first use); when the key changes, it raises `harmony-identity-changed` as an advisory and accepts the new
key. A server, or whoever controls its database, can substitute a sender's key and sign messages in
that sender's name. There is no verification ceremony between people.

Megolm stops being Harmony's main encryption in v2: MLS (RFC 9420) credentials bind each member's
signing key, and key changes are revisited there rather than on Megolm.

### M6 - Replayed Megolm messages are caught per device

A server can store one encrypted message twice; both copies decrypt and verify, since the sender's
signature does not cover the message's row. Each device records which message held each session
index and marks a later copy **Repeated**, content shown. The record lives on that device: a new
device, or one restored from a key backup, does not recognise copies stored before it saw the
original. MLS in v2 rejects replays by itself, since each message key is deleted after one use.

### M36 - ActivityPub private keys are stored in plain text

`user_private_keys.private_key` holds each local actor's RSA private key as PEM, readable by the
service role only (row-level security). Every database dump and backup therefore carries every local
account's signing key; anyone holding a backup can sign activities as those accounts. Mastodon stores
`accounts.private_key` the same way.

Planned for v2: envelope encryption under an instance key generated on upgrade and kept outside the
database.

---

## Performance notes

Patterns from the full performance audit that are still present. They are costs, not defects.

- **P-α** - array linear scans on hot reactive paths (post-interaction realtime, notifications, voice
  users, autosuggest).
- **P-β** - per-render content pipeline (regex compile, DOMPurify, `JSON.parse`, date format) in
  `useContentRenderer`, `markdownParser`, `MessageDisplay`, `ProviderEmbedSwitch`.
- **P-γ** - long-lived `setInterval` polling: the bot gateway reads new messages every 1 s and edits,
  reactions, members and moderation every 2 s (`bot-gateway/src/gateway/EventDispatcher.ts`).
  `NOTIFY` or Realtime would replace it.
- **P-δ** - sequential `await` in loops where `IN(...)` or `Promise.all` would batch (federated mention
  resolution, follower inbox collection, Megolm session sharing).
- **P-ε** - Maps without bounds in long-running services (fediverse embed cache, federation L1 cache
  promotion).
- **P-ζ** - per-request signer and public-key parse on the federation hot path; outbound delivery
  without `https.Agent({ keepAlive: true })`.
- **P-η** - main-thread crypto: Megolm signature verification per decrypt, HRTF panners, 100k PBKDF2
  iterations on weak devices.
