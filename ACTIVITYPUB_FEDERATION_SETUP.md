# ActivityPub Federation Setup Guide

## Overview

This guide will help you make your Harmony instance discoverable and federated with other ActivityPub instances like Mastodon, Misskey, Pleroma, etc.

## Prerequisites

- Domain name with SSL certificate (HTTPS required)
- Supabase project with Edge Functions enabled
- Database schema with ActivityPub tables

## 🚀 Deployment Steps

### 1. Deploy Edge Functions

Deploy the federation endpoints to Supabase:

```bash
# Install Supabase CLI if not already installed
npm install -g supabase

# Login to Supabase
supabase login

# Link your project
supabase link --project-ref your-project-ref

# Deploy all federation functions
supabase functions deploy webfinger
supabase functions deploy actor  
supabase functions deploy nodeinfo
supabase functions deploy inbox
```

### 2. Set Environment Variables

Set these environment variables in your Supabase project:

```bash
# Your domain name
supabase secrets set DOMAIN=har.mony.lol

# Your Supabase URL and service role key (should already be set)
# SUPABASE_URL=https://your-project.supabase.co  
# SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
```

### 3. Configure DNS/Reverse Proxy

You need to route these federation endpoints to your Supabase Edge Functions:

#### Option A: Using Cloudflare Workers/Pages
```javascript
// _worker.js - Cloudflare Worker
export default {
  async fetch(request) {
    const url = new URL(request.url)
    const supabaseUrl = 'https://your-project.supabase.co'
    
    // Route federation endpoints to Edge Functions
    const routes = {
      '/.well-known/webfinger': '/functions/v1/webfinger',
      '/.well-known/nodeinfo': '/functions/v1/nodeinfo', 
      '/nodeinfo/2.1': '/functions/v1/nodeinfo',
      '/api/activitypub/inbox': '/functions/v1/inbox'
    }
    
    // Route user actor endpoints
    if (url.pathname.match(/^\/users\/[^\/]+$/)) {
      return fetch(`${supabaseUrl}/functions/v1/actor${url.pathname}${url.search}`, request)
    }
    
    // Route user inboxes  
    if (url.pathname.match(/^\/users\/[^\/]+\/inbox$/)) {
      return fetch(`${supabaseUrl}/functions/v1/inbox${url.search}`, request)
    }
    
    // Check for direct federation routes
    if (routes[url.pathname]) {
      return fetch(`${supabaseUrl}${routes[url.pathname]}${url.search}`, request)
    }
    
    // Serve your regular app for all other requests
    return fetch(request)
  }
}
```

#### Option B: Using nginx
```nginx
# Add to your nginx config
location /.well-known/webfinger {
    proxy_pass https://your-project.supabase.co/functions/v1/webfinger;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
}

location /.well-known/nodeinfo {
    proxy_pass https://your-project.supabase.co/functions/v1/nodeinfo;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
}

location /nodeinfo/2.1 {
    proxy_pass https://your-project.supabase.co/functions/v1/nodeinfo;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
}

location ~ ^/users/([^/]+)$ {
    proxy_pass https://your-project.supabase.co/functions/v1/actor/users/$1;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
}

location ~ ^/users/([^/]+)/inbox$ {
    proxy_pass https://your-project.supabase.co/functions/v1/inbox;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
}

location /api/activitypub/inbox {
    proxy_pass https://your-project.supabase.co/functions/v1/inbox;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
}
```

### 4. Enable Required Database Features

Make sure you have the ActivityPub database schema:

```sql
-- Add to your existing schema
CREATE TABLE IF NOT EXISTS ap_activities (
    id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
    ap_id TEXT UNIQUE NOT NULL,
    ap_type TEXT NOT NULL,
    activity_data JSONB NOT NULL,
    origin_domain TEXT,
    status TEXT DEFAULT 'received',
    error_message TEXT,
    received_at TIMESTAMPTZ DEFAULT NOW(),
    processed_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Add federation fields to profiles if not exists
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS federated_id TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS public_key TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS private_key TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS inbox_url TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS outbox_url TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS followers_url TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS following_url TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS featured_url TEXT;
ALTER TABLE profiles ADD COLUMN IF NOT EXISTS last_synced_at TIMESTAMPTZ;

-- Create indexes for federation
CREATE INDEX IF NOT EXISTS idx_profiles_federated_id ON profiles(federated_id);
CREATE INDEX IF NOT EXISTS idx_profiles_username_domain ON profiles(username, domain);
CREATE INDEX IF NOT EXISTS idx_ap_activities_ap_id ON ap_activities(ap_id);
CREATE INDEX IF NOT EXISTS idx_ap_activities_status ON ap_activities(status);
```

