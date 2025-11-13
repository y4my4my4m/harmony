# Harmony - System Status & Context

> **Last Updated**: 2025-11-13  
> **Branch**: `refactor-and-improvements`  
> **Purpose**: Context document for future development sessions

---

## System Architecture

### Tech Stack
- **Frontend**: Vue 3 + Vite + TypeScript
- **Backend**: Supabase (PostgreSQL + Realtime + Storage + Auth)
- **Federation**: Node.js/Express backend (ActivityPub protocol)
- **WebRTC**: Peer-to-peer voice/video with Supabase Realtime signaling
- **Deployment**: Nginx reverse proxy on `har.mony.lol`

### Key Components

#### 1. Frontend (`/src`)
- Vue 3 SPA with TypeScript
- Stores: Pinia (ActivityPub, Chat, DM, Notifications, etc.)
- Services: Core services pattern (PostService, ProfileService, etc.)
- WebRTC: `unifiedWebRTC.ts` - Handles all voice/video

#### 2. Federation Backend (`/federation-backend`)
- **Port**: 3001
- **Purpose**: ONLY federation (ActivityPub protocol)
- **Routes**:
  - `/users/:username` - Actor endpoints
  - `/users/:username/inbox` - User inboxes
  - `/users/:username/outbox` - User outboxes
  - `/inbox` - Shared inbox
  - `/outbox` - Shared outbox
  - `/.well-known/webfinger` - WebFinger discovery
  - `/.well-known/nodeinfo` - NodeInfo

#### 3. Database (Supabase PostgreSQL)
- Tables: `posts`, `profiles`, `messages`, `follows`, `post_interactions`, etc.
- **Content Format**: MessagePart[] (JSONB array)
- **Realtime**: Enabled for posts, messages, follows, interactions
- **RLS**: Row Level Security enabled

---

## Recent Session - What Was Fixed

### 1. Federation System (COMPLETE OVERHAUL) ✅

#### Issues Fixed:
1. **Realtime Delivery**
   - **Before**: 30-second delay, queue-only
   - **After**: Immediate delivery attempt, queue only for retries
   - **File**: `federation-backend/src/activitypub/DeliveryQueue.ts`

2. **Inbox Routes**
   - **Problem**: Missing nginx proxy for `/inbox`, `/outbox`
   - **Solution**: Added to `nginx-harmony-updated.conf`
   - **Action Required**: Copy to server and reload nginx

3. **Actor Configuration**
   - **Problem**: `INSTANCE_DOMAIN=localhost:5173` in `.env`
   - **Solution**: Changed to `har.mony.lol`
   - **Added**: `endpoints.sharedInbox` and `sharedOutbox` to actor

4. **Content Parsing**
   - **Incoming**: Parse ActivityPub HTML → MessageParts in backend
   - **Outgoing**: Convert MessageParts → ActivityPub HTML in backend
   - **Supports**: Mentions, hashtags, custom emojis, media attachments
   - **Files**: 
     - `federation-backend/src/activitypub/converters/fromActivityPub.ts`
     - `federation-backend/src/activitypub/converters/toActivityPub.ts`

5. **Mention Delivery**
   - **Problem**: Mentions only sent to followers
   - **Solution**: Also deliver directly to mentioned users
   - **File**: `federation-backend/src/listeners/DatabaseListener.ts`

6. **HTTP Signatures**
   - **Problem**: Misskey rejected with 401
   - **Solution**: Added `(request-target)` pseudo-header
   - **File**: `federation-backend/src/activitypub/SignatureService.ts`
   - **Result**: Works with both Mastodon and Misskey

7. **Follow System**
   - **Auto-accept**: All incoming follows auto-accepted
   - **Accept activity**: Sent back to follower
   - **File**: `federation-backend/src/activitypub/ActivityProcessor.ts`

8. **Like/Reactions**
   - **Problem**: Wrong table/column names
   - **Solution**: Use `post_interactions` table, `ap_id` column
   - **File**: `federation-backend/src/activitypub/ActivityProcessor.ts`

