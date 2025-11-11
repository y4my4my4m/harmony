# Everything Explained - Complete Guide

## 🎯 Your Two Excellent Questions

### Q1: "How are we handling all 124 functions with just 15?"

**Answer**: We're **redistributing** them, not deleting the logic!

```
124 PostgreSQL Functions
  │
  ├─→ 15 Stay in PostgreSQL (complex queries only)
  ├─→ 30 Move to Federation Backend (TypeScript!)
  ├─→ 40 Move to Frontend (Utils/parsing)
  ├─→ 20 Become Triggers (auto-run)
  └─→ 19 Get Deleted (redundant/obsolete)
      ────
      124 Total (same logic, better organized!)
```

### Q2: "Isn't our Discord clone also federated?"

**Answer**: It's a **hybrid**! Some parts are local-only, some are federated.

```
Discord Features (Local-Only):
  ✅ Server chat (#general, #announcements)
  ✅ Voice channels
  ✅ Server management
  ✅ Roles and permissions
  
ActivityPub Features (Federated):
  ✅ Public posts (timeline)
  ✅ DMs to remote users (@user@mastodon.social)
  ✅ Follows (across instances)
  ✅ Reactions (on federated content)
```

---

## The Complete Logic Mapping

### Example 1: `create_federated_profile()`

**What it does**: Creates a profile for a remote user (from Mastodon, etc.)

**Where it goes**:

**BEFORE** (PostgreSQL - 50+ lines of SQL):
```sql
CREATE FUNCTION create_federated_profile(actor_url TEXT) ...
```

**AFTER** (Federation Backend - TypeScript):
```typescript
// federation-backend/src/activitypub/ActivityProcessor.ts

async ensureRemoteUser(actorUrl: string) {
  // Check if exists
  const { data: existing } = await supabase
    .from('profiles')
    .select('id')
    .eq('ap_id', actorUrl)
    .single()
  
  if (existing) return existing
  
  // Fetch from remote
  const response = await fetch(actorUrl, {
    headers: { 'Accept': 'application/activity+json' }
  })
  const actor = await response.json()
  
  // Convert ActivityPub Actor → our format
  const profile = {
    username: actor.preferredUsername,
    domain: new URL(actorUrl).hostname,
    display_name: actor.name,
    bio: actor.summary,
    avatar: actor.icon?.url,
    ap_id: actorUrl,
    inbox_url: actor.inbox,
    is_local: false
  }
  
  // Insert
  const { data } = await supabase
    .from('profiles')
    .insert(profile)
    .select()
    .single()
  
  return data
}
```

**Why better**: TypeScript is easier to debug and modify than SQL!

---

### Example 2: `create_notification()`

**What it does**: Creates a notification for a user

**Where it goes**:

**BEFORE** (PostgreSQL - complex with preferences, deduplication):
```sql
CREATE FUNCTION create_notification(
  p_user_id UUID,
  p_type TEXT,
  p_data JSONB
) ...
  -- Check notification preferences
  -- Deduplicate similar notifications
  -- Insert
  -- Update unread count
  -- Broadcast via Supabase real-time
```

**AFTER** (Multiple places):

**Simple Insert** (PostgreSQL - just 5 lines):
```sql
CREATE FUNCTION create_notification_structured(
  p_user_id UUID,
  p_type VARCHAR,
  p_data JSONB
) RETURNS UUID AS $$
BEGIN
  INSERT INTO notifications (user_id, type, data)
  VALUES (p_user_id, p_type, p_data)
  RETURNING id;
END;
$$;
```

**Trigger for Mentions** (Auto-run):
```sql
CREATE TRIGGER notify_mentions
AFTER INSERT ON messages
WHEN (NEW.content @> '[{"type": "mention"}]')
FOR EACH ROW
EXECUTE FUNCTION create_mention_notifications();
```

**Deduplication** (Frontend handles):
```typescript
// Frontend checks before creating
const existing = await supabase
  .from('notifications')
  .select('id')
  .eq('user_id', userId)
  .eq('type', 'mention')
  .eq('data->message_id', messageId)
  .maybeSingle()

if (!existing) {
  await supabase.from('notifications').insert({ ... })
}
```

