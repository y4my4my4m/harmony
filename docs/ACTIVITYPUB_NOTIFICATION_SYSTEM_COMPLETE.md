# ActivityPub Notification System - Complete Architecture

## Overview

Harmony now has a dual notification system that handles both **local** and **federated** interactions properly:

1. **Local Notifications**: For interactions between local users (using existing triggers)
2. **Federated Notifications**: For interactions from remote servers (using unified ActivityPub trigger)

## Architecture

### Local User → Local User (Existing System)
```
Local Post → Posts Table → Local Notification Triggers → Notifications Table
Local Follow → Follows Table → Local Follow Trigger → Notifications Table
Local Interaction → Interactions Table → Local Interaction Trigger → Notifications Table
```

### Remote User → Local User (Unified ActivityPub System)
```
Remote Activity → AP_Activities Table → Unified Trigger → Process Activity → Notifications Table
```

## Notification Types & Triggers

### 1. Local Post Mentions ✅ FIXED
**File**: `/migrations/fix_local_post_mention_notifications.sql`
- **Trigger**: `handle_local_post_mention_notifications_trigger` on `posts`
- **Function**: `handle_local_post_mention_notifications()`
- **Covers**: When local user mentions another local user in a post
- **Notification Type**: `activitypub_mention`

### 2. Local Replies ✅ EXISTING
**Function**: `handle_simple_post_notifications()` 
- **Trigger**: `simple_activitypub_post_notifications` on `posts`
- **Covers**: When local user replies to another local user's post
- **Notification Type**: `activitypub_reply`

### 3. Local Follows ✅ EXISTING  
**Function**: `handle_simple_follow_notifications()`
- **Trigger**: `simple_activitypub_follow_notifications` on `follows`
- **Covers**: When local user follows another local user
- **Notification Type**: `activitypub_follow`

### 4. Local Interactions ✅ EXISTING
**Function**: `handle_simple_interaction_notifications()`
- **Trigger**: `simple_activitypub_interaction_notifications` on `post_interactions`
- **Covers**: When local user likes/reblogs another local user's post
- **Notification Type**: `activitypub_favorite`, `activitypub_reblog`

### 5. Federated Activities ✅ UNIFIED TRIGGER
**Function**: `handle_activitypub_activity_processing()`
- **Trigger**: `unified_activitypub_processing_trigger` on `ap_activities`
- **Covers**: All remote ActivityPub activities (Follow, Like, Announce, Create, etc.)
- **Notification Types**: All ActivityPub types from remote servers

## Migration Deployment Order

### Step 1: Deploy Unified System
```sql
-- 1. Deploy unified trigger parts
-- \i migrations/unified_activitypub_processing_trigger_part1.sql
-- \i migrations/unified_activitypub_processing_trigger_part2.sql

-- 2. Set up retry cron job
-- \i migrations/setup_activitypub_retry_cron.sql
```

### Step 2: Fix Local Mentions
```sql
-- 3. Fix local post mention notifications
-- \i migrations/fix_local_post_mention_notifications.sql
```

### Step 3: Clean Up Safely
```sql
-- 4. Clean up ONLY conflicting functions (preserves local notifications)
-- \i migrations/cleanup_legacy_activitypub_functions.sql
```

## Notification Data Structure

### Local Mention Notification
```json
{
  "type": "activitypub_mention",
  "data": {
    "author": {
      "id": "uuid",
      "username": "string", 
      "display_name": "string",
      "avatar_url": "string",
      "domain": "string",
      "is_local": true
    },
    "post_id": "uuid",
    "post_content": [...], // Unified content format
    "timestamp": "2025-07-17T..."
  }
}
```

### Federated Notification (from unified trigger)
```json
{
  "type": "activitypub_follow|activitypub_favorite|activitypub_reblog|...",
  "data": {
    "actor": {
      "id": "uuid",
      "username": "string",
      "display_name": "string", 
      "avatar_url": "string",
      "domain": "remote.server",
      "is_local": false
    },
    "activity_id": "uuid",
    "object_id": "string", // ActivityPub object ID
    "timestamp": "2025-07-17T..."
  }
}
```

