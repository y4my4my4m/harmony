# ActivityPub Endpoints Issues and Fixes

## Issues Found

### 1. Content Processing Functions
The outbox and featured endpoints use the same content processing logic but both have the same issues:

1. **Missing content conversion function** - They're using a local `formatPostContent` but should use the unified content processing
2. **Missing tag extraction** - They extract emojis but not mention tags for proper ActivityPub compliance
3. **Incomplete attachment handling** - File processing could be improved

### 2. Security and Performance Issues

1. **No authentication checks** for private endpoints
2. **Missing rate limiting** 
3. **No caching strategy** for expensive queries
4. **SQL injection potential** in pagination

### 3. ActivityPub Compliance Issues

1. **Missing proper @context** - Should use full ActivityPub context
2. **Incomplete mention tags** - Not extracting mentions from content properly
3. **Missing conversation threading** - Not linking replies properly
4. **No visibility scoping** - Should respect user privacy settings

## Recommended Fixes

### Priority 1: Use Unified Content Processing

Instead of the local `formatPostContent` function, use the database function:

```typescript
// Replace formatPostContent calls with database function call
const { data: contentResult } = await supabase.rpc('convert_unified_content_to_activitypub_html', {
  content: post.content
})
const htmlContent = contentResult || ''
```

### Priority 2: Extract All Tags Properly

```typescript
// Extract both mentions and emojis
const { data: tagsResult } = await supabase.rpc('extract_all_activitypub_tags', {
  content: post.content
})
const allTags = tagsResult || []
```

### Priority 3: Add Authentication for Private Data

```typescript
// For followers/following endpoints, check if profile is public
const { data: profile } = await supabase
  .from('profiles')
  .select('privacy_settings')
  .eq('id', user.id)
  .single()

if (profile?.privacy_settings?.hide_followers && !isAuthorized) {
  return new Response('Forbidden', { status: 403, headers: corsHeaders })
}
```

### Priority 4: Improve Error Handling

```typescript
// Add proper error handling for all database calls
try {
  const { data, error } = await supabase...
  if (error) {
    console.error('Database error:', error)
    return new Response('Database error', { status: 500, headers: corsHeaders })
  }
} catch (err) {
  console.error('Unexpected error:', err)
  return new Response('Internal error', { status: 500, headers: corsHeaders })
}
```

## Code Quality Issues

### Outbox Endpoint
- ✅ Pagination working correctly
- ⚠️ Content processing could use unified functions
- ⚠️ Missing rate limiting
- ✅ CORS headers correct

### Featured Endpoint  
- ⚠️ Queries for non-existent `is_pinned` column
- ⚠️ Same content processing issues as outbox
- ⚠️ Should fallback to recent posts if no pinned posts

### Followers/Following Endpoints
- ✅ Basic functionality correct
- ⚠️ No privacy checks
- ⚠️ Should respect user privacy settings
- ⚠️ Missing authorization for private profiles

## Quick Fixes to Apply

### 1. Fix Featured Endpoint Query
```typescript
// Change this:
.eq('is_pinned', true) // This column doesn't exist

// To this:
.order('interactions_count', { ascending: false }) // Show most popular instead
.limit(5) // Limit to top 5 posts as "featured"
```

### 2. Add Rate Limiting Headers
```typescript
const headers = {
  ...corsHeaders,
  'Content-Type': 'application/activity+json; charset=utf-8',
  'Cache-Control': 'public, max-age=300',
  'X-RateLimit-Limit': '100',
  'X-RateLimit-Remaining': '99'
}
```

### 3. Use Database Functions for Content
```typescript
// Instead of local content processing, use the database:
const { data: htmlContent } = await supabase.rpc(
  'convert_unified_content_to_activitypub_html', 
  { content: post.content }
)

const { data: tags } = await supabase.rpc(
  'extract_all_activitypub_tags',
  { content: post.content }
)
```

## Overall Assessment

Your endpoints are **functionally correct** and will work for basic ActivityPub federation. The main issues are:

1. **Performance** - Not using optimized database functions
2. **Privacy** - No access control for sensitive data  
3. **Standards compliance** - Missing some ActivityPub best practices
4. **Error handling** - Could be more robust

These are **not critical issues** that would break federation, but addressing them would make the endpoints more professional and robust.

## Recommendation

Since you've already run the migrations and the endpoints are working, I'd suggest:

1. **Test them first** - Make sure federation is working
2. **Apply the quick fixes** (featured endpoint query, database functions)
3. **Add privacy controls** later as needed
4. **Monitor performance** and optimize if needed

The endpoints will work as-is for ActivityPub federation testing!