---

### Example 3: `extract_mentions()`

**What it does**: Parses content to find @mentions

**Where it goes**:

**BEFORE** (PostgreSQL - JSONB parsing in SQL):
```sql
CREATE FUNCTION extract_mentions(content JSONB)
RETURNS TABLE(username TEXT, domain TEXT) AS $$
  -- Loop through JSONB array
  -- Find parts where type = 'mention'
  -- Extract username and domain
  -- Return as table
$$;
```

**AFTER** (Frontend - TypeScript):
```typescript
// src/utils/contentParsing.ts

export function extractMentions(content: MessagePart[]): Mention[] {
  return content
    .filter((part): part is MentionPart => part.type === 'mention')
    .map(part => ({
      username: part.username,
      domain: part.domain,
      userId: part.userId,
      url: part.url
    }))
}

// SO MUCH EASIER!
```

**Use it**:
```typescript
const mentions = extractMentions(message.content)
// Create notifications
for (const mention of mentions) {
  await supabase.from('notifications').insert({
    user_id: mention.userId,
    type: 'mention',
    data: { message_id: messageId }
  })
}
```

---

### Example 4: `handle_post_federation()`

**What it does**: Queues a post for federation delivery

**Where it goes**:

**BEFORE** (PostgreSQL - complex):
```sql
CREATE FUNCTION handle_post_federation()
RETURNS TRIGGER AS $$
BEGIN
  -- Check if should federate
  -- Get followers
  -- Create activities
  -- Queue for delivery
  -- Complex error handling
END;
$$;
```

**AFTER** (Database Trigger + Federation Backend):

**Trigger** (Simple notification):
```sql
CREATE TRIGGER notify_post_created
AFTER INSERT ON posts
WHEN (NEW.is_local = true AND NEW.visibility IN ('public', 'unlisted'))
FOR EACH ROW
EXECUTE FUNCTION notify_federation_event('post_created');

-- Simple notify function:
CREATE FUNCTION notify_federation_event(event_type TEXT)
RETURNS TRIGGER AS $$
BEGIN
  PERFORM pg_notify('federation_events', 
    json_build_object('event', event_type, 'id', NEW.id)::text
  );
  RETURN NEW;
END;
$$;
```

**Federation Backend** (TypeScript - complex logic):
```typescript
// federation-backend/src/listeners/DatabaseListener.ts

supabase
  .channel('federation')
  .on('postgres_changes', {
    event: 'INSERT',
    schema: 'public',
    table: 'posts',
    filter: 'is_local=eq.true'
  }, async (payload) => {
    const post = payload.new
    
    // Get author
    const author = await getAuthor(post.author_id)
    
    // Get followers (local + remote)
    const followers = await getFollowers(author.id)
    
    // Convert to ActivityPub
    const activity = createPostActivity(post, author)
    
    // Queue delivery to remote followers
    for (const follower of followers) {
      if (!follower.is_local) {
        await deliveryQueue.enqueue(
          activity,
          follower.inbox_url,
          author.id
        )
      }
    }
  })
  .subscribe()
```

**Why better**: Complex logic in TypeScript, database just notifies!

---

## Discord vs ActivityPub Features

### Discord-Style (Local-Only)

**Server Chat**:
```
#general channel message
  ↓
Database: INSERT into messages (channel_id)
  ↓
Real-time: Broadcast to server members
  ↓
DONE! No federation!
```

**Voice Channels**:
```
WebRTC connections
  ↓
No database (just signaling)
  ↓
No federation (peer-to-peer)
```

### ActivityPub-Style (Federated)

**Public Posts**:
```
Create post (visibility: public)
  ↓
Database: INSERT into posts
  ↓
Trigger: NOTIFY federation backend
  ↓
Federation: Deliver to followers on Mastodon, Misskey, etc.
```

**Federated DMs**:
```
DM to @alice@mastodon.social
  ↓
Database: INSERT into messages (conversation_id)
  ↓
Trigger: Check if has remote participants → YES!
  ↓
Trigger: NOTIFY federation backend
  ↓
Federation: Send to alice's Mastodon inbox
```

