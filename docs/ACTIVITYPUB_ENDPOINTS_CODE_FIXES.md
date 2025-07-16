# ActivityPub Endpoints - Specific Code Fixes

This file contains the exact code changes needed for each endpoint based on their current implementation.

## 1. Featured Endpoint Fix (CRITICAL - Currently Working)

Your featured endpoint is actually working fine! You're using `favorites_count` instead of `is_pinned`, which is smart. However, let's apply the database function improvements.

### File: `/supabase/functions/featured/index.ts`

**Replace the `formatPostContent` function with database functions:**

```typescript
// REPLACE THIS SECTION (around lines 130-160):
const noteObject: any = {
  id: post.ap_id || `${baseUrl}/posts/${post.id}`,
  type: post.ap_type || 'Note',
  attributedTo: `${baseUrl}/users/${username}`,
  content: formatPostContent(post.content), // ❌ Replace this line
  published: post.created_at,
  to: post.visibility === 'public' ? ['https://www.w3.org/ns/activitystreams#Public'] : [],
  cc: [],
  ...(post.content_warning && { summary: post.content_warning }),
  ...(post.in_reply_to && { inReplyTo: post.in_reply_to })
};

// WITH THIS:
// Get properly formatted content and tags from database
const { data: htmlContent } = await supabase.rpc(
  'convert_unified_content_to_activitypub_html', 
  { content: post.content }
)

const { data: allTags } = await supabase.rpc(
  'extract_all_activitypub_tags',
  { content: post.content }
)

const noteObject: any = {
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
  id: post.ap_id || `${baseUrl}/posts/${post.id}`,
  type: post.ap_type || 'Note',
  attributedTo: `${baseUrl}/users/${username}`,
  content: htmlContent || '',
  published: post.created_at,
  to: post.visibility === 'public' ? ['https://www.w3.org/ns/activitystreams#Public'] : [],
  cc: [],
  tag: allTags || [],
  ...(post.content_warning && { summary: post.content_warning }),
  ...(post.in_reply_to && { inReplyTo: post.in_reply_to })
};
```

**Also remove the local `formatPostContent` function entirely (lines 181-229) since we're using the database function.**

## 2. Outbox Endpoint Fix

### File: `/supabase/functions/outbox/index.ts`

**Apply the same database function replacement:**

```typescript
// REPLACE THIS SECTION (around lines 130-150):
const activityObject: any = {
  id: post.ap_id || `${baseUrl}/posts/${post.id}`,
  type: post.ap_type || 'Note',
  attributedTo: `${baseUrl}/users/${username}`,
  content: formatPostContent(post.content), // ❌ Replace this line
  published: post.created_at,
  to: post.visibility === 'public' ? ['https://www.w3.org/ns/activitystreams#Public'] : [],
  cc: [],
  ...(post.content_warning && { summary: post.content_warning }),
  ...(post.in_reply_to && { inReplyTo: post.in_reply_to })
};

// WITH THIS:
// Get properly formatted content and tags from database  
const { data: htmlContent } = await supabase.rpc(
  'convert_unified_content_to_activitypub_html', 
  { content: post.content }
)

const { data: allTags } = await supabase.rpc(
  'extract_all_activitypub_tags',
  { content: post.content }
)

const activityObject: any = {
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
  id: post.ap_id || `${baseUrl}/posts/${post.id}`,
  type: post.ap_type || 'Note',
  attributedTo: `${baseUrl}/users/${username}`,
  content: htmlContent || '',
  published: post.created_at,
  to: post.visibility === 'public' ? ['https://www.w3.org/ns/activitystreams#Public'] : [],
  cc: [],
  tag: allTags || [],
  ...(post.content_warning && { summary: post.content_warning }),
  ...(post.in_reply_to && { inReplyTo: post.in_reply_to })
};
```

**Also remove the local `formatPostContent` function (lines 226-271).**

## 3. Followers Endpoint - Add Privacy Controls

### File: `/supabase/functions/followers/index.ts`

**Add privacy check after user lookup (around line 60):**

```typescript
// ADD THIS AFTER THE USER LOOKUP:
const { data: user, error: userError } = await supabase
  .from('profiles')
  .select('id, username, domain')
  .eq('username', username)
  .eq('domain', ourDomain)
  .eq('is_local', true)
  .single()

if (userError || !user) {
  return new Response('User not found', { 
    status: 404, 
    headers: corsHeaders 
  })
}

// ADD PRIVACY CHECK HERE:
const { data: profile, error: profileError } = await supabase
  .from('profiles')
  .select('privacy_settings')
  .eq('id', user.id)
  .single()

// Check if followers should be hidden
if (profile?.privacy_settings?.hide_followers) {
  return new Response(JSON.stringify({
    '@context': 'https://www.w3.org/ns/activitystreams',
    id: `${baseUrl}/users/${username}/followers`,
    type: 'OrderedCollection',
    totalItems: 0,
    orderedItems: []
  }), {
    status: 200,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/activity+json; charset=utf-8',
      'Cache-Control': 'public, max-age=300'
    }
  })
}

// Continue with existing logic...
```

## 4. Following Endpoint - Add Privacy Controls  

### File: `/supabase/functions/following/index.ts`

**Add the same privacy check:**

```typescript
// ADD AFTER USER LOOKUP (same as followers):
const { data: profile, error: profileError } = await supabase
  .from('profiles')
  .select('privacy_settings')
  .eq('id', user.id)
  .single()

// Check if following should be hidden
if (profile?.privacy_settings?.hide_following) {
  return new Response(JSON.stringify({
    '@context': 'https://www.w3.org/ns/activitystreams',
    id: `${baseUrl}/users/${username}/following`,
    type: 'OrderedCollection',
    totalItems: 0,
    orderedItems: []
  }), {
    status: 200,
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/activity+json; charset=utf-8',
      'Cache-Control': 'public, max-age=300'
    }
  })
}
```

## 5. Enhanced Error Handling (All Endpoints)

**Wrap the main try block in better error handling:**

```typescript
try {
  // Existing code...
  
} catch (error) {
  console.error('Endpoint error:', error)
  
  // Return proper ActivityPub error format
  const errorResponse = {
    '@context': 'https://www.w3.org/ns/activitystreams',
    type: 'Error',
    name: 'Internal Server Error',
    content: 'An error occurred while processing the request'
  }
  
  return new Response(JSON.stringify(errorResponse), { 
    status: 500, 
    headers: {
      ...corsHeaders,
      'Content-Type': 'application/activity+json; charset=utf-8'
    }
  })
}
```

## Priority Implementation Order

1. **Apply database functions to featured + outbox** (improves content processing)
2. **Add privacy controls to followers/following** (better security)
3. **Add enhanced error handling** (more robust)

## Benefits of These Changes

✅ **Better content processing** - Uses the same functions as your unified trigger system  
✅ **Proper ActivityPub compliance** - Correct @context and tag extraction  
✅ **Privacy protection** - Respects user privacy settings  
✅ **Consistent architecture** - Same content processing everywhere  
✅ **Better error handling** - Proper ActivityPub error responses  

## Testing

After applying these changes:

1. Test each endpoint: `curl -H "Accept: application/activity+json" https://yourdomain/users/username/outbox`
2. Verify content processing with posts that have mentions, hashtags, and media
3. Test privacy controls by setting privacy settings on a user
4. Test federation with another ActivityPub server

Your endpoints are already working well - these changes just make them more robust and compliant! 🚀
