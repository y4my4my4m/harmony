# encryption/EncryptionKeyStoreBrowser Service

**File:** `src/services/encryption/EncryptionKeyStoreBrowser.ts`

## Overview

```mermaid
graph TB
    subgraph "EncryptionKeyStoreBrowser Service"
        ENCRYPTIONKEYSTORE[EncryptionKeyStore]
    end
    
    subgraph "Interfaces"
        INT_STOREDIDENTITY[StoredIdentity]
    end
    
    subgraph "Classes"
        CLS_ENCRYPTIONKEYSTORE[EncryptionKeyStore]
    end
```


## Exports

- **EncryptionKeyStore** - class export



## Classes

### EncryptionKeyStore

No description available.

**Methods:**
- `constructor`
- `initialize`
- `setEncryptionKey`
- `getIdentityKeyPair`
- `getLocalRegistrationId`
- `isTrustedIdentity`
- `saveIdentity`
- `loadPreKey`
- `storePreKey`
- `removePreKey`
- `loadSession`
- `storeSession`
- `loadSignedPreKey`
- `storeSignedPreKey`
- `removeSignedPreKey`
- `saveIdentityKeyPair`
- `encrypt`
- `decrypt`
- `putInStore`
- `deleteFromStore`
- `arrayBufferToBase64`
- `base64ToArrayBuffer`

**Properties:**
- `db`
- `userId`
- `encryptionKey`
- `identityKeyPair`
- `registrationId`
- `INITIALIZATION`
- `request`
- `exist`
- `keyPath`
- `sessionStore`
- `data`
- `encoder`
- `passwordData`
- `password`
- `keyMaterial`
- `name`
- `salt`
- `iterations`
- `hash`
- `IMPLEMENTATION`
- `stored`
- `undefined`
- `decrypted`
- `parsed`
- `pubKey`
- `privKey`
- `identifier`
- `identityKey`
- `direction`
- `identities`
- `verification`
- `true`
- `encodedAddress`
- `Key`
- `nonblockingApproval`
- `address`
- `key`
- `value`
- `timestamp`
- `keyPair`
- `serialized`
- `encrypted`
- `id`
- `SessionRecordType`
- `record`
- `HELPERS`
- `dataBytes`
- `iv`
- `combined`
- `decoder`
- `transaction`
- `store`
- `METHODS`
- `bytes`
- `binary`
- `i`


## Interfaces

### StoredIdentity

No description available.

```typescript
interface StoredIdentity {

  keyPair: string // Base64 encoded encrypted data
  registrationId: number
  timestamp: number

}
```




## Constants

### DB_NAME

No description available.

```typescript
const DB_NAME = 'harmony_e2ee_keystore'
```

### DB_VERSION

No description available.

```typescript
const DB_VERSION = 1
```

### STORES

No description available.

```typescript
const STORES = {
```




## Source Code Insights

**File Size:** 12180 characters
**Lines of Code:** 410
**Imports:** 2

## Usage Example

```typescript
import { EncryptionKeyStore } from '@/services/encryption/EncryptionKeyStoreBrowser'

// Example usage
// Use the exported functionality
```

---

*This documentation was automatically generated from the source code.*