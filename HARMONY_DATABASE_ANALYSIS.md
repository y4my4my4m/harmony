# Harmony Database Schema Analysis & Refactor Plan

## Current Database State

### Tables Overview (47 tables)

#### **Core Content Tables**
- `posts` - Main posts/status updates with content, metadata, federation tracking, and interaction counts
- `messages` - Chat messages in channels/servers with reactions, replies, federation metadata  
- `conversations` - DM conversations between users (local and federated)
- `post_interactions` - User interactions with posts (favorite, reblog, bookmark)
- `reactions` - Emoji reactions on messages

#### **User & Federation Tables**
- `profiles` - User profiles with ActivityPub federation fields (keys, URLs, counters)
- `user_private_keys` - Secure storage of ActivityPub private keys (separate from profiles)
- `follows` - User follow relationships with federation status and metadata
- `blocked_instances` - Instance-level blocks for moderation

#### **ActivityPub Federation Core**
- `ap_activities` - All ActivityPub activities (Create, Follow, Like, etc.) with delivery tracking
- `ap_actor_cache` - Cached remote actor data with TTL
- `ap_object_cache` - Cached remote object data with TTL  
- `federated_instances` - Known instances with health status and metadata
- `federation_delivery_queue` - Outgoing federation delivery queue with retry logic
- `federation_delivery_stats` - Delivery performance metrics

#### **Server/Channel Structure**
- `servers` - Discord-like servers with federation support
- `channels` - Text/voice channels within servers
- `channel_categories` - Channel organization
- `user_servers` - Server membership
- `server_membership_events` - Join/leave/kick/ban events
- `server_federation_events` - Server federation activities

#### **Timeline & Discovery**
- `timeline_entries` - User timeline entries (home, public, local)
- `timeline_posts` - View combining posts with reblog data for timeline display
- `user_timeline_cache` - Cached timeline data for performance
- `hashtags` - Hashtag tracking with trending metrics
- `post_hashtags` - Post-hashtag relationships
- `trending_posts` - Trending posts with engagement scores
- `trending_users` - Trending users with growth metrics

#### **Notifications & UI**
- `notifications` - User notifications with federation support
- `notification_preferences` - User notification settings including ActivityPub
- `notification_channels` - Per-channel/conversation notification settings
- `unread_counts` - Unread message/mention counters

#### **Media & Customization**
- `emojis` - Custom emojis with usage tracking
- `emoji_usage` - Detailed emoji usage analytics
- `files` - File attachments and media
- `voice_federation_events` - Voice chat federation activities

#### **Administration**
- `instance_config` - Instance-wide configuration
- `admin_audit_log` - Admin action logging
- `invites` - Server invite codes

### Current Functions (147 total)

#### **ActivityPub Processing (NEEDS REFACTOR)**
- `handle_activitypub_activity_processing()` - Main AP activity processor trigger
- `process_*_activity()` functions - Handle specific AP activity types (Create, Follow, Like, etc.)
- `create_activitypub_note_activity()` - Convert local posts to AP activities
- `parse_activitypub_content_to_jsonb()` - **RENAME**: Convert AP HTML to internal format
- `convert_unified_content_to_activitypub_html()` - **RENAME**: Convert internal format to AP HTML

#### **Federation Management (NEEDS CONSOLIDATION)**
- `queue_activity_for_federation()` - Queue activities for delivery
- `process_pending_federation()` - Process federation delivery queue
- `insert_ap_activity_safe()` / `upsert_ap_activity()` - Safe activity insertion with deduplication
- `generate_activitypub_metadata()` - Generate AP actor URLs and keys
- `create_http_signature()` - **REMOVE**: HTTP signing should be in edge functions only

#### **Content Processing Triggers (NEEDS CONSOLIDATION)**
- `handle_post_federation()` - **RENAME/REFACTOR**: Federate posts after creation
- `handle_outgoing_messages()` - **RENAME/REFACTOR**: Federate DMs to remote users
- `handle_unified_interaction_processing()` - **RENAME/REFACTOR**: Federate likes/reblogs
- `handle_unified_reply_processing()` - **RENAME/REFACTOR**: Federate post replies

### Current Triggers (32 total - TOO MANY!)

#### **Federation Triggers (CONSOLIDATE TO 3-4 TRIGGERS)**
- `handle_post_federation_trigger` - Auto-federate new posts
- `handle_outgoing_messages` - Auto-federate new DMs  
- `follows_federation_trigger` - Auto-federate follow requests
- `unified_activitypub_interaction_processing` - Auto-federate likes/reblogs
- `unified_activitypub_reply_processing` - Auto-federate replies
- `unified_activitypub_processing_trigger` - Process incoming AP activities
- `profile_update_federation_trigger` - Federate profile updates

### Current Problems

