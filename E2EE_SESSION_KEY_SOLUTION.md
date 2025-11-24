# E2EE Password Session Management

## Problem
The encryption keys are stored encrypted in IndexedDB with a password-derived key.  
When sending messages, we need this key but don't have the password.

## Solution
Store the derived encryption key in **sessionStorage** (cleared on browser close).

### Modified Flow:

1. **User sets up E2EE** → Enters password
2. **Derive encryption key** from password
3. **Store derived key** in sessionStorage
4. **Use stored key** for encrypting/decrypting messages
5. **On browser close** → Key is cleared automatically

### Security:
- ✅ Password never stored
- ✅ Key only in memory (sessionStorage)
- ✅ Automatically cleared on browser close
- ✅ Re-prompt on new session if needed

### Implementation:
- Modify `EncryptionKeyStore` to check sessionStorage first
- Add key caching after successful password entry
- Add key clearing on logout