**Mixed Group DMs** (This is where it gets interesting!):
```
Group DM with:
  - You (local)
  - Bob (local)
  - Alice@mastodon.social (remote)
  
When you send a message:
  ↓
Database: INSERT into messages
  ↓
Real-time: Bob sees it instantly (local subscription)
  ↓
Trigger: Detects Alice is remote
  ↓
Federation: Sends to Alice's inbox (ActivityPub Note)
  ↓
Alice sees it in Mastodon!
```

---

## The Complete Function Breakdown

### Category 1: Complex Queries (PostgreSQL)

**These are HARD to do in the app**:
```sql
1. get_or_create_conversation(user1, user2)
   - Complex: Check both directions, handle edge cases
   - Would need multiple queries in app
   - Better as single SQL function

2. search_users(query, limit)
   - Complex: Full-text search, ranking, filters
   - PostgreSQL does this better than app
   - Uses tsvector indexing

3. get_timeline(user_id, limit, before)
   - Complex: Joins, filters, visibility rules
   - One optimized query better than multiple

4. get_trending_hashtags(days, limit)
   - Complex: Aggregations, time windows
   - SQL aggregation is faster
```

### Category 2: Simple Helpers (PostgreSQL)

**Convenient, keep them**:
```sql
5. get_user_handle(user_id)
   -- Returns: "username@domain"
   -- Used in many queries
   
6. is_local_user(user_id)
   -- Returns: boolean
   -- Used in conditional logic
   
7. extract_hashtags_from_content(content)
   -- Parses JSONB for #hashtags
   -- Complex JSONB manipulation
```

### Category 3: System Operations (PostgreSQL)

**Server-side only**:
```sql
8. create_system_message(channel_id, type, data)
   -- Creates "User joined" messages
   -- Server-triggered, not user-triggered
   
9. create_default_server_structure(server_id)
   -- Sets up default channels on server creation
   -- Convenience function
   
10. cleanup_old_notifications()
    -- Maintenance function
    -- Run by cron
```

### Category 4: Notifications (PostgreSQL)

**Could be triggers, but convenient as functions**:
```sql
11. create_notification_structured(user_id, type, data)
    -- Simple INSERT wrapper
    -- Used by triggers and app
    
12. get_unread_notification_count(user_id)
    -- Simple COUNT query
    -- Frequently used
```

### Category 5: Triggers (PostgreSQL)

**Auto-run helpers**:
```sql
13. update_updated_at_column()
    -- Sets updated_at = NOW() automatically
    
14. notify_federation_event(event_type)
    -- Sends pg_notify() to federation backend
    
15. update_post_counters()
    -- Updates reply_count, like_count automatically
```

---

## Where The Other ~109 Functions Go

### → Federation Backend (TypeScript)

**All ActivityPub stuff** (~30 functions):
```
create_http_signature                → SignatureService.ts
convert_to_activitypub               → toActivityPub.ts
extract_activitypub_tags             → fromActivityPub.ts
create_federated_profile             → ActivityProcessor.ts
process_federation_delivery_queue    → DeliveryQueue.ts
handle_post_federation               → DatabaseListener.ts
... ~24 more
```

### → Frontend Utils (TypeScript)

**Parsing & Formatting** (~40 functions):
```
extract_mentions                     → contentParsing.ts
extract_hashtags                     → contentParsing.ts
format_content                       → contentFormatting.ts
validate_username                    → validation.ts
parse_markdown                       → markdown.ts
... ~35 more
```

### → Auto-Run Triggers (~20 functions)

**Don't call these, they run automatically**:
```
handle_mention_notifications         → Trigger: notify_on_mention
handle_reaction_notifications        → Trigger: notify_on_reaction
update_timeline_cache                → Trigger: update_on_post
... ~17 more
```

### → Deleted (~19 functions)

**No longer needed**:
```
get_cached_timeline                  → Direct query is faster
update_follower_timelines            → Real-time handles this
log_notification_insert              → Don't need logging
... ~16 more
```

---

## Real-World Example: Complete User Flow

### Scenario: Send DM to Remote User

**You**: `@y4my4m@har.mony.lol`  
**Them**: `@alice@mastodon.social`

