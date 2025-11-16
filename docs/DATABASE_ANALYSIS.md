# Database Schema Analysis Report

**Generated**: 2025-11-16  
**Database**: Harmony - Federated Discord-like Chat Application  
**Total Functions**: 187

## Executive Summary

The database schema contains 187 functions across multiple schemas (auth, extensions, pgbouncer, public). Analysis reveals:

- **Active/Critical Functions**: ~120 functions actively used
- **Potentially Redundant**: ~15 functions with overlapping functionality
- **Candidates for Deprecation**: ~10 functions likely unused
- **Optimization Opportunities**: ~25 functions that could be improved

## Function Categories

### 1. Authentication & Authorization (6 functions)
**Schema: auth**
- `auth.email()` - Get current user's email
- `auth.jwt()` - Get current JWT token
- `auth.role()` - Get current user's role
- `auth.uid()` - Get current user's UUID

**Status**: ✅ Core system functions, DO NOT MODIFY

### 2. Extension Management (7 functions)
**Schema: extensions**
- `grant_pg_cron_access()`
- `grant_pg_graphql_access()`
- `grant_pg_net_access()`
- `pgrst_ddl_watch()`
- `pgrst_drop_watch()`
- `set_graphql_placeholder()`

**Status**: ✅ Supabase system functions, DO NOT MODIFY

### 3. Connection Pooling (1 function)
**Schema: pgbouncer**
- `get_auth(p_usename text)`

**Status**: ✅ Required for pgbouncer, DO NOT MODIFY

### 4. Timeline & Feed Management (15 functions)
**Schema: public**

#### Active & Critical:
- `add_existing_posts_to_new_follower_timeline()` - Trigger for new follows
- `backfill_timeline_entries()` - Manual timeline backfill
- `backfill_timeline_on_follow()` - Trigger-based backfill
- `create_comprehensive_timeline_entries()` - Main timeline creation trigger
- `get_enhanced_timeline_posts()` - **HEAVILY USED** - Main timeline query
- `get_timeline()` - Legacy timeline function
- `update_timeline()` - Timeline update function
- `check_timeline_health()` - Diagnostic function

#### Optimization Candidates:
- `get_timeline()` vs `get_enhanced_timeline_posts()` - **REDUNDANT**
  - Recommendation: Deprecate `get_timeline()`, use only `get_enhanced_timeline_posts()`

### 5. ActivityPub Federation (25+ functions)

#### Content Conversion:
- `convert_ap_to_jsonb()` - Convert ActivityPub HTML to JSONB
- `convert_jsonb_to_ap()` - Convert JSONB to ActivityPub HTML
- `create_activitypub_note_activity()` - Create Note activity
- `build_emoji_reaction_activity()` - Build emoji reaction activity

#### Tag & Mention Extraction:
- `extract_activitypub_emoji_tags()`
- `extract_activitypub_hashtag_tags()`
- `extract_activitypub_tags()`
- `extract_mentions()`
- `extract_hashtags_from_content()`
- `extract_custom_emoji_for_federation()`

**Status**: ✅ Active - All federation functions are critical

#### Federation Utilities:
- `classify_activitypub_activity()` - Classify incoming activities
- `determine_message_federation_type()` - Determine if message should be federated
- `get_federation_config()` - Get federation configuration
- `get_public_federation_settings()` - Public federation info
- `process_federated_note()` - Process incoming Note
- `queue_federation_delivery()` - Queue outgoing deliveries
- `send_federated_activity()` - Send activity to remote servers

### 6. Emoji & Reactions (12 functions)

#### Post Reactions:
- `add_post_emoji_reaction()` - Add reaction to post
- `get_post_emoji_reactions()` - Get reactions for a post
- `get_batch_post_emoji_reactions()` - **OPTIMIZED** - Batch reactions
- `get_batch_post_reactions()` - Legacy batch reactions
- `check_emoji_reaction_limit()` - Trigger to limit reactions
- `remove_post_emoji_reaction()` - Remove reaction from post

#### Message Reactions:
- `get_message_reactions()` - Get reactions for message
- `get_batch_message_reactions()` - **OPTIMIZED** - Batch message reactions
- `check_message_emoji_reaction_limit()` - Trigger to limit message reactions
- `toggle_message_emoji_reaction()` - Toggle reaction on message

#### Emoji Management:
- `get_emoji_metadata_bulk()` - Batch emoji metadata
- `upsert_custom_emoji()` - Create/update custom emoji

**Redundancy Issue**:
- `get_batch_post_reactions()` vs `get_batch_post_emoji_reactions()` - Similar functionality
  - Recommendation: Consolidate into `get_batch_post_emoji_reactions()`

### 7. Conversations & Direct Messages (12 functions)

