# Testing ActivityPub Federation for Harmony

## Quick Federation Tests

### 1. **WebFinger Test**
```bash
# Test if your users are discoverable
curl "https://har.mony.lol/.well-known/webfinger?resource=acct:username@har.mony.lol" \
  -H "Accept: application/json"

# Should return:
{
  "subject": "acct:username@har.mony.lol",
  "links": [
    {
      "rel": "self",
      "type": "application/activity+json",
      "href": "https://har.mony.lol/users/username"
    }
  ]
}
```

### 2. **Actor Document Test**
```bash
# Test user profile endpoint
curl "https://har.mony.lol/users/username" \
  -H "Accept: application/activity+json"

# Should return ActivityPub Actor object
```

### 3. **NodeInfo Test**
```bash
# Test instance discovery
curl "https://har.mony.lol/.well-known/nodeinfo" \
  -H "Accept: application/json"

# Then fetch the actual nodeinfo
curl "https://har.mony.lol/nodeinfo/2.1" \
  -H "Accept: application/json"
```

## Live Federation Tests

### 1. **Mastodon Search Test**
- Go to any Mastodon instance (mastodon.social, fosstodon.org, etc.)
- Search for `@username@har.mony.lol`
- Should find and display your user profile

### 2. **Misskey Search Test**
- Go to any Misskey instance (misskey.io, etc.) 
- Search for `@username@har.mony.lol`
- Should resolve your user

### 3. **Cross-Platform Follow Test**
- From Mastodon, try to follow `@username@har.mony.lol`
- Your instance should receive the follow activity
- Should be able to follow back

## Federation Debugging Tools

### 1. **Fediverse Observer**
Check if your instance is visible: https://fediverse.observer/

### 2. **ActivityPub Tester**
Use online tools to test your endpoints:
- https://activitypub.rocks/implementation-report/
- Check individual endpoints

### 3. **Browser Developer Tools**
Monitor network requests when testing federation:
```javascript
// Check WebFinger response
fetch('https://har.mony.lol/.well-known/webfinger?resource=acct:test@har.mony.lol')
  .then(r => r.json())
  .then(console.log)
```

## Common Issues

### 1. **CORS Headers**
Ensure your endpoints return proper CORS headers:
```
Access-Control-Allow-Origin: *
Access-Control-Allow-Headers: Accept, Content-Type
```

### 2. **Content-Type Headers**
ActivityPub endpoints must return:
```
Content-Type: application/activity+json; charset=utf-8
```

### 3. **HTTP Signatures**
For secure federation, implement HTTP signature verification:
- Incoming activities should be signed
- Outgoing activities should include signatures

### 4. **SSL/TLS Required**
ActivityPub federation requires HTTPS - no HTTP allowed

## Instance Compatibility

Your instance should be compatible with:
- **Mastodon** (most common)
- **Misskey** (popular in Japan)
- **Pleroma/Akkoma** 
- **Pixelfed** (image-focused)
- **PeerTube** (video)
- **Lemmy** (link aggregation)
- **BookWyrm** (books)
- And many others!

## Expected Federation Flow

1. **Discovery**: Other instances find your users via WebFinger
2. **Profile Fetch**: They fetch the user's Actor document  
3. **Follow**: They send a Follow activity to your inbox
4. **Accept**: You respond with an Accept activity
5. **Content Delivery**: You deliver new posts to their inbox
6. **Interactions**: They can like, reply, share your content

## Implementation Priority

1. ✅ **WebFinger** - Most critical for user discovery
2. ✅ **Actor endpoints** - Required for profiles  
3. ✅ **Inbox handling** - For receiving activities
4. ✅ **HTTP signatures** - For security
5. ⭐ **NodeInfo** - For instance discovery
6. ⭐ **Outbox** - For serving user activities 