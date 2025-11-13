# Bookmark Icon - The REAL Fix

## The Actual Problem

**Not** a real-time bug!  
**Not** a reactivity bug!  

**The timeline query doesn't fetch YOUR interactions!**

---

## What Was Happening

### When You Click Bookmark:
1. Interaction saves to database ✅
2. Real-time fires ✅
3. Store updates `is_bookmarked = true` ✅
4. Icon fills ✅

### When You Refresh Page:
1. Timeline query runs
2. Gets posts ✅
3. **Doesn't include your interactions** ❌
4. `is_bookmarked` not set ❌
5. Icon shows as unfilled ❌

---

## The Fix

**BEFORE** (Missing interactions):
```typescript
.select(`
  *,
  author:profiles(...)
`)
```

**AFTER** (Includes YOUR interactions):
```typescript
.select(`
  *,
  author:profiles(...),
  my_interactions:post_interactions!left(interaction_type, emoji_id)
`)
.eq('my_interactions.user_id', currentUser.id)
```

**Then process the interactions**:
```typescript
// Convert my_interactions array to boolean flags
post.is_bookmarked = my_interactions.some(i => i.interaction_type === 'bookmark')
post.is_favorited = my_interactions.some(i => i.interaction_type === 'favorite')  
post.is_reblogged = my_interactions.some(i => i.interaction_type === 'reblog')
```

---

## What I Fixed

Updated ALL timeline queries in `activityPubService.ts`:
- `getPublicTimeline()`
- `getEnhancedPublicTimeline()`
- `getLocalTimeline()`
- `getUserTimeline()` (home feed)

All now include `my_interactions` join!

---

## But Wait...

**The data comes back** but needs to be **processed**!

Need to add processing step after query:
```typescript
const { data: posts } = await query

// Process each post to set interaction flags
posts.forEach(post => {
  const myInteractions = post.my_interactions || []
  post.is_bookmarked = myInteractions.some(i => i.interaction_type === 'bookmark')
  post.is_favorited = myInteractions.some(i => i.interaction_type === 'favorite')
  post.is_reblogged = myInteractions.some(i => i.interaction_type === 'reblog')
})

return posts
```

---

## Test After Fix

1. Bookmark a post
2. Refresh page
3. Icon should be filled!

**This is the PROPER fix!** Not a hack! ✅