**Step 1 - Frontend** (You type and send):
```typescript
// 1. Get or create conversation
const { data: convId } = await supabase.rpc('get_or_create_conversation', {
  user1_uuid: 'your-id',
  user2_uuid: 'alice-id'  // Alice from Mastodon
})

// 2. Extract mentions from your typed message
const content = [
  { type: 'text', text: 'Hey ' },
  { type: 'mention', username: 'alice', domain: 'mastodon.social' },
  { type: 'text', text: ', check this out!' }
]

// 3. Send message
const { data: message } = await supabase
  .from('messages')
  .insert({
    conversation_id: convId,
    content: content
  })
  .select()
  .single()
```

**Step 2 - Database** (Trigger fires):
```sql
-- Trigger checks: Does conversation have remote users?
CREATE TRIGGER check_federation_on_dm
AFTER INSERT ON messages
FOR EACH ROW
WHEN (NEW.conversation_id IS NOT NULL)
EXECUTE FUNCTION maybe_federate_dm();

-- Function checks participants:
CREATE FUNCTION maybe_federate_dm()
RETURNS TRIGGER AS $$
BEGIN
  -- Are there remote participants?
  IF EXISTS (
    SELECT 1 FROM conversation_participants cp
    JOIN profiles p ON cp.user_id = p.id
    WHERE cp.conversation_id = NEW.conversation_id
      AND p.is_local = false
  ) THEN
    -- Yes! Notify federation backend
    PERFORM pg_notify('dm_to_remote', 
      json_build_object(
        'message_id', NEW.id,
        'conversation_id', NEW.conversation_id
      )::text
    );
  END IF;
  
  RETURN NEW;
END;
$$;
```

**Step 3 - Federation Backend** (Receives notification):
```typescript
// Listening to PostgreSQL NOTIFY
db.on('notification', async (msg) => {
  if (msg.channel === 'dm_to_remote') {
    const { message_id, conversation_id } = JSON.parse(msg.payload)
    
    // Get message from database
    const message = await supabase
      .from('messages')
      .select('*, author:profiles(*)')
      .eq('id', message_id)
      .single()
    
    // Get remote participants
    const { data: participants } = await supabase
      .from('conversation_participants')
      .select('user_id, profiles(*)')
      .eq('conversation_id', conversation_id)
    
    const remoteUsers = participants.filter(p => !p.profiles.is_local)
    
    // Convert message to ActivityPub Note
    const activity = {
      '@context': 'https://www.w3.org/ns/activitystreams',
      type: 'Create',
      actor: `https://har.mony.lol/users/${message.author.username}`,
      object: {
        type: 'Note',
        content: convertContentToHTML(message.content),
        to: remoteUsers.map(u => u.profiles.ap_id)
      }
    }
    
    // Queue delivery to each remote user
    for (const user of remoteUsers) {
      await deliveryQueue.enqueue(
        activity,
        user.profiles.inbox_url,  // alice@mastodon.social's inbox
        message.author.id
      )
    }
  }
})
```

**Step 4 - Delivery Queue** (Background worker):
```typescript
// Processes queue every 30 seconds

async function processDeliveries() {
  const pending = await getPendingDeliveries()
  
  for (const delivery of pending) {
    // Sign the HTTP request
    const signature = await signRequest(
      delivery.target_inbox,
      delivery.activity,
      delivery.sender_id
    )
    
    // POST to Mastodon's inbox
    const response = await fetch(delivery.target_inbox, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/activity+json',
        'Signature': signature,
        'Date': new Date().toUTCString()
      },
      body: JSON.stringify(delivery.activity)
    })
    
    if (response.ok) {
      // Mark as delivered
      await markDelivered(delivery.id)
    } else {
      // Retry with exponential backoff
      await scheduleRetry(delivery.id)
    }
  }
}
```

**Result**: Alice receives your DM in Mastodon! 🎉

---

## So What's Local vs Federated?

### Data Flow: Server Message (Local Only)

```
#general: "Hello everyone!"
  ↓
Frontend: INSERT into messages (channel_id = 'general')
  ↓
Database: INSERT succeeds
  ↓
Real-time: Supabase broadcasts to channel subscribers
  ↓
