# ActivityPub Content Standardization Complete

## Problem Solved

Previously, our system was doing multiple conversions of content:
1. **Incoming**: ActivityPub HTML → Store as HTML → Convert to JSONB for display → Re-process HTML
2. **Multiple Processing**: HTML cleaning happening in multiple places
3. **Inconsistency**: Different rendering paths for local vs federated content
4. **Complexity**: Multiple flattening/converting functions

## New Clean Solution

### ✅ **Single Conversion Point (Inbox)**
**Location**: `/supabase/functions/inbox/index.ts`

Incoming ActivityPub HTML is converted **once** to our standard JSONB format:

```typescript
// Convert ActivityPub HTML content to our standard JSONB format
const contentArray = parseActivityPubHTMLToJSONB(object.content || '', mentionTags);

// Store in standard format
content: contentArray, // [{ type: 'text', text: '...' }, { type: 'mention', username: '...' }]
```

### ✅ **Smart HTML Parser**
The `parseActivityPubHTMLToJSONB()` function:

1. **Cleans malformed HTML** (nested anchors, broken attributes)
2. **Extracts mentions** → `{ type: 'mention', username: 'user', domain: 'mastodon.social', isLocal: false }`
3. **Extracts URLs** → `{ type: 'url', url: 'https://...', text: 'link text' }`
4. **Extracts text** → `{ type: 'text', text: 'clean text content' }`
5. **Decodes HTML entities** (proper text display)

### ✅ **Simplified Frontend (MonyContent.vue)**
**No more HTML detection or dual processing paths!**

- All content is now in our standard JSONB format
- Single rendering path for all content (local + federated)
- Clean mention/hashtag/URL/emoji processing
- No more complex HTML cleaning on frontend

### ✅ **Clean Outgoing Federation (FederationService.ts)**
When sending posts to other instances:

```typescript
// Convert our JSONB format back to ActivityPub HTML
{ type: 'mention', username: 'user' } → <a href="..." class="mention">@user</a>
{ type: 'text', text: 'hello' }       → hello
{ type: 'url', url: 'https://...' }   → <a href="...">...</a>
```

## Data Flow Now

### **Incoming (Federated)**
```
Mastodon HTML → parseActivityPubHTMLToJSONB() → Standard JSONB → Store → Render
```

### **Local Posts**
```
User Input → Standard JSONB → Store → Render
```

### **Outgoing (Federation)**
```
Standard JSONB → formatContentForActivityPub() → ActivityPub HTML → Send
```

## Example Transformation

### **Before (Broken)**
```html
Input:  <a href="<a href="https://har.mony.lol/users/y4my4m">@y4my4m</a> hello
Display: "https://har.mony.lol/users/y4my4m" class="mention">@y4my4m hello
```

### **After (Clean)**
```json
Parsed: [
  { 
    "type": "mention", 
    "username": "y4my4m", 
    "domain": "har.mony.lol", 
    "isLocal": true,
    "url": "https://har.mony.lol/users/y4my4m"
  },
  { "type": "text", "text": " hello" }
]

Display: @y4my4m hello (with proper mention styling and click handlers)
```

## Benefits

✅ **Single Source of Truth**: All content stored in same format  
✅ **No Double Processing**: Conversion happens once at ingestion  
✅ **Clean Architecture**: One processing path for all content  
✅ **Better Performance**: No runtime HTML parsing on every render  
✅ **Consistent UX**: Mentions, hashtags, URLs work the same everywhere  
✅ **Database Compliance**: Fixes `posts_content_is_array` constraint  
✅ **Maintainable**: Much simpler codebase  

## Files Updated

- **Backend**: `/supabase/functions/inbox/index.ts` - Added HTML→JSONB parser
- **Frontend**: `/src/components/activitypub/MonyContent.vue` - Simplified to single processing path  
- **Federation**: `/src/services/FederationService.ts` - Added JSONB→HTML converter for outgoing

## Result

🎉 **Federated content now displays properly with clean mentions, preserves all formatting, and follows our standard content structure throughout the entire system!**

The previous database constraint error should now be resolved since we're storing proper JSONB arrays instead of raw HTML strings.
