# End-to-End Encryption Implementation Guide

## Overview

Harmony uses **Megolm** (the same group encryption protocol as Matrix/Element) for end-to-end encrypted messages. Each channel/conversation has a Megolm session key shared among participants. The Signal Protocol is used separately for WebRTC voice/video encryption.

**Key Features:**
- Zero-knowledge architecture (servers cannot decrypt messages)
- Per-room session keys (efficient for group channels)
- Recovery key system with mnemonic words
- Non-extractable CryptoKeys stored in IndexedDB
- Server-controlled encryption policies (disabled/optional/required)
- Cross-device key sharing via `megolm_session_shares` table
- Thread messages bypass encryption (sent as plaintext)

## Architecture

```
+---------------------------------------------+
|         User Interface Layer                |
|  - RecoveryKeySetupWizard.vue              |
|  - EncryptionIndicator.vue                 |
|  - EncryptionSettings.vue                  |
+-------------------+-------------------------+
                    |
+-------------------v-------------------------+
|      MegolmMessageEncryptionService         |
|  (singleton)                                |
|  - Policy enforcement                       |
|  - Lazy initialization                      |
|  - High-level encrypt/decrypt API           |
+-------------------+-------------------------+
                    |
+-------------------v-------------------------+
|      MegolmService                          |
|  - Session creation per channel             |
|  - Megolm encrypt/decrypt operations        |
|  - Session rotation                         |
+-------------------+-------------------------+
                    |
+-------------------v-------------------------+
|      RecoveryKeyService                     |
|  - Mnemonic word derivation                 |
|  - Key wrapping/unwrapping                  |
|  - Recovery flow                            |
+-------------------+-------------------------+
                    |
+-------------------v-------------------------+
|      SecureSessionKeyStore                  |
|  - IndexedDB storage                        |
|  - Non-extractable CryptoKeys               |
|  - Per-session key persistence              |
+-------------------+-------------------------+
                    |
+-------------------v-------------------------+
|      Database Layer                         |
|  - megolm_session_shares (key sharing)      |
|  - server_encryption_settings               |
+---------------------------------------------+
```

## User Setup Flow

### First-Time Setup

1. **User enables encryption** via `RecoveryKeySetupWizard`
2. **Mnemonic generation**: `completeSetupWithWords()` generates a mnemonic phrase
3. **Key derivation**: Mnemonic derives encryption keys via `RecoveryKeyService`
4. **CryptoKey storage**: Non-extractable `CryptoKey` objects stored in IndexedDB via `SecureSessionKeyStore`
5. **User saves mnemonic**: Recovery words must be saved securely (they are NOT stored anywhere)

### Auto-Unlock on Page Load

On subsequent visits, `tryAutoUnlock()` loads the non-extractable CryptoKeys from IndexedDB. No mnemonic or password is needed - the keys are bound to the browser's origin via the Web Crypto API.

### Recovery

If a user clears browser data or switches browsers, they can restore access by entering their mnemonic words, which re-derives the keys.

## Message Encryption Flow

### Sending an Encrypted Message

```
1. CoreMessageService.sendMessage(channelId, content)
2. Check server encryption mode
3. If encryption enabled:
   a. Lazy-init MegolmMessageEncryptionService
   b. Check: isInitialized() && hasRecoveryKey() && isUnlocked()
   c. Get or create Megolm session for this channel
   d. Encrypt content with the channel's session key
   e. INSERT message with encrypted payload
4. If encryption disabled or keys unavailable:
   a. INSERT message as plaintext
5. Database trigger broadcasts via Realtime
6. Database trigger queues federation (plaintext for federated recipients)
```

### Receiving an Encrypted Message

```
1. Realtime delivers new message to useChat/useDM store
2. Check if message is encrypted
3. If encrypted:
   a. processMessageDecryption(message) in messageDecryption.ts
   b. MegolmMessageEncryptionService.decrypt(ciphertext, sessionId)
   c. If session key available → decrypt and display
   d. If session key missing → mark as "encrypted (key unavailable)"
      and listen for megolm-key-received CustomEvent
4. If plaintext: display directly
```

### Encrypted Message Structure

```json
{
  "encrypted": true,
  "content": {
    "ciphertext": "base64_encrypted_content",
    "session_id": "megolm-session-uuid",
    "device_id": "sender-device-id"
  }
}
```

Unlike Signal Protocol (per-recipient), Megolm uses a single ciphertext that any participant with the session key can decrypt.

## Key Sharing

When a user needs the session key for a channel (new member, new device):

1. An existing member with the key creates a share in `megolm_session_shares`
2. The new user subscribes to this table via Supabase Realtime
3. On receiving a share, a `megolm-key-received` CustomEvent is dispatched
4. Stores listen for this event and reprocess any previously undecryptable messages
5. The key is stored in IndexedDB via `SecureSessionKeyStore`

