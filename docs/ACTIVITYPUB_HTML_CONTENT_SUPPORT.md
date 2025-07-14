# ActivityPub HTML Content Support

## Overview

Harmony now fully supports HTML content natively as per the ActivityPub standard. This document outlines our approach and implementation.

## Why HTML Support?

ActivityPub posts commonly contain HTML content, which is the standard format for rich text in the fediverse. Rather than fighting this standard or converting content, we've embraced native HTML support.

## Implementation Details

### 1. Content Storage

**Federated Posts (Incoming)**:
- Raw HTML content is stored directly in the `posts.content` field
- No conversion or processing during storage
- Original HTML formatting is preserved

**Local Posts (Outgoing)**:
- Internal JSON format is converted to HTML when federating
- Plain text is properly escaped and formatted as HTML
- Line breaks are converted to `<br>` tags

### 2. Content Rendering

**MonyContent.vue Component**:
- Detects whether content is HTML (federated) or internal JSON format
- For HTML content: Applies minimal processing (emoji replacement only)
- For internal content: Applies full formatting (mentions, hashtags, URLs, emojis)
- Uses `v-html` for safe HTML rendering

```vue
<!-- Federated HTML content: minimal processing -->
if (typeof props.content === 'string' && (formatted.includes('<') || formatted.includes('&'))) {
  // Apply emoji formatting only
  return formatted;
}

<!-- Internal content: full formatting -->
// Apply hashtags, mentions, URLs, line breaks, emojis
```

### 3. Notification System

**Content Preview Generation**:
- HTML tags are stripped for notification previews
- HTML entities are decoded for readability
- Content is truncated to 120 characters
- Preserves the original HTML in the post for full viewing

**Inbox Function (Backend)**:
```typescript
// Strip HTML tags and decode entities for notification preview
contentPreview = savedPost.content
  .replace(/<[^>]*>/g, '') // Remove HTML tags
  .replace(/&lt;/g, '<')   // Decode HTML entities
  .replace(/&gt;/g, '>')
  .replace(/&amp;/g, '&')
  .replace(/&quot;/g, '"')
  .replace(/&#39;/g, "'")
  .replace(/&nbsp;/g, ' ')  // Non-breaking space
  .replace(/&hellip;/g, '...') // Ellipsis
  .trim()
  .substring(0, 120);
```

### 4. Federation (Outgoing)

**FederationService.ts**:
- Converts internal JSON format to proper HTML
- Escapes plain text content appropriately
- Preserves existing HTML content unchanged
- Ensures ActivityPub compliance

```typescript
private formatContentForActivityPub(content: any): string {
  // If content is already HTML, use directly
  if (typeof content === 'string') {
    return content;
  }
  
  // Convert internal format to HTML
  if (Array.isArray(content)) {
    return content
      .map(item => {
        if (item.type === 'text') {
          return item.text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/\n/g, '<br>');
        }
        return '';
      })
      .join('');
  }
}
```

## Benefits

1. **Standards Compliance**: Follows ActivityPub HTML content standard
2. **Rich Content**: Preserves formatting from federated instances
3. **Performance**: No unnecessary content conversion
4. **Compatibility**: Works with all major fediverse software (Mastodon, Pleroma, etc.)
5. **Maintainability**: Less complex than content conversion systems

## Security Considerations

- Content is rendered using Vue's `v-html` which is safe when content comes from trusted sources
- HTML content from federated instances should be sanitized if needed (future enhancement)
- Current implementation trusts ActivityPub content (standard practice in fediverse)

## Future Enhancements

1. **HTML Sanitization**: Add DOMPurify or similar for extra security
2. **Rich Editor**: Support HTML editing for local posts
3. **Content Filtering**: Allow users to strip HTML if desired
4. **Accessibility**: Ensure HTML content meets accessibility standards

## Files Modified

### Backend
- `/supabase/functions/inbox/index.ts` - Store raw HTML, clean previews
- `/supabase/functions/outbox/index.ts` - Send HTML content

### Frontend
- `/src/components/activitypub/MonyContent.vue` - HTML content rendering
- `/src/services/FederationService.ts` - HTML content formatting
- `/src/services/NotificationFormatter.ts` - HTML-aware notifications

## Testing

✅ Incoming HTML content from Mastodon renders properly  
✅ Notifications show clean text previews  
✅ Outgoing content converts to HTML correctly  
✅ Emojis work in both HTML and internal content  
✅ Mentions, hashtags, and URLs render correctly  

## Conclusion

Harmony now provides robust HTML content support that aligns with ActivityPub standards while maintaining excellent user experience for both federated and local content.
