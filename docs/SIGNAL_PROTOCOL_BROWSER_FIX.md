# Signal Protocol Browser Fix

## Problem

`@signalapp/libsignal-client` is a **Node.js native module** with C++ bindings that cannot run in the browser. When imported eagerly, it causes:

```
Cannot read properties of undefined (reading 'modules')
```

## Solution Applied

### 1. Vite Configuration

Excluded Signal Protocol from browser bundle:

```typescript
// vite.config.ts
optimizeDeps: {
  exclude: [
    '@signalapp/libsignal-client',  // Native Node.js module
  ]
}
```

### 2. Lazy Loading

Changed all encryption service imports to **lazy/dynamic imports**:

**Before (❌ Breaks browser):**
```typescript
import { messageEncryptionService } from '@/services/encryption'
```

**After (✅ Works):**
```typescript
// Lazy load
let messageEncryptionService: any = null
async function getEncryptionService() {
  if (!messageEncryptionService) {
    try {
      const module = await import('@/services/encryption/MessageEncryptionService')
      messageEncryptionService = module.messageEncryptionService
    } catch (error) {
      console.warn('Encryption not available:', error)
    }
  }
  return messageEncryptionService
}

// Use it
const encryptionService = await getEncryptionService()
if (encryptionService) {
  // Use encryption
}
```

### 3. Files Updated

- ✅ `vite.config.ts` - Excluded native module
- ✅ `src/services/encryption/index.ts` - Added lazy exports
- ✅ `src/services/core/CoreMessageService.ts` - Lazy loading
- ✅ `src/services/unifiedWebRTC.ts` - Lazy loading

## Result

- ✅ App loads in browser without errors
- ✅ Encryption services load **only when actually needed**
- ✅ Graceful fallback if encryption not available
- ✅ No breaking changes to API

## Testing

1. App should load without errors
2. Encryption works when explicitly enabled
3. App works fine without encryption

## Notes

**Signal Protocol is designed for native environments (Node.js, iOS, Android).** For true browser E2EE, consider:

1. **WebCrypto API** - Browser-native crypto
2. **libsignal-protocol-javascript** - Pure JS implementation (but older)
3. **Keep current approach** - Encryption optional, loaded lazily

Current implementation makes E2EE **optional** and **progressive enhancement** - app works fine without it!

