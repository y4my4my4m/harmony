# encryption/SignalProtocolServiceBrowser Service

**File:** `src/services/encryption/SignalProtocolServiceBrowser.ts`

## Overview

```mermaid
graph TB
    subgraph "SignalProtocolServiceBrowser Service"
        KEYPAIR[KeyPair]
        PREKEY[PreKey]
        SIGNEDPREKEY[SignedPreKey]
        PREKEYBUNDLEDATA[PreKeyBundleData]
        ENCRYPTEDMESSAGE[EncryptedMessage]
        SIGNALPROTOCOLSERVICE[SignalProtocolService]
        SIGNALPROTOCOLSERVICE[signalProtocolService]
    end
    
    subgraph "Interfaces"
        INT_KEYPAIR[KeyPair]
        INT_PREKEY[PreKey]
        INT_SIGNEDPREKEY[SignedPreKey]
        INT_PREKEYBUNDLEDATA[PreKeyBundleData]
        INT_ENCRYPTEDMESSAGE[EncryptedMessage]
    end
    
    subgraph "Classes"
        CLS_SIGNALPROTOCOLSERVICE[SignalProtocolService]
    end
```


## Exports

- **KeyPair** - interface export
- **PreKey** - interface export
- **SignedPreKey** - interface export
- **PreKeyBundleData** - interface export
- **EncryptedMessage** - interface export
- **SignalProtocolService** - class export
- **signalProtocolService** - const export



## Classes

### SignalProtocolService

No description available.

**Methods:**
- `constructor`
- `getInstance`
- `initialize`
- `isInitialized`
- `ensureInitialized`
- `generateIdentityKeyPair`
- `generateSignedPreKey`
- `generatePreKeys`
- `generateRegistrationId`
- `createSessionFromPreKeyBundle`
- `hasSession`
- `encryptMessage`
- `decryptMessage`
- `encodeToBase64`
- `decodeFromBase64`
- `stringToArrayBuffer`
- `arrayBufferToString`

**Properties:**
- `instance`
- `keyStore`
- `initialized`
- `store`
- `true`
- `null`
- `GENERATION`
- `pair`
- `keyPair`
- `Key`
- `prekey`
- `identityKeyPair`
- `signedPreKeyId`
- `identityPrivateKey`
- `signedPreKey`
- `pubKey`
- `id`
- `signature`
- `timestamp`
- `prekeys`
- `count`
- `preKeys`
- `i`
- `preKey`
- `ID`
- `MANAGEMENT`
- `bundle`
- `recipientAddress`
- `address`
- `sessionBuilder`
- `library`
- `registrationId`
- `identityKey`
- `keyId`
- `undefined`
- `recipient`
- `sessionRecord`
- `DECRYPTION`
- `plaintext`
- `sessionCipher`
- `ciphertext`
- `type`
- `body`
- `sender`
- `senderAddress`
- `encryptedMessage`
- `messageBody`
- `METHODS`
- `bytes`
- `binary`
- `encoder`
- `decoder`


## Interfaces

### KeyPair

No description available.

```typescript
interface KeyPair {

  publicKey: string // Base64 encoded
  privateKey: string // Base64 encoded

}
```

### PreKey

No description available.

```typescript
interface PreKey {

  id: number
  keyPair: KeyPair

}
```

### SignedPreKey

No description available.

```typescript
interface SignedPreKey {

  signature: string // Base64 encoded
  timestamp: number

}
```

### PreKeyBundleData

No description available.

```typescript
interface PreKeyBundleData {

  identityKey: string // Base64 encoded public key
  registrationId: number
  deviceId: number
  signedPreKey: {
    id: number
    publicKey: string
    signature: string
  }
  oneTimePreKey?: {
    id: number
    publicKey: string
  }

}
```

### EncryptedMessage

No description available.

```typescript
interface EncryptedMessage {

  type: 'prekey' | 'message'
  body: string // Base64 encoded ciphertext
  registrationId: number

}
```








## Source Code Insights

**File Size:** 8490 characters
**Lines of Code:** 304
**Imports:** 3

## Usage Example

```typescript
import { KeyPair, PreKey, SignedPreKey, PreKeyBundleData, EncryptedMessage, SignalProtocolService, signalProtocolService } from '@/services/encryption/SignalProtocolServiceBrowser'

// Example usage
// Use the exported functionality
```

---

*This documentation was automatically generated from the source code.*