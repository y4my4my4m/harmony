# Voice System User Data Integration Fix

## Issue
The voice overlay dock and spatial audio grid were not properly displaying user icons/names because they were using the old `serverUsersStore.userProfiles` instead of our unified `userDataService` single source of truth.

## Root Cause
1. **Voice Store**: `unifiedVoiceChannel.ts` was using `serverUsersStore.userProfiles[userId]` in its `getUserProfile()` method
2. **No Profile Loading**: Voice components weren't calling `ensureProfilesAvailable()` to load user data through the unified system
3. **Inconsistent Data Source**: While `UnifiedVoiceDock` was correctly using `useUserData()`, the overlay and spatial panel were relying on the voice store's broken profile method

## Fixes Applied

### 1. Updated Voice Store (`src/stores/unifiedVoiceChannel.ts`)

**Before:**
```typescript
getUserProfile(userId: string) {
  const serverUsersStore = useServerUsersStore();
  return serverUsersStore.userProfiles[userId] || {
    id: userId,
    username: 'Unknown User',
    display_name: 'Unknown User',
    avatar_url: null
  };
}
```

**After:**
```typescript
getUserProfile(userId: string) {
  const { getUserProfile } = useUserData();
  const profile = getUserProfile(userId).value;
  
  return profile || {
    id: userId,
    username: 'Unknown User',
    display_name: 'Unknown User',
    avatar_url: null
  };
}
```

### 2. Added Profile Loading on User Events

**User Joined Event:**
```typescript
unifiedWebRTC.on('user-joined', async (data) => {
  // ...existing code...
  
  // Ensure user profile data is loaded through unified system
  const { ensureProfilesAvailable } = useUserData();
  try {
    await ensureProfilesAvailable([data.userId]);
    console.log('✅ Loaded profile for voice user:', data.userId);
  } catch (error) {
    console.warn('⚠️ Failed to load profile for voice user:', data.userId, error);
  }
  
  // ...existing code...
});
```

**Channel State Synced Event:**
```typescript
unifiedWebRTC.on('channel-state-synced', async (data) => {
  // ...existing code...
  
  // Ensure all users' profile data is loaded through unified system
  const { ensureProfilesAvailable } = useUserData();
  const userIds = data.users.map((user: any) => user.userId);
  if (userIds.length > 0) {
    try {
      await ensureProfilesAvailable(userIds);
      console.log('✅ Loaded profiles for all voice users:', userIds.length);
    } catch (error) {
      console.warn('⚠️ Failed to load profiles for voice users:', error);
    }
  }
});
```

### 3. Updated Spatial Audio Panel (`src/components/voice/SpatialAudioPanel.vue`)

**Added Direct Integration:**
```typescript
import { useUserData } from '@/composables/useUserData';

const { getUserProfile: getUnifiedUserProfile, ensureProfilesAvailable } = useUserData();

const getUserProfile = (userId: string) => {
  const profile = getUnifiedUserProfile(userId).value;
  return profile || {
    id: userId,
    username: 'Unknown User',
    display_name: 'Unknown User',
    avatar_url: null
  };
};

// Ensure all participant profiles are loaded when participants change
watch(allParticipants, async (newParticipants) => {
  const userIds = newParticipants.map(p => p.userId);
  if (userIds.length > 0) {
    try {
      await ensureProfilesAvailable(userIds);
      console.log('✅ Loaded profiles for spatial audio participants:', userIds.length);
    } catch (error) {
      console.warn('⚠️ Failed to load profiles for spatial audio participants:', error);
    }
  }
}, { immediate: true });
```

## Files Modified

1. **`src/stores/unifiedVoiceChannel.ts`**
   - ✅ Added `useUserData` import
   - ✅ Updated `getUserProfile()` to use unified system
   - ✅ Added profile loading on `user-joined` events
   - ✅ Added profile loading on `channel-state-synced` events

2. **`src/components/voice/SpatialAudioPanel.vue`**
   - ✅ Added `useUserData` import
   - ✅ Updated `getUserProfile()` to use unified system directly
   - ✅ Added watcher to load profiles when participants change

3. **`src/components/voice/UnifiedVoiceDock.vue`** ✅ Already correct
   - Was already using `useUserData()` properly

## Result

Now all voice components use the same unified user data source:

1. **Voice Overlay**: Uses `voiceStore.getUserProfile()` → **Now uses unified system** ✅
2. **Spatial Grid**: Uses direct `getUserProfile()` → **Now uses unified system** ✅  
3. **Voice Dock**: Uses `useUserData()` directly → **Already correct** ✅

**User icons and names should now display correctly in:**
- ✅ Voice overlay grid view
- ✅ Voice overlay speaker view  
- ✅ Spatial audio positioning grid
- ✅ Voice dock (was already working)

The fix ensures that when users join voice channels, their profile data (avatar, display name, etc.) is automatically loaded through the unified `userDataService` and displayed consistently across all voice components.
