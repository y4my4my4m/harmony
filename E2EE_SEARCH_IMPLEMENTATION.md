# E2EE Search Implementation Plan

## Overview

This document outlines the implementation of a **Seshat-like local encrypted search index** for Harmony, enabling full-text search of end-to-end encrypted messages while maintaining privacy guarantees.

## The Problem

End-to-end encryption (E2EE) ensures that only the sender and recipient can read messages - the server never sees plaintext. However, this creates a challenge for search:

- **Server-side search is impossible** - the server only has ciphertext
- **Naive client-side search is slow** - decrypting all messages on every search is impractical
- **Users expect search to work** - it's a core feature of any messaging app

## How Other Apps Solve This

| App | Approach | Pros | Cons |
|-----|----------|------|------|
| **Signal** | In-memory search of loaded messages | Simple, no persistence | Only searches visible messages, slow for large histories |
| **Matrix/Element** | Seshat - encrypted local search index | Fast, searchable history | Complex, per-device index, storage overhead |
| **WhatsApp** | Local SQLite full-text search | Fast, native | Mobile-only, tied to device backup |
| **Telegram** | Server-side (no E2EE by default) | Fast, cross-device | No privacy for regular chats |

## Proposed Solution: Local Encrypted Search Index

Implement a **Seshat-inspired architecture** using browser technologies:

### Architecture

```
┌─────────────────────────────────────────────────────────────────┐
│                        Message Flow                              │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  1. Message Received (encrypted)                                 │
│         │                                                        │
│         ▼                                                        │
│  2. Decrypt with Signal Protocol                                 │
│         │                                                        │
│         ├──────────────────┐                                     │
│         ▼                  ▼                                     │
│  3. Display in UI    4. Index for Search                         │
│                            │                                     │
│                            ▼                                     │
│                     5. Tokenize & Hash                           │
│                            │                                     │
│                            ▼                                     │
│                     6. Encrypt Index Entry                       │
│                            │                                     │
│                            ▼                                     │
│                     7. Store in IndexedDB                        │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

### Search Flow

```
┌─────────────────────────────────────────────────────────────────┐
│                        Search Flow                               │
├─────────────────────────────────────────────────────────────────┤
│                                                                  │
│  1. User enters search query                                     │
│         │                                                        │
│         ▼                                                        │
│  2. Tokenize query (same algorithm as indexing)                  │
│         │                                                        │
│         ▼                                                        │
│  3. Hash tokens (deterministic)                                  │
│         │                                                        │
│         ▼                                                        │
│  4. Look up hashed tokens in IndexedDB                           │
│         │                                                        │
│         ▼                                                        │
│  5. Get matching message IDs                                     │
│         │                                                        │
│         ▼                                                        │
│  6. Fetch & decrypt matching messages                            │
│         │                                                        │
│         ▼                                                        │
│  7. Display results with highlighted matches                     │
│                                                                  │
└─────────────────────────────────────────────────────────────────┘
```

## Technical Design

### 1. Index Structure

```typescript
interface SearchIndex {
  // Token hash → list of message references
  tokens: Map<string, MessageReference[]>
  
  // Message ID → message metadata (for quick lookups)
  messages: Map<string, IndexedMessageMeta>
  
  // Index metadata
  meta: {
    version: number
    lastUpdated: number
    userId: string
    indexKeyId: string // Key used to encrypt the index
  }
}

interface MessageReference {
  messageId: string
  conversationId?: string
  channelId?: string
  timestamp: number
  positions: number[] // Token positions for highlighting
}

