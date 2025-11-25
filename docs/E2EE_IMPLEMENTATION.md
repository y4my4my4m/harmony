# End-to-End Encryption Implementation Guide

## 🔐 Overview

Harmony uses the **Signal Protocol** for end-to-end encryption, providing industry-standard security for messages, DMs, and voice/video calls.

**Key Features:**
- ✅ Zero-knowledge architecture (servers can't decrypt)
- ✅ Perfect forward secrecy
- ✅ Future secrecy with key rotation
- ✅ Asynchronous message encryption (offline recipients)
- ✅ Group message support via Sender Keys
- ✅ Per-user keys with upgrade path to per-device
- ✅ Server-controlled encryption policies

## 📐 Architecture

### Components

```
┌─────────────────────────────────────────────┐
│         User Interface Layer                │
│  - KeySetupWizard.vue                      │
│  - EncryptionIndicator.vue                 │
│  - EncryptionSettings.vue                  │
└────────────────┬────────────────────────────┘
                 │
┌────────────────▼────────────────────────────┐
│      Message Encryption Service             │
│  - Policy enforcement                       │
│  - Session management                       │
│  - High-level encrypt/decrypt API           │
└────────────────┬────────────────────────────┘
                 │
┌────────────────▼────────────────────────────┐
│      Signal Protocol Service                │
│  - Key generation                           │
│  - Session establishment                    │
│  - Encrypt/decrypt operations               │
└────────────────┬────────────────────────────┘
                 │
┌────────────────▼────────────────────────────┐
│      Encryption Key Store                   │
│  - IndexedDB storage                        │
│  - Web Crypto API encryption                │
│  - Signal Protocol interfaces               │
└────────────────┬────────────────────────────┘
                 │
┌────────────────▼────────────────────────────┐
│      Database Layer                         │
│  - user_key_pairs                           │
│  - prekeys                                  │
│  - encryption_sessions                      │
│  - server_encryption_settings               │
└─────────────────────────────────────────────┘
```

## 🚀 User Setup Flow

### First-Time Setup

1. **User Registration/Login**
   - After authentication, check if user has encryption keys

2. **Key Setup Wizard**
   ```typescript
   import { KeySetupWizard } from '@/components/encryption'
   
   // Show wizard if no keys
   <KeySetupWizard 
     @complete="handleSetupComplete"
     @close="handleClose"
   />
   ```

3. **Key Generation Process**
   - User creates encryption password
   - Generate identity key pair (Ed25519)
   - Generate signed prekey
   - Generate 100 one-time prekeys
   - Upload public keys to server
   - Store private keys in IndexedDB (encrypted)

4. **Backup Code**
   - Generate recovery code
   - User must save it securely
   - Used for account recovery

### Message Flow

#### Sending Encrypted Message

```typescript
// In CoreMessageService.sendChannelMessage()

1. Check server encryption policy
2. If encryption required:
   a. Get all server members (recipients)
   b. For each recipient:
      - Check if session exists
      - If no session: fetch prekey bundle, establish session
      - Encrypt message with session
   c. Create encrypted content structure
   d. Insert to database with encrypted=true
3. Real-time broadcast to recipients
```

#### Receiving Encrypted Message

```typescript
// In useChatStore or useDMStore

1. Receive message from real-time
2. Check if encrypted=true
3. If encrypted:
   a. Extract encrypted payload for current user
   b. Get sender's address
   c. Decrypt using session
   d. Parse decrypted content
   e. Display in UI
```

## 🔑 Key Management

### Identity Keys

**Storage:**
- Public key: Stored in database (`user_key_pairs.identity_public_key`)
- Private key: Encrypted and stored in IndexedDB

**Lifecycle:**
- Generated once per user (per-device in future)
- Never rotated (permanent identity)
- Used to sign prekeys

### Prekeys

**Types:**

1. **Signed Prekeys**
   - Long-term prekeys signed by identity key
   - Rotated every 90 days
   - Can be reused

2. **One-Time Prekeys**
   - Single-use prekeys for session establishment
   - Marked as used after consumption
   - Auto-generated when count < 20
   - Batch of 100 generated at setup

**Rotation:**
```typescript
// Automatic rotation (called periodically)
await messageEncryptionService.rotatePrekeys()

// Manual rotation (in settings)
<button @click="rotateKeys">Generate More Pre-keys</button>
```

### Sessions

**Establishment:**
```
Alice → Bob (first message)
  ↓
1. Fetch Bob's prekey bundle
   - Identity key (public)
   - Signed prekey
   - One-time prekey (consumed)
  ↓
2. Process bundle → create session
  ↓
3. Encrypt message with PreKeyMessage
  ↓
4. Save session state
```

**Subsequent Messages:**
```
Alice → Bob (after session exists)
  ↓
1. Load existing session
  ↓
2. Encrypt with SignalMessage
  ↓
3. Update session state
```

**Session Refresh:**
- Automatic after 1000 messages
- Manual via session management
- Provides future secrecy

## 🏢 Server Encryption Policies

### Policy Modes

```typescript
type EncryptionMode = 
  | 'disabled'              // No E2EE allowed
  | 'optional'              // User choice (default)
  | 'required'              // E2EE required, federation allowed (plaintext)
  | 'required_local_only'   // E2EE required, no federation
```

### Database Schema

```sql
CREATE TABLE server_encryption_settings (
    server_id UUID REFERENCES servers(id),
    encryption_mode TEXT DEFAULT 'optional',
    allow_federation BOOLEAN DEFAULT true
);
```

### Setting Policy (Server Owner)

```typescript
// In ServerSettings.vue
const policy = {
  encryption_mode: 'required',
  allow_federation: true // Federated messages sent as plaintext
}

await supabase
  .from('server_encryption_settings')
  .upsert({ server_id, ...policy })
```

### Policy Enforcement

```typescript
// Checked before sending message
const policy = await messageEncryptionService
  .checkServerEncryptionPolicy(serverId)

if (policy.mode === 'required' && !policy.hasKeys) {
  throw new Error('Encryption required - please set up E2EE')
}
```

## 💬 Message Encryption Format

### Encrypted Message Structure

```json
{
  "encrypted": true,
  "content": [
    {
      "type": "encrypted",
      "encrypted_payloads": {
        "user-id-1": "{\"type\":\"prekey\",\"body\":\"base64...\"}",
        "user-id-2": "{\"type\":\"message\",\"body\":\"base64...\"}"
      }
    }
  ],
  "encryption_metadata": {
    "algorithm": "signal_protocol_v1",
    "encrypted_for": ["user-id-1", "user-id-2"],
    "sender_key_id": "sender-user-id",
    "timestamp": 1234567890
  }
}
```

### Group Encryption (Sender Keys)

For large groups, more efficient to use Sender Keys:

```json
{
  "encrypted": true,
  "content": [
    {
      "type": "encrypted_group",
      "group_id": "channel-or-conversation-id",
      "encrypted_body": "base64_encrypted_content"
    }
  ]
}
```

## 📞 Voice/Video E2EE

### WebRTC DTLS-SRTP

WebRTC already provides encryption via DTLS-SRTP (standard).

### Additional E2EE Layer (Optional)

Using **Insertable Streams API**:

```typescript
// In unifiedWebRTC.ts

async setupE2EEForCall(remoteUserId: string) {
  const sender = this.peerConnection.getSenders()[0]
  const senderStreams = sender.createEncodedStreams()
  
  const transformStream = new TransformStream({
    transform: async (chunk, controller) => {
      // Encrypt frame with Signal Protocol session
      const encrypted = await signalProtocolService.encryptMessage(
        `${remoteUserId}:1`,
        chunk.data.toString('base64')
      )
      
      chunk.data = Buffer.from(encrypted.body, 'base64')
      controller.enqueue(chunk)
    }
  })
  
  senderStreams.readable
    .pipeThrough(transformStream)
    .pipeTo(senderStreams.writable)
}
```

## 🔄 Key Rotation

### Automatic Rotation

```typescript
// Background task (run daily)
setInterval(async () => {
  try {
    await messageEncryptionService.rotatePrekeys()
  } catch (error) {
    console.error('Prekey rotation failed:', error)
  }
}, 24 * 60 * 60 * 1000) // 24 hours
```

### Manual Rotation

User can trigger in settings:
- Generates 100 new one-time prekeys
- Deletes used prekeys older than 30 days
- Marks expired signed prekeys

## 🌐 Federation & E2EE

### Hybrid Approach

Server owners choose behavior:

**Option 1: E2EE with Federation**
- Local users: Messages encrypted
- Federated users: Messages sent as plaintext (ActivityPub limitation)
- Clear UI indicator showing encryption status

**Option 2: E2EE Only (No Federation)**
- All messages encrypted
- Federation disabled for this server
- Maximum privacy

### Implementation

```typescript
const policy = await messageEncryptionService
  .checkServerEncryptionPolicy(serverId)

if (policy.mode === 'required_local_only') {
  // Don't federate this message
  // Only local encrypted delivery
}
```

## 🛠️ Development

### Initialize Encryption for User

```typescript
import { messageEncryptionService } from '@/services/encryption'

// After user login
const userId = authStore.user.id

// Initialize service
await messageEncryptionService.initialize(userId)

// Check if keys exist
const hasKeys = await messageEncryptionService.hasEncryptionKeys()

if (!hasKeys) {
  // Show setup wizard
  showKeySetupWizard()
}
```

### Encrypt a Message

```typescript
const content: MessagePart[] = [
  { type: 'text', value: 'Hello, encrypted world!' }
]

const recipientIds = ['user-id-1', 'user-id-2']

const encrypted = await messageEncryptionService.encryptMessage(
  content,
  recipientIds
)

// encrypted.content contains encrypted payloads
// encrypted.encryption_metadata contains metadata
```

### Decrypt a Message

```typescript
const decrypted = await messageEncryptionService.decryptMessage(
  encryptedContent,
  senderId
)

// decrypted is the original MessagePart[]
```

## 🔍 Troubleshooting

### "Encryption required but keys not set up"

**Solution:** User needs to complete Key Setup Wizard
- Go to Settings → Security
- Click "Enable E2EE"
- Follow wizard steps

### "Failed to fetch prekey bundle"

**Possible causes:**
- Recipient hasn't enabled E2EE yet
- Recipient ran out of one-time prekeys
- Database connection issue

**Solution:**
- Ask recipient to enable E2EE
- Check database connectivity
- Verify prekey counts

### "Decryption failed"

**Possible causes:**
- Session corrupted or out of sync
- Key mismatch
- Encrypted with wrong recipient

**Solution:**
- Delete session and re-establish
- Ask sender to resend message
- Check encryption audit log

### Low Prekey Count

**Automatic:** Service auto-generates when < 20
**Manual:** User can trigger in Settings → Encryption

## 📊 Monitoring

### Encryption Audit Log

All encryption events are logged:

```sql
SELECT * FROM encryption_audit_log
WHERE user_id = 'some-user-id'
ORDER BY created_at DESC;
```

Event types:
- `key_generated` - New keys created
- `key_rotated` - Keys rotated
- `session_established` - New session with another user
- `encryption_enabled` - Encryption enabled for conversation
- `decryption_failed` - Failed to decrypt (security alert)

### Statistics

```typescript
const status = await messageEncryptionService.getEncryptionStatus()

console.log({
  available: status.available,    // Service initialized
  hasKeys: status.hasKeys,        // User has keys
  keyCount: status.keyCount       // Unused one-time prekeys
})
```

## 🔐 Security Considerations

### Password Security

- Users create encryption password (separate from account password)
- Password never sent to server
- Used to derive AES-256 key for local encryption
- PBKDF2 with 100,000 iterations

### Key Storage

- Private keys: Encrypted in IndexedDB
- Public keys: Stored in database
- Session state: Encrypted in IndexedDB
- Never log sensitive keys

### Session Security

- Sessions refreshed after 1000 messages
- Old sessions can be manually deleted
- Each session has unique ephemeral keys

### Server Trust Model

- Server stores only public keys
- Server cannot decrypt messages
- Server cannot impersonate users (signed prekeys)
- Audit log tracks all encryption events

## 🔄 Migration Path: Per-User → Per-Device

Current implementation uses per-user keys (simpler UX). Future migration:

### Phase 1: Current (Per-User)
```
User
  └── Device "default"
       └── One identity key pair
            └── One set of prekeys
```

### Phase 2: Future (Per-Device)
```
User
  ├── Device "desktop-chrome"
  │    └── Identity key pair
  ├── Device "mobile-ios"
  │    └── Identity key pair
  └── Device "laptop-firefox"
       └── Identity key pair
```

### Migration Steps

1. Database already supports `device_id` field
2. UI adds device management
3. Generate separate keys per device
4. Cross-device session establishment
5. Key backup/sync mechanism

## 📱 User Experience

### Setup (First Time)

1. User logs in
2. Prompt: "Enable E2EE for enhanced privacy?"
3. Create encryption password
4. Keys generated (30-60 seconds)
5. Show backup code
6. Done!

### Daily Use

- 🔒 Lock icon shows encryption status
- Messages encrypted/decrypted transparently
- No user interaction needed
- Warnings if encryption fails

### Settings

Users can:
- View encryption status
- Check prekey count
- Generate more prekeys
- Export backup code
- Reset encryption (warning shown)

## 🧪 Testing

### Local Testing

```bash
# Terminal 1: Start main app
npm run dev

# Terminal 2: Check encryption service
# In browser console:
import { messageEncryptionService } from '@/services/encryption'

// Initialize
await messageEncryptionService.initialize(userId, password)

// Setup
await messageEncryptionService.setupEncryption(password)

// Check status
await messageEncryptionService.getEncryptionStatus()
```

### Database Verification

```sql
-- Check if user has keys
SELECT * FROM user_key_pairs WHERE user_id = 'some-user-id';

-- Check prekeys
SELECT COUNT(*) FROM prekeys 
WHERE user_id = 'some-user-id' AND is_used = false;

-- Check sessions
SELECT * FROM encryption_sessions 
WHERE local_user_id = 'some-user-id';

-- Check audit log
SELECT * FROM encryption_audit_log 
WHERE user_id = 'some-user-id' 
ORDER BY created_at DESC LIMIT 10;
```

## 📚 API Reference

### messageEncryptionService

```typescript
// Initialize service
await messageEncryptionService.initialize(userId: string, password?: string)

// Setup encryption (first time)
await messageEncryptionService.setupEncryption(password: string)

// Check if user has keys
const hasKeys = await messageEncryptionService.hasEncryptionKeys()

// Encrypt message
const encrypted = await messageEncryptionService.encryptMessage(
  content: MessagePart[],
  recipientIds: string[]
)

// Decrypt message
const decrypted = await messageEncryptionService.decryptMessage(
  encryptedContent: MessagePart[],
  senderId: string
)

// Check server policy
const policy = await messageEncryptionService.checkServerEncryptionPolicy(serverId: string)

// Check conversation encryption
const status = await messageEncryptionService.checkConversationEncryption(conversationId: string)

// Rotate prekeys
await messageEncryptionService.rotatePrekeys()

// Get status
const status = await messageEncryptionService.getEncryptionStatus()
```

### signalProtocolService

```typescript
// Generate identity key pair
const keyPair = await signalProtocolService.generateIdentityKeyPair()

// Generate signed prekey
const signedPreKey = await signalProtocolService.generateSignedPreKey(
  identityKeyPair: KeyPair,
  signedPreKeyId: number
)

// Generate one-time prekeys
const preKeys = await signalProtocolService.generatePreKeys(
  startId: number,
  count: number
)

// Encrypt message
const encrypted = await signalProtocolService.encryptMessage(
  recipientAddress: string,
  plaintext: string
)

// Decrypt message
const plaintext = await signalProtocolService.decryptMessage(
  senderAddress: string,
  encryptedMessage: EncryptedMessage
)
```

## 🎯 Best Practices

### For Developers

1. **Always check encryption status before sending**
2. **Handle encryption errors gracefully**
3. **Never log decrypted content**
4. **Verify recipients have keys before encrypting**
5. **Implement proper error messages for users**

### For Server Admins

1. **Choose appropriate encryption mode**
   - `optional`: Good for public servers
   - `required`: For privacy-focused communities
   - `required_local_only`: Maximum privacy (no federation)

2. **Communicate policy to members**
3. **Provide setup assistance**
4. **Monitor encryption audit logs**

### For Users

1. **Create strong encryption password**
2. **Save backup code securely**
3. **Enable E2EE for all DMs**
4. **Check for lock icon**
5. **Report decryption failures**

## ⚙️ Configuration

### Environment Variables

```env
# Enable E2EE by default for all new users
VITE_AUTO_ENABLE_E2EE=false

# Minimum prekey count before auto-generation
VITE_MIN_PREKEY_COUNT=20

# Session refresh threshold (message count)
VITE_SESSION_REFRESH_THRESHOLD=1000
```

### Database Configuration

```sql
-- Set default encryption mode for all new servers
ALTER TABLE server_encryption_settings 
ALTER COLUMN encryption_mode SET DEFAULT 'optional';

-- Enable encryption for specific server
UPDATE server_encryption_settings
SET encryption_mode = 'required'
WHERE server_id = 'some-server-id';
```

## 🚨 Security Auditing

### Audit Query Examples

```sql
-- Failed decryptions (potential attacks)
SELECT * FROM encryption_audit_log
WHERE event_type = 'decryption_failed'
AND severity = 'error'
ORDER BY created_at DESC;

-- Suspicious activity
SELECT * FROM encryption_audit_log
WHERE severity IN ('error', 'critical')
ORDER BY created_at DESC;

-- Recent key operations
SELECT 
  user_id,
  event_type,
  created_at
FROM encryption_audit_log
WHERE event_type IN ('key_generated', 'key_rotated', 'session_established')
ORDER BY created_at DESC
LIMIT 100;
```

## 📖 Further Reading

- [Signal Protocol Documentation](https://signal.org/docs/)
- [Double Ratchet Algorithm](https://signal.org/docs/specifications/doubleratchet/)
- [X3DH Key Agreement](https://signal.org/docs/specifications/x3dh/)

## ✨ Future Enhancements

- [ ] Per-device keys
- [ ] Device verification
- [ ] Safety numbers
- [ ] Key backup to server (encrypted)
- [ ] Cross-signing between devices
- [ ] Session verification UI
- [ ] Encrypted file uploads
- [ ] Encrypted voice notes