9. **Visibility Detection**
   - **Problem**: Public mentions treated as DMs
   - **Solution**: Proper `determineVisibility()` logic
   - **File**: `federation-backend/src/activitypub/ActivityProcessor.ts`

10. **Body Parser**
    - **Added**: `application/activity+json` and `application/ld+json` types
    - **File**: `federation-backend/src/index.ts`

11. **Private Keys**
    - **Fixed**: Use `user_private_keys` table (not `profiles`)
    - **File**: `federation-backend/src/activitypub/SignatureService.ts`

### 2. WebRTC Camera System ✅

#### Issues Fixed:
1. **Camera Toggle After Join**
   - **Problem**: Camera only worked if turned on BEFORE peers joined
   - **Solution**: Proper renegotiation with signaling state checks
   - **File**: `src/services/unifiedWebRTC.ts`

2. **Video Element Display**
   - **Problem**: Video element didn't appear when camera toggled on
   - **Solution**: Check stream tracks to show/hide video container
   - **File**: `src/components/voice/UnifiedVoiceUserCard.vue`

3. **Frozen Frame Removal**
   - **Problem**: Frozen frame shown after camera turned off
   - **Solution**: Clear `srcObject` when no video tracks
   - **File**: `src/components/voice/UnifiedVoiceUserCard.vue`

### 3. Mention Parser ✅

#### Issues Fixed:
1. **Autocomplete Missing @**
   - **Problem**: Handles returned without leading `@`
   - **Solution**: Added check to ensure `@` prefix
   - **File**: `src/composables/useAutoSuggest.ts`

2. **Mention Display**
   - **Problem**: Broken highlighting like "user[@partial].domain"
   - **Solution**: Fixed regex and parsing logic
   - **File**: `src/components/RichTextEditor.vue`

### 4. Git & Configuration ✅
- Force-added `federation-backend/docker-compose.yml`
- Updated `federation-backend/.env` with correct `INSTANCE_DOMAIN`

---

## Current System State

### What Works ✅
- ✅ Send posts to Mastodon (with mentions, emojis, media)
- ✅ Send posts to Misskey (with mentions, emojis, media)
- ✅ Receive posts from Mastodon (all content types)
- ✅ Receive posts from Misskey (all content types)
- ✅ Send follow requests (works with both platforms)
- ✅ Receive follow requests (auto-accepts)
- ✅ Mention delivery (to non-followers too)
- ✅ WebRTC camera toggle (on/off/on works correctly)
- ✅ Video element appears/disappears dynamically

### Known Issues ⚠️

1. **Signature Verification** 
   - Incoming signatures fail verification (but we accept anyway)
   - Not blocking functionality, but should be fixed for security
   - File to check: `federation-backend/src/activitypub/SignatureService.ts`

2. **Database Schema Migration Pending**
   - File: `db_schema/fix_delivery_queue_schema.sql`
   - Adds missing columns to `federation_delivery_queue`
   - Columns: `last_attempt_at`, `next_retry_at`, `activity_data`, `sender_id`, `target_inbox`
   - **Status**: SQL file created, needs to be run

3. **Nginx Config Update Needed**
   - File: `nginx-harmony-updated.conf`
   - Changes: Added `/inbox`, `/outbox`, added `sharedInbox`/`sharedOutbox` endpoints
   - **Action**: Copy to `/etc/nginx/sites-available/harmony` and reload nginx

4. **Mastodon Cache**
   - Still trying `/api/activitypub/inbox` (old cached endpoint)
   - Will expire in ~24 hours
   - Or force refresh on Mastodon's side

### Not Yet Implemented ⏳

1. **Advanced Interactions**
   - Announce/Reblog (receiving works, sending needs testing)
   - Delete activities
   - Update activities (edit posts)
   - Undo Like
   - Block/Mute federation

2. **Follow Management UI**
   - Show pending follow requests
   - Cancel outgoing follow requests
   - Approve/reject incoming follows (currently auto-accepts all)
   - Unfollow functionality

