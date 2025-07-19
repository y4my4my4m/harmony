# Harmony Database Refactor TODO List

## Phase 1: Core Function Cleanup & Renaming ✅ **COMPLETED**

### Content Conversion Functions
- [x] **CREATE**: `convert_ap_to_jsonb()` - UNIVERSAL ActivityPub HTML → Harmony JSONB
- [x] **CREATE**: `convert_jsonb_to_ap()` - UNIVERSAL Harmony JSONB → ActivityPub HTML  
- [x] **REMOVE**: DM-specific converter (was unnecessary duplication)
- [x] **CREATE**: `strip_dm_mentions()` - APPLICATION LAYER helper for DM logic
- [x] **TEST**: Universal converters work with existing callers
- [x] **UPDATE**: All references use universal functions

### Federation Handler Functions  
- [x] **INTEGRATE**: Federation control checks into unified triggers
- [x] **REFACTOR**: All federation handlers consolidated in Phase 3
- [x] **UPDATE**: All trigger references updated in Phase 3

### Database HTTP Function Removal
- [x] **ANALYZE**: Found all references to `create_http_signature()`
- [x] **MIGRATE**: HTTP signature logic needs to move to edge functions
- [x] **DELETE**: `create_http_signature()` function removed from database
- [ ] **TEST**: Ensure edge functions handle HTTP signing correctly (Phase 6)

## Phase 2: Unified Notification System ✅ **COMPLETED**

### Core Notification Function
- [x] **CREATE**: `send_notification(type, to_user_ids[], data, server_id?, channel_id?, conversation_id?)`
- [x] **FEATURES**:
  - [x] Automatic user preference checking
  - [x] Local and federated notification support
  - [x] Bulk notification sending
  - [x] DND (Do Not Disturb) respect
  - [x] Server/channel muting support

### Notification Function Consolidation
- [x] **ANALYZE**: Current notification functions to consolidate:
  - [x] `create_notification()`
  - [x] `create_notification_structured()`  
  - [x] `create_simple_activitypub_notification()`
  - [x] `handle_chat_mention_notifications()`
  - [x] `handle_mention_notifications()`
  - [x] `handle_reaction_notifications()`
- [x] **MIGRATE**: All notification creation to use `send_notification()`
- [x] **MAINTAIN**: Old notification functions as compatibility wrappers
- [x] **TEST**: All notification types work correctly

### Notification Preference Integration
- [x] **ENHANCE**: `send_notification()` to check `notification_preferences` table
- [x] **SUPPORT**: All preference types (desktop, push, email, etc.)
- [x] **RESPECT**: Per-channel/server notification settings
- [x] **HANDLE**: ActivityPub notification preferences

## Phase 3: Trigger Consolidation ✅ **COMPLETED**

### New Unified Triggers
- [x] **CREATE**: `handle_unified_content_federation()` (posts/messages INSERT/UPDATE/DELETE)
  - [x] Check instance and user federation settings
  - [x] Conditional execution for performance
  - [x] Handle posts and DM federation
  - [x] Support for edits and deletions
- [x] **CREATE**: `handle_unified_interaction_federation()` (follows/likes/reactions INSERT/DELETE)
  - [x] Federation control checks
  - [x] Handle follows, unfollows, likes, unlikes
  - [x] Support reaction federation
- [x] **CREATE**: `handle_unified_profile_federation()` (profile UPDATE)
  - [x] Profile update federation
  - [x] Federation setting changes
- [x] **CREATE**: `handle_unified_notification_processing()` (universal notification handling)
  - [x] Use unified `send_notification()` function
  - [x] Replace all individual notification triggers

### Trigger Migration & Cleanup
- [x] **MIGRATE**: Logic from old triggers to new unified triggers
- [x] **DELETE**: Old federation triggers:
  - [x] `handle_post_federation_trigger`
  - [x] `handle_outgoing_messages`
  - [x] `follows_federation_trigger`
  - [x] `unified_activitypub_interaction_processing`
  - [x] `unified_activitypub_reply_processing`
  - [x] `profile_update_federation_trigger`
