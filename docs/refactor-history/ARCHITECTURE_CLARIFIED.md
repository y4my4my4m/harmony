# Harmony Architecture - CLARIFIED

## The Full Picture

Harmony is a **hybrid** system:
- **Discord-like** features (local-only servers and channels)
- **ActivityPub** features (federated posts and DMs)

---

## What's Local vs What's Federated

### 🏠 Local-Only Features (No Federation)

**Server Chat** (Like Discord)
```
User sends message in #general
  ↓
Frontend: supabase.from('messages').insert({ 
  content, 
  channel_id 
})
  ↓
Database: INSERT (done!)
  ↓
Real-time: Other users see it instantly
  ↓
NO federation! It's a server channel.
```

**Voice Channels** (Like Discord)
```
WebRTC peer-to-peer
  ↓
No database involvement
  ↓
No federation needed
```

### 🌐 Federated Features (Cross-Instance)

**ActivityPub Posts**
```
User creates public post
  ↓
Frontend: supabase.from('posts').insert({ 
  content,
  visibility: 'public' 
})
  ↓
Database: INSERT + Trigger fires
  ↓
Trigger: NOTIFY federation_backend 'post_created'
  ↓
Federation Backend:
  - Converts to ActivityPub
  - Gets followers (local + remote)
  - For remote followers:
    - Queues delivery
    - Signs HTTP request
    - POSTs to their inbox
```

**Federated DMs** (To remote users)
```
User DMs @alice@mastodon.social
  ↓
Frontend: 
  convId = await supabase.rpc('get_or_create_conversation', {
    user1: myId,
    user2: aliceId
  })
  
  await supabase.from('messages').insert({
    conversation_id: convId,
    content
  })
  ↓
Database: Trigger checks participants
  IF has_remote_participants THEN
    NOTIFY federation_backend 'dm_to_remote'
  END IF
  ↓
Federation Backend:
  - Converts message to ActivityPub Note
  - Sends to alice@mastodon.social's inbox
  - Alice receives it in Mastodon!
```

**Reactions** (Context-aware)
```
React to server message
  ↓
Frontend: supabase.from('reactions').insert({ 
  message_id,
  emoji_id
})
  ↓
Database: INSERT
  ↓
Trigger: IF message is in federated DM THEN
  NOTIFY federation_backend
END IF
  ↓
Federation Backend (only if federated):
  - Creates Like activity
  - Sends to participants
```

---

## The 124 Functions - WHERE THEY GO

### PostgreSQL (Keep ~15)

**Complex Queries Only**:
```sql
get_or_create_conversation()         -- Complex lookup logic
search_users()                        -- Full-text search
get_timeline()                        -- Joins, filters, sorting
get_trending_hashtags()               -- Aggregations
extract_hashtags_from_content()       -- JSONB parsing
get_user_handle()                     -- Helper
is_local_user()                       -- Helper
create_system_message()               -- System-only
create_default_server_structure()     -- System-only
create_notification_structured()      -- Insert helper
get_unread_notification_count()       -- Count helper
cleanup_old_notifications()           -- Maintenance
update_updated_at_column()            -- Trigger
notify_federation_event()             -- Trigger
update_post_counters()                -- Trigger
```

### Federation Backend (Move ~30)

**ActivityPub Protocol** (`federation-backend/src/activitypub/`):
```typescript
// Signing & Verification
create_http_signature()               → SignatureService.signRequest()
verify_http_signature()               → SignatureService.verifySignature()
generate_rsa_keypair()                → SignatureService.generateKeyPair()

// Content Conversion (SQL → TypeScript)
convert_content_to_activitypub_html() → toActivityPub.postToNote()
convert_unified_content_to_activitypub_html() → toActivityPub.messageToNote()
extract_activitypub_attachments()     → fromActivityPub.extractAttachments()
extract_activitypub_mention_tags()    → fromActivityPub.extractMentions()
extract_misskey_emoji_tags()          → fromActivityPub.extractTags()
generate_activitypub_metadata()       → toActivityPub.profileToActor()

// Remote User Management
create_federated_profile()            → ActivityProcessor.ensureRemoteUser()
search_federated_users()              → FederationService.searchRemote()

// Activity Processing
process_federation_activity()         → ActivityProcessor.processIncomingActivity()
handle_post_federation()              → Listeners.handleNewPost()
create_outgoing_dm_activity()         → Listeners.handleNewDM()
queue_activity_for_federation()       → DeliveryQueue.enqueue()

// Delivery & Queue
process_federation_delivery_queue()   → DeliveryQueue.processQueue()
cleanup_federation_delivery_queue()   → MaintenanceService.cleanup()
collect_federation_stats()            → StatsService.collectFederationStats()

// Instance Management
mark_instance_reachable()             → InstanceHealthService.markReachable()
mark_instance_unreachable()           → InstanceHealthService.markUnreachable()
moderate_instance()                   → ModerationService.moderateInstance()
```

### Frontend Utilities (Move ~40)

**Parsing** (`src/utils/contentParsing.ts`):
```typescript
extract_mentions()                    → extractMentions(content)
extract_hashtags()                    → extractHashtags(content)
normalize_hashtag()                   → normalizeHashtag(tag)
convert_unified_content_to_plain_text() → contentToPlainText(content)
```

**Formatting** (`src/utils/formatting.ts`):
```typescript
format_user_handle()                  → formatHandle(username, domain)
format_timestamp()                    → formatTimestamp(date)
```