3. **Notifications**
   - Mentions from non-followers don't trigger notifications
   - Like notifications need testing
   - Follow notification UI

4. **Timeline Issues**
   - Federated posts don't appear in home timeline (only federated timeline)
   - Trigger issue with `create_comprehensive_timeline_entries`

5. **WebRTC Advanced**
   - Device change while in call (partially works)
   - Screenshare toggle edge cases
   - Reconnection logic

---

## Content Format (Critical!)

### MessagePart[] Structure
Your system uses a **unified content format** stored as JSONB:

```typescript
type MessagePart = 
  | { type: 'text', text: string }
  | { type: 'mention', username: string, domain: string, isLocal: boolean, userId: string, displayName: string }
  | { type: 'hashtag', name: string }
  | { type: 'emoji', emoji: { id: string, name: string, url: string, server_id: string } }
  | { type: 'url', url: string }
  | { type: 'file', url: string, fileType: string, fileName?: string }
  | { type: 'system', event_type: string, ... }
```

**Examples**:
```json
[
  {"type": "mention", "domain": "misskey.io", "username": "tester004", "isLocal": false, "userId": "...", "displayName": "Tester004"},
  {"type": "text", "text": " hello "},
  {"type": "emoji", "emoji": {"id": "...", "name": "wave", "url": "https://...", "server_id": "remote"}}
]
```

### Conversion Functions

**Backend (TypeScript)**:
- `noteToContent(note)` - ActivityPub HTML → MessageParts
- `extractContentAsHtml(content)` - MessageParts → ActivityPub HTML
- `extractTags(content)` - MessageParts → ActivityPub tag array

**Database (SQL)**:
- `convert_ap_to_jsonb(html, tags)` - ActivityPub → MessageParts
- `convert_jsonb_to_ap(content)` - MessageParts → ActivityPub HTML

---

## Federation Data Flow

### Outgoing Posts
1. User creates post in Vue app → Supabase `posts` table
2. Supabase Realtime → Federation backend receives INSERT event
3. Backend fetches post + author
4. Convert MessageParts → ActivityPub Note with HTML + tags
5. Sign request with user's private key
6. **Immediate delivery** to:
   - All remote followers
   - All mentioned users (even non-followers)
7. If delivery fails → Queue for retry (5, 10, 20, 40, 80 min backoff)

### Incoming Posts
1. Remote instance POSTs to `/users/:username/inbox`
2. Nginx proxies to federation backend
3. Backend validates activity
4. Extract Note content (HTML + tags)
5. Parse to MessageParts (mentions, emojis, hashtags, etc.)
6. Store in `posts` table with `is_local=false`
7. Frontend receives via Realtime → displays

---

## Key Files Reference

### Federation Backend
```
federation-backend/
├── src/
│   ├── index.ts                    # Main server, routes, middleware
│   ├── config/
│   │   ├── index.ts               # Environment config
│   │   └── supabase.ts            # Supabase client
│   ├── activitypub/
│   │   ├── InboxHandler.ts        # POST /inbox, /users/:user/inbox
│   │   ├── OutboxHandler.ts       # GET /outbox, /users/:user/outbox
│   │   ├── ActorService.ts        # GET /users/:user (Actor object)
│   │   ├── WebFingerService.ts    # /.well-known/webfinger
│   │   ├── NodeInfoService.ts     # /.well-known/nodeinfo
│   │   ├── ActivityProcessor.ts   # Process incoming activities
│   │   ├── DeliveryQueue.ts       # Outgoing delivery with retry
│   │   ├── SignatureService.ts    # HTTP signatures
│   │   └── converters/
│   │       ├── fromActivityPub.ts # ActivityPub → MessageParts
│   │       └── toActivityPub.ts   # MessageParts → ActivityPub
│   └── listeners/
│       ├── DatabaseListener.ts    # Supabase Realtime subscriptions
│       └── FederationHandlers.ts  # Create activities
└── .env                           # INSTANCE_DOMAIN=har.mony.lol
```

