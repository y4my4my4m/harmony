# Emoji API Endpoint

## Overview

Simple JSON API endpoint that returns ActivityPub-compatible emoji data.

## Endpoint

**GET** `/emojis/{emoji_id}`

## Example

```bash
curl "https://har.mony.lol/emojis/0231b736-3acb-4812-8823-0b6be44907d5"
```

Returns:
```json
{
  "@context": ["https://www.w3.org/ns/activitystreams", {...}],
  "id": "https://har.mony.lol/emojis/0231b736-3acb-4812-8823-0b6be44907d5",
  "type": "Emoji",
  "name": ":money:",
  "updated": "2025-07-16T13:31:42.726335+00:00",
  "icon": {
    "type": "Image",
    "mediaType": "image/gif",
    "url": "..."
  }
}
```

## Implementation

**Production Only**: Uses Supabase Edge Function + nginx proxy

### Files
- `supabase/functions/emojis/index.ts` - Edge function
- `nginx-harmony.conf` - Route configuration

### Deploy

```bash
# Deploy edge function
supabase functions deploy emojis

# Reload nginx
sudo nginx -s reload
```