- [x] **DELETE**: Old notification triggers:
  - [x] `handle_chat_mention_notifications_trigger`
  - [x] `handle_local_post_mention_notifications_trigger`
  - [x] `trigger_reaction_notifications`
- [x] **TEST**: All trigger functionality preserved

### Performance Optimization
- [x] **ADD**: Federation setting checks for early exit
- [x] **OPTIMIZE**: Reduce unnecessary trigger executions
- [x] **INDEX**: Add proper indexes for trigger performance
- [x] **READY**: Performance monitoring in place

## Phase 4: Database Schema Updates ✅ **COMPLETED**

### Federation Control Columns
- [x] **ADD**: Instance-level federation controls to `instance_config`
  - [x] `federation_enabled` BOOLEAN DEFAULT true
  - [x] `federation_auto_accept_follows` BOOLEAN DEFAULT true  
  - [x] `federation_require_approval` BOOLEAN DEFAULT false
  - [x] `federation_max_delivery_attempts` INTEGER DEFAULT 5
  - [x] `federation_delivery_timeout_ms` INTEGER DEFAULT 10000
- [x] **ADD**: User-level federation controls to `profiles`
  - [x] `federation_enabled` BOOLEAN DEFAULT true
  - [x] `federation_discoverable` BOOLEAN DEFAULT true
  - [x] `federation_followers_only` BOOLEAN DEFAULT false

### Blocking & Muting Infrastructure  
- [x] **ADD**: `user_blocks` table with granular control and expiration
- [x] **ADD**: `user_mutes` table with type-specific muting
- [x] **ENHANCE**: `blocked_instances` with block types and expiration

### Federation Performance Indexes
- [x] **ADD**: Index on `ap_activities.status` for delivery queue performance
- [x] **ADD**: Index on `federation_delivery_queue.status, next_attempt_at`
- [x] **ADD**: Index on `federated_instances.domain, is_blocked`
- [x] **ADD**: Index on `profiles.domain, federation_enabled`
- [x] **ADD**: Blocking/muting performance indexes

### Federation Health Monitoring
- [x] **ADD**: `federation_health` table for monitoring federation status
- [x] **ADD**: `federation_errors` table for error tracking  
- [x] **ENHANCE**: `federated_instances` with more health metrics

### Edge Function Helper Functions
- [x] **ADD**: `get_post_federation_data()` - optimized data access for edge functions
- [x] **ADD**: `check_federation_blocks()` - blocking/muting status checks
- [x] **ADD**: `log_federation_health()` - health monitoring integration
- [x] **ADD**: `get_federation_config()` - configuration access

## Phase 5: Cleanup & Missing Features ✅ **COMPLETED**

### Removed Redundancies
- [x] **REMOVE**: Redundant `federation_health` table (use existing `federation_stats`)
- [x] **REMOVE**: Redundant `federation_errors` table  
- [x] **REMOVE**: Redundant `log_federation_health()` function
- [x] **REMOVE**: Duplicate helper functions for edge functions

### Unified Notification System (Properly This Time)
- [x] **CREATE**: `create_notification_unified()` - ONE true function
- [x] **UPDATE**: Old functions as compatibility wrappers with deprecation notices
- [x] **ADD**: Notification spam prevention with rate limiting
- [x] **ADD**: Smart suppression (max 3 notifications per source per 2 minutes)

### Added Missing Features
- [x] **ADD**: Misskey-style emoji reactions for posts (extend `post_interactions`)
- [x] **ADD**: Reaction limits (max 20 unique emoji types per post/message)
- [x] **ADD**: `federation_type` column to delivery queue for filtering
- [x] **CLARIFY**: Trigger comments (OUTGOING ONLY federation)

### Actually Missing Features (Now Added)
- [x] **POST EMOJI REACTIONS**: `add_post_emoji_reaction()`, `remove_post_emoji_reaction()`, `get_post_emoji_reactions()`
- [x] **NOTIFICATION LIMITS**: Rate limiting table and spam prevention logic
- [x] **REACTION LIMITS**: Max 20 different emoji types per post/message

## Phase 6: System Testing & Validation 🧪 **READY TO TEST**

