# E2EE Refactor: Megolm-Style Encryption

## Overview

This document describes the new Megolm-style E2EE (End-to-End Encryption) system for Harmony. This is a major refactor from the previous Signal Protocol approach to a Matrix/Megolm-inspired design that better suits Harmony's use case as a persistent chat platform.

## Why the Change?

### Previous System (Signal Protocol)
- Per-message key exchange (complex, resource-intensive)
- Keys stored only in browser IndexedDB
- **Problem**: If cache is cleared → **All message history lost forever** 💀
- Complex multi-device support

### New System (Megolm-Style)
- Per-room session keys (efficient, simpler)
- **Recovery key** (12-word mnemonic like crypto wallets)
- **Server-stored encrypted backup** (only user can decrypt)
- **Cache cleared?** → Enter recovery key → **All messages readable again!** ✅

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  INITIAL SETUP                                          │
│  1. Generate identity keys                              │
│  2. Create RECOVERY KEY (12-word phrase)                │
│  3. Derive encryption keys from recovery key            │
│  4. Session keys encrypted and backed up to server      │
└─────────────────────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────┐
│  SENDING ENCRYPTED MESSAGES                             │
│  1. Get/create outbound session for room                │
│  2. Encrypt message with session key                    │
│  3. Share session key with room members (encrypted)     │
│  4. Message stored with session_id + message_index      │
└─────────────────────────────────────────────────────────┘
                           │
                           ▼
┌─────────────────────────────────────────────────────────┐
│  NEW DEVICE / CLEARED CACHE                             │
│  1. Log in                                              │
│  2. Enter recovery key (12 words)                       │
│  3. Derive encryption keys                              │
│  4. Download and decrypt server backup                  │
│  5. ✅ All messages readable again!                     │
└─────────────────────────────────────────────────────────┘
```

## Components Created

### Services (`src/services/encryption/`)

1. **`MegolmService.ts`** - Core Megolm session management
   - Outbound sessions (for sending)
   - Inbound sessions (for receiving)
   - Ratchet key derivation (forward secrecy)
   - Session rotation (100 messages or 7 days)

2. **`RecoveryKeyService.ts`** - Recovery key management
   - BIP39 mnemonic generation (12 or 24 words)
   - Key derivation (encryption, backup, signing keys)
   - QR code support for cross-device sharing
   - Verification code generation

3. **`MegolmKeyBackupService.ts`** - Server backup management
   - Encrypted backup creation/restore
   - Automatic backup on session changes
   - Cross-device key request/fulfillment
   - File export/import

4. **`MegolmMessageEncryptionService.ts`** - High-level encryption API
   - Message encryption/decryption
   - Session sharing management
   - Backward compatibility with Signal Protocol messages

### UI Components (`src/components/encryption/`)

1. **`RecoveryKeySetupWizard.vue`** - First-time setup flow
   - Step-by-step guide
   - Recovery key display (grid format)
   - Verification step (prove user wrote it down)
   - Copy/download options

2. **`KeyRecoveryModal.vue`** - Restore encryption
   - Enter 12-word phrase
   - Paste/clipboard support
   - QR code scanner (placeholder)
   - Verification code check

3. **`EncryptionSettingsNew.vue`** - Settings management
   - Status overview
   - Backup management
   - Session statistics
   - Reset encryption option

### Database Schema (`db_schema/megolm_e2ee_schema.sql`)

New tables:
- `megolm_key_backups` - Encrypted session backups
- `megolm_key_requests` - Cross-device key sharing
- `recovery_key_metadata` - Recovery key info (NOT the key!)
- `megolm_room_sessions` - Public session metadata
- `megolm_session_shares` - Encrypted session key shares

## Migration Path

### For New Users
1. Set up encryption via `RecoveryKeySetupWizard`
2. Write down 12-word recovery phrase
3. Encryption automatically enabled

### For Existing Users
The old Signal Protocol encryption still works. Users can:
1. Continue using old system
2. Eventually migrate to new system via settings

### Backward Compatibility
- `MegolmMessageEncryptionService` can decrypt both:
  - New Megolm messages (`algorithm: 'megolm_v1'`)
  - Legacy Signal messages (`algorithm: 'signal_protocol_v1_hybrid'`)

## Security Model

### What's Stored on Server (Encrypted)
- Session keys backup (encrypted with recovery-derived key)
- Session key shares (encrypted with recipient identity key)
- Recovery key metadata (verification code, word count - NOT the phrase!)

### What's NEVER Stored on Server
- Recovery phrase (12 words)
- Derived encryption keys
- Plaintext message content

### Recovery Key Security
```
Recovery Phrase (12 words)
         │
         ▼ PBKDF2 (100k iterations)
    Master Key
         │
         ├──► Encryption Key (local data)
         ├──► Backup Key (server backups)
         └──► Signing Key (cross-device auth)
