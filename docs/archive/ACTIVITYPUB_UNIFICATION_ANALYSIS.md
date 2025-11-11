# ActivityPub Thread and Post Unification Analysis

## Current State Analysis

### Current Routing Structure
The system currently has **two separate routes** for handling posts and threads:

1. **Individual Post Route**: `/social/post/:postId`
   - Component: `PostDetailView.vue`
   - Shows a single post in detail
   - Displays replies in a simple linear format
   - Limited conversation context

2. **Thread/Conversation Route**: `/social/conversation/:postId`
   - Component: `ConversationThreadView.vue`
   - Shows full conversation thread
   - Displays ancestors and descendants
   - Rich threading with proper nesting
   - Better conversation context

### Current Service Architecture
The `ActivityPubService` has **duplicate logic** for handling posts and conversations:

#### Post-Related Methods:
- `createPost()` - Creates new posts
- `getTimeline()` - Gets timeline posts
- `getPublicTimeline()` - Gets public posts
- `getLocalTimeline()` - Gets local posts

#### Thread-Related Methods:
- `getConversationContext()` - Gets ancestors/descendants
- `getConversationThread()` - Gets full thread
- `getPostReplies()` - Gets replies to a post

### Current Types Structure
The type system has **overlapping concepts**:
- `ActivityPubPost` - Base post type
- `TimelinePost` - Enhanced post for timelines
- `ConversationThread` - Thread container
- `ConversationContext` - Ancestors/descendants

### Current Issues

#### 1. **Duplicate Logic & Code**
- Two separate views doing similar things
- Duplicate API calls for post data
- Inconsistent UX between post detail and thread view
- Maintenance burden of keeping both in sync

#### 2. **Poor User Experience**
- Users confused about when to use which view
- Inconsistent navigation patterns
- Breaking ActivityPub federation standards
- No standardized URL structure for posts

#### 3. **Federation Compatibility Issues**
- Current URLs don't follow ActivityPub conventions
- External instances can't properly link to posts
- Poor interoperability with Mastodon, Pleroma, etc.
- SEO and sharing problems

#### 4. **Performance Problems**
- Multiple API calls for the same data
- Inefficient data fetching
- No proper caching strategy
- Redundant database queries

## Proposed Unified Solution

### New URL Structure (ActivityPub Compliant)
```
/posts/:uuid                          # Main post URL (ActivityPub standard)
/posts/:uuid?reply=:replyId          # Highlight specific reply
/posts/:uuid?context=thread          # Show full thread context
/posts/:uuid?context=minimal         # Show minimal context (default)
```

#### URL Parameters:
- `uuid` - The post ID (primary post being viewed)
- `reply` - Optional: Highlight a specific reply in the thread
- `context` - Optional: `thread|minimal|ancestors|descendants`
- `t` - Optional: Timestamp for deep linking

### Unified Component Architecture

#### Single Unified Component: `PostView.vue`
```vue
<template>
  <div class="post-view">
    <!-- Header with context info -->
    <PostViewHeader 
      :post="mainPost"
      :context="viewContext"
      :thread-info="threadInfo"
    />
    
    <!-- Conversation ancestors (if any) -->
    <ConversationAncestors 
      v-if="showAncestors && ancestors.length"
      :ancestors="ancestors"
      :highlighted-post="highlightedPostId"
    />
    
    <!-- Main post (always shown) -->
    <MainPost
      :post="mainPost"
      :is-highlighted="isMainPostHighlighted"
      :context="viewContext"
    />
    
    <!-- Conversation descendants (replies) -->
    <ConversationDescendants
      v-if="showDescendants && descendants.length"
      :descendants="descendants"
      :highlighted-post="highlightedPostId"
      :max-depth="maxThreadDepth"
    />
    
    <!-- Reply composer -->
    <ReplyComposer
      v-if="canReply"
      :reply-to="replyToPost"
    />
  </div>
</template>
```

### Unified Service Architecture

#### Single Method: `getPostWithContext()`
```typescript
async getPostWithContext(
  postId: string, 
  options: PostContextOptions = {}
): Promise<PostWithContext> {
  const {
    context = 'minimal',     // 'minimal' | 'thread' | 'ancestors' | 'descendants'
    highlightReply,          // Specific reply to highlight
    maxDepth = 10,           // Maximum thread depth
    includeInteractions = true
  } = options;

  // Single RPC call that returns everything needed
  const { data, error } = await supabase.rpc('get_post_with_context', {
    p_post_id: postId,
    p_user_id: user.id,
    p_context_type: context,
    p_highlight_reply: highlightReply,
    p_max_depth: maxDepth,
    p_include_interactions: includeInteractions
  });

  return {
    mainPost: data.main_post,
    ancestors: data.ancestors || [],
    descendants: data.descendants || [],
    threadInfo: data.thread_info,
    highlightedPost: highlightReply,
    contextType: context
  };
}
```

