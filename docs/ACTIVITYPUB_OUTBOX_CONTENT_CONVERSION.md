# ActivityPub Outbox Content Conversion 

## Overview
The outbox endpoint now properly converts Harmony's unified content format to ActivityPub-compliant JSON-LD that works with both Mastodon and Misskey.

## Unified Content Format Examples

### 1. Text with Emojis
**Input:**
```json
[
  {"text": "No!...  ", "type": "text"}, 
  {
    "type": "emoji", 
    "emoji": {
      "id": "c5a205c5-dc0f-423a-ad47-a1b9d660aaa1",
      "url": "http://localhost:8000/storage/v1/object/public/emojis/.../merong.gif",
      "name": "merong",
      "uploader": "2e4f6d9a-0c98-4533-bd6c-d0d5ee117f4e",
      "server_id": "1803806b-eb5b-4c55-996d-c8670d3269a8",
      "display_name": "merong"
    }
  }
]
```

**ActivityPub Output:**
```json
{
  "@context": [
    "https://www.w3.org/ns/activitystreams",
    "https://w3id.org/security/v1",
    {
      "Hashtag": "as:Hashtag",
      "sensitive": "as:sensitive", 
      "toot": "http://joinmastodon.org/ns#",
      "Emoji": "toot:Emoji"
    }
  ],
  "content": "No!... :merong:",
  "tag": [
    {
      "id": "http://localhost:8000/storage/v1/object/public/emojis/.../merong.gif",
      "type": "Emoji",
      "name": ":merong:",
      "icon": {
        "type": "Image",
        "url": "http://localhost:8000/storage/v1/object/public/emojis/.../merong.gif"
      }
    }
  ]
}
```

### 2. File Attachments
**Input:**
```json
[
  {
    "url": "https://media.tenor.com/leAEu72bILgAAAAC/ekoi-ekoi-dancekid.gif",
    "type": "file",
    "fileType": "image"
  }
]
```

**ActivityPub Output:**
```json
{
  "content": "",
  "attachment": [
    {
      "type": "Document",
      "url": "https://media.tenor.com/leAEu72bILgAAAAC/ekoi-ekoi-dancekid.gif",
      "mediaType": "image/gif"
    }
  ]
}
```

### 3. Mentions
**Input:**
```json
[
  {
    "type": "mention",
    "userId": "2d06f6ba-4c21-4c84-a963-db65148ac543",
    "mention": "@y4my4m@harmony.com"
  },
  {"text": " bro", "type": "text"}
]
```

**ActivityPub Output:**
```json
{
  "content": "<span class=\"h-card\"><a href=\"https://harmony.com/users/y4my4m\" class=\"u-url mention\">@y4my4m</a></span> bro",
  "tag": [
    {
      "type": "Mention",
      "href": "https://harmony.com/users/y4my4m",
      "name": "@y4my4m@harmony.com"
    }
  ]
}
```

### 4. URL Previews
**Input:**
```json
[
  {
    "url": "https://text-adventure.ai",
    "type": "url", 
    "preview": true
  }
]
```

**ActivityPub Output:**
```json
{
  "content": "<a href=\"https://text-adventure.ai\" target=\"_blank\" rel=\"noopener\">https://text-adventure.ai</a>"
}
```

### 5. Simple Text
**Input:**
```json
[
  {"text": "test", "type": "text"}
]
```

**ActivityPub Output:**
```json
{
  "content": "test"
}
```

## Database Functions Used

The outbox endpoint uses three unified database functions:

### 1. `convert_unified_content_to_activitypub_html(content JSONB)`
- Converts unified content to ActivityPub HTML
- Handles text, mentions, URLs, emojis
- Returns proper HTML with microformat markup for mentions

### 2. `extract_all_activitypub_tags(content JSONB)`
- Extracts all tags (mentions, hashtags, emojis) 
- Returns array of ActivityPub tag objects
- Handles both Mastodon and Misskey format requirements

### 3. `extract_activitypub_attachments(content JSONB)`
- Extracts file attachments as ActivityPub Document objects
- Handles various media types (image, video, audio, etc.)
- Returns proper mediaType based on file extension/type

## ActivityPub Compatibility

### Mastodon
- Uses standard ActivityStreams context
- HTML content with microformat markup
- Standard attachment and tag formats

### Misskey
- Additional Misskey-specific emoji context (`toot:Emoji`)
- Custom emoji format with icon objects
- Backward compatibility with existing formats

## Complete Create Activity Structure

```json
{
  "@context": [
    "https://www.w3.org/ns/activitystreams",
    "https://w3id.org/security/v1", 
    {
      "Hashtag": "as:Hashtag",
      "sensitive": "as:sensitive",
      "toot": "http://joinmastodon.org/ns#",
      "Emoji": "toot:Emoji"
    }
  ],
  "id": "https://harmony.com/users/username/activities/create/123",
  "type": "Create",
  "actor": "https://harmony.com/users/username",
  "published": "2025-07-16T13:31:35.741608Z",
  "object": {
    "id": "https://harmony.com/posts/123",
    "type": "Note",
    "attributedTo": "https://harmony.com/users/username",
    "content": "...", // Converted HTML
    "published": "2025-07-16T13:31:35.741608Z",
    "to": ["https://www.w3.org/ns/activitystreams#Public"],
    "cc": [],
    "tag": [...], // Extracted tags
    "attachment": [...] // Extracted attachments
  }
}
```

## Implementation Benefits

1. **Unified Processing**: Single source of truth for content conversion
2. **ActivityPub Compliance**: Works with all major ActivityPub implementations
3. **Maintainability**: Database functions can be updated without touching endpoint code
4. **Performance**: Efficient database-side processing
5. **Consistency**: Same conversion logic used across all federation endpoints

## Testing

To test the conversion:

```sql
-- Test content conversion
SELECT convert_unified_content_to_activitypub_html('[{"text": "Hello", "type": "text"}]'::jsonb);

-- Test tag extraction
SELECT extract_all_activitypub_tags('[{"type": "mention", "mention": "@test@example.com"}]'::jsonb);

-- Test attachment extraction  
SELECT extract_activitypub_attachments('[{"type": "file", "url": "https://example.com/image.jpg"}]'::jsonb);
```