interface IndexedMessageMeta {
  messageId: string
  senderId: string
  timestamp: number
  conversationId?: string
  channelId?: string
  hasMedia: boolean
  // Encrypted preview for search results
  encryptedPreview?: string
}
```

### 2. Tokenization Strategy

```typescript
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    // Remove punctuation except apostrophes in words
    .replace(/[^\w\s']/g, ' ')
    // Split on whitespace
    .split(/\s+/)
    // Remove empty strings
    .filter(token => token.length > 0)
    // Optionally: stem words (running → run)
    // Optionally: remove stop words (the, a, an)
}

// Example:
// "Hello, how are you doing today?" 
// → ["hello", "how", "are", "you", "doing", "today"]
```

### 3. Token Hashing (Blind Index)

To prevent leaking information about indexed words, we hash tokens with a user-specific key:

```typescript
async function hashToken(token: string, indexKey: CryptoKey): Promise<string> {
  const encoder = new TextEncoder()
  const data = encoder.encode(token)
  
  // HMAC-SHA256 with user's index key
  const signature = await crypto.subtle.sign(
    'HMAC',
    indexKey,
    data
  )
  
  // Return base64 of first 16 bytes (128 bits - sufficient for uniqueness)
  return btoa(String.fromCharCode(...new Uint8Array(signature).slice(0, 16)))
}
```

### 4. Index Encryption

The index itself should be encrypted at rest:

```typescript
interface EncryptedIndex {
  // Encrypted JSON blob of the index
  encryptedData: string
  // IV for AES-GCM
  iv: string
  // Key derivation salt (if using password-based key)
  salt?: string
  // Version for migration
  version: number
}

async function encryptIndex(
  index: SearchIndex, 
  indexKey: CryptoKey
): Promise<EncryptedIndex> {
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const encoder = new TextEncoder()
  const data = encoder.encode(JSON.stringify(index))
  
  const encrypted = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    indexKey,
    data
  )
  
  return {
    encryptedData: btoa(String.fromCharCode(...new Uint8Array(encrypted))),
    iv: btoa(String.fromCharCode(...iv)),
    version: 1
  }
}
```

### 5. IndexedDB Schema

```typescript
// Database: harmony_search_index
// Object Stores:

interface SearchIndexDB {
  // Store: 'index_meta'
  // Key: 'meta'
  indexMeta: {
    version: number
    lastUpdated: number
    userId: string
    totalMessages: number
    totalTokens: number
  }
  
  // Store: 'token_index'
  // Key: tokenHash
  // Index: by conversationId, channelId
  tokenIndex: {
    tokenHash: string // Primary key
    messageRefs: MessageReference[]
  }
  
  // Store: 'message_meta'
  // Key: messageId
  // Index: by timestamp, conversationId, channelId
  messageMeta: {
    messageId: string // Primary key
    senderId: string
    timestamp: number
    conversationId?: string
    channelId?: string
    tokenCount: number
    encryptedPreview: string
  }
  
  // Store: 'index_key'
  // Key: 'current'
  // Stores the wrapped index encryption key
  indexKey: {
    wrappedKey: string // Encrypted with user's master key
    keyId: string
    createdAt: number
  }
}
```

## Implementation Plan

### Phase 1: Core Infrastructure (Week 1-2)

1. **Create `LocalSearchIndexService`**
   - IndexedDB initialization and schema
   - Index encryption/decryption
   - Token hashing utilities

2. **Implement tokenization**
   - Text normalization
   - Token extraction
   - Optional: stemming, stop word removal

3. **Basic indexing**
   - Hook into message decryption pipeline
   - Index newly decrypted messages
   - Handle message updates and deletions

### Phase 2: Search Functionality (Week 2-3)

4. **Implement search queries**
   - Token-based lookup
   - Multi-token AND/OR queries
   - Phrase matching (optional)

5. **Result ranking**
   - TF-IDF or BM25 scoring
   - Recency weighting
   - Conversation/channel filtering

6. **Search UI integration**
   - Hook into existing `MessageSearchModal`
   - Add "Local E2EE Search" mode
   - Display encrypted message indicators

### Phase 3: Optimization & Polish (Week 3-4)

7. **Performance optimization**
   - Batch indexing for history
   - Index compression
   - Memory-efficient lookups

8. **Background indexing**
   - Web Worker for indexing
   - Progressive history indexing
   - Index health monitoring

9. **Cross-conversation search**
   - Global search across all E2EE conversations
   - Conversation-scoped search
   - Search filters (date, sender, media)

### Phase 4: Advanced Features (Future)

10. **Index sync (optional)**
    - Encrypted index backup to server
    - Cross-device index restore
    - Index merging

11. **Fuzzy search**
    - Typo tolerance
    - Phonetic matching

12. **Semantic search (experimental)**
    - Local embedding generation
    - Vector similarity search

## File Structure

```
src/
├── services/
│   └── search/
│       ├── LocalSearchIndexService.ts    # Main service
│       ├── TokenizerService.ts           # Text tokenization
│       ├── BlindIndexService.ts          # Token hashing
│       ├── IndexStorageService.ts        # IndexedDB operations
│       └── SearchQueryService.ts         # Query execution
├── composables/
│   └── useLocalEncryptedSearch.ts        # Vue composable
├── workers/
│   └── searchIndexWorker.ts              # Background indexing
└── types/
    └── search.ts                         # Type definitions