### New Unified Types

```typescript
export interface PostWithContext {
  mainPost: TimelinePost;
  ancestors: TimelinePost[];
  descendants: TimelinePost[];
  threadInfo: ThreadInfo;
  highlightedPost?: string;
  contextType: PostContextType;
}

export interface ThreadInfo {
  totalPosts: number;
  participantCount: number;
  depth: number;
  rootPostId: string;
  lastActivity: string;
}

export type PostContextType = 'minimal' | 'thread' | 'ancestors' | 'descendants';

export interface PostContextOptions {
  context?: PostContextType;
  highlightReply?: string;
  maxDepth?: number;
  includeInteractions?: boolean;
}
```

### Database Optimization

#### Single RPC Function: `get_post_with_context()`
```sql
CREATE OR REPLACE FUNCTION get_post_with_context(
  p_post_id UUID,
  p_user_id UUID,
  p_context_type TEXT DEFAULT 'minimal',
  p_highlight_reply UUID DEFAULT NULL,
  p_max_depth INTEGER DEFAULT 10,
  p_include_interactions BOOLEAN DEFAULT TRUE
) RETURNS JSONB AS $$
-- Single function that handles all post context scenarios
-- Returns: { main_post, ancestors, descendants, thread_info }
$$;
```

### Router Unification

#### New Route Structure:
```typescript
{
  path: '/posts/:postId',
  name: 'Post',
  component: () => import('@/views/PostView.vue'),
  props: route => ({
    postId: route.params.postId as string,
    highlightReply: route.query.reply as string,
    contextType: route.query.context as PostContextType || 'minimal',
    timestamp: route.query.t ? parseInt(route.query.t as string) : null
  })
}
```

**Note**: Since this project isn't publicly released yet, we can remove the old routes entirely without backward compatibility concerns.

## Implementation Benefits

### 1. **ActivityPub Compliance**
- ✅ Standard `/posts/:uuid` URL structure
- ✅ Compatible with Mastodon, Pleroma, Misskey
- ✅ Proper federation linking
- ✅ SEO-friendly URLs

### 2. **DRY & Maintainable Code**
- ✅ Single component instead of two
- ✅ Single service method for all post contexts
- ✅ Unified type system
- ✅ Reduced code duplication by ~40%

### 3. **Better Performance**
- ✅ Single database query for all data
- ✅ Optimized caching strategy
- ✅ Reduced API calls
- ✅ Faster page loads

### 4. **Enhanced User Experience**
- ✅ Consistent interface for all post views
- ✅ Smooth context switching (minimal ↔ thread)
- ✅ Proper deep linking
- ✅ Better mobile experience

### 5. **Professional & Scalable**
- ✅ Industry-standard URL patterns
- ✅ Future-proof architecture
- ✅ Easy to extend with new features
- ✅ Better testing capabilities

## Migration Strategy

### Phase 1: Backend Unification (1-2 days)
1. Create unified `get_post_with_context()` RPC function
2. Add new service method `getPostWithContext()`
3. Create unified types (`PostWithContext`, etc.)
4. Add comprehensive tests

### Phase 2: Frontend Unification (2-3 days)
1. Create unified `PostView.vue` component
2. Break down into smaller sub-components
3. Add route with new URL structure
4. Implement context switching logic

### Phase 3: Migration & Cleanup (1 day)

1. Update all internal links to new `/posts/:uuid` format
2. Remove old `PostDetailView.vue` and `ConversationThreadView.vue` components
3. Remove old routes from router
4. Update documentation and examples

### Phase 4: Testing & Polish (1 day)

1. Test federation compatibility with new URLs
2. Test all context scenarios (minimal, thread, ancestors, descendants)
3. Performance optimization and caching
4. Final UX polish and accessibility improvements

## Expected Outcomes

### Code Quality Metrics:
- **Reduced codebase size**: ~300 lines removed
- **Improved maintainability**: Single source of truth
- **Better test coverage**: Unified testing strategy
- **Enhanced type safety**: Consolidated type system

### User Experience Metrics:
- **Faster load times**: Single optimized query
- **Better navigation**: Consistent URL patterns
- **Improved mobile UX**: Responsive unified component
- **Enhanced accessibility**: Consolidated a11y implementation

### Federation Compatibility:
- **Standard URLs**: Compatible with all ActivityPub implementations
- **Proper linking**: External instances can link correctly
- **Better SEO**: Search engine friendly URLs
- **Future-proof**: Follows ActivityPub specifications

This unified approach will make Harmony's post system more professional, maintainable, and compatible with the broader ActivityPub ecosystem while providing a superior user experience.