## Server Encryption Policies

### Policy Modes

| Mode | Behavior |
|------|----------|
| `disabled` | No encryption, all messages plaintext |
| `optional` | Encrypt if keys available, fall back to plaintext |
| `required` | Block message send if encryption not set up |

### Policy Enforcement

`CoreMessageService` checks the server's encryption mode before sending:

- **required**: If the user hasn't set up encryption, the send is blocked with an error
- **optional**: Encrypts if `MegolmMessageEncryptionService` is initialized and unlocked, otherwise sends plaintext
- **disabled**: Always sends plaintext

## Key Management

### Key Hierarchy

```
Mnemonic Words (user's secret, never stored)
  └── Derived Master Key (via RecoveryKeyService)
       └── Wrapping Key (wraps/unwraps session keys)
            └── Per-Channel Megolm Session Keys
                 (stored as non-extractable CryptoKeys in IndexedDB)
```

### Session Rotation

Megolm sessions can be rotated per channel. When a session is rotated:
- A new session key is generated
- The new key is shared with current channel members via `megolm_session_shares`
- Old messages remain decryptable with the old session key
- New messages use the new session

### Key Storage

- **IndexedDB** (`SecureSessionKeyStore`): Non-extractable CryptoKeys - cannot be exported from the browser
- **Database** (`megolm_session_shares`): Encrypted session key shares for cross-device delivery
- **User's memory**: Mnemonic recovery words (the only way to recover on a new device)

## Voice/Video E2EE

Voice and video calls use a separate encryption layer:

- **WebRTC DTLS-SRTP**: Standard WebRTC transport encryption (always on)
- **Additional E2EE** (optional): `WebRTCEncryptionService` using the Signal Protocol for frame-level encryption via Insertable Streams API
- **LiveKit E2EE**: When using LiveKit SFU mode, `ExternalE2EEKeyProvider` handles key distribution

## Thread Messages

Thread messages (`ThreadService`) bypass encryption entirely and are sent as plaintext. This is by design for simplicity in threaded discussions.

## Federation and E2EE

Federated messages are always sent as plaintext via ActivityPub. The encryption modes affect local delivery only:

- **optional**: Local users get encrypted messages, federated users get plaintext
- **required**: Only local encrypted delivery (federation still works but content is plaintext in transit)

## Encryption Services Reference

| Service | Purpose |
|---------|---------|
| `MegolmMessageEncryptionService` | High-level singleton: encrypt/decrypt messages, lazy init, policy checks |
| `MegolmService` | Low-level: Megolm session CRUD, encrypt/decrypt operations |
| `RecoveryKeyService` | Mnemonic generation, key derivation, recovery |
| `SecureSessionKeyStore` | IndexedDB persistence for non-extractable CryptoKeys |
| `MegolmKeyBackupService` | Server-side key backup and restore |
| `WebRTCEncryptionService` | Signal Protocol for WebRTC frame encryption |

## Troubleshooting

### "Encryption required but keys not set up"

User needs to complete the Recovery Key Setup Wizard:
1. Navigate to encryption settings
2. Complete `RecoveryKeySetupWizard`
3. Save the mnemonic words securely

### "Encrypted (key unavailable)"

The user doesn't have the Megolm session key for this channel:
- Wait for an existing member to share the key (automatic via realtime)
- If persistent, the channel session may need to be re-shared by an admin/owner

### Decryption failures

- Check `SecureSessionKeyStore` in DevTools > Application > IndexedDB
- Verify `MegolmMessageEncryptionService.isInitialized()` returns true
- Look for `megolm-key-received` CustomEvents in the console
- Check that `tryAutoUnlock()` succeeded on page load

### Lost recovery words

If the mnemonic is lost and browser data is cleared, encrypted messages from before the loss cannot be recovered. The user must set up encryption again with new keys.

## Testing

Encryption tests live in `src/services/encryption/__tests__/`:

- `MegolmService.test.ts` - Session creation, rotation, encrypt/decrypt cycles
- `MegolmMessageEncryptionService.test.ts` - High-level message encryption
- `RecoveryKeyService.test.ts` - Mnemonic derivation and key recovery

Tests use `fake-indexeddb` to simulate browser IndexedDB.

## Configuration

### Environment Variables

```env
VITE_ENABLE_E2E_ENCRYPTION=true
```

### Server Settings

Each server configures its encryption mode via `EncryptionSettings` component or the admin panel. The setting is stored in `server_encryption_settings`.

## Further Reading

- [Megolm specification](https://gitlab.matrix.org/matrix-org/olm/blob/master/docs/megolm.md)
- [Matrix E2EE guide](https://matrix.org/docs/guides/end-to-end-encryption-implementation-guide)
- [Web Crypto API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Crypto_API)
