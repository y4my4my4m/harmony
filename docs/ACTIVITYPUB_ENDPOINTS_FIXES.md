# ActivityPub Endpoints Fix Implementation

This file contains the actual code fixes for the outbox, featured, followers, and following endpoints based on the issues identified in the review.

## Priority 1: Fix Featured Endpoint (Critical)

The featured endpoint is currently querying for a non-existent `is_pinned` column. Here's the fix:

### File: `/supabase/functions/featured/index.ts`

**Replace this query:**
```typescript
const { data: posts, error } = await supabase
  .from('posts')
  .select(`
    id,
    content,
    created_at,
    updated_at,
    author:profiles(id, username, display_name, avatar_url, domain, federated_id),
    interactions_count,
    replies_count
  `)
  .eq('author_id', user.id)
  .eq('is_pinned', true) // ❌ This column doesn't exist!
  .order('created_at', { ascending: false })
  .limit(20)
```

**With this:**
```typescript
const { data: posts, error } = await supabase
  .from('posts')
  .select(`
    id,
    content,
    created_at,
    updated_at,
    author:profiles(id, username, display_name, avatar_url, domain, federated_id),
    interactions_count,
    replies_count
  `)
  .eq('author_id', user.id)
  .order('interactions_count', { ascending: false }) // Show most popular posts
  .limit(5) // Limit to top 5 as "featured"
```

## Priority 2: Use Database Functions for Content Processing

### For Both Outbox and Featured Endpoints

**Replace the local `formatPostContent` function calls with database functions:**

```typescript
// OLD WAY (remove this):
const content = formatPostContent(post.content)

// NEW WAY (use this):
const { data: htmlContent } = await supabase.rpc(
  'convert_unified_content_to_activitypub_html', 
  { content: post.content }
)

const { data: allTags } = await supabase.rpc(
  'extract_all_activitypub_tags',
  { content: post.content }
)

const content = htmlContent || ''
const tag = allTags || []
```

### Complete Note Object Creation

**Replace the note creation with this improved version:**

```typescript
const note = {
  '@context': [
    'https://www.w3.org/ns/activitystreams',
    'https://w3id.org/security/v1',
    {
      'Hashtag': 'as:Hashtag',
      'sensitive': 'as:sensitive',
      'toot': 'http://joinmastodon.org/ns#',
      'Emoji': 'toot:Emoji'
    }
  ],
  id: `${instanceDomain}/posts/${post.id}`,
  type: 'Note',
  published: post.created_at,
  attributedTo: `${instanceDomain}/users/${post.author.username}`,
  content: htmlContent || '',
  url: `${instanceDomain}/posts/${post.id}`,
  tag: allTags || [],
  replies: {
    id: `${instanceDomain}/posts/${post.id}/replies`,
    type: 'Collection',
    totalItems: post.replies_count || 0
  },
  likes: {
    id: `${instanceDomain}/posts/${post.id}/likes`,
    type: 'Collection', 
    totalItems: post.interactions_count || 0
  },
  shares: {
    id: `${instanceDomain}/posts/${post.id}/shares`,
    type: 'Collection',
    totalItems: 0 // Add actual shares count if available
  }
}

// Add conversation threading if it's a reply
if (post.reply_to_id) {
  note.inReplyTo = `${instanceDomain}/posts/${post.reply_to_id}`
}
```

## Priority 3: Add Privacy Controls for Followers/Following

### For Followers and Following Endpoints

**Add this privacy check at the beginning:**

```typescript
// Add after getting the user but before querying followers/following
const { data: profile, error: profileError } = await supabase
  .from('profiles')
  .select('privacy_settings')
  .eq('id', user.id)
  .single()

if (profileError) {
  console.error('Profile error:', profileError)
  return new Response('Profile not found', { status: 404, headers: corsHeaders })
}

// Check if followers/following should be hidden
const hideFollowers = profile?.privacy_settings?.hide_followers
const hideFollowing = profile?.privacy_settings?.hide_following

// For followers endpoint:
if (hideFollowers) {
  return new Response(JSON.stringify({
    '@context': 'https://www.w3.org/ns/activitystreams',
    id: `${instanceDomain}/users/${username}/followers`,
    type: 'OrderedCollection',
    totalItems: 0,
    orderedItems: []
  }), {
    status: 200,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/activity+json; charset=utf-8'
    }
  })
}

// For following endpoint:
if (hideFollowing) {
  return new Response(JSON.stringify({
    '@context': 'https://www.w3.org/ns/activitystreams', 
    id: `${instanceDomain}/users/${username}/following`,
    type: 'OrderedCollection',
    totalItems: 0,
    orderedItems: []
  }), {
    status: 200,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/activity+json; charset=utf-8'
    }
  })
}
```

## Priority 4: Improve Error Handling

### Add This Error Handling Pattern to All Endpoints

```typescript
try {
  const { data, error } = await supabase...
  
  if (error) {
    console.error('Database error:', error)
    return new Response(JSON.stringify({
      error: 'Database error',
      details: error.message
    }), {
      status: 500,
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json'
      }
    })
  }
  
  // Process data...
  
} catch (err) {
  console.error('Unexpected error:', err)
  return new Response(JSON.stringify({
    error: 'Internal server error'
  }), {
    status: 500,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/json'
    }
  })
}
```

## Priority 5: Add Caching Headers

### For All Endpoints, Update Headers:

```typescript
const headers = {
  ...corsHeaders,
  'Content-Type': 'application/activity+json; charset=utf-8',
  'Cache-Control': 'public, max-age=300', // Cache for 5 minutes
  'Vary': 'Accept',
  'X-RateLimit-Limit': '100',
  'X-RateLimit-Remaining': '99'
}
```

## Implementation Order

1. **Start with Featured endpoint** - Fix the `is_pinned` query first (this is breaking)
2. **Update content processing** - Replace `formatPostContent` with database functions
3. **Add privacy controls** - For followers/following endpoints
4. **Improve error handling** - Add try/catch blocks
5. **Add caching headers** - For better performance

## Testing

After implementing these fixes:

1. Test each endpoint manually: `/users/{username}/outbox`, `/users/{username}/featured`, etc.
2. Verify ActivityPub compliance with: https://activitypub.rocks/
3. Test federation with another ActivityPub server
4. Check that privacy controls work correctly

## Notes

- These fixes maintain backward compatibility
- All changes are incremental improvements
- The endpoints will work better with other ActivityPub servers
- Content processing will be more consistent and efficient