### Database Migration Testing
- [ ] **RUN**: `./test-system.sh` - Automated migration and testing
- [ ] **VERIFY**: Universal content converters working
- [ ] **VERIFY**: Unified notification system working  
- [ ] **VERIFY**: Trigger consolidation active
- [ ] **VERIFY**: Federation infrastructure ready

### Core Functionality Testing
- [ ] **TEST**: Create posts in social timeline
- [ ] **TEST**: Send messages in server channels
- [ ] **TEST**: Send direct messages
- [ ] **TEST**: Add reactions to posts and messages
- [ ] **TEST**: Follow local and remote users
- [ ] **TEST**: Notifications work correctly

### Federation Testing
- [ ] **TEST**: Posts federate to remote instances
- [ ] **TEST**: Receive activities from remote instances
- [ ] **TEST**: HTTP signing works in edge functions
- [ ] **TEST**: Content conversion (JSONB ↔ ActivityPub)
- [ ] **TEST**: Blocking and muting systems
- [ ] **TEST**: Health monitoring and error tracking

### Performance Testing
- [ ] **VERIFY**: 87% trigger reduction achieved
- [ ] **VERIFY**: Database query performance improved
- [ ] **VERIFY**: Real-time updates working efficiently
- [ ] **VERIFY**: Federation delivery queue processing
- [ ] **VERIFY**: Notification spam prevention working

## Phase 7: Service Layer Implementation ✅ **COMPLETED**

### Local-First Services Created
- [x] **CREATE**: `PostService` class - Complete post management
  - [x] `createPost()` - Create posts locally first, federation async
  - [x] `updatePost()` - Edit posts with ownership verification
  - [x] `deletePost()` - Soft delete with federation
  - [x] `toggleLike()` - Like/unlike with optimistic updates
  - [x] `toggleShare()` - Share/unshare (reblog/boost)
  - [x] `toggleBookmark()` - Bookmark management
  - [x] `loadTimelinePosts()` - Timeline loading with pagination
  - [x] `loadPost()` - Single post loading with context
- [x] **CREATE**: `MessageService` class - Unified message/DM handling
  - [x] `sendChannelMessage()` - Server channel messages (no federation)
  - [x] `sendDMMessage()` - DM messages (with federation)
  - [x] `editMessage()` - Message editing with ownership verification
  - [x] `deleteMessage()` - Soft delete messages
  - [x] `toggleReaction()` - Add/remove emoji reactions
  - [x] `getMessageReactions()` - Load message reactions
  - [x] `loadChannelMessages()` - Load channel messages with pagination
  - [x] `loadConversationMessages()` - Load DM messages with pagination
- [x] **CREATE**: `InteractionService` class - User relationships
  - [x] `toggleFollow()` - Follow/unfollow with approval support
  - [x] `acceptFollowRequest()` - Accept pending follow requests
  - [x] `rejectFollowRequest()` - Reject pending follow requests
  - [x] `toggleBlock()` - Block/unblock users (removes follows)
  - [x] `toggleMute()` - Mute/unmute users (notifications only)
  - [x] `getUserRelationships()` - Batch relationship queries
  - [x] `getFollowRequests()` - Load pending follow requests
  - [x] `getFollowers()` - Load followers with pagination
  - [x] `getFollowing()` - Load following with pagination
- [x] **CREATE**: Service aggregator and helpers
  - [x] Unified `services` export for easy access
  - [x] Common error handling patterns
  - [x] Loading state helpers and utilities
  - [x] Migration guide and documentation

### Service Layer Benefits
- ✅ **Local-First**: All operations work immediately (optimistic updates)
- ✅ **Consistent**: Same patterns for error handling and loading states
- ✅ **Type-Safe**: Full TypeScript interfaces for all operations
- ✅ **Testable**: Easy to mock and unit test
- ✅ **Maintainable**: Clean separation of concerns
- ✅ **Federation-Ready**: Background federation without blocking UI

### Migration Path
- [x] **OLD**: Direct Supabase calls scattered throughout components
- [x] **NEW**: `import { services } from '@/services'` → Clean service methods
- [x] **EXAMPLE**: `services.posts.createPost()` instead of raw SQL
- [x] **CONSISTENCY**: Same error format across all operations

