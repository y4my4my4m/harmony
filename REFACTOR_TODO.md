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

## Phase 4: Database Schema Updates 📊 **NEXT PRIORITY**

### Federation Control Columns
- [ ] **ADD**: Instance-level federation controls to `instance_config`
  - [ ] `federation_enabled` BOOLEAN DEFAULT true
  - [ ] `federation_auto_accept_follows` BOOLEAN DEFAULT true  
  - [ ] `federation_require_approval` BOOLEAN DEFAULT false
- [ ] **ADD**: User-level federation controls to `profiles`
  - [ ] `federation_enabled` BOOLEAN DEFAULT true
  - [ ] `federation_discoverable` BOOLEAN DEFAULT true
  - [ ] `federation_followers_only` BOOLEAN DEFAULT false

### Federation Performance Indexes
- [ ] **ADD**: Index on `ap_activities.status` for delivery queue performance
- [ ] **ADD**: Index on `federation_delivery_queue.status, next_attempt_at`
- [ ] **ADD**: Index on `federated_instances.domain, is_blocked`
- [ ] **ADD**: Index on `profiles.domain, federation_enabled`

### Federation Health Monitoring
- [ ] **ADD**: `federation_health` table for monitoring federation status
- [ ] **ADD**: `federation_errors` table for error tracking
- [ ] **ENHANCE**: `federated_instances` with more health metrics

## Phase 5: Service Layer Implementation 🏗️ LOW PRIORITY (After DB Refactor)

### Local-First Services  
- [ ] **CREATE**: `PostService` class
  - [ ] `createPost()` - Create posts locally first
  - [ ] `editPost()` - Edit posts with federation
  - [ ] `deletePost()` - Delete posts with federation
  - [ ] `likePost()` / `unlikePost()` - Local-first interactions
  - [ ] `reblogPost()` / `unreblogPost()` - Local-first reblogs
- [ ] **CREATE**: `MessageService` class  
  - [ ] `sendMessage()` - Send channel messages
  - [ ] `sendDM()` - Send direct messages (local and federated)
  - [ ] `editMessage()` - Edit messages with federation
  - [ ] `deleteMessage()` - Delete messages with federation
- [ ] **CREATE**: `InteractionService` class
  - [ ] `followUser()` / `unfollowUser()` - Local-first follows
  - [ ] `blockUser()` / `unblockUser()` - Local-first blocks
  - [ ] `acceptFollow()` / `rejectFollow()` - Handle follow requests

### Federation Services
- [ ] **CREATE**: `FederationManager` class
  - [ ] Central federation control and configuration
  - [ ] Health monitoring and status
  - [ ] Enable/disable federation controls
- [ ] **CREATE**: `IncomingFederationHandler` class
  - [ ] Process all incoming ActivityPub activities
  - [ ] Unified entry point for federation
  - [ ] Validation and security checks
- [ ] **CREATE**: `OutgoingFederationHandler` class
  - [ ] Queue all outgoing ActivityPub activities  
  - [ ] Determine federation targets
  - [ ] Handle delivery and retries

## Phase 6: Frontend Store Migration 🖥️ LOW PRIORITY

### Store Updates
- [ ] **REFACTOR**: `useActivityPub.ts` to use new service layer
- [ ] **REFACTOR**: `useChat.ts` to use new MessageService
- [ ] **REFACTOR**: `useDM.ts` to use unified conversation handling
- [ ] **REFACTOR**: `useProfile.ts` to use new InteractionService
- [ ] **ADD**: Federation status indicators in UI
- [ ] **ADD**: Federation controls in user settings

### Edge Function Updates
- [ ] **UPDATE**: `inbox/index.ts` to use new IncomingFederationHandler
- [ ] **UPDATE**: Outbox functions to use new OutgoingFederationHandler
- [ ] **ADD**: HTTP signature handling in edge functions
- [ ] **REMOVE**: Database HTTP signature dependencies

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