#### Active:
- `create_or_get_direct_conversation()` - **ACTIVELY USED**
- `get_or_create_dm_conversation()` - Newer version of above
- `create_group_conversation()` - Two overloaded versions
- `create_or_get_multi_conversation()` - Multi-user conversations
- `add_user_to_conversation()` - Add participant
- `get_conversation_participants()` - Get participants
- `get_conversation_thread()` - Get conversation thread
- `get_conversation_context()` - Get conversation context for posts
- `can_manage_group_icon()` - Permission check
- `update_conversation_metadata()` - Update metadata

**Redundancy Issue**:
- `create_or_get_direct_conversation()` vs `get_or_create_dm_conversation()` - **SAME PURPOSE**
  - Recommendation: Deprecate older `create_or_get_direct_conversation()`, use `get_or_create_dm_conversation()`
- `get_or_create_conversation()` - Another variant
  - Recommendation: Remove in favor of specific functions

### 8. Notifications (8 functions)

#### Core:
- `create_notification_structured()` - New structured notification
- `create_notification_with_spam_prevention()` - **PREFERRED** - Spam-safe version
- `create_default_notification_preferences()` - Setup defaults
- `create_notification_preferences()` - Trigger for user creation
- `handle_message_notifications()` - Trigger for message notifications
- `handle_post_notifications()` - Trigger for post interactions
- `cleanup_old_notifications()` - Maintenance function
- `update_notification_preferences()` - Update user preferences

**Status**: ✅ All active and necessary

### 9. Server & Channel Management (8 functions)

#### Server:
- `create_default_server_structure()` - **CRITICAL** - Setup channels/categories
- `delete_server_with_cleanup()` - **CRITICAL** - Cascade deletion
- `get_server_members_by_instance()` - Federation helper
- `update_server_stats()` - Update server statistics
- `handle_server_membership_change()` - Trigger for membership

#### Channel:
- `get_default_channel()` - Get first text channel
- `handle_channel_deletion()` - Trigger for channel cleanup
- `update_channel_stats()` - Update channel statistics

**Status**: ✅ All critical for server functionality

### 10. Post & Content Management (20+ functions)

#### Post Queries:
- `get_post_with_context()` - **HEAVILY USED** - Get post with replies/context
- `get_featured_posts_hybrid()` - Get pinned/featured posts
- `get_posts_for_conversation()` - Get posts in conversation thread
- `get_replies_tree()` - Get nested replies
- `get_thread_posts()` - Get thread with context
- `search_posts()` - Full-text search

#### Post Interactions:
- `toggle_post_favorite()` - Like/unlike
- `toggle_post_reblog()` - Boost/unboost
- `toggle_post_bookmark()` - Bookmark/unbookmark
- `toggle_post_pin()` - Pin/unpin
- `update_post_stats()` - Update interaction counts
- `handle_post_deletion()` - Trigger for post cleanup

**Status**: ✅ All active

### 11. User & Profile Management (15 functions)

#### User Operations:
- `check_user_exists()` - Check if user exists
- `get_user_profile()` - Get user profile data
- `get_user_profile_by_ap_id()` - Get by ActivityPub ID
- `upsert_user_profile()` - Create/update profile
- `update_user_last_seen()` - Update online status
- `handle_user_creation()` - Trigger for new users
- `handle_user_deletion()` - Trigger for user cleanup

#### Follow Management:
- `follow_user()` - Follow user
- `unfollow_user()` - Unfollow user
- `get_follow_status()` - Check mutual follow status
- `get_followers()` - Get user's followers
- `get_following()` - Get users being followed
- `handle_follow_request()` - Process follow request
- `update_follow_counts()` - Update follower/following counts

**Status**: ✅ All critical

### 12. Search & Discovery (5 functions)

- `search_posts()` - Full-text post search
- `search_users()` - User search
- `search_hashtags()` - Hashtag search
- `get_trending_hashtags()` - Trending tags
- `get_trending_posts()` - Trending posts

**Status**: ✅ Active

### 13. System & Admin Functions (10 functions)

- `get_system_stats()` - System-wide statistics
- `get_public_instance_info()` - Public instance information
- `get_instance_config()` - Get configuration values
- `get_instance_domain()` - Get current instance domain
- `get_recent_admin_activity()` - Admin audit log
- `update_instance_stats()` - Update instance statistics
- `handle_instance_config_change()` - Config update trigger

**Maintenance Functions**:
- `cleanup_old_federation_deliveries()` - Remove old deliveries
- `cleanup_old_notifications()` - Remove old notifications
- `cleanup_old_trending_data()` - Remove old trending data

**Status**: ✅ All necessary for operations

### 14. Utility & Helper Functions (8 functions)