## Testing

### Test Local Mentions
1. Create post with `@username` mention to local user
2. Check notifications table for `activitypub_mention` type
3. Verify notification data contains proper author and post info

### Test Local Replies
1. Reply to another local user's post
2. Check for `activitypub_reply` notification

### Test Local Follows
1. Follow another local user
2. Check for `activitypub_follow` notification

### Test Local Interactions
1. Like/reblog another local user's post
2. Check for `activitypub_favorite`/`activitypub_reblog` notification

### Test Federation
1. Process remote ActivityPub activity via inbox
2. Check `ap_activities` table for activity
3. Check notifications for federated notification

## Monitoring

### Check Notification System Health
```sql
-- Recent local notifications
SELECT type, count(*) 
FROM notifications 
WHERE created_at > NOW() - INTERVAL '1 hour'
  AND type LIKE 'activitypub_%'
GROUP BY type;

-- Recent federated activities
SELECT ap_type, status, count(*)
FROM ap_activities
WHERE created_at > NOW() - INTERVAL '1 hour'
GROUP BY ap_type, status;

-- Failed activities (need retry)
SELECT ap_type, count(*)
FROM ap_activities 
WHERE status = 'failed'
GROUP BY ap_type;
```

### Check Triggers
```sql
-- Verify all notification triggers exist
SELECT 
    schemaname,
    tablename, 
    triggername
FROM pg_triggers
WHERE triggername LIKE '%notification%'
ORDER BY tablename, triggername;
```

## Troubleshooting

### Local Mentions Not Working
1. Check if trigger exists: `handle_local_post_mention_notifications_trigger`
2. Check if function exists: `handle_local_post_mention_notifications()`
3. Verify unified content format in posts table
4. Check notification preferences for mentioned user

### Federated Activities Not Processing
1. Check unified trigger: `unified_activitypub_processing_trigger`
2. Check ap_activities table for failed activities
3. Run retry processor: `SELECT process_failed_activities_retry();`
4. Check cron job setup

### Missing Notifications
1. Check notification preferences table
2. Verify user has notifications enabled for the type
3. Check RLS policies on notifications table
4. Verify realtime subscription is active

## Key Functions Preserved

### ✅ Local Notification Functions (KEPT)
- `handle_simple_follow_notifications()` - Local follows
- `handle_simple_interaction_notifications()` - Local likes/reblogs  
- `handle_simple_post_notifications()` - Local replies
- `handle_local_post_mention_notifications()` - Local mentions (NEW)
- `create_simple_activitypub_notification()` - Notification creation

### ✅ Federated Processing Functions (UNIFIED)
- `handle_activitypub_activity_processing()` - Main processor
- `process_follow_activity()` - Remote follows
- `process_like_activity()` - Remote likes
- `process_announce_activity()` - Remote reblogs
- `process_create_activity()` - Remote posts/DMs
- `process_failed_activities_retry()` - Retry system

### ✅ Utility Functions (PRESERVED)
- `setup_activitypub_federation()` - User setup
- `convert_unified_content_to_activitypub_html()` - Content conversion
- `extract_all_activitypub_tags()` - Tag extraction
- All conversation management functions

## Summary

The notification system now properly handles both local and federated interactions:

- **Local users mentioning local users**: ✅ Working with new trigger
- **Local users replying to local users**: ✅ Working with existing trigger  
- **Local users following local users**: ✅ Working with existing trigger
- **Local users interacting with local posts**: ✅ Working with existing trigger
- **Remote users interacting with local users**: ✅ Working with unified trigger
- **Failed activity retry**: ✅ Working with cron job system

The dual system ensures comprehensive notification coverage while maintaining clean separation between local and federated concerns.
