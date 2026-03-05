# ProfileService Service

**File:** `src/services/ProfileService.ts`

## Overview

```mermaid
graph TB
    subgraph "ProfileService Service"
        PROFILEDATA[ProfileData]
        PROFILESERVICEERROR[ProfileServiceError]
        PROFILESERVICE[ProfileService]
        PROFILESERVICE[profileService]
        UPDATEUSERSTATUS[updateUserStatus]
        GETPROFILE[getProfile]
        GETPROFILEWITHAVATARURL[getProfileWithAvatarUrl]
        GETPROFILEBYAUTHUSERID[getProfileByAuthUserId]
        UPDATEPROFILE[updateProfile]
        UPLOADAVATAR[uploadAvatar]
        UPLOADBANNER[uploadBanner]
    end
    
    subgraph "Functions"
        FN_FETCHPROMISE[fetchPromise]
    end
    
    subgraph "Interfaces"
        INT_PROFILEDATA[ProfileData]
        INT_PROFILESERVICEERROR[ProfileServiceError]
    end
    
    subgraph "Classes"
        CLS_PROFILESERVICE[ProfileService]
    end
```


## Exports

- **ProfileData** - interface export
- **ProfileServiceError** - interface export
- **ProfileService** - class export
- **profileService** - const export
- **updateUserStatus** - const export
- **getProfile** - const export
- **getProfileWithAvatarUrl** - const export
- **getProfileByAuthUserId** - const export
- **updateProfile** - const export
- **uploadAvatar** - const export
- **uploadBanner** - const export

## Functions

### `fetchPromise(async ()`

No description available.

**Parameters:**
- `async (`

**Returns:** `Unknown`

```typescript
const fetchPromise = (async () =>
```


## Classes

### ProfileService

No description available.

**Methods:**
- `getInstance`
- `getCurrentProfile`
- `catch`
- `updateCurrentProfile`
- `createProfile`
- `getProfileById`
- `getProfileByUsername`
- `searchProfiles`
- `checkUsernameAvailability`
- `createError`
- `updateUserStatus`
- `fetchProfile`
- `fetchProfileByAuthUserId`
- `updateProfile`
- `isProfileComplete`
- `getProfileWithAvatarUrl`
- `uploadAvatar`
- `uploadBanner`

**Properties:**
- `instance`
- `deduplication`
- `pendingFetches`
- `Cache`
- `cache`
- `timestamp`
- `CACHE_TTL`
- `profile`
- `lookup`
- `context`
- `data`
- `error`
- `automatically`
- `auth_user_id`
- `userDataService`
- `ID`
- `username`
- `domain`
- `query`
- `profiles`
- `options`
- `limit`
- `offset`
- `includeFederated`
- `hasMore`
- `total`
- `searchQuery`
- `count`
- `availability`
- `available`
- `reason`
- `message`
- `code`
- `details`
- `status`
- `supabase`
- `caching`
- `useCache`
- `first`
- `cached`
- `ProfileService`
- `pending`
- `promise`
- `fetchPromise`
- `result`
- `fetch`
- `null`
- `userId`
- `url`
- `imports`
- `URL`
- `avatar_url`
- `success`
- `avatar`
- `banner_url`
- `banner`


## Interfaces

### ProfileData

No description available.

```typescript
interface ProfileData {

  username?: string
  display_name?: string
  avatar_url?: string
  banner_url?: string
  bio?: string
  color?: string

}
```

### ProfileServiceError

No description available.

```typescript
interface ProfileServiceError {

  code: string
  message: string
  details?: any

}
```








## Source Code Insights

**File Size:** 13318 characters
**Lines of Code:** 462
**Imports:** 5

## Usage Example

```typescript
import { ProfileData, ProfileServiceError, ProfileService, profileService, updateUserStatus, getProfile, getProfileWithAvatarUrl, getProfileByAuthUserId, updateProfile, uploadAvatar, uploadBanner } from '@/services/ProfileService'

// Example usage
fetchPromise()
```

---

*This documentation was automatically generated from the source code.*