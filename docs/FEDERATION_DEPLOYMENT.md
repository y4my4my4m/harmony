# ActivityPub Federation Deployment Guide

## 1. Nginx Configuration

Replace your current nginx configuration with the new one in `nginx-harmony.conf`. This adds the necessary proxy rules for ActivityPub federation endpoints.

### Key changes:
- Adds `.well-known/webfinger` endpoint
- Adds `.well-known/nodeinfo` and `/nodeinfo/2.1` endpoints  
- Adds `/users/{username}` actor endpoints
- Adds `/users/{username}/inbox` and `/api/activitypub/inbox` inbox endpoints
- Proper CORS headers for federation
- ActivityPub signature header forwarding

### Deploy nginx config:
```bash
# Backup current config
sudo cp /etc/nginx/sites-available/harmony /etc/nginx/sites-available/harmony.backup

# Copy new config
sudo cp nginx-harmony.conf /etc/nginx/sites-available/harmony

# Test nginx config
sudo nginx -t

# Reload nginx
sudo systemctl reload nginx
```

## 2. Supabase Functions

Make sure your Supabase functions are deployed and accessible on port 8000:

```bash
# In your Supabase project directory
supabase functions deploy actor
supabase functions deploy inbox  
supabase functions deploy webfinger
supabase functions deploy nodeinfo
```

## 3. Environment Variables

Ensure these environment variables are set in your Supabase functions:

```bash
SUPABASE_URL=your_supabase_url
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key
DOMAIN=har.mony.lol
```

## 4. Database Schema

Make sure your database has the required tables for ActivityPub:

- `profiles` table with federation fields (`federated_id`, `inbox_url`, `outbox_url`, etc.)
- `follows` table for federation relationships
- `ap_activities` table for storing incoming activities
- Proper indexes for federation lookups

## 5. Testing Federation

After deployment, test these endpoints:

### WebFinger Discovery
```bash
curl -H "Accept: application/jrd+json" \
  "https://har.mony.lol/.well-known/webfinger?resource=acct:username@har.mony.lol"
```

### NodeInfo
```bash
curl -H "Accept: application/json" \
  "https://har.mony.lol/.well-known/nodeinfo"

curl -H "Accept: application/json" \
  "https://har.mony.lol/nodeinfo/2.1"
```

### Actor Profile
```bash
curl -H "Accept: application/activity+json" \
  "https://har.mony.lol/users/username"
```

### Browser Access
Visit `https://har.mony.lol/users/username` in a browser - should redirect to the Vue app profile page.

## 6. Federation Testing

To test with other ActivityPub instances:

1. Try following a user from Mastodon: `@username@har.mony.lol`
2. Check logs: `sudo tail -f /var/log/nginx/harmony.access.log`
3. Monitor Supabase function logs for incoming activities

## 7. Troubleshooting

### Check function connectivity:
```bash
curl http://localhost:8000/functions/v1/webfinger
```

### Check nginx error logs:
```bash
sudo tail -f /var/log/nginx/harmony.error.log
```

### Verify CORS headers:
```bash
curl -H "Origin: https://mastodon.social" \
     -H "Access-Control-Request-Method: GET" \
     -H "Access-Control-Request-Headers: Accept" \
     -X OPTIONS \
     "https://har.mony.lol/.well-known/webfinger"
```

## 8. Security Considerations

- [ ] Implement HTTP signature verification in inbox function
- [ ] Add rate limiting for federation endpoints
- [ ] Monitor for spam/abuse from remote instances
- [ ] Implement proper error handling and logging
- [ ] Consider implementing blocklist functionality
