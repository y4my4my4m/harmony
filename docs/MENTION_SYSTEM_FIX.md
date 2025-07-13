# User Mentions Fix Summary

## Issues Fixed

### 1. **Updated Mention Regex Pattern**
- **Before**: Only matched `@username@domain` format: `/(@\w+@\w+\S+)/g`
- **After**: Matches both `@username` and `@username@domain`: `/@([a-zA-Z0-9_]+)(?:@([a-zA-Z0-9.-]+))?/g`

### 2. **Enhanced Username-to-UserId Mapping**
- **Updated**: `useServerUsers.ts` - `usernameToUserIdMap` getter
- **Added**: Support for both local username lookup and full handle lookup
- **Local users**: Mapped by just `username`
- **Remote users**: Mapped by both `username` and `username@domain`

### 3. **Improved Mention Parsing Logic**
- **Updated files**: 
  - `src/utils/messageParser.ts`
  - `src/components/ChatComponent.vue`
  - `src/components/MessageDisplay.vue`
- **Added**: Logic to handle both local and remote mention formats
- **Logic**: 
  - Local users displayed as `@username`
  - Remote users displayed as `@username@domain`
  - Proper user ID lookup for both formats

### 4. **Updated AutoSuggest System**
- **Enhanced**: `src/composables/useAutoSuggest.ts`
- **Added**: Domain-aware mention insertion
- **Logic**: Automatically formats mentions based on user's domain
  - Local users (domain: `har.mony.lol`) → `@username`
  - Remote users → `@username@domain`

### 5. **Updated ActivityPub Content Formatting**
- **Enhanced**: `src/components/activitypub/MonyContent.vue`
- **Added**: Proper display formatting for mentions
- **Logic**: Same as chat - local users as `@username`, remote as `@username@domain`

## Expected Behavior

### Local Users
- **Display**: `@y4my4m`
- **Clickable**: ✅ Opens profile modal
- **Auto-suggest**: Works with `@y` → suggests local users

### Remote Users  
- **Display**: `@bobby@mastodon.social`
- **Clickable**: ✅ Opens profile modal
- **Auto-suggest**: Works with `@bob` → suggests both local and remote users

## Database Schema
- Users are stored with separate `username` and `domain` fields
- Local users have domain `har.mony.lol`
- Remote users have their actual domain (e.g., `mastodon.social`)

## Components Updated
1. `src/utils/messageParser.ts` - Core mention parsing
2. `src/stores/useServerUsers.ts` - Username mapping
3. `src/components/ChatComponent.vue` - Chat mention parsing
4. `src/components/MessageDisplay.vue` - Message edit mention parsing
5. `src/composables/useAutoSuggest.ts` - Auto-suggest mention insertion
6. `src/components/activitypub/MonyContent.vue` - ActivityPub content formatting

## Features Working
- ✅ Mention parsing and display
- ✅ Click to open profile modal (already implemented)
- ✅ Auto-suggest for both local and remote users
- ✅ Proper visual distinction between local and remote users
- ✅ Database compatibility with separated username/domain structure