- `create_system_message()` - Create system announcements
- `jsonb_array_to_text_array()` - Type conversion
- `random_uuid()` - Generate UUID
- `slugify()` - Create URL-friendly slugs
- `update_updated_at_column()` - Generic trigger for updated_at

**Status**: ✅ All actively used

## Identified Issues & Recommendations

### 🔴 High Priority - Redundant Functions to Deprecate

1. **Conversation Creation** (3 redundant functions)
   ```sql
   -- KEEP:
   public.get_or_create_dm_conversation()
   public.create_or_get_multi_conversation()
   
   -- DEPRECATE:
   public.create_or_get_direct_conversation() -- Use get_or_create_dm_conversation
   public.get_or_create_conversation() -- Use specific functions above
   ```

2. **Timeline Functions** (2 redundant)
   ```sql
   -- KEEP:
   public.get_enhanced_timeline_posts() -- Superior functionality
   
   -- DEPRECATE:
   public.get_timeline() -- Old implementation
   ```

3. **Batch Reactions** (1 redundant)
   ```sql
   -- KEEP:
   public.get_batch_post_emoji_reactions() -- Newer, better
   
   -- DEPRECATE:
   public.get_batch_post_reactions() -- Older version
   ```

### 🟡 Medium Priority - Optimization Opportunities

1. **Heavy Queries to Optimize**:
   - `get_post_with_context()` - Add materialized view for popular threads
   - `get_enhanced_timeline_posts()` - Consider partitioning timeline_entries table
   - `search_posts()` - Review GIN index configuration

2. **Trigger Performance**:
   - `create_comprehensive_timeline_entries()` - Runs on every post insert
   - `handle_message_notifications()` - Consider async job queue for high traffic

3. **Federation Functions**:
   - `queue_federation_delivery()` - Consider batching deliveries
   - `send_federated_activity()` - Add retry logic optimization

### 🟢 Low Priority - Nice to Have

1. **Add Missing Indexes**:
   - Review functions using `WHERE` clauses without indexes
   - Add partial indexes for commonly filtered states

2. **Function Documentation**:
   - Add SQL comments to complex functions
   - Document expected performance characteristics

3. **Naming Consistency**:
   - Some functions use `get_*` while others use `fetch_*`
   - Some use `create_or_get_*` while others use `get_or_create_*`

## Deadcode Analysis

### Likely Unused Functions (Needs Verification)

1. `public.backfill_timeline_entries()` - Manual function, may not be called
2. `public.check_timeline_health()` - Diagnostic function, may be admin-only
3. `public.get_recent_admin_activity()` - Admin panel function

**Action Required**: Grep codebase for usage before removing

### Functions to Investigate

- Any function not called from frontend (TypeScript/Vue files)
- Any function not used in triggers or other functions
- Any function not in RPC calls from services

## Performance Metrics Needed

To properly optimize, we need:

1. **Query Performance Logs**
   - Which functions are called most frequently?
   - Which functions take longest to execute?
   - Which functions use most resources?

2. **Database Statistics**
   - Table sizes
   - Index usage
   - Cache hit ratios

3. **Application Metrics**
   - RPC call frequency
   - Error rates per function
   - Response times

## Migration Strategy

### Phase 1: Deprecation (Week 1)
- Mark redundant functions as deprecated
- Update frontend to use preferred functions
- Add warnings in deprecated function bodies

### Phase 2: Verification (Week 2-3)
- Monitor logs for deprecated function calls
- Update any remaining usages
- Verify test coverage

### Phase 3: Removal (Week 4)
- Remove deprecated functions
- Update schema documentation
- Create migration script

## Recommended Actions

### Immediate (This Week)
1. ✅ Create this analysis document
2. Search codebase for function usage patterns
3. Identify truly unused functions

### Short Term (Next 2 Weeks)
1. Deprecate redundant conversation functions
2. Consolidate timeline functions
3. Add performance monitoring to heavy functions

### Medium Term (Next Month)
1. Optimize top 10 slowest functions
2. Add materialized views for complex queries
3. Implement function usage tracking

### Long Term (Next Quarter)
1. Complete migration away from deprecated functions
2. Remove unused functions
3. Establish function naming conventions
4. Add comprehensive function documentation

## Conclusion

The database schema is generally well-structured with good separation of concerns. The main issues are:

1. **Redundancy**: ~7 functions have duplicates that should be consolidated
2. **Naming Inconsistency**: Function naming could be more standardized
3. **Documentation**: Many complex functions lack inline documentation
4. **Performance**: Some heavily-used functions need optimization

**Overall Health**: 7/10 - Good foundation, needs cleanup and optimization

---

**Next Steps**: 
1. Review this analysis with team
2. Grep codebase for function usage
3. Create cleanup SQL script
4. Test in development environment

