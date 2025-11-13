# Reblog & Emoji Reactions Unified Implementation Plan

## 📋 Executive Summary

This plan addresses the implementation of a unified, professional, DRY, and scalable system for ActivityPub "reblog" (Mastodon-style reposts) and Misskey/Pleroma-style custom emoji "reactions" for posts. The system will ensure proper timeline display, federation, and real-time updates.

## 🔍 Current State Analysis

### 🔄 Reblog System Status

**✅ What's Working:**
- Database schema supports reblogs via `post_interactions` table
- `ActivityPubService.toggleReblog()` creates both interaction records and actual reblog posts
- Federation triggers exist for ActivityPub compliance
- Basic reblog creation and removal functionality

**⚠️ Issues to Fix:**
- Multiple competing reblog implementations causing confusion
- Timeline visibility inconsistencies - reblogs not reliably appearing in feeds
- State management complexity across multiple stores
- Real-time synchronization gaps

**📁 Key Files:**
- `src/services/activityPubService.ts` - Full reblog logic (creates interaction + reblog post)
- `src/services/core/CorePostService.ts` - Simple reblog logic (interaction-only, no reblog post)
- `src/stores/useActivityPub.ts` - Timeline management
- `src/components/activitypub/MonyPost.vue` - Reblog display

### 🎭 Emoji Reactions System Status

**✅ What's Working:**
- Message reactions fully implemented (Discord-style) for chat
- Emoji cache system with server-specific emojis (`useEmojiCache`)
- Custom emoji upload/management via `ServerEmojiManagement.vue`
- Database functions: `add_post_emoji_reaction`, `get_post_emoji_reactions`, `remove_post_emoji_reaction`
- Backend service layer in `CorePostService.toggleReaction()`

**❌ Missing Components:**
- Frontend UI for post emoji reactions (`PostReactions.vue`)
- Emoji picker for posts (`EmojiPicker.vue`)
- ActivityPub federation for post emoji reactions
- Integration with timeline and post components

**📁 Key Files:**
- `src/components/MessageReactions.vue` - Chat reactions (template for posts)
- `src/stores/useReactions.ts` - Reaction state management
- `src/services/emojiService.ts` - Emoji management
- `src/composables/useMessageReactions.ts` - Reaction logic

## 🎯 Implementation Strategy

