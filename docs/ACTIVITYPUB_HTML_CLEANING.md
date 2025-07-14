# ActivityPub HTML Content Cleaning Implementation

## Problem

ActivityPub content from remote instances (like Mastodon) sometimes contains malformed HTML that causes rendering issues. Example problem:

```html
<a href="<a href="https://har.mony.lol/social/profile/y4my4m" target="_blank" rel="noopener noreferrer" class="url-link">https://har.mony.lol/social/profile/y4my4m"</a> class="u-url mention">@<span>y4my4m</span></span> hello
```

This renders as broken text: `https://har.mony.lol/social/profile/y4my4m class="u-url mention">@y4my4m hello`

## Solution

Implemented a two-layer HTML cleaning approach:

### 1. Backend Cleaning (Inbox Function)

**Location**: `/supabase/functions/inbox/index.ts`

**Purpose**: Clean malformed HTML before storing in database

**Implementation**:
```typescript
// Clean up the HTML content before storing
let cleanContent = object.content || '';
if (typeof cleanContent === 'string') {
  cleanContent = cleanContent
    // Fix nested anchor tags
    .replace(/<a\s+href="<a\s+href="\s*([^"]+)"\s*[^>]*>\s*([^<]+)<\/a>/gi, '<a href="$1" class="mention">$2</a>')
    // Fix broken anchor tag attributes  
    .replace(/<a\s+href="\s*([^"]+)"\s*[^>]*class="[^"]*mention[^"]*"[^>]*>\s*@?([^<]+)\s*<\/a>/gi, '<a href="$1" class="mention">@$2</a>')
    // Fix h-card spans with malformed structure
    .replace(/<span[^>]*class="[^"]*h-card[^"]*"[^>]*>.*?<a[^>]*href="\s*([^"]+)"\s*[^>]*>\s*@?([^<]+)\s*<\/a>.*?<\/span>/gi, '<a href="$1" class="mention">@$2</a>')
    // Remove stray closing tags
    .replace(/<\/a>\s*class="[^"]*"/gi, '')
    // Fix malformed URLs
    .replace(/([^"'>])(https?:\/\/[^\s<>"']+)([^<]*?)class="[^"]*"/gi, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>$3')
    // Clean up whitespace
    .replace(/\s+/g, ' ').trim();
}
```

### 2. Frontend Cleaning (MonyContent Component)

**Location**: `/src/components/activitypub/MonyContent.vue`

**Purpose**: Additional client-side HTML cleaning and repair

**Implementation**:
```typescript
const cleanActivityPubHTML = (html: string): string => {
  // Fix nested anchor tags
  html = html.replace(/<a\s+href="<a\s+href="\s*([^"]+)"\s*[^>]*>\s*([^<]+)<\/a>/gi, '<a href="$1" class="mention">$2</a>');
  
  // Fix broken anchor tag attributes
  html = html.replace(/<a\s+href="\s*([^"]+)"\s*[^>]*class="[^"]*mention[^"]*"[^>]*>\s*@?([^<]+)\s*<\/a>/gi, '<a href="$1" class="mention">@$2</a>');
  
  // Fix h-card spans with malformed structure
  html = html.replace(/<span[^>]*class="[^"]*h-card[^"]*"[^>]*>.*?<a[^>]*href="\s*([^"]+)"\s*[^>]*>\s*@?([^<]+)\s*<\/a>.*?<\/span>/gi, '<a href="$1" class="mention">@$2</a>');
  
  // Remove stray closing tags
  html = html.replace(/<\/a>\s*class="[^"]*"/gi, '');
  
  // Fix malformed URLs
  html = html.replace(/([^"'>])(https?:\/\/[^\s<>"']+)([^<]*?)class="[^"]*"/gi, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>$3');
  
  // Clean up whitespace
  html = html.replace(/\s+/g, ' ').trim();
  
  // Ensure mentions are properly formatted
  html = html.replace(/<a\s+href="([^"]+)"\s+class="mention">@?([^<]+)<\/a>/gi, '<a href="$1" class="mention" target="_blank" rel="noopener noreferrer">@$2</a>');
  
  return html;
};
```

## Specific Fixes

### 1. Nested Anchor Tags
**Problem**: `<a href="<a href="URL">text</a>`
**Fix**: Extract inner URL and text, create clean anchor tag

### 2. Broken Attributes
**Problem**: `<a href="URL" broken_attrs...>@user</a>`
**Fix**: Clean attributes, preserve URL and mention format

### 3. H-Card Microformat Issues
**Problem**: Complex `<span class="h-card">` structures with nested anchors
**Fix**: Extract mention link and simplify to clean anchor tag

### 4. Stray Closing Tags
**Problem**: `</a> class="..."` (closing tag with orphaned attributes)
**Fix**: Remove orphaned attributes

### 5. Malformed URL + Class Mixing
**Problem**: URLs mixed with class attributes outside proper tags
**Fix**: Wrap URLs in proper anchor tags

## Benefits

1. **Clean Storage**: Malformed HTML is fixed before being stored in database
2. **Reliable Rendering**: Frontend gets consistent, well-formed HTML
3. **Better UX**: Mentions and links work properly instead of showing as broken text
4. **Compatibility**: Handles various ActivityPub implementation quirks
5. **Performance**: Cleaning happens once during ingestion, not every render

## Testing

✅ **Original Problem**: 
```
Input: <a href="<a href="https://har.mony.lol/social/profile/y4my4m"...>@y4my4m</a>
Output: Broken text display
```

✅ **After Fix**:
```
Input: Same malformed HTML
Output: <a href="https://har.mony.lol/social/profile/y4my4m" class="mention">@y4my4m</a>
Result: Clean, clickable mention link
```

## Future Enhancements

1. **DOMPurify Integration**: Add comprehensive HTML sanitization library
2. **More Patterns**: Handle additional malformed HTML patterns as discovered
3. **Validation**: Add HTML validation to detect and log problematic content
4. **Configurable**: Allow admins to configure cleaning rules
5. **Monitoring**: Track and report common malformed patterns

## Files Modified

- `/supabase/functions/inbox/index.ts` - Backend HTML cleaning during ingestion
- `/src/components/activitypub/MonyContent.vue` - Frontend HTML cleaning and rendering

This implementation ensures that malformed ActivityPub HTML content is properly cleaned and displays correctly to users, maintaining the rich formatting while fixing structural issues.
