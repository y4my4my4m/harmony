# Emoji Reaction Federation Compatibility Analysis & Fix Plan

## 📋 Executive Summary

This document analyzes the current federation implementation for emoji reactions and provides a comprehensive plan to fix compatibility issues with Misskey, Pleroma, and other ActivityPub platforms. Our current reactions work locally but have federation compatibility problems that prevent them from being properly received and processed by remote instances.

## 🔍 Current State Analysis

### ✅ What's Working (Local Only)
- **Local Database Operations**: Full CRUD operations via `add_post_emoji_reaction`, `remove_post_emoji_reaction`, and `get_post_emoji_reactions` functions
- **Frontend Implementation**: Complete PostReactions.vue component with optimistic updates, batch fetching, and real-time updates
- **Store Architecture**: Unified postReactions store following the same pattern as message reactions
- **User Experience**: Instant feedback, audio reactions, tooltip limits, and proper error handling

### ❌ Federation Issues Identified

#### 1. **No Federation Integration**
**Problem**: The current `postReactions.ts` store and database functions operate in isolation without any federation hooks.

**Evidence**:
```typescript
// Current toggleReaction in postReactions.ts - NO federation calls
const { error } = await supabase.rpc('add_post_emoji_reaction', {
  p_user_id: userId,
  p_post_id: postId,
  p_emoji_id: emoji.id || null,
  p_custom_emoji_content: emoji.native || emoji.name || null
})
// Missing: Federation activity creation
```

#### 2. **Missing ActivityPub Activity Creation**
**Problem**: While `FederationActivityService.createPostReactionActivity()` exists, it's never called from the reaction flow.

**Evidence**: No calls to `createPostReactionActivity` found in:
- `src/stores/postReactions.ts`
- `src/composables/usePostReactions.ts` 
- `src/components/activitypub/PostReactions.vue`

#### 3. **Incorrect Activity Type for Misskey/Pleroma**
**Problem**: Current implementation uses standard `Like` activities, but Misskey/Pleroma expect specialized formats.

**Current Implementation**:
```typescript
// In FederationActivityService.ts - Standard ActivityPub Like
{
  '@context': 'https://www.w3.org/ns/activitystreams',
  type: 'Like',
  actor: actor.federated_id,
  object: `${instanceDomain}/posts/${postData.id}`,
  content: emojiData.name
}
```

**What Misskey Expects**:
```typescript
{
  "@context": [
    "https://www.w3.org/ns/activitystreams",
    {
      "_misskey_reaction": "https://misskey-hub.net/ns#_misskey_reaction"
    }
  ],
  "type": "EmojiReaction", // ← Key difference
  "actor": "https://misskey.io/users/example",
  "object": "https://example.com/posts/123",
  "_misskey_reaction": "👍", // ← Misskey-specific field
  "content": "👍"
}
```

#### 4. **Missing Incoming Federation Handling**
**Problem**: The inbox handler (`supabase/functions/inbox/index.ts`) doesn't process incoming `EmojiReaction` activities.

**Evidence**:
```typescript
// Current inbox handler only handles:
case 'Follow':
case 'Accept':
case 'Reject': 
case 'Undo':
case 'Update':
case 'Delete':
case 'Like':        // ← Generic Like, not EmojiReaction
case 'Announce':
case 'Create':
// Missing: case 'EmojiReaction':
```

#### 5. **Database Schema Gaps**
**Problem**: No storage for federated reaction metadata or remote actor information.

**Missing Fields**:
- `federated_actor_uri` - Who sent the reaction from remote instance
- `federated_activity_id` - Original ActivityPub activity ID
- `remote_emoji_url` - Custom emoji from remote instances

## 🎯 Compatibility Requirements

### Misskey Requirements
1. **Activity Type**: Must use `EmojiReaction` instead of `Like`
2. **Special Fields**: Must include `_misskey_reaction` field
3. **Custom Emojis**: Must include proper emoji metadata and URLs
4. **Context**: Must include Misskey namespace in `@context`

### Pleroma Requirements
1. **Activity Type**: Supports both `EmojiReaction` and `Like` with emoji content
2. **Emoji Format**: Uses `:emoji_name:` format for custom emojis
3. **Tag Support**: Custom emojis should be in `tag` array

### Mastodon Requirements
1. **Activity Type**: Uses standard `Like` activities
2. **No Custom Emojis**: Only supports Unicode emoji in reactions
3. **Content Field**: Emoji should be in `content` field

## 🔧 Technical Fix Plan

### Phase 1: Outgoing Federation (1-2 days)

#### 1.1 Integrate Federation into Reaction Toggle
**File**: `src/stores/postReactions.ts`

**Change**: Add federation hook after successful database operation:

```typescript
// After successful database operation
if (operation === 'add') {
  const { error } = await supabase.rpc('add_post_emoji_reaction', {
    p_user_id: userId,
    p_post_id: postId,
    p_emoji_id: emoji.id || null,
    p_custom_emoji_content: emoji.native || emoji.name || null
  })
  if (error) throw error
  
  // NEW: Trigger federation
  try {
    const federationService = FederationActivityService.getInstance()
    await federationService.createPostReactionActivity(
      postId, 
      emoji.id || 'unicode', // Handle unicode emojis
      userId, 
      'add'
    )
  } catch (federationError) {
    console.warn('Federation failed, but local reaction succeeded:', federationError)
    // Don't fail the entire operation if federation fails
  }
}
```

#### 1.2 Fix Activity Format for Multi-Platform Compatibility
**File**: `src/services/federation/FederationActivityService.ts`

**Change**: Update `buildPostReactionActivityData` to generate format compatible with all platforms:

```typescript
private async buildPostReactionActivityData(params: {
  activityId: string
  activityType: string
  actor: any
  postData: any
  emojiData: any
  operation: 'add' | 'remove'
}) {
  const { activityId, activityType, actor, postData, emojiData, operation } = params
  const instanceDomain = await this.getInstanceDomain()

  if (operation === 'add') {
    // Multi-platform compatible reaction activity
    const baseActivity = {
      '@context': [
        'https://www.w3.org/ns/activitystreams',
        {
          'toot': 'http://joinmastodon.org/ns#',
          '_misskey_reaction': 'https://misskey-hub.net/ns#_misskey_reaction'
        }
      ],
      id: activityId,
      type: 'EmojiReaction', // Use EmojiReaction for Misskey/Pleroma compatibility
      actor: actor.federated_id,
      object: `${instanceDomain}/posts/${postData.id}`,
      published: new Date().toISOString(),
      content: emojiData.name || emojiData.native
    }

    // Add Misskey-specific field
    if (emojiData.native) {
      baseActivity._misskey_reaction = emojiData.native
    } else if (emojiData.name) {
      baseActivity._misskey_reaction = `:${emojiData.name}:`
    }

    // Add emoji tag for custom emojis (Pleroma compatibility)
    if (emojiData.url) {
      baseActivity.tag = [{
        id: emojiData.url,
        type: 'Emoji',
        name: `:${emojiData.name}:`,
        icon: {
          type: 'Image',
          url: emojiData.url
        }
      }]
    }

    return baseActivity
  } else {
    // Undo EmojiReaction activity
    return {
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: activityId,
      type: 'Undo',
      actor: actor.federated_id,
      object: {
        type: 'EmojiReaction',
        object: `${instanceDomain}/posts/${postData.id}`,
        content: emojiData.name || emojiData.native
      },
      published: new Date().toISOString()
    }
  }
}
```

### Phase 2: Incoming Federation (2-3 days)

#### 2.1 Extend Database Schema
**File**: Create migration `extend_post_interactions_federation.sql`

```sql
-- Add federation fields to post_interactions table
ALTER TABLE post_interactions 
ADD COLUMN federated_actor_uri TEXT,
ADD COLUMN federated_activity_id TEXT,
ADD COLUMN remote_emoji_url TEXT,
ADD COLUMN is_federated BOOLEAN DEFAULT FALSE;

-- Create index for federated lookups
CREATE INDEX idx_post_interactions_federated_activity 
ON post_interactions(federated_activity_id) 
WHERE federated_activity_id IS NOT NULL;
```

#### 2.2 Update Database Functions
**File**: Update `add_post_emoji_reaction` function

```sql
CREATE OR REPLACE FUNCTION public.add_post_emoji_reaction(
    p_user_id uuid, 
    p_post_id uuid, 
    p_emoji_id uuid DEFAULT NULL::uuid, 
    p_custom_emoji_content text DEFAULT NULL::text,
    p_federated_actor_uri text DEFAULT NULL::text,
    p_federated_activity_id text DEFAULT NULL::text,
    p_remote_emoji_url text DEFAULT NULL::text
) RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
AS $function$
DECLARE
    v_interaction_id uuid;
BEGIN
    INSERT INTO post_interactions (
        post_id, user_id, interaction_type, emoji_id, 
        custom_emoji_content, federated_actor_uri, 
        federated_activity_id, remote_emoji_url, is_federated
    ) VALUES (
        p_post_id, p_user_id, 'emoji_reaction', p_emoji_id, 
        p_custom_emoji_content, p_federated_actor_uri,
        p_federated_activity_id, p_remote_emoji_url,
        (p_federated_actor_uri IS NOT NULL)
    )
    RETURNING id INTO v_interaction_id;
    
    RETURN v_interaction_id;
END;
$function$;
```

#### 2.3 Extend Inbox Handler
**File**: `supabase/functions/inbox/index.ts`

**Change**: Add EmojiReaction handling:

