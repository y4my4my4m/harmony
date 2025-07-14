# ActivityPub Content Storage Format Fix

## Issue

Database constraint error when storing federated posts:
```
new row for relation "posts" violates check constraint "posts_content_is_array"
```

## Root Cause

The `posts` table has a constraint requiring the `content` field to be a JSONB array format:
```sql
CONSTRAINT posts_content_is_array CHECK (jsonb_typeof(content) = 'array')
CONSTRAINT posts_content_not_empty CHECK (jsonb_array_length(content) > 0)
```

But the inbox function was storing HTML content directly as a string, violating this constraint.

## Solution

### 1. Backend Fix (Inbox Function)

**File**: `/supabase/functions/inbox/index.ts`

**Change**: Store HTML content in proper JSONB array format:

```typescript
// Before (BROKEN):
content: cleanContent, // String - violates constraint

// After (FIXED):
content: [{ type: 'text', text: cleanContent }], // JSONB array - follows constraint
```

### 2. Frontend Fix (MonyContent Component)

**File**: `/src/components/activitypub/MonyContent.vue`

**Change**: Updated HTML detection logic to handle both formats:

```typescript
// Detect HTML content in both direct string and JSONB array formats
const isHtmlContent = (typeof props.content === 'string' && (formatted.includes('<') || formatted.includes('&'))) ||
  (Array.isArray(props.content) && props.content.length === 1 && 
   props.content[0]?.type === 'text' && 
   typeof props.content[0]?.text === 'string' && 
   (props.content[0].text.includes('<') || props.content[0].text.includes('&')));
```

### 3. Notification Preview Fix

**File**: `/supabase/functions/inbox/index.ts`

**Change**: Extract text from JSONB array format for notification previews:

```typescript
// Extract text content from JSONB array format
if (Array.isArray(savedPost.content) && savedPost.content.length > 0) {
  const textContent = savedPost.content[0]?.text || '';
  // Then strip HTML tags for preview...
}
```

## Data Format

### Federated Posts (ActivityPub HTML Content)
```json
{
  "content": [
    {
      "type": "text", 
      "text": "<p><a href=\"https://example.com/users/user\" class=\"mention\">@user</a> Hello!</p>"
    }
  ]
}
```

### Local Posts (Internal Format)
```json
{
  "content": [
    { "type": "text", "text": "Hello " },
    { "type": "mention", "username": "user", "domain": "example.com" },
    { "type": "text", "text": "!" }
  ]
}
```

## Benefits

1. **Database Compliance**: Follows existing table constraints
2. **Consistent Storage**: All posts use same JSONB array format
3. **Backward Compatibility**: Frontend handles both old and new formats
4. **Clean HTML**: Malformed ActivityPub HTML is still cleaned during storage
5. **Proper Notifications**: Content previews work correctly

## Validation

✅ **Database Constraint**: Content stored as JSONB array  
✅ **HTML Cleaning**: Malformed HTML still cleaned before storage  
✅ **Frontend Rendering**: MonyContent detects and renders HTML correctly  
✅ **Notifications**: Previews strip HTML tags properly  
✅ **Backward Compatibility**: Handles existing content formats  

This fix ensures that federated ActivityPub content is stored in the correct format while maintaining all the HTML cleaning and rendering functionality we've built.