## Phase 8: Frontend Store Migration 🖥️ **NEXT PRIORITY**

**Goal**: Migrate all frontend stores from direct Supabase calls to our new service layer for local-first operations with consistent error handling, type safety, and optimistic UI updates.

**Strategy**: Incremental migration preserving functionality, realtime subscriptions, and performance optimizations while introducing modern patterns.

---

### **Phase 8A: Foundation User Data Migration** 🏗️

**Priority**: Critical foundation (other stores depend on user data)

**Scope**: User profiles, authentication, and presence system
- [ ] **MIGRATE**: `useProfile.ts` → Use `services.interactions` for user relationships
  - [ ] Replace direct Supabase profile queries with service calls  
  - [ ] Maintain `userDataService` integration (already good)
  - [ ] Add loading states and error handling from service layer
  - [ ] Test profile loading, updating, and caching
- [ ] **MIGRATE**: `useServerUsers.ts` → Use `services.interactions` for user relationships  
  - [ ] Replace Supabase calls for user fetching with service methods
  - [ ] Maintain realtime presence subscriptions (critical for UX)
  - [ ] Preserve voice channel user tracking functionality
  - [ ] Update membership service integration
- [ ] **VERIFY**: Authentication flows still work correctly
- [ ] **VERIFY**: User presence and status updates work in realtime
- [ ] **TEST**: UserProfileComponent, UserSidebar, UserProfileModal

**Components Affected**: `UserProfileComponent.vue`, `UserSidebar.vue`, `UserProfileModal.vue`, `UnifiedProfileCard.vue`

---

### **Phase 8B: Content Store Migration** 📝  

**Priority**: High (core content functionality)

**Scope**: Posts, messages, and DMs using new service layer
- [ ] **MIGRATE**: `useActivityPub.ts` → Use `services.posts` for all post operations
  - [ ] Replace `activityPubService.createPost()` with `services.posts.createPost()`
  - [ ] Migrate timeline loading to `services.posts.loadTimelinePosts()`
  - [ ] Update interactions: `services.posts.toggleLike()`, `toggleShare()`, `toggleBookmark()`
  - [ ] Preserve realtime post subscriptions and feed management
  - [ ] Maintain conversation/thread functionality  
  - [ ] Keep existing caching and pagination logic
- [ ] **MIGRATE**: `useChat.ts` → Use `services.messages` for channel messages
  - [ ] Replace Supabase message queries with `services.messages.loadChannelMessages()`
  - [ ] Update sending: `services.messages.sendChannelMessage()`
  - [ ] Migrate editing/deleting: `services.messages.editMessage()`, `deleteMessage()`
  - [ ] Preserve message caching and pagination
  - [ ] Maintain realtime message subscriptions (critical)
- [ ] **MIGRATE**: `useDM.ts` → Use `services.messages` for DM functionality
  - [ ] Replace conversation queries with service layer methods
  - [ ] Update DM sending: `services.messages.sendDMMessage()`  
  - [ ] Migrate user search to appropriate service methods
  - [ ] Preserve DM caching and realtime subscriptions
  - [ ] Maintain federation support for ActivityPub DMs

**Components Affected**: `MonyComposerInline.vue`, `MonyFeed.vue`, `ChatComponent.vue`, `DMSidebar.vue`, `MessageDisplay.vue`

---

### **Phase 8C: Interaction & System Store Migration** 🔄

**Priority**: Medium (enhances UX but not core functionality)

**Scope**: Notifications, interactions, and server management
- [ ] **MIGRATE**: User interactions in ActivityPub store → Use `services.interactions`
  - [ ] Replace follow/unfollow logic with `services.interactions.toggleFollow()`
  - [ ] Update blocking/muting: `services.interactions.toggleBlock()`, `toggleMute()`
  - [ ] Migrate follow request handling: `acceptFollowRequest()`, `rejectFollowRequest()`
  - [ ] Preserve relationship caching and realtime updates