### Core Principles:
1. **DRY (Don't Repeat Yourself)**: Consolidate multiple reblog implementations
2. **Professional**: Follow ActivityPub standards and best practices
3. **Scalable**: Optimize for performance and maintainability
4. **Unified**: Consistent API patterns across features

### Architecture Goals:
- Single source of truth for reblog logic
- Reusable emoji reaction components
- Proper federation compliance
- Real-time updates with optimistic UI

## 🚀 Implementation Phases

### Phase 1: Reblog System Unification

#### 1.1 Consolidate Reblog Architecture

**Goal**: Single, consistent reblog implementation following Mastodon/ActivityPub standards

**Changes**:

1. **Standardize on ActivityPub approach**: Reblog = new post that references original
2. **Simplify service layer**: Remove duplicate implementations from `CorePostService`
3. **Fix timeline queries**: Ensure reblog posts appear in feeds
4. **Update UI components**: Show proper reblog attribution

**Files to modify**:

- `src/services/activityPubService.ts` - Keep as primary reblog service
- `src/services/core/CorePostService.ts` - Remove competing reblog implementation
- `src/stores/useActivityPub.ts` - Fix timeline reblog visibility
- `src/components/activitypub/MonyPost.vue` - Improve reblog display

#### 1.2 Timeline Integration

**Goal**: Ensure reblog posts appear correctly in all timeline views

**Changes**:

1. Update timeline RPC functions to include reblog posts
2. Fix realtime subscription handling for reblog posts
3. Ensure proper sorting and deduplication
4. Add reblog post filtering options

### Phase 2: Post Emoji Reactions Implementation

#### 2.1 Create Frontend Components

**Goal**: Reusable emoji reaction system for ActivityPub posts

**New files to create**:

- `src/components/activitypub/PostReactions.vue` - Main reaction display component
- `src/components/common/EmojiPicker.vue` - Unified emoji picker
- `src/composables/usePostReactions.ts` - Post reaction composable

**Changes to existing files**:

- `src/components/activitypub/MonyPost.vue` - Integrate reaction display
- `src/services/PostService.ts` - Add reaction service methods
- `src/composables/usePostInteractions.ts` - Add reaction functions

#### 2.2 Backend Service Integration

**Goal**: Connect existing database functions with frontend

**Changes**:

1. Create `PostReactionService` class
2. Integrate with existing emoji cache system
3. Add proper error handling and race condition management
4. Implement optimistic UI updates

### Phase 3: Federation & Real-time Updates

#### 3.1 ActivityPub Compliance

**Goal**: Proper federation of reblogs and reactions

**Changes**:

1. Enhance reblog federation (Announce activities)
2. Implement emoji reaction federation (EmojiReact activities)
3. Add Undo activities for unreblogs/unreactions
4. Custom emoji federation for Misskey/Pleroma compatibility

#### 3.2 Real-time System

**Goal**: Live updates for all interactions

**Changes**:

1. WebSocket events for reblog/reaction changes
2. Optimistic UI updates with rollback on failure
3. Conflict resolution for race conditions
4. Performance optimization for high-volume reactions

## 📋 Detailed Implementation Tasks

### Task 1: Reblog System Cleanup

**Priority**: High
**Estimated Time**: 2-3 days

1. **Remove duplicate reblog logic** from `CorePostService.toggleShare()`
2. **Standardize on** `ActivityPubService.toggleReblog()` as the single implementation
3. **Update timeline queries** to properly include reblog posts
4. **Fix realtime handling** for reblog post creation/deletion
5. **Update UI state management** in `useActivityPub` store

### Task 2: PostReactions Component

**Priority**: High
**Estimated Time**: 3-4 days

1. **Create `PostReactions.vue`** based on `MessageReactions.vue` template
2. **Adapt reaction logic** for posts instead of messages
3. **Integrate emoji cache** for custom emoji display
4. **Add reaction count display** and user indication
5. **Handle loading states** and error conditions

### Task 3: EmojiPicker Component

**Priority**: Medium
**Estimated Time**: 2-3 days

1. **Create unified emoji picker** for both messages and posts
2. **Support Unicode emoji categories** (smileys, objects, etc.)
3. **Display server custom emojis** with search functionality
4. **Add recent/frequently used** emoji tracking
5. **Responsive design** for mobile and desktop

### Task 4: Post Reaction Service

**Priority**: High
**Estimated Time**: 2-3 days

1. **Create `PostReactionService`** class in services layer
2. **Connect to existing database functions** (`add_post_emoji_reaction`, etc.)
3. **Implement optimistic updates** with rollback capability
4. **Add emoji validation** and fallback handling
5. **Integration with emoji cache** system

### Task 5: Federation Enhancement

**Priority**: Medium
**Estimated Time**: 3-4 days

1. **Enhance ActivityPub outbox** for EmojiReact activities
2. **Add custom emoji federation** (Misskey/Pleroma format)
3. **Implement Undo activities** for reaction removal
4. **Update federation triggers** for emoji reactions
5. **Add federation retry logic** for failed deliveries

### Task 6: Real-time Integration

**Priority**: Medium
**Estimated Time**: 2-3 days

1. **Add WebSocket events** for reaction changes
2. **Update realtime subscriptions** in `useActivityPub` store
3. **Implement optimistic UI** with server reconciliation
4. **Add conflict resolution** for simultaneous reactions
5. **Performance optimization** for reaction streams

## 🔧 Technical Implementation Details

### Reblog Data Structure

```typescript
interface ReblogPost {
  id: string
  author_id: string // User who reblogged
  content: [] // Empty content
  ap_type: 'Announce'
  metadata: {
    reblog_of: string // Original post ID
    original_author: string
  }
  reblog: OriginalPost // Full original post
  reblog_author: Profile
  created_at: string
  visibility: string
}
```

### Emoji Reaction Data Structure

```typescript
interface PostEmojiReaction {
  emoji_id: string
  emoji_name: string
  emoji_url?: string // Custom emoji URL
  custom_emoji_content?: string // Unicode emoji
  count: number
  user_reactions: Array<{
    user_id: string
    username: string
    display_name: string
  }>
  user_reacted: boolean // Current user's state
}
```

### API Interfaces

```typescript
// Reblog API
interface ReblogService {
  toggleReblog(postId: string): Promise<{
    reblogged: boolean
    newCount: number
    reblogPost?: ReblogPost
  }>
  
  getRebloggedBy(postId: string): Promise<Profile[]>
}

// Emoji Reaction API
interface PostReactionService {
  addReaction(postId: string, emojiId: string): Promise<void>
  removeReaction(postId: string, emojiId: string): Promise<void>
  getReactions(postId: string): Promise<PostEmojiReaction[]>
  getUserReaction(postId: string, userId: string): Promise<string | null>
}
```

## 🎯 Success Criteria

### Reblog System

1. ✅ User clicks reblog → reblog post appears in feeds immediately
2. ✅ Reblog shows original author with "reblogged by" attribution
3. ✅ Reblog counts update in real-time across all clients
4. ✅ Proper ActivityPub federation to Mastodon/Pleroma instances
5. ✅ Undo reblog removes reblog post and updates counts
6. ✅ Timeline performance remains optimal with reblogs

### Emoji Reactions

1. ✅ Users can add/remove emoji reactions on any public post
2. ✅ Reactions display with counts and user attribution
3. ✅ Support for Unicode and custom server emojis
4. ✅ Reactions federate to compatible ActivityPub instances
5. ✅ Real-time updates when others react to posts
6. ✅ Mobile-friendly reaction interface
7. ✅ Performance scales with high reaction volumes

### Performance Targets

- ⚡ Reaction UI feedback: < 100ms (optimistic updates)
- ⚡ Timeline loading with reblogs: < 500ms
- ⚡ Federation delivery: < 2 seconds
- ⚡ Real-time reaction updates: < 200ms
- 📊 Database query optimization: < 50ms for reaction queries

## 🗓️ Implementation Timeline

### Week 1: Foundation
- Day 1-2: Reblog system cleanup and consolidation
- Day 3-4: Timeline integration fixes
- Day 5: Testing and documentation

### Week 2: Emoji Reactions Frontend
- Day 1-2: PostReactions component creation
- Day 3-4: EmojiPicker component development
- Day 5: Integration with MonyPost component

### Week 3: Backend Integration
- Day 1-2: PostReactionService implementation
- Day 3-4: Real-time updates and WebSocket integration
- Day 5: Error handling and edge cases

### Week 4: Federation & Polish
- Day 1-2: ActivityPub federation for reactions
- Day 3-4: Performance optimization and testing
- Day 5: Documentation and deployment

This comprehensive plan provides a clear roadmap for implementing both reblog and emoji reaction systems in a unified, professional manner that follows ActivityPub standards and provides excellent user experience.
