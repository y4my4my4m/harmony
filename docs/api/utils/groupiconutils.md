# groupIconUtils Utility

**File:** `src/utils/groupIconUtils.ts`

## Overview

```mermaid
graph TB
    subgraph "groupIconUtils Utility"
        GETGROUPICONURL[getGroupIconUrl]
        GETDEFAULTGROUPICON[getDefaultGroupIcon]
        UPLOADGROUPICON[uploadGroupIcon]
        DELETEGROUPICON[deleteGroupIcon]
        GROUPICONPRESETS[GroupIconPresets]
    end
    
    subgraph "Functions"
        FN_GETGROUPICONURL[getGroupIconUrl]
        FN_GETDEFAULTGROUPICON[getDefaultGroupIcon]
        FN_DELETEGROUPICON[deleteGroupIcon]
    end
```


## Exports

- **getGroupIconUrl** - function export
- **getDefaultGroupIcon** - function export
- **uploadGroupIcon** - function export
- **deleteGroupIcon** - function export
- **GroupIconPresets** - const export

## Functions

### `getGroupIconUrl(conversationId: string, iconPath: string | null | undefined, options: {
    size?: number
    quality?: number
  } = {})`

No description available.

**Parameters:**
- `conversationId: string`
- `iconPath: string | null | undefined`
- `options: {
    size?: number
    quality?: number
  } = {}`

**Returns:** `string`

```typescript
/**
 * Group Icon Utilities
 * 
 * Follows the same pattern as server icons:
 * - Store relative path in database
 * - Fetch from bucket with transforms for optimization
 * - Support resizing and quality optimization
 */

const BUCKET_NAME = 'group-icons'
const DEFAULT_QUALITY = 80
const DEFAULT_SIZE = 128

/**
 * Get the full URL for a group icon with optional transformations
 */
export function getGroupIconUrl(
  conversationId: string,
  iconPath: string | null | undefined,
  options: {
    size?: number
    quality?: number
  } = {}
): string
```

### `getDefaultGroupIcon(conversationId: string, size: number = DEFAULT_SIZE)`

No description available.

**Parameters:**
- `conversationId: string`
- `size: number = DEFAULT_SIZE`

**Returns:** `string`

```typescript
/**
 * Generate a default group icon (similar to Discord's algorithm)
 */
export function getDefaultGroupIcon(conversationId: string, size: number = DEFAULT_SIZE): string
```

### `deleteGroupIcon(conversationId: string)`

No description available.

**Parameters:**
- `conversationId: string`

**Returns:** `Promise&lt;`

```typescript
/**
 * Upload a group icon file
 */
export async function uploadGroupIcon(
  conversationId: string,
  file: File,
  onProgress?: (progress: number) => void
): Promise<{ success: boolean; iconPath?: string; error?: string }> {
  try {
    // Validate file
    if (!file.type.startsWith('image/')) {
      return { success: false, error: 'File must be an image' }
    }

    // Check file size (max 5MB)
    const maxSize = 5 * 1024 * 1024
    if (file.size > maxSize) {
      return { success: false, error: 'File size must be less than 5MB' }
    }

    // Generate unique filename
    const fileExt = file.name.split('.').pop()
    const fileName = `${Date.now()}-${Math.random().toString(36).substring(2)}.${fileExt}`
    const filePath = `${conversationId}/${fileName}`

    // Upload to storage
    const { data, error: uploadError } = await supabase.storage
      .from(BUCKET_NAME)
      .upload(filePath, file, {
        cacheControl: '3600',
        upsert: true // Allow overwriting existing group icons
      })

    if (uploadError) {
      debug.error('Upload error:', uploadError)
      return { success: false, error: uploadError.message }
    }

    // Get current user profile ID
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      throw new Error('User not authenticated')
    }

    // Get profile ID from auth user
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('id')
      .eq('auth_user_id', user.id)
      .single()

    if (profileError || !profile) {
      throw new Error('User profile not found')
    }

    // Update conversation metadata with new icon path
    const { data: updateResult, error: updateError } = await supabase.rpc('update_group_icon', {
      conversation_uuid: conversationId,
      user_profile_id: profile.id,
      icon_path: filePath
    })

    if (updateError) {
      debug.error('Database update error:', updateError)
      // Clean up uploaded file if database update fails
      await supabase.storage.from(BUCKET_NAME).remove([filePath])
      return { success: false, error: 'Failed to update group settings' }
    }

    return { success: true, iconPath: filePath }

  } catch (error: any) {
    debug.error('Group icon upload failed:', error)
    return { success: false, error: error.message || 'Upload failed' }
  }
}

/**
 * Delete a group icon
 */
export async function deleteGroupIcon(conversationId: string): Promise<
```








## Constants

### BUCKET_NAME

No description available.

```typescript
const BUCKET_NAME = 'group-icons'
```

### DEFAULT_QUALITY

No description available.

```typescript
const DEFAULT_QUALITY = 80
```

### DEFAULT_SIZE

No description available.

```typescript
const DEFAULT_SIZE = 128
```




## Source Code Insights

**File Size:** 8185 characters
**Lines of Code:** 257
**Imports:** 2

## Usage Example

```typescript
import { getGroupIconUrl, getDefaultGroupIcon, uploadGroupIcon, deleteGroupIcon, GroupIconPresets } from '@/utils/groupIconUtils'

// Example usage
getGroupIconUrl()
```

---

*This documentation was automatically generated from the source code.*