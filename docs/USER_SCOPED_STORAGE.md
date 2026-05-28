# User-Scoped LocalStorage

## Overview

LocalStorage data is now user-scoped to prevent data leakage when switching between accounts. Each user's localStorage data is isolated using a user ID prefix.

## How It Works

- **On Login**: User ID is set in `userStorage`, all subsequent localStorage operations are scoped to that user
- **On Logout**: Current user's localStorage data is cleared
- **On Switch**: When switching users, old user's data is cleared and new user's data is loaded

## Usage

```typescript
import { userStorage } from '@/utils/userScopedStorage'

// Set current user (automatically called on login)
userStorage.setCurrentUser(userId)

// Use like normal localStorage
userStorage.setItem('key', 'value')
const value = userStorage.getItem('key')
userStorage.removeItem('key')

// Clear current user's data (automatically called on logout)
userStorage.clearCurrentUser()
```

## Migration Status

### ✅ Migrated Services
- **Auth Store** - Sets/clears user storage on login/logout
- **UserDataService** - User status and custom status
- **StatePersistence** - App state persistence
- **useVisualTheme** - Theme settings

### ⚠️ Services Still Using Direct localStorage
These services still use direct `localStorage` and should be migrated:
- `VoiceSettingsService.ts` - Voice settings
- `unifiedWebRTC.ts` - Stream quality settings
- `unifiedVoiceChannel.ts` - Voice session state, user volumes
- `livekitWebRTC.ts` - Stream settings
- `LoggingService.ts` - Logging config
- `unifiedEmojiService.ts` - Emoji pack preferences
- `useKeybinds.ts` - Keybind settings
- `useFrequentEmojis.ts` - Frequent emoji cache
- `useMessageSearch.ts` - Search history
- `useHapticSettings.ts` - Haptic feedback settings
- `EncryptionKeyStore.ts` - Encryption keys (CRITICAL - should be user-scoped)
- `MegolmMessageEncryptionService.ts` - Encryption state
- `AudioThemeService.ts` - Audio theme settings

## Migration Guide

To migrate a service:

1. **Import userStorage**:
   ```typescript
   import { userStorage } from '@/utils/userScopedStorage'
   ```

2. **Replace localStorage calls**:
   ```typescript
   // Before
   localStorage.setItem('harmony-key', value)
   const data = localStorage.getItem('harmony-key')
   localStorage.removeItem('harmony-key')
   
   // After
   userStorage.setItem('key', value)  // Note: remove 'harmony-' prefix
   const data = userStorage.getItem('key')
   userStorage.removeItem('key')
   ```

3. **Update key names**: Remove the `harmony-` prefix since `userStorage` adds it automatically

## Backwards Compatibility

The `userStorage` service maintains backwards compatibility:
- If no user is set, it uses global keys (with `harmony-` prefix)
- This allows gradual migration without breaking existing functionality

## Security Notes

- **Encryption keys MUST be user-scoped** - Currently `EncryptionKeyStore.ts` uses direct localStorage
- **User volumes and preferences** should be user-scoped for privacy
- **Search history** should be user-scoped

## Testing

To test user-scoped storage:
1. Log in as User A, set some preferences
2. Log out
3. Log in as User B
4. Verify User B doesn't see User A's data
5. Log out and log back in as User A
6. Verify User A's data is restored

