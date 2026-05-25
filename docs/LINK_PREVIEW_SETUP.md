# Link Preview Setup - Webhook Architecture

## Overview

Link previews are now handled via a **webhook architecture**:

1. **BEFORE INSERT trigger**: Synchronously enriches local Harmony post URLs (fast, no HTTP)
2. **AFTER INSERT trigger**: Fires async webhook to federated backend for external URLs
3. **Federated backend**: Fetches previews, updates message metadata via Supabase RPC

## Installation Steps

### 1. Deploy SQL Functions & Triggers

Run these SQL files in order on your Supabase instance:

```bash
psql $SUPABASE_DB_URL -f db_schema/link_previews.sql
psql $SUPABASE_DB_URL -f db_schema/message_link_previews.sql
```

Or paste the contents into the Supabase SQL Editor.

**What this creates:**
- `process_local_link_previews()` - BEFORE INSERT trigger for Harmony URLs
- `webhook_external_link_previews()` - AFTER INSERT trigger that fires webhook
- `update_message_embeds(uuid, jsonb)` - RPC endpoint for backend to update metadata

### 2. Configure Supabase Instance Settings

Update your `instance_config` table with the backend URL:

```sql
update public.instance_config
set config_value = jsonb_set(
  config_value::jsonb,
  '{link_preview_backend_url}',
  '"https://har.mony.lol"'::jsonb,
  true
)::text
where config_key = 'federation_settings';
```

**Important**: Use your public nginx/domain URL, **not** `localhost`. Supabase needs to reach this from their infrastructure.

### 3. Update Federation Backend

The federated backend now has a new webhook endpoint at `/webhooks/enrich-message-previews`.

**Environment variables needed** (already in your `.env`):
```env
SUPABASE_URL=https://your-project.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
```

**Restart the backend:**
```bash
cd federation-backend
npm run dev  # or pm2 restart harmony-federation
```

### 4. Update Nginx Configuration

Ensure your nginx proxies webhook requests to the backend:

```nginx
# In your nginx-harmony-updated.conf
location /webhooks/ {
    proxy_pass http://localhost:3001;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection 'upgrade';
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
    proxy_cache_bypass $http_upgrade;
}
```

Then reload nginx:
```bash
sudo nginx -t
sudo systemctl reload nginx
```

## Testing

### Test Local Harmony URL (synchronous)

1. Send a message with a Harmony post URL: `https://har.mony.lol/posts/<some-uuid>`
2. Check the database:
   ```sql
   select id, metadata->'embeds'
   from messages
   where id = '<your-message-id>';
   ```
3. You should see the embed immediately in `metadata.embeds` (before the message even finishes inserting).

### Test External URL (async webhook)

1. Send a message with a YouTube URL: `https://www.youtube.com/watch?v=...`
2. Check federated backend logs - you should see:
   ```
   📨 Webhook received for message <uuid> with 1 URLs
   🔗 Fetching preview for: https://www.youtube.com/...
   ✅ Preview fetched for: https://www.youtube.com/...
   ✅ Updated message <uuid> with 1 embeds
   ```
3. Query the database after ~1-2 seconds:
   ```sql
   select id, metadata->'embeds'
   from messages
   where id = '<your-message-id>';
   ```
4. The YouTube embed should now be populated.

### Frontend Behavior

- **Local Harmony URLs**: Embed shows immediately (populated during BEFORE INSERT)
- **External URLs**: Message appears first, then embed pops in 1-2 seconds later when webhook completes
- **Realtime updates**: When the backend updates `metadata`, Supabase fires an UPDATE realtime event, and the frontend reactively shows the embed

## Troubleshooting

### Webhook not firing

Check Supabase logs (Dashboard → Logs → Postgres Logs) for errors like:
- `Failed to fetch external preview for <url>`
- `pg_net request failed`

Verify the backend URL is reachable from Supabase:
```sql
select net.http_post(
  url := 'https://har.mony.lol/webhooks/enrich-message-previews',
  body := '{"messageId":"test","urls":["https://youtube.com/watch?v=test"]}'::text
);
```

### Backend not receiving webhook

- Check nginx logs: `sudo tail -f /var/log/nginx/error.log`
- Check backend logs: `pm2 logs harmony-federation`
- Verify nginx proxy_pass is correct and backend is running

### RPC update fails

Check that `service_role` key has execute permission:
```sql
select has_function_privilege('service_role', 'update_message_embeds(uuid, jsonb)', 'execute');
```

Should return `true`.

## Architecture Diagram

```
┌─────────────────┐
│  Client sends   │
│  message + URL  │
└────────┬────────┘
         │
         ▼
┌─────────────────────────────────────────┐
│  Supabase: messages INSERT              │
│                                         │
│  1. BEFORE INSERT trigger:              │
│     - Local Harmony URLs → instant      │
│       embed in metadata.embeds          │
│                                         │
│  2. Row inserted (message saved)        │
│                                         │
│  3. AFTER INSERT trigger:               │
│     - External URLs → fire webhook      │
│       (pg_net async POST)               │
└─────────┬───────────────────────────────┘
          │
          ▼ (webhook)
┌─────────────────────────────────────────┐
│  Federated Backend                      │
│  /webhooks/enrich-message-previews      │
│                                         │
│  - Respond 202 immediately              │
│  - Fetch each URL preview (YouTube,     │
│    Spotify, generic, etc.)              │
│  - Call Supabase RPC:                   │
│    update_message_embeds(id, embeds)    │
└─────────┬───────────────────────────────┘
          │
          ▼ (RPC callback)
┌─────────────────────────────────────────┐
│  Supabase: UPDATE messages              │
│  SET metadata = metadata || embeds      │
│                                         │
│  Realtime broadcasts UPDATE event       │
└─────────┬───────────────────────────────┘
          │
          ▼
┌─────────────────────────────────────────┐
│  Frontend receives UPDATE               │
│  - Embed appears in chat/DM             │
└─────────────────────────────────────────┘
```

## Cleanup

The following files/functions are **no longer used** and can be removed:

- Any client-side link preview fetching logic (already removed)
- `VITE_FEDERATION_BACKEND_URL` env var (frontend doesn't call backend directly anymore)
- Old `fetch_remote_link_preview` attempts using `net.http_request` with complex signatures

All preview logic is now server-side webhook-driven.

