# DM Issues - Quick Debug

## What's Working ✅
- Messages stored in database with correct MessagePart[] format
- Backend converts ActivityPub HTML → MessagePart[]
- Signature verification works
- Conversation exists

## What's Not Working ❌

### 1. Messages Don't Show in Conversation View
**Messages exist in DB but don't appear when you open the conversation**

**Debug in browser console**:
```javascript
// Check if DM store has the messages
const dmStore = useDMStore()
console.log('Current conversation:', dmStore.currentConversationId)
console.log('Messages loaded:', dmStore.currentDMMessages.length)
console.log('Messages:', dmStore.currentDMMessages)

// Force reload
await dmStore.fetchConversationMessages('18f369e8-db2c-47c6-967e-149108f52aa0')
console.log('After fetch:', dmStore.currentDMMessages.length)
```

**Possible causes**:
- Cache issue (old cache blocking new fetch)
- Realtime subscription not set up for that conversation
- Messages being filtered somewhere

### 2. Notification Shows JSON
**Trigger sends `LEFT(NEW.content::text, 100)` which stringifies JSONB**

**Current code** (db trigger):
```sql
'content_preview', LEFT(NEW.content::text, 100)
```

**Result**: `[{"type":"mention","username":"y4my4m"...`

**Should be**:
```sql
'content_preview', messageparts_to_text(NEW.content)
```

**Result**: `@y4my4m hmmk`

**Fix**: Need to update the database trigger

### 3. Double Notifications
**Two triggers both firing for federated DMs**

**Triggers**:
1. `handle_message_federation` (AFTER INSERT) - For incoming federated
2. `handle_outgoing_messages` (AFTER INSERT) - For outgoing messages

Both call `send_notification()` for DMs, causing duplicates.

**Fix**: One should check if message is incoming vs outgoing

---

## Quick Fixes You Can Try Now

### Fix 1: Clear DM Cache
In browser console:
```javascript
localStorage.removeItem('dm_cache')
location.reload()
```

### Fix 2: Check Realtime Subscription
In browser console when viewing that DM:
```javascript
const dmStore = useDMStore()
console.log('Subscriptions:', dmStore.activeSubscriptions)
console.log('Current conversation:', dmStore.currentConversationId)
```

Should show subscription for `dm-conversation-18f369e8-db2c-47c6-967e-149108f52aa0`

### Fix 3: Manually Fetch
```javascript
await dmStore.fetchConversationMessages('18f369e8-db2c-47c6-967e-149108f52aa0')
```

If this works, it's a cache/subscription issue. If not, there's a query problem.

---

## Real Fixes Needed

1. **Update notification trigger** - Use `messageparts_to_text()` helper
2. **Fix double notifications** - Make triggers conditional on incoming/outgoing
3. **Debug DM loading** - Add logging to see why fetch isn't working

But DON'T create migration scripts - fix the actual trigger functions in your schema!