```

## Security Considerations

### What's Protected

- ✅ **Message content** - never leaves device unencrypted
- ✅ **Search queries** - processed locally
- ✅ **Index contents** - encrypted at rest
- ✅ **Token hashes** - keyed HMAC prevents rainbow tables

### What's NOT Protected

- ⚠️ **Index size** - reveals approximate message count
- ⚠️ **Search timing** - may reveal query complexity
- ⚠️ **Memory** - decrypted data exists in RAM during search

### Threat Model

| Threat | Mitigation |
|--------|------------|
| Server compromise | Index never sent to server |
| Device theft (locked) | Index encrypted with user key |
| Device theft (unlocked) | Beyond threat model (like any local app) |
| Memory forensics | Clear sensitive data after use |
| XSS attack | Standard CSP protections |

## Storage Estimates

| Messages | Index Size (estimated) |
|----------|----------------------|
| 1,000 | ~500 KB |
| 10,000 | ~5 MB |
| 100,000 | ~50 MB |
| 1,000,000 | ~500 MB |

IndexedDB typically allows 50% of free disk space, so this should be fine for most users.

## Alternatives Considered

### 1. Server-Side Blind Index
Store encrypted keyword hashes on server, query by hash.
- **Rejected**: Still leaks access patterns, requires server changes

### 2. Homomorphic Encryption
Compute on encrypted data without decrypting.
- **Rejected**: Too slow, not practical for text search

### 3. Trusted Execution Environment (TEE)
Run search in secure enclave on server.
- **Rejected**: Requires specialized hardware, trust issues

### 4. Searchable Symmetric Encryption (SSE)
Academic schemes for encrypted search.
- **Rejected**: Complex, limited query support, emerging research

## Success Metrics

- [ ] Search latency < 100ms for 10k messages
- [ ] Index build time < 1 second per 100 messages
- [ ] Storage overhead < 50% of message size
- [ ] Zero plaintext data sent to server
- [ ] Works offline

## References

- [Seshat - Matrix encrypted search](https://github.com/matrix-org/seshat)
- [Signal Protocol documentation](https://signal.org/docs/)
- [IndexedDB API](https://developer.mozilla.org/en-US/docs/Web/API/IndexedDB_API)
- [Web Crypto API](https://developer.mozilla.org/en-US/docs/Web/API/Web_Crypto_API)
- [Blind Index patterns](https://paragonie.com/blog/2017/05/building-searchable-encrypted-databases-with-php-and-sql)

## Conclusion

Implementing local encrypted search is the professional approach used by Signal and Matrix. It provides:

1. **Privacy** - Search happens entirely on-device
2. **Speed** - Pre-built index enables fast lookups
3. **Functionality** - Users can search their entire E2EE history
4. **Offline support** - Works without network

The main tradeoffs are:
- Per-device index (no cross-device search without sync)
- Initial indexing time for history
- Storage overhead

This is the right approach for a privacy-focused chat application and aligns with industry best practices.

