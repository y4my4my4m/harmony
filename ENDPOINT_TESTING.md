# ActivityPub Federation Endpoint Testing Guide

## Prerequisites
Make sure your Supabase functions are running:
```bash
# Check if Supabase is running
curl http://localhost:15432/health

# If not running, start Supabase
supabase start
```

## 1. Test Nginx Configuration
First, test that nginx can start with the new config:
```bash
# Test nginx configuration
sudo nginx -t

# If successful, reload nginx
sudo systemctl reload nginx

# Check nginx status
sudo systemctl status nginx
```

## 2. Test WebFinger Discovery
WebFinger is used by other ActivityPub instances to discover your users:

```bash
# Test WebFinger for a user (replace 'alice' with actual username)
curl -H "Accept: application/jrd+json" \
  "https://har.mony.lol/.well-known/webfinger?resource=acct:alice@har.mony.lol"

# Alternative with curl verbose output
curl -v -H "Accept: application/jrd+json" \
  "https://har.mony.lol/.well-known/webfinger?resource=acct:alice@har.mony.lol"
```

Expected response:
```json
{
  "subject": "acct:alice@har.mony.lol",
  "links": [
    {
      "rel": "self",
      "type": "application/activity+json",
      "href": "https://har.mony.lol/users/alice"
    },
    {
      "rel": "http://webfinger.net/rel/profile-page",
      "type": "text/html",
      "href": "https://har.mony.lol/users/alice"
    }
  ]
}
```

## 3. Test NodeInfo Discovery
NodeInfo provides metadata about your instance:

```bash
# Test NodeInfo discovery
curl -H "Accept: application/json" \
  "https://har.mony.lol/.well-known/nodeinfo"

# Test NodeInfo 2.1 endpoint
curl -H "Accept: application/json" \
  "https://har.mony.lol/nodeinfo/2.1"
```

## 4. Test User Actor Endpoints
These serve ActivityPub user profiles:

```bash
# Test user actor with ActivityPub headers (should return JSON)
curl -H "Accept: application/activity+json" \
  "https://har.mony.lol/users/alice"

# Test user actor with browser headers (should redirect or return HTML)
curl -L -H "Accept: text/html" \
  "https://har.mony.lol/users/alice"

# Test with verbose output to see all headers
curl -v -H "Accept: application/activity+json" \
  "https://har.mony.lol/users/alice"
```

Expected ActivityPub response:
```json
{
  "@context": [
    "https://www.w3.org/ns/activitystreams",
    "https://w3id.org/security/v1"
  ],
  "id": "https://har.mony.lol/users/alice",
  "type": "Person",
  "preferredUsername": "alice",
  "name": "Alice",
  "inbox": "https://har.mony.lol/users/alice/inbox",
  "outbox": "https://har.mony.lol/users/alice/outbox",
  "followers": "https://har.mony.lol/users/alice/followers",
  "following": "https://har.mony.lol/users/alice/following"
}
```

## 5. Test Inbox Endpoints
These receive ActivityPub activities from other instances:

```bash
# Test user inbox (POST endpoint)
curl -X POST \
  -H "Content-Type: application/activity+json" \
  -H "Accept: application/activity+json" \
  -d '{
    "@context": "https://www.w3.org/ns/activitystreams",
    "type": "Follow",
    "actor": "https://example.com/users/bob",
    "object": "https://har.mony.lol/users/alice",
    "id": "https://example.com/activities/1"
  }' \
  "https://har.mony.lol/users/alice/inbox"

# Test shared inbox
curl -X POST \
  -H "Content-Type: application/activity+json" \
  -d '{
    "@context": "https://www.w3.org/ns/activitystreams",
    "type": "Follow",
    "actor": "https://example.com/users/bob",
    "object": "https://har.mony.lol/users/alice",
    "id": "https://example.com/activities/2"
  }' \
  "https://har.mony.lol/api/activitypub/inbox"
```

## 6. Test with Real Mastodon Instance
You can test federation with a real Mastodon instance:

```bash
# Try to resolve your user from a Mastodon instance
# (Replace mastodon.social with any Mastodon instance)
curl -H "Accept: application/activity+json" \
  "https://mastodon.social/.well-known/webfinger?resource=acct:alice@har.mony.lol"
```

## 7. Debug Commands
If something isn't working:

```bash
# Check nginx error logs
sudo tail -f /var/log/nginx/harmony.error.log

# Check nginx access logs
sudo tail -f /var/log/nginx/harmony.access.log

# Check if Supabase functions are accessible
curl http://localhost:15432/functions/v1/actor
curl http://localhost:15432/functions/v1/webfinger
curl http://localhost:15432/functions/v1/nodeinfo
curl http://localhost:15432/functions/v1/inbox

# Test DNS resolution
nslookup har.mony.lol
dig har.mony.lol

# Test SSL certificate
openssl s_client -connect har.mony.lol:443 -servername har.mony.lol
```

## 8. Browser Testing
You can also test in a browser:

1. **WebFinger**: Visit `https://har.mony.lol/.well-known/webfinger?resource=acct:alice@har.mony.lol`
2. **NodeInfo**: Visit `https://har.mony.lol/.well-known/nodeinfo`
3. **User Profile**: Visit `https://har.mony.lol/users/alice` (should redirect to Vue app)

## 9. Federation Testing with External Tools
- **Mastodon**: Try searching for `@alice@har.mony.lol` in Mastodon
- **ActivityPub Validator**: Use online tools to validate your endpoints
- **Federation Tester**: Use tools like `fediverse.party` or similar

## Common Issues
- **502 Bad Gateway**: Supabase functions not running
- **404 Not Found**: nginx routing issues
- **CORS errors**: Missing CORS headers
- **SSL errors**: Certificate issues
