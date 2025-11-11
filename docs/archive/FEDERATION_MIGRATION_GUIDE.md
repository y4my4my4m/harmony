# Migration Guide: Frontend to Database-Driven Federation

## 🎯 Migration Overview

This guide helps you migrate from the current frontend-triggered federation approach to a professional database-driven federation system.

## 📋 Pre-Migration Checklist

### 1. Backup Current Implementation
```bash
# Create backup branch
git checkout -b backup/frontend-federation
git commit -am "Backup: Frontend-triggered federation implementation"

# Return to main branch for migration
git checkout main
```

### 2. Verify Current State
```bash
# Check that current reactions work
npm run test # or your test command

# Verify edge functions are working
curl -X GET "https://your-instance.com/users/test/outbox"
```

### 3. Database Prerequisites
- Ensure you have access to modify database functions
- Verify `ap_activities` table exists and is used by edge functions
- Confirm `post_interactions` table has the expected structure

## 🗃️ Phase 1: Database Migration

### 1.1 Install New Database Functions

```sql
-- Execute the professional federation functions
\i db_schema/professional_federation_functions.sql
```

### 1.2 Test Database Functions

```sql
-- Test federation decision logic
SELECT should_federate_post_reaction(
  'some-post-uuid'::uuid, 
  'some-user-uuid'::uuid
);

-- Test the complete system with test data
SELECT test_federation_system();

-- Verify federation health view
SELECT * FROM federation_health;
```

### 1.3 Verify Edge Function Compatibility

The new database functions create activities in the same `ap_activities` table format, so your existing edge functions should work unchanged:

```sql
-- Check that activities are still created in the expected format
SELECT ap_id, ap_type, activity_data 
FROM ap_activities 
WHERE created_at > NOW() - INTERVAL '1 hour'
LIMIT 5;
```

## 🔄 Phase 2: Frontend Migration

### 2.1 Create New Store File

```bash
# Copy the professional implementation
cp src/stores/postReactions_professional.ts src/stores/postReactions_new.ts
```

### 2.2 Update Imports Gradually

**Option A: Gradual Migration** (Recommended)
```typescript
// In components that use reactions, temporarily import both:
import { usePostReactionsStore } from '@/stores/postReactions' // Old
import { usePostReactionsStore as useNewPostReactionsStore } from '@/stores/postReactions_new' // New

// Test the new store in specific components first
const postReactions = useNewPostReactionsStore()
```

**Option B: Direct Replacement** (Faster but riskier)
```bash
# Replace the old file directly
mv src/stores/postReactions.ts src/stores/postReactions_old.ts
mv src/stores/postReactions_professional.ts src/stores/postReactions.ts
```

### 2.3 Remove Federation Service Imports

Look for and remove these imports in your components:

```typescript
// ❌ Remove these imports
import { FederationActivityService } from '@/services/federation/FederationActivityService'
import { federationActivityService } from '@/services/federation'

// ❌ Remove federation trigger code like this:
try {
  const federationService = FederationActivityService.getInstance()
  await federationService.createPostReactionActivity(...)
} catch (federationError) {
  // ...
}
```

### 2.4 Update Function Calls

The professional version has the same API, so most calls don't need changes:

```typescript
// ✅ This stays the same
await postReactions.toggleReaction(postId, emoji, userId)

// ✅ This stays the same  
await postReactions.fetchPostReactions(postId)

// ✅ This stays the same
const reactions = postReactions.getPostReactions(postId)
```

## 🧪 Phase 3: Testing & Validation

### 3.1 Test Basic Functionality

```typescript
// Test that reactions still work locally
const result = await postReactions.toggleReaction(
  'test-post-id',
  { native: '👍', name: 'thumbs_up' },
  'test-user-id'
)
console.log('Reaction toggle result:', result)
```

### 3.2 Verify Federation Activities

```sql
-- Check that federation activities are still being created
SELECT COUNT(*) as recent_activities
FROM ap_activities 
WHERE created_at > NOW() - INTERVAL '1 hour';

-- Check activity format
SELECT ap_type, activity_data->'type' as activity_type, activity_data->'content' as emoji
FROM ap_activities 
WHERE ap_type IN ('Like', 'Undo')
ORDER BY created_at DESC 
LIMIT 10;
```

### 3.3 Test Real-time Updates

1. Open two browser windows with the same post
2. Add a reaction in one window
3. Verify it appears in real-time in the other window
4. Check that optimistic updates still work (instant feedback)

### 3.4 Test Federation Delivery

```bash
# Check that edge functions are processing the new activities
curl -X POST "https://your-instance.com/functions/v1/outbox/delivery" \
  -H "Authorization: Bearer YOUR_SERVICE_KEY"
```

## 🔍 Phase 4: Monitoring & Cleanup

