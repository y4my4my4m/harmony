# Post Functionality Investigation Report

**Date**: July 23, 2025  
**Issue**: Posts stop working after database and frontend refactor, despite DMs working correctly

## Summary

After investigating the codebase following a refactor that enabled federated DMs, the post creation functionality has stopped working. This document outlines the findings and potential root causes.

## Architecture Overview

### Post Creation Flow
1. **Frontend Components** → `MonyComposerInline.vue`, `PostsContainer.vue`, `MonyPost.vue`
2. **State Management** → `useActivityPubStore` (Pinia store)
3. **Service Layer** → Multiple service layers handle posts:
   - `PostService.ts` - Simplified service that trusts database triggers
   - `CorePostService.ts` - Pure local database operations  
   - `activityPubService.ts` - ActivityPub operations with federation
   - `FederationActivityService.ts` - ActivityPub activity creation

### Database Layer
- **Table**: `posts` table with proper JSONB content structure
- **Triggers**: Multiple triggers handle post federation and processing:
  - `trg_handle_post_federation` - Handles outgoing post federation
  - `create_comprehensive_timeline_entries_trigger` - Adds posts to timelines
  - `trigger_validate_post_content_format` - Validates content format
  - `trigger_update_post_counters` - Updates user post counts

## Investigation Findings

### 1. Service Architecture

The post creation follows this simplified pattern:
```typescript
// Frontend calls
services.posts.createPost(data)
  ↓
// PostService.ts (simplified)
corePostService.createPost(data)
  ↓
// CorePostService.ts (pure local)
supabase.from('posts').insert(postData)
  ↓
// Database triggers handle federation automatically
```

✅ **Status**: Service exports verified in `src/services/index.ts`
```typescript
export const services = {
  posts: postService,
  messages: messageService,
  interactions: interactionService,
  profiles: profileService,
  notifications: notificationService,
  activityPub: activityPubService
}
```

### 2. Database Schema

The `posts` table structure appears correct:
```sql
CREATE TABLE public.posts (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    content jsonb NOT NULL,
    author_id uuid NOT NULL,
    visibility text DEFAULT 'public'::text,
    is_local boolean DEFAULT true,
    is_federated boolean DEFAULT true,
    -- ... other fields
    CONSTRAINT posts_content_is_array CHECK ((jsonb_typeof(content) = 'array'::text)),
    CONSTRAINT posts_content_not_empty CHECK (((jsonb_array_length(content) > 0) OR (reblog IS NOT NULL)))
);
```

### 3. Environment and Connectivity Issues

**Primary Issue Identified**: Database connectivity failure
- Test script fails with "TypeError: fetch failed"
- Missing environment variables for Supabase connection
- `.env` file missing (only `.env.example` exists)

**Required Environment Variables** (from `.env.example`):
```env
# Supabase Configuration
VITE_SUPABASE_URL=your-supabase-url
VITE_SUPABASE_ANON_KEY=your-supabase-anon-key

# Instance Configuration  
VITE_DOMAIN=har.mony.lol
VITE_INSTANCE_NAME=Harmony
VITE_INSTANCE_DESCRIPTION=A federated social platform

# Development
VITE_NODE_ENV=development
VITE_FEDERATION_ENABLED=true

# Optional - Edge Function Configuration
VITE_SUPABASE_FUNCTIONS_URL=your-edge-functions-url
```

### 4. Error Patterns

Console errors found in the codebase suggest various failure points:
- `❌ Core: Failed to create post:` (CorePostService.ts:110)
- `❌ Simplified: Failed to create post:` (PostService.ts:70)
- `Failed to create post:` (MonyComposerInline.vue:550)

### 5. Working vs Broken Features

**Working**: DMs (Direct Messages)
- Uses same database structure (JSONB content)
- Uses same trigger patterns
- Federation working properly

**Broken**: Posts
- Same database patterns but failing
- Suggests issue is not with database schema
- Likely configuration or service layer issue

## Potential Root Causes

### 1. **Environment Configuration** (Most Likely)
```bash
# Missing environment variables
VITE_SUPABASE_URL=
VITE_SUPABASE_ANON_KEY=
VITE_DOMAIN=
```

### 2. **Database Trigger Issues**
- Post federation trigger may be failing
- Content validation trigger may be rejecting content
- Timeline trigger may be causing conflicts

### 3. **Service Layer Configuration**
- PostService not properly exported in services/index.ts ✅ **VERIFIED: Working**
- ActivityPubService domain configuration issues
- CorePostService authentication context failures

### 4. **Content Format Issues**
- Post content validation failing
- MessagePart[] array structure mismatch
- JSONB serialization problems

### 5. **RLS (Row Level Security) Issues**
- User authentication not working for posts table
- Profile resolution failing
- Authorization context missing

## Recommended Investigation Steps

### 1. **Environment Setup** (Priority 1)
```bash
# Copy environment example
cp .env.example .env

# Configure with proper Supabase credentials
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=your-anon-key
VITE_DOMAIN=har.mony.lol
VITE_INSTANCE_NAME=Harmony
VITE_FEDERATION_ENABLED=true
```

### 2. **Database Connection Test** (Priority 1)
```javascript
// Test basic connectivity
const { data, error } = await supabase.from('posts').select('id').limit(1)
console.log('Connection test:', { data, error })
```

### 3. **Post Creation Debug** (Priority 2)
```javascript
// Add detailed logging to CorePostService.createPost()
console.log('Creating post with data:', data)
console.log('User authentication:', user)
console.log('Profile ID:', profileId)
console.log('Post data:', postData)
```

### 4. **Database Trigger Analysis** (Priority 2)
```sql
-- Check if triggers are firing
SELECT * FROM ap_activities WHERE ap_type = 'Create' ORDER BY created_at DESC LIMIT 5;
SELECT * FROM timeline_entries ORDER BY "position" DESC LIMIT 5;
```

### 5. **Service Export Verification** (Priority 3) ✅ **COMPLETED**
```typescript
// Verify services.posts is properly exported
import { services } from '@/services'
console.log('PostService available:', !!services.posts)
```

## Next Steps

1. **Set up environment variables** - Copy `.env.example` to `.env` and configure
2. **Test database connectivity** - Run basic Supabase queries
3. **Enable detailed logging** - Add console.log statements to trace execution
4. **Test minimal post creation** - Try creating a simple post with minimal data
5. **Check database triggers** - Verify triggers are executing properly

## Impact Assessment

- **Critical**: Post creation is core functionality
- **User Experience**: Severely degraded social features
- **Federation**: May affect outgoing ActivityPub posts
- **Timeline**: Users cannot see or create content

## Technical Debt Noted

- **Complex Service Architecture**: 4 different services handling posts
- **Trigger Complexity**: 147 functions and 32 triggers in database
- **Environment Dependencies**: Missing `.env` file causes silent failures
- **Error Handling**: Inconsistent error reporting across services

## Key Finding

**The most likely root cause is missing environment configuration**. The post functionality architecture is sound (evidenced by working DMs using the same patterns), but the application cannot connect to the database due to missing Supabase credentials.

---

*This investigation reveals that the post functionality architecture is sound, but environmental configuration issues are likely preventing proper execution. The working DM system proves the underlying patterns are correct.*