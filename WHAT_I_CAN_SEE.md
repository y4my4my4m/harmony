# What I Can See From Code Analysis

**Based on code review, not actual testing**

---

## ✅ Should Be Working

### Timeline Loading
- ✅ Direct Supabase queries (replaced RPC)
- ✅ Includes author info with color
- ✅ Pagination logic intact
- ✅ Multiple timeline types (home, public, local)

### Message Creation
- ✅ CoreMessageService uses Supabase insert
- ✅ Real-time subscriptions in place
- ✅ Channel and DM messages

### User Data
- ✅ userDataService has color loading
- ✅ Color included in queries
- ✅ Cache mechanism in place

---

## ⚠️ Likely Issues (Code Smells)

### 1. Post Interaction Icons Not Filling

**What I see in code**:

`useActivityPub.ts` line 774:
```
🔍 DEBUG: Post not found in feed for postId: 8bed59b6-a7c0-4c4c-a67f-4b84ff48ffbd
```

**Problem**: Post lookup is failing!

**Root Cause** (from code):
```typescript
// Line ~700 in useActivityPub.ts
const post = this.homeFeed.posts.find(p => p.id === postId)
```

**Why it fails**:
- Post might be in different feed (publicFeed, localFeed)
- Only checking homeFeed
- Need to check ALL feeds!

**Proper Fix**:
```typescript
// Check all feeds
const post = 
  this.homeFeed.posts.find(p => p.id === postId) ||
  this.publicFeed.posts.find(p => p.id === postId) ||
  this.localFeed.posts.find(p => p.id === postId)

if (post) {
  // Update state
  post.is_bookmarked = true
}
```

### 2. Follow Approval Hardcoded

**Code shows**:
```typescript
const requiresApproval = false // HACK!
```

**Missing**:
- No `manually_approves_followers` column
- No proper approval logic
- No Accept activity sent

**Proper Fix Needed**:
1. Add database column
2. Check actual value
3. Send Accept activity via federation

### 3. Notification Functions Exist

**Good news**: 16 notification functions still exist!
```
create_notification_structured
create_notification_with_spam_prevention
handle_local_post_mention_notifications
handle_unified_notification_processing
... (12 more)
```

**Should be working!** But need to test.

---

## 🔍 Obvious Bugs I Can Fix Now

### Bug 1: Post Not Found in Feed

**File**: `src/stores/useActivityPub.ts`
**Line**: ~700-800 (updatePostInteractionFromRealtime)

**Fix**: Check ALL feeds, not just homeFeed

### Bug 2: unifiedWebRTC Export

**File**: `src/components/dm/DMHeader.vue`
**Status**: FIXED! Changed to `unifiedWebRTC`

### Bug 3: is_private References

**Files**: CoreProfileService, CoreInteractionService
**Status**: FIXED! Removed references

---

## 📊 What Needs Testing (I Can't Do This!)

You need to manually test:
- Does timeline load? (Should work!)
- Do colors show? (Should work!)
- Do bookmarks save? (Check DB)
- Do bookmark icons fill? (Frontend bug - I can see the issue!)
- Do notifications appear? (Should work - functions exist!)
- Does follow work? (Backend yes, approval logic is hackedneed proper fix)

---

## 🎯 What I Should Fix NOW

Based on code analysis, I can fix:

1. **Post lookup in all feeds** (obvious bug I can see)
2. **Add manually_approves_followers column** (proper ActivityPub)
3. **Remove TODO comment hacks** (implement properly)

**Want me to fix these obvious issues?** Or should you test first and report what's actually broken?

---

I'm at the limit of what I can do without you testing the actual app! 🧪