1. **Scattered Federation Logic**: Federation is handled by multiple triggers and functions across different tables
2. **No Central Control**: No unified way to enable/disable federation at instance or user level
3. **Tightly Coupled**: Local operations are tightly coupled with federation - failures could break local functionality
4. **Inconsistent Patterns**: Different content types (posts, DMs, follows) use different federation patterns
5. **No Error Recovery**: Limited federation retry and error handling mechanisms
6. **Performance Issues**: Multiple triggers firing on every insert causing potential bottlenecks
7. **Maintenance Complexity**: 147 functions and 32 triggers make the system hard to maintain and debug
8. **Bad Naming**: Functions like `parse_activitypub_content_to_jsonb()` are verbose and unclear
9. **Database HTTP Signing**: `create_http_signature()` should be in edge functions, not database
10. **Notification Complexity**: Multiple notification functions instead of unified system

## Refactor Plan

### Phase 1: Core Function Cleanup & Renaming

#### **Content Conversion Functions**
- `parse_activitypub_content_to_jsonb()` → `convert_ap_to_jsonb()`
- `convert_unified_content_to_activitypub_html()` → `convert_jsonb_to_ap()`
- `parse_activitypub_dm_content_to_jsonb()` → `convert_ap_dm_to_jsonb()`

#### **Federation Handler Functions**
- `handle_post_federation()` → `queue_post_federation()`
- `handle_outgoing_messages()` → `queue_message_federation()`
- `handle_unified_interaction_processing()` → `queue_interaction_federation()`
- `handle_unified_reply_processing()` → `queue_reply_federation()`

#### **Remove Database HTTP Functions**
- **DELETE**: `create_http_signature()` - Move to edge functions

### Phase 2: Unified Notification System

#### **Single Notification Function**
- **NEW**: `send_notification(type, to_user_ids[], data, server_id?, channel_id?, conversation_id?)`
- **CONSOLIDATE**: All notification creation functions into single entry point
- **RESPECT**: User notification preferences automatically
- **SUPPORT**: Both local and federated notification delivery

### Phase 3: Trigger Consolidation

#### **Reduce to Essential Triggers Only**
- `trigger_content_federation` - Handle posts/messages federation (INSERT/UPDATE/DELETE)
- `trigger_interaction_federation` - Handle follows/likes/reactions federation (INSERT/DELETE)
- `trigger_profile_federation` - Handle profile updates federation (UPDATE)
- `trigger_notification_processing` - Handle all notification creation (INSERT)

#### **Add Federation Controls**
- Each trigger checks instance and user federation settings before processing
- Conditional execution for performance optimization

### Phase 4: Service Layer Implementation

#### **Local-First Services**
- `PostService` - Create, update, delete posts locally first
- `MessageService` - Send messages/DMs locally first  
- `InteractionService` - Handle likes/follows locally first
- `NotificationService` - Unified notification handling

#### **Federation Services**
- `FederationManager` - Central federation control
- `IncomingFederationHandler` - Process incoming ActivityPub
- `OutgoingFederationHandler` - Queue outgoing ActivityPub

### Phase 5: Database Schema Updates

#### **Add Federation Controls**
```sql
-- Instance-level federation settings
ALTER TABLE instance_config ADD COLUMN IF NOT EXISTS federation_enabled BOOLEAN DEFAULT true;

-- User-level federation settings  
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS federation_enabled BOOLEAN DEFAULT true;
```

#### **Optimize Federation Tables**
- Add proper indexes for federation delivery performance
- Add federation health monitoring columns
- Optimize ActivityPub cache tables

## Features That Must Continue Working

### **Core Chat/DM Features**
- ✅ Discord-like servers and channels
- ✅ Direct messages between local users
- ✅ Direct messages with federated users (private mention approach)
- ✅ Conversation creation for DMs
- ✅ Message reactions and replies
- ✅ File attachments and media

### **Social Features**
- ✅ Posts (status updates) with media
- ✅ Likes, reblogs, bookmarks
- ✅ Follow relationships
- ✅ Mentions in posts and messages
- ✅ Hashtags and trending
- ✅ User timelines (home, public, local)

### **Federation Features**
- ✅ ActivityPub compatibility
- ✅ Remote user interactions
- ✅ Cross-instance messaging
- ✅ Federation delivery queue
- ✅ Instance blocking and moderation

### **Admin Features**
- ✅ Instance configuration
- ✅ User moderation
- ✅ Federation controls
- ✅ Analytics and monitoring

### **Notification Features**
- ✅ Real-time notifications
- ✅ Notification preferences
- ✅ Federation-aware notifications
- ✅ Do not disturb settings

## Success Metrics

1. **Performance**: Reduce database function count from 147 to <50
2. **Maintainability**: Reduce triggers from 32 to <10
3. **Reliability**: Local operations never fail due to federation issues
4. **Control**: Instance and user-level federation toggles working
5. **Compatibility**: All existing features continue working
6. **Clean Code**: Clear naming conventions and separation of concerns

## Implementation Order

1. **Documentation**: This analysis document ✅
2. **Function Renaming**: Clean up existing function names
3. **Notification Unification**: Single notification system
4. **Trigger Consolidation**: Reduce trigger complexity
5. **Service Layer**: Local-first service implementation
6. **Federation Handlers**: Unified incoming/outgoing handlers
7. **Schema Updates**: Add federation controls
8. **Testing**: Ensure all features work
9. **Cleanup**: Remove old functions and triggers
10. **Documentation**: Update API documentation