### Frontend
```
src/
├── services/
│   ├── unifiedWebRTC.ts           # WebRTC voice/video service
│   ├── activityPubService.ts      # ActivityPub operations
│   └── core/                      # Core CRUD services
├── components/
│   ├── voice/
│   │   ├── UnifiedVoiceUserCard.vue  # Video element display
│   │   └── UnifiedVoiceOverlay.vue   # Voice channel UI
│   ├── activitypub/
│   │   ├── MonyComposerInline.vue    # Post composer
│   │   └── MonyContent.vue           # Post display
│   └── RichTextEditor.vue            # Mention autocomplete
├── composables/
│   ├── useContentRenderer.ts      # Unified content rendering
│   └── useAutoSuggest.ts          # Mention/emoji autocomplete
└── utils/
    └── unifiedContentProcessing.ts  # Content parsing utilities
```

### Database
```
db_schema/
├── essential_functions.sql        # Core DB functions
├── fix_delivery_queue_schema.sql  # PENDING MIGRATION
└── supabase_schema_prod_backup_latest.sql
```

---

## What Still Needs to Be Done

### High Priority 🔴

1. **Run Database Migration**
   ```bash
   psql -U postgres -d postgres -f ~/harmony/db_schema/fix_delivery_queue_schema.sql
   ```
   Adds columns to `federation_delivery_queue` for proper retry handling.

2. **Update Nginx on Server**
   ```bash
   sudo cp ~/harmony/nginx-harmony-updated.conf /etc/nginx/sites-available/harmony
   sudo nginx -t
   sudo systemctl reload nginx
   ```

3. **Fix Incoming Signature Verification**
   - Currently accepts posts despite failed verification
   - Security risk (spoofing possible)
   - File: `federation-backend/src/activitypub/SignatureService.ts`
   - Method: `verifySignature()`

4. **Timeline Entry Bug**
   - Federated posts don't appear in home timeline
   - Only show in federated timeline
   - Likely trigger issue: `create_comprehensive_timeline_entries`

### Medium Priority 🟡

5. **Outgoing Reactions**
   - **Current**: Incoming reactions work
   - **Missing**: Send reactions to remote instances when YOU react
   - File: `federation-backend/src/listeners/DatabaseListener.ts`
   - Handler: `handleNewReaction()` - may need fixes

6. **Announce/Reblog**
   - Receiving works
   - Sending needs implementation/testing
   - Handler exists but may need work

7. **Delete/Update Activities**
   - Post edits don't federate
   - Post deletions don't federate
   - Needs implementation

8. **Follow UI**
   - Show pending status
   - Cancel requests
   - Manual approve/reject option (disable auto-accept)

### Low Priority 🟢

9. **Undo Activities**
   - Undo Like (un-react)
   - Undo Announce (un-reblog)
   - Undo Follow (unfollow)

10. **Block/Mute Federation**
    - Block user → send Block activity
    - Receive Block → handle appropriately

11. **Advanced WebRTC**
    - Multi-track scenarios
    - Better reconnection
    - Network quality adaptation

---

## Critical Concepts

### Content Processing Flow

**Creating Content**:
```
User types → RichTextEditor → parseContentToMessageParts() → MessagePart[]
  ↓
Store in DB as JSONB
  ↓
Federation backend: extractContentAsHtml() → ActivityPub HTML + tags
  ↓
Send to remote instances
```

**Receiving Content**:
```
Remote POST /inbox → ActivityPub Note (HTML + tags)
  ↓
Backend: noteToContent() → MessagePart[]
  ↓
Store in DB as JSONB
  ↓
Frontend: Render MessageParts directly (no parsing needed)
```

### Realtime Architecture

**Federation Backend**:
- Uses Supabase Realtime to listen for INSERT events
- Subscribed to: `posts`, `follows`, `post_interactions`
- When event received → process → deliver to remote instances
- **Channel**: `federation-events` (SUBSCRIBED, state: joined)