```typescript
// Add to activity type switch
case 'EmojiReaction':
  isValid = await processEmojiReactionActivity(supabase, activity, ourDomain)
  break

// Add new processing function
async function processEmojiReactionActivity(
  supabase: any, 
  activity: ActivityPubActivity, 
  ourDomain: string
): Promise<boolean> {
  try {
    const actorUri = typeof activity.actor === 'string' ? activity.actor : activity.actor?.id
    const objectUrl = typeof activity.object === 'string' ? activity.object : activity.object?.id
    
    // Extract post ID from object URL
    const postIdMatch = objectUrl?.match(/\/posts\/([a-f0-9-]+)/)
    if (!postIdMatch) {
      console.warn('Could not extract post ID from object:', objectUrl)
      return false
    }
    
    const postId = postIdMatch[1]
    const emoji = activity._misskey_reaction || activity.content
    const remoteEmojiUrl = activity.tag?.[0]?.icon?.url
    
    // Get or create federated user
    const { data: federatedUser } = await supabase
      .rpc('get_or_create_federated_user', {
        p_actor_uri: actorUri,
        p_actor_data: { /* actor data from activity */ }
      })
    
    if (!federatedUser) {
      console.warn('Could not process federated user:', actorUri)
      return false
    }
    
    // Add federated reaction
    const { error } = await supabase.rpc('add_post_emoji_reaction', {
      p_user_id: federatedUser.id,
      p_post_id: postId,
      p_emoji_id: null, // Federated reactions don't use local emoji IDs
      p_custom_emoji_content: emoji,
      p_federated_actor_uri: actorUri,
      p_federated_activity_id: activity.id,
      p_remote_emoji_url: remoteEmojiUrl
    })
    
    if (error) {
      console.error('Failed to add federated reaction:', error)
      return false
    }
    
    console.log('✅ Added federated emoji reaction:', emoji, 'from', actorUri)
    return true
    
  } catch (error) {
    console.error('Error processing EmojiReaction activity:', error)
    return false
  }
}
```

### Phase 3: Enhanced Compatibility (1-2 days)

#### 3.1 Multi-Format Outgoing Activities
**Goal**: Send activities in the format that each remote instance expects

**Implementation**: Detect remote instance type and format activities accordingly:

```typescript
// In delivery logic - detect instance type and format appropriately
private async formatActivityForRemoteInstance(activity: any, remoteInstanceUrl: string) {
  const instanceType = await this.detectInstanceType(remoteInstanceUrl)
  
  switch (instanceType) {
    case 'misskey':
      return this.formatForMisskey(activity)
    case 'pleroma':
      return this.formatForPleroma(activity)
    case 'mastodon':
      return this.formatForMastodon(activity)
    default:
      return activity // Standard ActivityPub format
  }
}
```

#### 3.2 Custom Emoji Federation
**Goal**: Properly federate custom server emojis to remote instances

**Implementation**: Include custom emoji metadata in activities and handle remote custom emojis

#### 3.3 Fallback Handling
**Goal**: Graceful degradation when remote instances don't support reactions

**Implementation**: Convert reactions to standard Like activities for instances that don't support EmojiReaction

## 🧪 Testing Plan

### Unit Tests
1. **Federation Activity Creation**: Test all emoji types (unicode, custom, remote)
2. **Inbox Processing**: Test various ActivityPub reaction formats
3. **Database Operations**: Test federated reaction storage and retrieval

### Integration Tests
1. **Local to Misskey**: Send reactions from Harmony to test Misskey instance
2. **Misskey to Local**: Receive reactions from Misskey into Harmony
3. **Multi-Platform**: Test reactions between Harmony, Misskey, Pleroma, and Mastodon
4. **Custom Emoji**: Test custom emoji reactions across platforms

### Manual Testing
1. **UI Behavior**: Verify optimistic updates work with federation
2. **Error Handling**: Test network failures, malformed activities
3. **Performance**: Ensure federation doesn't slow down local reactions

## 📊 Expected Outcomes

### Immediate Benefits
- ✅ Reactions federate to Misskey/Pleroma/Mastodon instances
- ✅ Remote reactions appear in local timeline
- ✅ Custom emojis work across federation
- ✅ Full bidirectional reaction compatibility

### Performance Impact
- **Minimal Local Impact**: Federation runs asynchronously, won't slow down local reactions
- **Improved User Experience**: Users can interact with federated content seamlessly
- **Better Compatibility**: Harmony becomes a better citizen of the fediverse

## 🗓️ Implementation Schedule

### Day 1: Outgoing Federation
- Integrate federation hooks into postReactions store
- Update FederationActivityService activity format
- Basic testing with Misskey format

### Day 2: Activity Format Optimization  
- Multi-platform compatibility improvements
- Custom emoji handling in activities
- Testing with different emoji types

### Day 3: Database Schema & Functions
- Migration for federation fields
- Updated database functions
- Testing federated reaction storage

### Day 4: Incoming Federation
- Inbox handler updates
- EmojiReaction activity processing
- Remote user handling

### Day 5: Testing & Refinement
- Integration testing with real instances
- Performance optimization
- Error handling improvements

## 🚀 Next Steps

1. **Create migration files** for database schema changes
2. **Update FederationActivityService** with multi-platform activity format
3. **Integrate federation** into postReactions store
4. **Extend inbox handler** for incoming EmojiReaction activities
5. **Test federation** with real Misskey/Pleroma instances

This plan addresses all the identified federation issues and provides a path to full compatibility with the ActivityPub ecosystem while maintaining the excellent local user experience already implemented.