```

## Usage Examples

### Setting Up Encryption
```typescript
const { megolmMessageEncryptionService } = await import('@/services/encryption/MegolmMessageEncryptionService')

// Initialize
await megolmMessageEncryptionService.initialize(authUserId)

// Setup new encryption (returns recovery words)
const words = await megolmMessageEncryptionService.setupNewEncryption()
// Display words to user - they MUST write these down!
```

### Restoring Encryption
```typescript
const { megolmMessageEncryptionService } = await import('@/services/encryption/MegolmMessageEncryptionService')

await megolmMessageEncryptionService.initialize(authUserId)

// Restore with recovery key
const words = ['word1', 'word2', ..., 'word12']
await megolmMessageEncryptionService.initializeWithRecoveryKey(words)
// All sessions restored from backup!
```

### Encrypting Messages
```typescript
const result = await megolmMessageEncryptionService.encryptMessage(
  content,        // MessagePart[]
  roomId,         // channel_id or conversation_id
  recipientIds    // user IDs in the room
)

// result contains:
// - encrypted: true
// - content: [{ type: 'text', text: 'base64-ciphertext' }]
// - encryption_metadata: { algorithm: 'megolm_v1', session_id, message_index, ... }
```

### Decrypting Messages
```typescript
const decryptedContent = await megolmMessageEncryptionService.decryptMessage({
  content: message.content,
  encryption_metadata: message.encryption_metadata
})
```

## Database Migration

Run the SQL file to create the new tables:
```sql
\i db_schema/megolm_e2ee_schema.sql
```

This creates all necessary tables and RLS policies without affecting existing Signal Protocol tables.

## Key Rotation

Sessions automatically rotate when:
- 100 messages sent with same session
- 7 days since session creation

New session keys are automatically:
1. Shared with existing room members
2. Backed up to server

## Forward Secrecy

Each message uses a unique ratchet key derived from:
- Session key
- Message index

This means compromising one message doesn't reveal others.

## Comparison: Signal vs Megolm

| Feature | Signal (Old) | Megolm (New) |
|---------|-------------|--------------|
| Forward Secrecy | Perfect (per-message) | Good (per-session) |
| Key Backup | ❌ No | ✅ Yes, encrypted |
| Cache Cleared | 💀 Lost forever | ✅ Recoverable |
| Multi-device | Complex | Easy (recovery key) |
| Group Efficiency | 1:1 encryption per member | 1 encryption for all |
| Best For | Ephemeral messaging | Persistent chat rooms |

## Files Changed/Created

### New Files
```
src/services/encryption/
├── MegolmService.ts
├── RecoveryKeyService.ts
├── MegolmKeyBackupService.ts
└── MegolmMessageEncryptionService.ts

src/components/encryption/
├── RecoveryKeySetupWizard.vue
├── KeyRecoveryModal.vue
└── EncryptionSettingsNew.vue

db_schema/
└── megolm_e2ee_schema.sql
```

### Modified Files
```
src/services/encryption/index.ts  (added new exports)
```

## Testing Checklist

- [ ] New user can set up encryption
- [ ] Recovery phrase displays correctly
- [ ] Verification step works
- [ ] Encrypted messages send successfully
- [ ] Encrypted messages decrypt correctly
- [ ] Server backup created
- [ ] Clear cache → restore with recovery key works
- [ ] New device can restore with recovery key
- [ ] Legacy Signal messages still decrypt
- [ ] Session rotation works
- [ ] Multi-user room encryption works