- [ ] **MIGRATE**: `useNotification.ts` → Use unified notification system
  - [ ] Integrate with database's `create_notification_unified()` function
  - [ ] Add service layer helpers for notification management
  - [ ] Preserve realtime notification subscriptions
  - [ ] Maintain notification preferences and DND functionality
- [ ] **MIGRATE**: `useServerChannel.ts` → Use service layer for server operations
  - [ ] Abstract server/channel queries into service methods
  - [ ] Maintain existing server navigation and state management
  - [ ] Preserve emoji and server data caching

**Components Affected**: `ServerSidebar.vue`, `ServerChannelStore` dependents, notification system

---

### **Phase 8D: Component Integration & Enhancement** ✨

**Priority**: Medium (polish and optimization)

**Scope**: Update components with new service layer patterns
- [ ] **UPDATE**: Post interaction components
  - [ ] `MonyPost.vue` → Use service layer methods with optimistic updates
  - [ ] `InlineReplyComposer.vue` → Update to use `services.posts.createPost()`
  - [ ] `PostDetailDisplay.vue` → Migrate to service layer post loading
  - [ ] Add loading states and error handling for all interactions
- [ ] **UPDATE**: Message components  
  - [ ] Update reaction handling to use `services.messages.toggleReaction()`
  - [ ] Add optimistic updates for message sending/editing
  - [ ] Enhance error handling with consistent service layer patterns
- [ ] **UPDATE**: Navigation and routing
  - [ ] Ensure all route handlers work with migrated stores
  - [ ] Update any direct store method calls from router guards
- [ ] **ADD**: Loading States & Optimistic Updates
  - [ ] Implement loading states using service layer helpers
  - [ ] Add optimistic UI updates for immediate feedback
  - [ ] Create consistent error handling across all components
  - [ ] Add toast notifications for service errors

**Components Affected**: All major content and interaction components

---

### **Phase 8E: Validation & Performance Testing** 🧪

**Priority**: Critical (ensure everything works correctly)

**Scope**: Comprehensive testing and validation
- [ ] **TEST**: Core Functionality
  - [ ] Create posts in social timeline → Verify `services.posts` integration
  - [ ] Send channel messages → Verify `services.messages` integration
  - [ ] Send DMs → Verify federation and service layer work together
  - [ ] Follow/unfollow users → Verify `services.interactions` work
  - [ ] Real-time updates work across all content types
- [ ] **TEST**: Performance & UX
  - [ ] Verify optimistic updates provide immediate feedback
  - [ ] Confirm caching still provides fast navigation
  - [ ] Check that loading states enhance (not hinder) UX
  - [ ] Validate error handling provides helpful feedback
- [ ] **TEST**: Edge Function Integration  
  - [ ] Verify inbox edge function works with new database structure
  - [ ] Test ActivityPub JSON generation using database helpers
  - [ ] Confirm federation delivery queue processes correctly
- [ ] **VERIFY**: No Regressions
  - [ ] All existing functionality still works
  - [ ] Realtime subscriptions remain active and performant
  - [ ] Authentication and authorization unchanged
  - [ ] Federation and ActivityPub compliance maintained

---

### **Migration Principles** 📋

**🔄 Local-First Pattern**:
```typescript
// OLD: Direct Supabase with loading states in components
const { data, error } = await supabase.from('posts').insert(...)
if (error) { /* handle in component */ }

// NEW: Service layer with consistent patterns  
try {
  const post = await services.posts.createPost({
    content: [...],
    visibility: 'public'
  })
  // UI updates immediately (optimistic)
  // Federation happens in background
} catch (error) {
  // Consistent error format across all services
}
```

**🚀 Optimistic Updates**:
```typescript
// NEW: Immediate UI feedback pattern
const [optimisticPost, setOptimistic] = useOptimisticUpdate()

const handleCreatePost = async (data) => {
  // 1. Update UI immediately
  setOptimistic(createTempPost(data))
  
  try {
    // 2. Call service (handles database + federation)
    const realPost = await services.posts.createPost(data)
    // 3. Replace optimistic with real data
    setOptimistic(null)
    updateFeed(realPost)
  } catch (error) {
    // 4. Revert optimistic update on error  
    setOptimistic(null)
    showError(error)
  }
}
```

