# Mention System Fix - Database-Driven Implementation

## Overview
Fixed the user mention system to use the `is_local` column from the profiles table instead of hardcoding domain checks. This makes the system database-driven, flexible, and maintainable.

## Changes Made

### 1. Database-Driven Approach
- Replaced hardcoded `'har.mony.lol'` domain checks with `is_local` field from user profiles
- Local users display as `@username` regardless of their actual domain
- Remote users display as `@username@domain` when `is_local` is false

### 2. Core Files Updated

#### `src/stores/useServerUsers.ts`
- Updated `usernameToUserIdMap` getter to use `is_local` field
- Local users: only map `username` → `userId`
- Remote users: map both `username` → `userId` and `username@domain` → `userId`

#### `src/components/ChatComponent.vue`
- Updated mention parsing logic to check user's `is_local` field
- Display format determined by database field, not hardcoded domain

#### `src/components/MessageDisplay.vue`  
- Updated mention display logic to use `is_local` field
- Consistent display format based on user's database profile

#### `src/composables/useAutoSuggest.ts`
- Updated auto-suggest insertion to use `is_local` field instead of `isLocal`
- Updated suggestion display to use `is_local` for determining mention format
- Removed hardcoded domain defaults in ActivityPub user search

#### `src/components/activitypub/MonyComposerInline.vue`
- Updated mention text generation to use `is_local` field

#### `src/components/activitypub/MonyContent.vue`
- Added TODO comment to enhance with database-driven approach
- Current implementation handles basic mention formatting

### 3. Expected Behavior

#### Local Users (`is_local: true`)
- Display: `@username`
- Can be mentioned with just `@username`
- Lookup works with username key

#### Remote Users (`is_local: false`)
- Display: `@username@domain`  
- Can be mentioned with `@username@domain`
- Lookup works with full handle key

### 4. Benefits
- **Database-driven**: No hardcoded domain assumptions
- **Flexible**: Works with any domain configuration
- **Maintainable**: Changes to local/remote status handled in database
- **Consistent**: Single source of truth for user locality

### 5. Regex Pattern (Unchanged)
```regex
/@([a-zA-Z0-9_]+)(?:@([a-zA-Z0-9.-]+))?/g
```
Still supports both formats but display is now determined by database.

### 6. Testing Checklist
- [ ] Local user mentions display as `@username`
- [ ] Remote user mentions display as `@username@domain`
- [ ] Auto-suggest works for both local and remote users
- [ ] Mention clicking opens correct profile modal
- [ ] Username mapping works for both formats
- [ ] Database `is_local` field correctly determines display format

### 7. Database Schema Dependency
Requires `profiles` table to have:
- `is_local` boolean column
- `domain` string column (for remote users)
- `username` string column

This implementation is now properly database-driven and follows the existing schema design.