### 4.1 Monitor Federation Health

```sql
-- Check federation health regularly
SELECT * FROM federation_health;

-- Monitor for failed activities
SELECT ap_id, activity_data->'type', status, updated_at
FROM ap_activities 
WHERE status = 'failed'
ORDER BY updated_at DESC;
```

### 4.2 Performance Monitoring

```typescript
// Add performance logging to verify improvements
console.time('reaction-toggle')
await postReactions.toggleReaction(postId, emoji, userId)
console.timeEnd('reaction-toggle')

// Monitor batch fetch performance
console.time('batch-fetch')
await postReactions.fetchMultiplePostReactions(postIds)
console.timeEnd('batch-fetch')
```

### 4.3 Clean Up Old Code

After successful migration:

```bash
# Remove old files
rm src/stores/postReactions_old.ts
rm src/stores/postReactions_new.ts

# Remove unused federation service code (if not used elsewhere)
# Check usage first:
grep -r "FederationActivityService" src/
grep -r "createPostReactionActivity" src/

# If only used for reactions, these can be removed:
rm src/services/federation/FederationActivityService.ts
# Update src/services/federation/index.ts to remove the exports
```

## 🚨 Troubleshooting

### Common Issues

#### 1. Database Function Errors
```sql
-- Check function exists
SELECT proname FROM pg_proc WHERE proname LIKE '%post_emoji_reaction%';

-- Check permissions
GRANT EXECUTE ON FUNCTION add_post_emoji_reaction TO authenticated;
GRANT EXECUTE ON FUNCTION remove_post_emoji_reaction TO authenticated;
```

#### 2. Federation Activities Not Created
```sql
-- Check federation decision logic
SELECT should_federate_post_reaction('your-post-id'::uuid, 'your-user-id'::uuid);

-- Check instance federation settings
SELECT * FROM instance_config WHERE config_key = 'federation';

-- Check user federation settings
SELECT id, username, metadata->'federation_enabled' as federation_enabled 
FROM profiles WHERE id = 'your-user-id'::uuid;
```

#### 3. Real-time Updates Broken
```typescript
// Verify real-time subscription is still working
const subscription = supabase
  .channel('post_interactions')
  .on('postgres_changes', 
    { event: '*', schema: 'public', table: 'post_interactions' },
    postReactions.handleRealtimeReactionUpdate
  )
  .subscribe()

console.log('Subscription state:', subscription.state)
```

#### 4. Edge Functions Not Processing Activities
```sql
-- Check activity format matches expected schema
SELECT ap_id, ap_type, status, activity_data 
FROM ap_activities 
WHERE status = 'pending'
LIMIT 5;
```

### Rollback Plan

If issues occur, you can quickly rollback:

```bash
# Rollback to backup branch
git checkout backup/frontend-federation

# Or restore old store file
mv src/stores/postReactions_old.ts src/stores/postReactions.ts
```

### Database Rollback

```sql
-- Disable new functions (rename them)
ALTER FUNCTION add_post_emoji_reaction RENAME TO add_post_emoji_reaction_new;
ALTER FUNCTION remove_post_emoji_reaction RENAME TO remove_post_emoji_reaction_new;

-- Restore old functions if you have backups
-- \i db_schema/old_functions_backup.sql
```

## 📊 Success Metrics

After migration, you should see:

1. **Simplified Frontend Code**
   - ✅ No federation imports in reaction components
   - ✅ Cleaner error handling
   - ✅ Fewer network calls per reaction

2. **Improved Reliability**
   - ✅ Atomic operations (local + federation succeed/fail together)
   - ✅ No partial state inconsistencies
   - ✅ Better error recovery

3. **Better Performance**
   - ✅ Single database call instead of local + federation
   - ✅ Reduced frontend complexity
   - ✅ Database-level optimization

4. **Professional Architecture**
   - ✅ Business logic (federation) in database layer
   - ✅ Presentation logic (UI) in frontend layer
   - ✅ Clear separation of concerns

5. **Federation Health**
   - ✅ Activities still created in `ap_activities`
   - ✅ Edge functions processing activities
   - ✅ Misskey/Pleroma compatibility maintained
   - ✅ Real-time updates working

## 🎉 Post-Migration Benefits

### For Developers
- Cleaner, more maintainable frontend code
- Fewer integration points to manage
- Easier debugging (federation errors in database logs)
- Professional architecture patterns

### For Users
- More reliable reactions (atomic operations)
- Faster reaction responses (fewer network calls)
- Better consistency across federation
- Improved real-time experience

### For Operations
- Centralized federation monitoring
- Database-level federation metrics
- Easier troubleshooting and maintenance
- Better performance under load

This migration transforms your reaction system from a prototype-level implementation to an enterprise-grade, production-ready architecture! 🚀