**Frontend**:
- Each component subscribes to its own realtime channels
- Chat: `channel-${channelId}`
- DMs: `dm-conversation-${conversationId}`
- Posts: `activitypub_posts_service`

### Supabase Configuration

**Environment Variables** (`.env` files):
```env
# Frontend (.env)
VITE_SUPABASE_URL=your-supabase-url
VITE_SUPABASE_ANON_KEY=your-anon-key
VITE_DOMAIN=har.mony.lol

# Federation Backend (federation-backend/.env)
SUPABASE_URL=your-supabase-url
SUPABASE_ANON_KEY=your-anon-key
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
INSTANCE_DOMAIN=har.mony.lol
INSTANCE_NAME=Harmony
PORT=3001
```

---

## Common Issues & Solutions

### "Federation not working"
1. Check federation backend is running: `cd federation-backend && npm run dev`
2. Check logs show: `📡 Realtime subscription status: SUBSCRIBED`
3. Check nginx proxies `/inbox` and `/users/:user/inbox`
4. Check `INSTANCE_DOMAIN` in `.env` is correct domain

### "Posts not appearing in timeline"
- Check visibility (only `public`/`unlisted` federate)
- Check `is_local` flag
- Check timeline triggers in database

### "Can't send to Misskey"
- Check signature includes `(request-target)`
- Check private key exists in `user_private_keys` table
- Check 401 vs 202 response

### "Camera not showing"
- Check browser console for WebRTC logs
- Check if tracks are received: `📹 Received track from:`
- Check `userStream` has video tracks
- Check `hasVideo` computed value

---

## Database Tables Schema Notes

### `posts`
- `content`: JSONB (MessagePart[])
- `ap_id`: ActivityPub Note ID (for federated posts)
- `is_local`: true for local posts, false for federated
- `visibility`: 'public' | 'unlisted' | 'followers' | 'direct'

### `profiles`
- `domain`: User's domain (har.mony.lol for local, remote domain for federated)
- `is_local`: true for local users
- `federated_id`: ActivityPub Actor ID
- `inbox_url`, `outbox_url`: ActivityPub endpoints
- **NO `private_key`** - stored in `user_private_keys` table

### `user_private_keys`
- `user_id`: UUID
- `private_key`: PEM format private key
- **Security**: SECURITY DEFINER function `get_user_private_key()`

### `federation_delivery_queue`
- **Current columns**: id, created_at, updated_at, activity_id, target_domain, target_inbox_url, status, attempts, max_attempts, next_attempt_at
- **Missing columns** (migration needed): last_attempt_at, next_retry_at, activity_data, sender_id, target_inbox

### `post_interactions`
- `interaction_type`: 'emoji_reaction' | 'favorite' | 'reblog' | 'bookmark'
- `emoji_id`: UUID of custom emoji (nullable)
- `custom_emoji_content`: For remote emojis (string like "❤️")

---

## Testing Checklist

### Federation
- [x] Send public post to Mastodon
- [x] Send public post to Misskey  
- [x] Receive post from Mastodon
- [x] Receive post from Misskey
- [x] Send with mentions
- [x] Receive with mentions
- [x] Send with custom emojis
- [x] Receive with custom emojis
- [x] Send follow request
- [x] Receive follow request
- [ ] Send like/reaction to remote post
- [ ] Receive like on your post (works but needs UI verification)
- [ ] Reblog/Announce
- [ ] Delete post (federation)
- [ ] Edit post (federation)

### WebRTC
- [x] Camera toggle on after join
- [x] Camera toggle off (video element hides)
- [x] Multiple on/off toggles
- [ ] Device change during call
- [ ] Screenshare toggle
- [ ] Network reconnection

### UI/UX
- [ ] Follow request UI (pending status, approve/reject)
- [ ] Notification for mentions from non-followers
- [ ] Federated posts in home timeline
- [ ] Like/reaction counts update in realtime

---

## Important Commands

