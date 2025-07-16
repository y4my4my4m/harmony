# ActivityPub Migration Split - Deployment Guide

## Overview

The large unified ActivityPub processing migration has been split into two maintainable parts for better organization and easier deployment.

## Migration Files

### Part 1: `unified_activitypub_processing_trigger_part1.sql`
**Core trigger and processor functions**

Contains:
- Main trigger function `handle_activitypub_activity_processing()`
- Core activity processors:
  - `process_follow_activity()` - Follow requests
  - `process_accept_activity()` - Follow accepts
  - `process_reject_activity()` - Follow rejects  
  - `process_undo_activity()` - Unfollows, unlikes
  - `process_update_activity()` - Profile/post updates
  - `process_delete_activity()` - Post deletions
  - `process_like_activity()` - Likes/favorites
  - `process_announce_activity()` - Boosts/reblogs
- Helper functions:
  - `extract_activitypub_mentions()`
  - `create_simple_activitypub_notification()`
  - `parse_activitypub_content_to_jsonb()`

### Part 2: `unified_activitypub_processing_trigger_part2.sql`
**DM/post processors, retry system, and final setup**

Contains:
- Content processors:
  - `process_activitypub_direct_message()` - DM handling
  - `process_activitypub_public_post()` - Public post creation
  - `process_create_activity()` - Create activity dispatcher
  - `is_activitypub_direct_message()` - DM detection
- Retry system:
  - `process_failed_activities_retry()` - Retry processor function
- Final setup:
  - Trigger creation
  - Grants and permissions
  - Completion logging

## Deployment Order

**CRITICAL**: Deploy in exact order:

1. **First**: Deploy Part 1
   ```sql
   -- Run unified_activitypub_processing_trigger_part1.sql
   ```

2. **Second**: Deploy Part 2
   ```sql
   -- Run unified_activitypub_processing_trigger_part2.sql
   ```

3. **Third**: Set up retry cron job
   ```sql
   -- Create a cron job to run every 5 minutes:
   SELECT process_failed_activities_retry();
   ```

## Why Split?

### Benefits:
- **Maintainability**: Smaller, focused files are easier to review and modify
- **Modularity**: Core functions separated from content processing
- **Deployment Safety**: Can deploy incrementally and test each part
- **Version Control**: Easier to track changes to specific functionality
- **Debugging**: Clearer separation makes issues easier to isolate

### File Sizes:
- Original: ~2006 lines (very large)
- Part 1: ~698 lines (core trigger + processors)
- Part 2: ~428 lines (content processing + setup)

## Features

### Robust Error Handling
- Transient failures retry with exponential backoff (5min, 20min, 60min)
- Permanent failures after 3 attempts
- Comprehensive error logging

### Professional Architecture
- Inbox only validates and stores activities
- Triggers handle all business logic
- DRY principle - no duplication
- Proper separation of concerns

### Complete ActivityPub Support
- All standard activity types: Follow, Accept, Reject, Undo, Create, Update, Delete, Like, Announce
- Direct message detection and processing
- Mention extraction and notifications
- Content conversion from ActivityPub HTML to Harmony JSONB

### Monitoring and Logging
- Activity processing status tracking
- Performance metrics
- Error details for debugging

## Testing After Deployment

1. **Check trigger creation**:
   ```sql
   SELECT * FROM information_schema.triggers 
   WHERE trigger_name = 'unified_activitypub_processing_trigger';
   ```

2. **Monitor activity processing**:
   ```sql
   SELECT status, count(*) FROM ap_activities GROUP BY status;
   ```

3. **Test activity flow**:
   - Send test Follow activity
   - Verify it gets processed correctly
   - Check notifications are created

4. **Monitor retry system**:
   ```sql
   SELECT * FROM ap_activities WHERE status = 'pending' AND attempts > 0;
   ```

## Rollback Plan

If issues occur:

1. **Disable trigger**:
   ```sql
   DROP TRIGGER IF EXISTS unified_activitypub_processing_trigger ON ap_activities;
   ```

2. **Restore old functions** (if needed):
   ```sql
   -- Restore from backup or previous migration
   ```

3. **Reset failed activities**:
   ```sql
   UPDATE ap_activities SET status = 'received' WHERE status IN ('failed', 'pending');
   ```

## Next Steps

After successful deployment:

1. **Remove legacy triggers/functions** - Clean up old, duplicate code
2. **Set up monitoring** - Track processing metrics
3. **Performance testing** - Verify improved performance
4. **Documentation** - Update API docs if needed

## Files Location

- Part 1: `/migrations/unified_activitypub_processing_trigger_part1.sql`
- Part 2: `/migrations/unified_activitypub_processing_trigger_part2.sql`
- This guide: `/docs/ACTIVITYPUB_MIGRATION_SPLIT.md`

## Success Metrics

- ✅ All activity types processed correctly
- ✅ No duplication of business logic
- ✅ Failed activities retry automatically
- ✅ Notifications created for local users
- ✅ Content properly converted to Harmony format
- ✅ Performance improved (trigger-based vs function calls)
- ✅ Maintainable, professional codebase
