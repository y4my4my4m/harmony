# Emoji API Endpoint

## Overview

This implementation adds a simple JSON API endpoint to your Vue/Vite application that returns ActivityPub-compatible emoji data.

## Endpoint

**GET** `/emojis/{emoji_id}`

Returns emoji data in ActivityPub format when an emoji ID is requested.

## Example Request

```bash
curl -X GET \
  -H "Accept: application/activity+json" \
  "https://har.mony.lol/emojis/0231b736-3acb-4812-8823-0b6be44907d5"
```

## Example Response

```json
{
  "@context": [
    "https://www.w3.org/ns/activitystreams",
    {
      "toot": "http://joinmastodon.org/ns#",
      "Emoji": "toot:Emoji",
      "focalPoint": {
        "@container": "@list",
        "@id": "toot:focalPoint"
      }
    }
  ],
  "id": "https://har.mony.lol/emojis/0231b736-3acb-4812-8823-0b6be44907d5",
  "type": "Emoji",
  "name": ":money:",
  "updated": "2025-07-16T13:31:42.726335+00:00",
  "icon": {
    "type": "Image",
    "mediaType": "image/gif",
    "url": "http://localhost:8000/storage/v1/object/public/emojis/1803806b-eb5b-4c55-996d-c8670d3269a8/2e4f6d9a-0c98-4533-bd6c-d0d5ee117f4e/9c2b8f82-9035-4389-8aab-100d9887996e.gif"
  }
}
```

## Implementation Details

### Files Created/Modified

1. **`src/api/emoji.ts`** - Contains the emoji API logic
   - `getEmojiById()` - Fetches emoji from Supabase
   - `createActivityPubEmoji()` - Formats emoji data for ActivityPub
   - `handleEmojiRequest()` - Main request handler

2. **`vite.config.ts`** - Added Vite plugin for API middleware
   - Custom plugin `emojiApiPlugin()` handles `/emojis/*` routes
   - Serves JSON responses during development

3. **`test-emoji-api.sh`** - Test script for the endpoint

### Database Integration

The endpoint queries your existing `emojis` table in Supabase:

- Fetches emoji by ID
- Returns 404 if not found
- Formats data according to ActivityPub Emoji specification

### Content Type

- Returns `application/activity+json` content type
- Includes CORS headers for cross-origin access
- Proper error handling with JSON responses

## Testing

Run the development server:

```bash
npm run dev
# or
bun dev
```

Test the endpoint:

```bash
# Using the test script
./test-emoji-api.sh 0231b736-3acb-4812-8823-0b6be44907d5

# Or manually with curl
curl "http://localhost:5173/emojis/0231b736-3acb-4812-8823-0b6be44907d5"
```

## Production Deployment

For production, you may want to consider:

1. **Add rate limiting** to prevent abuse
2. **Cache responses** to reduce database load
3. **Add authentication** if needed
4. **Use a proper API framework** like Express.js if the API grows

## Notes

- The endpoint currently works in development via Vite middleware
- For production builds, you'd need to set up proper server routing (e.g., nginx reverse proxy)
- The implementation follows ActivityPub Emoji specifications for federated social networks