### Start Federation Backend
```bash
cd ~/harmony/federation-backend
npm run dev
```

### Check Federation Backend Logs
Should show:
```
🚀 Harmony Federation Backend running on port 3001
📝 Environment: development
🌐 Instance: Harmony (har.mony.lol)
📡 Realtime subscription status: SUBSCRIBED
✅ Database listener active
📊 Channel state: joined
```

### Test Actor Endpoint
```bash
curl -H "Accept: application/activity+json" https://har.mony.lol/users/y4my4m
```

Should show:
```json
{
  "inbox": "https://har.mony.lol/users/y4my4m/inbox",
  "endpoints": {
    "sharedInbox": "https://har.mony.lol/inbox",
    "sharedOutbox": "https://har.mony.lol/outbox"
  }
}
```

### Check Nginx Config
```bash
sudo nginx -t
sudo systemctl status nginx
tail -f /var/log/nginx/harmony.error.log
```

### Database Queries
```sql
-- Check recent federated posts
SELECT id, ap_id, content, visibility, is_local, created_at 
FROM posts 
WHERE is_local = false 
ORDER BY created_at DESC 
LIMIT 10;

-- Check delivery queue
SELECT * FROM federation_delivery_queue 
WHERE status = 'pending' 
ORDER BY created_at DESC;

-- Check follows
SELECT 
  follower.username || '@' || follower.domain as follower,
  following.username || '@' || following.domain as following,
  f.status,
  f.created_at
FROM follows f
JOIN profiles follower ON f.follower_id = follower.id
JOIN profiles following ON f.following_id = following.id
ORDER BY f.created_at DESC
LIMIT 10;
```

---

## Debugging Tips

### Federation Not Sending
1. Check federation backend console for errors
2. Verify realtime subscription: `📡 Realtime subscription status: SUBSCRIBED`
3. When creating post, look for: `📝 Processing post for federation:`
4. Check delivery logs: `📤 Attempting immediate delivery to...`

### Federation Not Receiving
1. Check nginx access log for POST requests to `/inbox` or `/users/*/inbox`
2. Check federation backend for: `📮 POST to /users/:username/inbox`
3. Check for errors in: `📬 Processing incoming Note:`
4. Verify content was stored: Check `posts` table for new entries

### WebRTC Issues
1. Open browser console
2. Look for: `🔗 Creating peer connection`, `📹 Received track from:`
3. Check offer/answer exchange: `📞 Handling offer/answer`
4. Verify stream assignment: `📡 Setting remote stream for user:`

### Content Display Issues
1. Check browser console for: `🔍 Parsing ActivityPub HTML`
2. Verify MessageParts structure in database
3. Test parser manually in console:
   ```javascript
   const { convertActivityPubHTMLToMessageParts } = await import('@/utils/unifiedContentProcessing');
   convertActivityPubHTMLToMessageParts('<p>test HTML</p>');
   ```

---

## For Future AI Assistants

When continuing work on this codebase:

1. **Content is MessagePart[] format** - Don't try to store HTML or plain text
2. **Federation backend handles ActivityPub ONLY** - No app logic there
3. **Use service role key** for federation backend (bypasses RLS)
4. **Supabase Realtime subscriptions** work (channel state: joined)
5. **Test with both Mastodon AND Misskey** - they have different requirements
6. **Column names**: `ap_id` not `federated_id`, `post_interactions` not `post_reactions`
7. **Auto-accepts follows** currently - manual approval not implemented
8. **Signature includes (request-target)** - Required for Misskey

### User Preferences
- Scalable, professional, clean, DRY code
- No migration runner scripts
- Reusable components and composables
- Avoid over-engineering simple tasks

---

## Next Session Priorities

1. Fix incoming signature verification (security)
2. Handle outgoing reactions properly
3. Implement Announce/Reblog fully
4. Fix home timeline for federated posts
5. Add follow request UI (approve/reject/cancel)
6. Notifications for federated interactions
7. Test and fix remaining WebRTC edge cases

---

**End of Status Document**

