# Harmony: The CORRECT Architecture

## Core Principle

**Supabase for app operations, Separate backend for federation ONLY**

---

## Architecture Overview

```
┌──────────────────────────────────────────────────────────────┐
│                         FRONTEND (Vue 3)                      │
│                                                               │
│  Components → Stores → Direct Supabase Calls                │
│  - No API layer for CRUD                                     │
│  - Direct database access (fast!)                            │
│  - Real-time subscriptions                                   │
└────────────────────────┬─────────────────────────────────────┘
                         │
                         │ Direct Access (RLS protected)
                         ▼
┌──────────────────────────────────────────────────────────────┐
│                    SUPABASE (PostgreSQL)                      │
│                                                               │
│  ┌────────────────┐  ┌──────────────┐  ┌─────────────────┐ │
│  │ Tables         │  │ Simple       │  │ Row Level       │ │
│  │ - messages     │  │ Functions    │  │ Security (RLS)  │ │
│  │ - posts        │  │ (~10 total)  │  │                 │ │
│  │ - profiles     │  │              │  │ Security rules  │ │
│  │ - servers      │  │ Just CRUD!   │  │ per table       │ │
│  └────────────────┘  └──────────────┘  └─────────────────┘ │
│                                                               │
│  ┌────────────────┐  ┌──────────────┐                       │
│  │ Triggers       │  │ Notifications│                       │
│  │ - on INSERT    │─▶│ NOTIFY       │────────┐             │
│  │ - on UPDATE    │  │ federation   │        │             │
│  └────────────────┘  └──────────────┘        │             │
└───────────────────────────────────────────────┼─────────────┘
                                                │
                         PostgreSQL NOTIFY      │
                                                ▼
┌──────────────────────────────────────────────────────────────┐
│              FEDERATION BACKEND (Node.js)                     │
│                   ⚠️  FEDERATION ONLY!                        │
│                                                               │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ Database Listener (LISTEN/NOTIFY)                    │   │
│  │ - Watches for post_created, dm_created, etc.        │   │
│  │ - Converts to ActivityPub                           │   │
│  │ - Queues for delivery                               │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                               │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ ActivityPub Endpoints (NO CRUD!)                     │   │
│  │ - POST /inbox (receive)                              │   │
│  │ - GET /users/:user/outbox (serve)                    │   │
│  │ - GET /.well-known/webfinger                         │   │
│  │ - GET /.well-known/nodeinfo                          │   │
│  └──────────────────────────────────────────────────────┘   │
│                                                               │
│  ┌──────────────────────────────────────────────────────┐   │
│  │ Delivery Queue                                       │   │
│  │ - HTTP signature signing                             │   │
│  │ - Retry logic                                        │   │
│  │ - Send to remote instances                           │   │
│  └──────────────────────────────────────────────────────┘   │
└────────────────────────┬─────────────────────────────────────┘
                         │
                         │ HTTP + Signatures
                         ▼
┌──────────────────────────────────────────────────────────────┐
│                   FEDIVERSE (Mastodon, etc.)                  │
└──────────────────────────────────────────────────────────────┘
```

---

## What Lives Where

### Frontend (Vue 3)
**Responsibility**: User interface and direct database operations

```typescript
// ✅ YES - Direct Supabase
await supabase.from('messages').insert({ content, channel_id })
await supabase.from('posts').select('*')
await supabase.channel('messages').subscribe()

// ❌ NO - No API calls for CRUD
await api.messages.create() // DON'T DO THIS
```

### Supabase (PostgreSQL + Services)
**Responsibility**: Data storage, security, real-time, simple business logic

**Simple Functions** (Only ~10 needed):
1. `create_message()` - Basic insert with auth check
2. `create_post()` - Basic insert with auth check  
3. `update_profile()` - Basic update with validation
4. `delete_message()` - Soft delete
5. `toggle_reaction()` - Add/remove reaction
6. `get_timeline()` - Optimized query
7. `search_users()` - Full-text search
8. `create_conversation()` - DM conversation logic
9. `check_permissions()` - Server/channel permissions
10. `cleanup_old_data()` - Maintenance

**Database Triggers** (Notify federation):
```sql
CREATE TRIGGER notify_post_created
AFTER INSERT ON posts
FOR EACH ROW WHEN (NEW.visibility IN ('public', 'unlisted'))
EXECUTE FUNCTION notify_federation('post_created');
```

### Federation Backend (Node.js)
**Responsibility**: ActivityPub protocol ONLY

**What it does**:
- ✅ Listens for database notifications
- ✅ Converts internal format → ActivityPub
- ✅ Signs HTTP requests
- ✅ Delivers to followers' inboxes
- ✅ Receives incoming activities
- ✅ Converts ActivityPub → internal format
- ✅ Writes back to database