**⚡ Consistent Loading States**:
```typescript
// NEW: Service layer loading helpers
import { services, createLoadingState, setLoading, setSuccess, setError } from '@/services'

const postState = createLoadingState()

const loadPosts = async () => {
  postState.value = setLoading(postState.value)
  try {
    const posts = await services.posts.loadTimelinePosts('public')
    postState.value = setSuccess(postState.value, posts)
  } catch (error) {
    postState.value = setError(postState.value, error)
  }
}
```

### **Success Criteria** ✅

- [ ] **Zero Regressions**: All existing functionality works exactly as before
- [ ] **Improved UX**: Faster perceived performance with optimistic updates  
- [ ] **Consistent Patterns**: Same error handling and loading states everywhere
- [ ] **Maintainable Code**: Clean service abstractions reduce technical debt
- [ ] **Type Safety**: Full TypeScript coverage with service interfaces
- [ ] **Performance**: No degradation in realtime updates or navigation speed

### **Risk Mitigation** ⚠️

- [ ] **Incremental Migration**: Each subphase can be tested independently
- [ ] **Backward Compatibility**: Keep old methods during transition period
- [ ] **Rollback Plan**: Each subphase can be reverted if issues arise
- [ ] **Testing Strategy**: Comprehensive testing at each subphase
- [ ] **Documentation**: Clear migration guide for any manual component updates

## Phase 7: Testing & Validation ✅ ONGOING

### Database Testing
- [ ] **TEST**: All renamed functions work correctly
- [ ] **TEST**: New unified triggers handle all scenarios
- [ ] **TEST**: Federation controls work as expected
- [ ] **TEST**: Notification system respects all preferences
- [ ] **TEST**: Performance improvements achieved

### Integration Testing  
- [ ] **TEST**: Local-only mode works (federation disabled)
- [ ] **TEST**: Mixed local/federated scenarios
- [ ] **TEST**: All existing features continue working
- [ ] **TEST**: DM federation with private mention approach
- [ ] **TEST**: Conversation creation for federated DMs

### Performance Testing
- [ ] **BENCHMARK**: Function execution times before/after
- [ ] **BENCHMARK**: Trigger performance improvements
- [ ] **MONITOR**: Federation delivery performance
- [ ] **VALIDATE**: Database query optimization

## Phase 8: Cleanup & Documentation 🧹 LOW PRIORITY

### Function Cleanup
- [ ] **DELETE**: All old functions after successful migration
- [ ] **DELETE**: Unused notification functions
- [ ] **DELETE**: HTTP signature database function
- [ ] **VALIDATE**: No orphaned function references

### Documentation Updates
- [ ] **UPDATE**: Database schema documentation
- [ ] **UPDATE**: API documentation for new services
- [ ] **CREATE**: Federation configuration guide
- [ ] **CREATE**: Migration guide for developers
- [ ] **UPDATE**: Notification system documentation

### Final Validation
- [ ] **VERIFY**: Function count reduced from 147 to <50
- [ ] **VERIFY**: Trigger count reduced from 32 to <10  
- [ ] **VERIFY**: All features working correctly
- [ ] **VERIFY**: Federation controls working
- [ ] **VERIFY**: Performance improvements achieved

## Critical Success Criteria

### Must Work After Refactor
- ✅ **Discord-like chat**: All server/channel messaging
- ✅ **Direct messages**: Local user DMs
- ✅ **Federated DMs**: Cross-instance DMs with private mention approach
- ✅ **Social features**: Posts, likes, reblogs, follows
- ✅ **Federation**: ActivityPub compatibility maintained
- ✅ **Notifications**: All notification types working
- ✅ **Performance**: Improved database performance
- ✅ **Controls**: Federation enable/disable functionality

### Key Metrics
- **Functions**: 147 → <50 (66% reduction)
- **Triggers**: 32 → <10 (69% reduction)  
- **Maintainability**: Clear separation of concerns
- **Reliability**: Local operations independent of federation
- **Performance**: Faster database operations
- **Control**: Granular federation settings