## 🧪 Testing Your Federation

### 1. Test WebFinger Discovery
```bash
curl "https://har.mony.lol/.well-known/webfinger?resource=acct:yourUsername@har.mony.lol" \
  -H "Accept: application/json"
```

Expected response:
```json
{
  "subject": "acct:yourUsername@har.mony.lol",
  "links": [
    {
      "rel": "self",
      "type": "application/activity+json", 
      "href": "https://har.mony.lol/users/yourUsername"
    }
  ]
}
```

### 2. Test Actor Profile
```bash
curl "https://har.mony.lol/users/yourUsername" \
  -H "Accept: application/activity+json"
```

Expected: ActivityPub Actor JSON object

### 3. Test NodeInfo
```bash
curl "https://har.mony.lol/.well-known/nodeinfo" \
  -H "Accept: application/json"
```

### 4. Test with Real Instances

Try searching for `@yourUsername@har.mony.lol` from:
- Mastodon (mastodon.social, fosstodon.org, etc.)
- Misskey (misskey.io, etc.)
- Other ActivityPub instances

## 🔒 Security Considerations

### 1. HTTP Signatures (TODO)
For production, implement HTTP signature verification:
- Verify incoming activities are signed
- Sign outgoing activities
- Implement proper key management

### 2. Rate Limiting
Add rate limiting to prevent abuse:
```sql
-- Add rate limiting table
CREATE TABLE federation_rate_limits (
    domain TEXT PRIMARY KEY,
    request_count INTEGER DEFAULT 0,
    window_start TIMESTAMPTZ DEFAULT NOW(),
    blocked_until TIMESTAMPTZ
);
```

### 3. Content Filtering
Implement content filtering for incoming activities:
- Spam detection
- Content policies
- User blocking

## 🐛 Troubleshooting

### Federation Not Working?

1. **Check DNS**: Ensure your domain resolves correctly
2. **Check SSL**: HTTPS is required for ActivityPub
3. **Check CORS**: Ensure proper CORS headers
4. **Check logs**: Monitor Supabase Edge Function logs
5. **Test endpoints**: Use curl to test each endpoint manually

### Common Issues

**WebFinger not found (404)**
- Check domain configuration
- Verify Edge Function deployment
- Check routing configuration

**Actor not accessible**
- Verify user exists in database
- Check `is_local = true` for local users
- Verify correct Accept headers

**Incoming activities not processed**
- Check inbox logs in Supabase
- Verify ap_activities table exists
- Check for processing errors

## 📊 Monitoring Federation

Monitor your federation status:

```sql
-- Check recent activities
SELECT ap_type, origin_domain, status, COUNT(*)
FROM ap_activities 
WHERE created_at > NOW() - INTERVAL '24 hours'
GROUP BY ap_type, origin_domain, status;

-- Check federation errors
SELECT * FROM ap_activities 
WHERE status = 'failed' 
ORDER BY created_at DESC 
LIMIT 10;

-- Check remote followers
SELECT domain, COUNT(*) 
FROM profiles p
JOIN follows f ON f.follower_id = p.id
WHERE p.is_local = false
GROUP BY domain;
```

## 🎯 Next Steps

After basic federation is working:

1. **Implement HTTP signatures** for security
2. **Add post federation** (Create/Update/Delete activities)
3. **Add interaction federation** (Like/Announce activities)
4. **Add media attachment support**
5. **Implement proper key rotation**
6. **Add federation analytics and monitoring**

## 🔗 Resources

- [ActivityPub Specification](https://www.w3.org/TR/activitypub/)
- [WebFinger RFC](https://tools.ietf.org/html/rfc7033)
- [NodeInfo Specification](https://nodeinfo.diaspora.software/)
- [Mastodon API Documentation](https://docs.joinmastodon.org/api/)
- [Fediverse Observer](https://fediverse.observer/) - Test instance visibility

## 🎉 Success!

Once working, your users should be discoverable and followable from any ActivityPub instance! Users from Mastodon, Misskey, etc. can search for `@username@har.mony.lol` and follow your users. 