Other users in server: See message instantly
  ↓
DONE! (No federation involved)
```

### Data Flow: DM to Local User (Local Only)

```
DM to @bob (local user on same instance)
  ↓
Frontend: INSERT into messages (conversation_id)
  ↓
Database: INSERT succeeds
  ↓
Trigger: Checks participants → ALL LOCAL
  ↓
No NOTIFY sent (no federation needed)
  ↓
Real-time: Bob sees message
  ↓
DONE! (No federation involved)
```

### Data Flow: DM to Remote User (Federated!)

```
DM to @alice@mastodon.social
  ↓
Frontend: INSERT into messages (conversation_id)
  ↓
Database: INSERT succeeds
  ↓
Trigger: Checks participants → HAS REMOTE!
  ↓
Trigger: pg_notify('dm_to_remote', message_id)
  ↓
Federation Backend: Receives notification
  ↓
Federation Backend: 
  - Converts to ActivityPub
  - Signs HTTP request
  - POSTs to mastodon.social/inbox
  ↓
Alice sees DM in Mastodon!
```

### Data Flow: Public Post (Always Federated)

```
Create post (visibility: public)
  ↓
Frontend: INSERT into posts
  ↓
Database: INSERT succeeds
  ↓
Trigger: ALWAYS notifies (public posts always federate)
  ↓
pg_notify('post_created', post_id)
  ↓
Federation Backend:
  - Gets followers (local + remote)
  - For LOCAL followers: They see via Supabase real-time
  - For REMOTE followers: Queue ActivityPub delivery
  ↓
Remote instances receive Create activity
```

---

## The Truth About Those 124 Functions

### They're Not All "Functions" - Many Are Different Things!

**Actual callable functions**: ~50
**Trigger helpers**: ~20 (auto-run, don't call directly)
**Duplicates**: ~15 (same logic, different names)
**Obsolete**: ~10 (replaced by better approach)
**Federation protocol**: ~29 (move to TypeScript)

### Example Breakdown

**Timeline Functions** (10 → 1):
```sql
-- All these do basically the same thing:
get_timeline()
get_user_timeline()
get_cached_timeline()
get_timeline_posts_with_interactions()
create_simple_timeline_entries()
update_timeline_cache()
update_follower_timelines()
...

-- Consolidated into ONE:
get_timeline(user_id, limit, before) 
  -- Simple: Get posts from followed users
```

**Notification Functions** (10 → 2):
```sql
-- All handle different notification types:
handle_mention_notifications()
handle_reaction_notifications()
handle_follow_notifications()
handle_post_notifications()
create_notification()
create_simple_notification()
...

-- Consolidated into:
1. create_notification_structured()  -- Insert
2. get_unread_notification_count()   -- Count

-- Plus triggers that auto-create notifications!
```

---

## Updated Architecture Diagram

```
┌────────────────────────────────────────────────────────┐
│             FRONTEND (Vue 3)                            │
│                                                         │
│  Discord Features:        ActivityPub Features:        │
│  ─────────────────        ────────────────────         │
│  • Server chat           • Public posts                │
│  • Voice channels        • Federated DMs               │
│  • Local DMs             • Follows                     │
│                          • Reactions (on federated)    │
│                                                         │
│  Utilities:                                             │
│  • extractMentions()                                    │
│  • extractHashtags()                                    │
│  • formatContent()                                      │
│  • validateInput()                                      │
└────────────┬────────────────────────┬──────────────────┘
             │                        │
             │ Direct Supabase        │ Direct Supabase
             ▼                        ▼
