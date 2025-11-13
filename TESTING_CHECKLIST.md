# Harmony Testing Checklist

**Use this to systematically test everything after the refactor**

---

## 🧪 Test 1: Basic CRUD Operations

### Posts
- [ ] **Create post** → Open ActivityPub, write post, submit
  - Check: Does it appear in timeline?
  - Check DB: `SELECT * FROM posts ORDER BY created_at DESC LIMIT 1;`
  - Console errors?

- [ ] **Edit post** → Click edit on a post
  - Check: Does update save?
  - Check: Shows edited content?

- [ ] **Delete post** → Delete a post
  - Check: Removes from timeline?
  - Check DB: Soft delete or hard delete?

### Messages (Server Chat)
- [ ] **Send message in #general**
  - Check: Appears in chat?
  - Check: Other users see it (if testing multi-user)?
  - Check DB: `SELECT * FROM messages WHERE channel_id = 'X' ORDER BY created_at DESC LIMIT 5;`

### DMs
- [ ] **Send DM**
  - Check: Appears in conversation?
  - Check: Recipient sees it?
  - Check DB: `SELECT * FROM messages WHERE conversation_id = 'X' ORDER BY created_at DESC LIMIT 5;`

**PASS/FAIL**: _____

---

## 🧪 Test 2: Post Interactions (CRITICAL - Known Issues!)

### Likes
- [ ] **Click heart icon** on a post
  - Check DB: `SELECT * FROM post_interactions WHERE post_id = 'POST_ID' AND interaction_type = 'like';`
  - Result: Row exists? ✅ Backend works
  - Check UI: Does heart icon FILL with color?
  - Result: Icon fills? ⚠️ **KNOWN BUG** if no

- [ ] **Click heart again** (unlike)
  - Check DB: Row deleted?
  - Check UI: Icon unfills?

### Bookmarks
- [ ] **Click bookmark icon**
  - Check DB: `SELECT * FROM post_interactions WHERE post_id = 'POST_ID' AND interaction_type = 'bookmark';`
  - Result: Row exists? ✅ Backend works
  - Check UI: Does bookmark icon FILL?
  - Result: Icon fills? ⚠️ **KNOWN BUG** if no

### Reblogs
- [ ] **Click reblog icon**
  - Check DB: `SELECT * FROM posts WHERE reblog_of = 'POST_ID';`
  - Result: Reblog post created? ✅ Backend works
  - Check UI: Does reblog icon FILL?
  - Result: Icon fills? ⚠️ **KNOWN BUG** if no

**Diagnosis**:
- If DB has data but UI doesn't update → **Frontend state management bug**
- If DB doesn't have data → **Backend bug**

**PASS/FAIL**: _____

---

## 🧪 Test 3: Notifications

### Mention Notifications
- [ ] **Mention someone** in a post (@username)
  - Check DB: `SELECT * FROM notifications WHERE type = 'mention' ORDER BY created_at DESC LIMIT 5;`
  - Result: Notification created?
  - Check UI: Notification bell shows count?
  - Check UI: Notification appears in list?

### Follow Notifications
- [ ] **Follow a user**
  - Check DB: `SELECT * FROM notifications WHERE type = 'follow' ORDER BY created_at DESC LIMIT 5;`
  - Result: They get notification?

### Like Notifications (if enabled)
- [ ] **Like someone's post**
  - Check DB: `SELECT * FROM notifications WHERE type = 'like' ORDER BY created_at DESC LIMIT 5;`
  - Result: They get notification?

**Check Console**: Any notification errors?

**PASS/FAIL**: _____

---

## 🧪 Test 4: Follow System

### Basic Follow
- [ ] **Click Follow** on a user
  - Check DB: `SELECT * FROM follows WHERE follower_id = 'YOU' AND following_id = 'THEM';`
  - Result: Row created?
  - Check: `status` column = 'accepted' or 'pending'?
  - Check UI: Button changes to "Following"?
  - Check UI: Following count increments?

### Unfollow
- [ ] **Click Unfollow**
  - Check DB: Row deleted?
  - Check UI: Button changes back to "Follow"?
  - Check UI: Following count decrements?

### Follow Counters
- [ ] Check follower/following counts
  - UI matches database?

**PASS/FAIL**: _____

---

## 🧪 Test 5: Real-Time Updates

### Timeline Real-Time
- [ ] **Open timeline** in two browser tabs (or two users)
  - One user creates post
  - Check: Other user sees it appear instantly?

### Chat Real-Time
- [ ] **Open same channel** in two tabs
  - Send message in one
  - Check: Appears in other instantly?

### Notifications Real-Time
- [ ] **Get mentioned/followed**
  - Check: Notification appears without refresh?

**PASS/FAIL**: _____

---

## 🧪 Test 6: Federation (If Backend Running)

### Setup
```bash
cd federation-backend
npm run dev
```

### Public Post Federation
- [ ] **Create public post**
  - Check backend logs: "Post created" event?
  - Check DB: `SELECT * FROM federation_delivery_queue ORDER BY created_at DESC LIMIT 5;`
  - Result: Delivery queued?

### Server Message Federation
- [ ] **Enable federation on server**: 
  ```sql
  UPDATE servers SET federation_enabled = true WHERE id = 'YOUR_SERVER_ID';
  ```
- [ ] **Send message in channel**
  - Check backend logs: "Channel message federate" event?
  - Check: Message queued for delivery?

**PASS/FAIL**: _____

---

## 📋 Results Summary

Fill this out after testing:

### Working ✅
```
- 
- 
- 
```

### Broken (New - from refactor) ❌
```
- 
- 
```

### Broken (Pre-existing) ⚠️
```
- Bookmark icon doesn't fill (KNOWN)
- Reblog icon doesn't fill (KNOWN)
- Like icon doesn't fill (KNOWN)
- 
```

### Console Errors
```
(Paste any errors here)
```

---

## 🔧 Next Steps After Testing

1. **Share results** with me
2. **I'll analyze** and identify root causes
3. **We'll fix** issues properly (no hacks!)
4. **Re-test** to verify

---

**Start testing! Report back what works and what doesn't!** 🧪