**Validation** (`src/utils/validation.ts`):
```typescript
validate_username()                   → validateUsername(username)
validate_content()                    → validateContent(content)
```

### Triggers (Convert ~20)

**Current** (Callable functions):
```sql
handle_mention_notifications()
handle_reaction_notifications()
handle_follow_notifications()
```

**New** (Auto-run triggers):
```sql
CREATE TRIGGER notify_on_mention
AFTER INSERT ON messages
WHEN (content has mentions)
FOR EACH ROW
EXECUTE FUNCTION create_mention_notifications();
```

### Delete (~19)

**Cache Functions** (Not needed with proper app caching):
```sql
get_cached_timeline()
update_timeline_cache()
update_follower_timelines()
```

**Duplicate/Old**:
```sql
create_notification() -- Use create_notification_structured
handle_new_message() -- Replaced by triggers
update_unread_count() -- Can be computed
```

**Move to Cron** (Run periodically, not in DB):
```sql
archive_popular_hashtags()
cleanup_inactive_hashtags()
update_hashtag_trending_scores()
```

---

## Example: Complete Flow

### Sending a Federated DM

**1. Frontend** (Simple!):
```typescript
await supabase.from('messages').insert({
  conversation_id: 'conv-123',
  content: [
    { type: 'text', text: 'Hello ' },
    { type: 'mention', username: 'alice', domain: 'mastodon.social' },
    { type: 'text', text: '!' }
  ]
})
```

**2. Database Trigger**:
```sql
-- Auto-fires on INSERT
CREATE TRIGGER check_federation
AFTER INSERT ON messages
FOR EACH ROW
EXECUTE FUNCTION maybe_federate_message();
```

**3. Federation Check** (Simple SQL):
```sql
CREATE FUNCTION maybe_federate_message()
RETURNS TRIGGER AS $$
BEGIN
  -- Is this a DM?
  IF NEW.conversation_id IS NOT NULL THEN
    -- Has remote participants?
    IF has_remote_participants(NEW.conversation_id) THEN
      -- Notify federation backend
      PERFORM pg_notify('dm_to_remote', NEW.id::text);
    END IF;
  END IF;
  RETURN NEW;
END;
$$;
```

**4. Federation Backend** (Listens):
```typescript
// federation-backend/src/listeners/DatabaseListener.ts

db.on('notification', async (msg) => {
  if (msg.channel === 'dm_to_remote') {
    const messageId = msg.payload
    
    // Get message from database
    const message = await getMessageFromDB(messageId)
    
    // Get remote participants
    const remoteUsers = await getRemoteParticipants(message.conversation_id)
    
    // Convert to ActivityPub
    const activity = messageToActivityPub(message)
    
    // Send to each remote user's inbox
    for (const user of remoteUsers) {
      await deliveryQueue.enqueue(activity, user.inbox_url)
    }
  }
})
```

**5. Delivery Queue** (Background worker):
```typescript
// Processes queue periodically
async function processQueue() {
  const pending = await getP endingDeliveries()
  
  for (const item of pending) {
    // Sign request
    const signature = await signRequest(item.activity, item.sender)
    
    // POST to remote inbox
    await fetch(item.target_inbox, {
      method: 'POST',
      headers: { ...signature },
      body: JSON.stringify(item.activity)
    })
  }
}
```

---

## The Logic Distribution

### PostgreSQL (~15 functions)
**Role**: Complex queries, helpers, triggers  
**Examples**: Search, timeline, conversation lookup  
**Why**: SQL is good at this!

### Federation Backend (~30 functions worth)
**Role**: ActivityPub protocol, cross-instance communication  
**Examples**: Signing, converting, delivering, receiving  
**Why**: TypeScript is easier to maintain!

### Frontend (~40 functions worth)
**Role**: Parsing, formatting, validation, UI logic  
**Examples**: Extract mentions, format content, validate input  
**Why**: Should be in the app, not the database!

### Triggers (~20 auto-run)
**Role**: Automatic operations on data changes  
**Examples**: Create notifications, update counters, notify federation  
**Why**: Happens automatically, no manual calls!

### Deleted (~19)
**Role**: None - they were redundant or obsolete  
**Why**: Cleanup!

---

## So To Answer Your Questions:

### Q1: How are we handling all 124 functions with just 15?

**A**: We're not! We're **redistributing** them:
- 15 stay in PostgreSQL (complex queries)
- ~30 move to Federation Backend (TypeScript!)
- ~40 move to Frontend (Utils!)
- ~20 become auto-run triggers
- ~19 get deleted (redundant)

**Total**: Still ~124 functions worth of logic, just **better organized**!

### Q2: Isn't Discord also federated?

**A**: Kind of! You're mixing two concepts:
- **Server chat** = Local only (like Discord)
- **Direct messages** = CAN be federated (if to remote user!)
- **Posts** = Fully federated (ActivityPub)

**Federation backend handles**:
- Posts (always federated if public)
- DMs to remote users (federated)
- Reactions on federated content
- Follows of remote users
- Profile updates to remote instances

**Local database handles**:
- Server chat (never federated)
- DMs to local users (not federated)
- Reactions on local content
- All Discord-like features

---

## The Key Insight

**Instead of**:
```
124 complex PostgreSQL functions doing EVERYTHING
```

**We have**:
```
15 PostgreSQL functions (complex queries)
+ Federation Backend (ActivityPub protocol)
+ Frontend Utils (parsing, formatting)
+ Triggers (auto-run)
= Same functionality, better organized!
```

---

**Does this make sense now?** The logic doesn't disappear - it just moves to where it belongs! 🎯