┌────────────────────────────────────────────────────────┐
│           SUPABASE (PostgreSQL + Real-time)             │
│                                                         │
│  ~15 Functions:                                         │
│  ──────────────                                         │
│  • get_or_create_conversation() [complex query]        │
│  • search_users()               [full-text search]     │
│  • get_timeline()               [complex joins]        │
│  • get_trending_hashtags()      [aggregation]          │
│  • extract_hashtags_from_content() [JSONB parse]       │
│  • get_user_handle()            [helper]               │
│  • is_local_user()              [helper]               │
│  • create_system_message()      [system]               │
│  • create_default_server_structure() [system]          │
│  • create_notification_structured() [insert]           │
│  • get_unread_notification_count() [count]             │
│  • cleanup_old_notifications()  [maintenance]          │
│  • update_updated_at_column()   [trigger]              │
│  • notify_federation_event()    [trigger]              │
│  • update_post_counters()       [trigger]              │
│                                                         │
│  Triggers:                                              │
│  ─────────                                              │
│  • Post created (public) → NOTIFY federation           │
│  • DM to remote user → NOTIFY federation               │
│  • Mention in content → Create notification            │
│  • Reaction added → Update counters                    │
│  • Profile updated → NOTIFY federation                 │
└────────────┬───────────────────────────────────────────┘
             │
             │ PostgreSQL NOTIFY/LISTEN
             │ + Supabase Real-time subscriptions
             ▼
┌────────────────────────────────────────────────────────┐
│    FEDERATION BACKEND (Node.js/TypeScript)              │
│    Handles ONLY cross-instance communication           │
│                                                         │
│  ~30 Functions Worth of Logic:                         │
│  ───────────────────────────                           │
│  ActivityPub Protocol:                                  │
│  • signRequest() [HTTP signatures]                     │
│  • verifySignature() [incoming verification]           │
│  • postToNote() [convert post → ActivityPub]           │
│  • noteToContent() [convert ActivityPub → post]        │
│  • profileToActor() [convert profile → Actor]          │
│  • actorToProfile() [convert Actor → profile]          │
│                                                         │
│  Processing:                                            │
│  • processFollow() [handle Follow activity]            │
│  • processCreate() [handle Create activity]            │
│  • processLike() [handle Like/reaction]                │
│  • processAnnounce() [handle reblog]                   │
│  • ensureRemoteUser() [fetch remote profile]           │
│                                                         │
│  Delivery:                                              │
│  • enqueueDelivery() [queue for sending]               │
│  • processQueue() [background worker]                  │
│  • deliverActivity() [HTTP POST with signature]        │
│  • broadcastToFollowers() [send to all followers]      │
│                                                         │
│  Endpoints:                                             │
│  • POST /inbox [receive activities]                    │
│  • GET /outbox [serve activities]                      │
│  • GET /.well-known/webfinger [discovery]              │
│  • GET /users/:username [Actor]                        │
└────────────┬───────────────────────────────────────────┘
             │
             │ HTTP + ActivityPub Protocol
             ▼
┌────────────────────────────────────────────────────────┐
│         FEDIVERSE (Other Instances)                     │
│  • Mastodon • Misskey • Pleroma • Other Harmony        │
└────────────────────────────────────────────────────────┘
```

---

## Summary: Nothing Is Lost!

### The Logic Still Exists, Just Better Organized

**Before**:
- 124 functions in PostgreSQL
- Complex SQL hard to debug
- Mixed concerns (CRUD + federation + parsing)
- Everything in one place

**After**:
- 15 functions in PostgreSQL (only complex queries)
- ~30 in Federation Backend (ActivityPub protocol)
- ~40 in Frontend (parsing, formatting)
- ~20 as Triggers (auto-run)
- ~19 deleted (redundant)

**Total**: Still ~124 functions worth of logic!  
**Difference**: Much better organized! 🎯

---

## Your Discord IS Partially Federated!

```
┌─────────────────────────────────────┐
│  LOCAL (Not Federated)              │
│  ─────────────────────              │
│  • Server chat messages             │
│  • Voice channels                   │
│  • Server settings                  │
│  • Channel management               │
│  • DMs between local users          │
└─────────────────────────────────────┘

┌─────────────────────────────────────┐
│  FEDERATED (Cross-Instance)         │
│  ────────────────────────           │
│  • Public posts                     │
│  • DMs to remote users  ←── YES!    │
│  • Group DMs with remote users      │
│  • Follows                          │
│  • Reactions on federated content   │
│  • Profile updates                  │
└─────────────────────────────────────┘
```

Your Discord-like app has a **social layer** on top that's fully federated!

---

**Does this clarify everything?** 🤔

The logic doesn't disappear - it just moves to the right place! And yes, your Discord clone has federation for DMs and the social features!