**What it does NOT do**:
- ❌ Handle normal CRUD operations
- ❌ User authentication (Supabase does this)
- ❌ Business logic (database does this)
- ❌ Real-time updates (Supabase does this)

---

## Example Flows

### Creating a Post (Local)

```
1. User clicks "Post"
   ↓
2. Frontend: supabase.from('posts').insert({ content, visibility: 'public' })
   ↓
3. Database: INSERT succeeds, trigger fires
   ↓
4. Trigger: NOTIFY federation 'post_created', post_id
   ↓
5. Federation Backend: Receives notification
   ↓
6. Federation Backend:
   - Converts post to ActivityPub Note
   - Signs HTTP request
   - Sends to followers' inboxes
   ↓
7. Remote instances: Receive and display
```

### Receiving a Federated Post

```
1. Remote Mastodon: POST https://yourdomain.com/inbox
   ↓
2. Federation Backend: 
   - Verifies HTTP signature
   - Validates activity
   - Converts ActivityPub → internal format
   ↓
3. Federation Backend: 
   supabase.from('posts').insert({
     content: convertedContent,
     author_id: remoteUserId,
     is_local: false
   })
   ↓
4. Database: INSERT succeeds, real-time fires
   ↓
5. Frontend: Receives real-time update, displays post
```

### Sending a DM (Federated)

```
1. User sends DM to @user@mastodon.social
   ↓
2. Frontend: supabase.from('messages').insert({ 
     content, 
     conversation_id 
   })
   ↓
3. Database: INSERT succeeds, trigger fires
   ↓
4. Trigger: NOTIFY federation 'dm_created', message_id
   ↓
5. Federation Backend:
   - Checks if recipient is remote
   - Creates ActivityPub Note (direct message)
   - Signs request
   - POSTs to recipient's inbox
```

---

## Benefits of This Architecture

### 1. **Supabase Used Properly**
- Direct database access (fast!)
- RLS for security
- Real-time subscriptions
- Simple functions only

### 2. **Federation is Isolated**
- Complex ActivityPub logic separate
- Can be developed/tested independently
- Can scale separately
- Easy to debug

### 3. **Clean Separation**
```
App Logic     → Supabase (fast, simple)
Federation    → Backend (complex, async)
```

### 4. **Scalability**
- Frontend: Static, can be CDN
- Supabase: Managed, auto-scales
- Federation: Can run multiple workers

### 5. **Maintainability**
- No complex PostgreSQL functions
- TypeScript for federation (easy to edit!)
- Clear boundaries

---

## Migration Path

### Phase 1: Clean Up PostgreSQL ✅
1. Audit existing 126 functions
2. Identify which are actually needed
3. Consolidate into ~10 simple ones
4. Remove the rest

### Phase 2: Revert Frontend Changes ✅
1. Remove API client I created
2. Keep direct Supabase calls
3. Ensure everything still works

### Phase 3: Refactor Federation Backend ✅
1. Remove CRUD endpoints (messages, posts, users)
2. Keep ONLY ActivityPub endpoints
3. Add database notification listener
4. Test federation flow

### Phase 4: Database Triggers ✅
1. Create triggers for federated events
2. Use PostgreSQL NOTIFY
3. Federation backend listens

### Phase 5: Test & Deploy ✅
1. Test local operations (should be fast!)
2. Test federation (should work!)
3. Deploy federation backend separately

---

## File Structure

```
harmony/
├── src/                          # Frontend (Vue 3)
│   ├── components/
│   ├── stores/
│   └── Direct Supabase calls!    # No API client!
│
├── supabase/
│   ├── migrations/               # Simple schema
│   └── functions/                # 10 simple SQL functions
│
├── federation/                   # NEW: Federation backend
│   ├── src/
│   │   ├── listeners/           # Database notification listeners
│   │   ├── activitypub/         # ActivityPub endpoints
│   │   ├── delivery/            # Queue & delivery
│   │   └── converters/          # Format conversion
│   └── package.json
│
└── docs/
    └── CORRECT_ARCHITECTURE.md  # This file
```

---

## Implementation Priority

1. **First**: Revert frontend API changes ✅
2. **Second**: Refactor federation backend (remove CRUD)
3. **Third**: Add database listeners
4. **Fourth**: Clean up PostgreSQL functions
5. **Fifth**: Test everything
6. **Sixth**: Document & deploy

---

## Success Criteria

✅ Frontend talks directly to Supabase  
✅ Less than 15 PostgreSQL functions total  
✅ Federation backend handles ONLY ActivityPub  
✅ Clear separation of concerns  
✅ Fast local operations  
✅ Working federation  

---

**This is the RIGHT way to build it!** 🎯

