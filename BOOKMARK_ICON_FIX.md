# Bookmark/Like/Reblog Icon Fix

## The Problem

Icons don't fill even though the interaction saves to database!

## Root Cause

**Vue Reactivity Issue!**

The component uses:
```vue
:class="{ active: displayInteractionCounts.is_bookmarked }"
```

Where `displayInteractionCounts` is a **computed property** reading from `props.post.is_bookmarked`.

When the store updates `post.is_bookmarked = true`, Vue's computed property doesn't re-evaluate because:
- Props aren't deeply reactive by default
- Direct mutation doesn't trigger reactivity
- The post object reference doesn't change

## The Fix Applied

**Changed**:
```typescript
// OLD (doesn't trigger reactivity):
post.is_bookmarked = true

// NEW (triggers reactivity):
Object.assign(post, { is_bookmarked: true })
```

Using `Object.assign()` creates a shallow copy which Vue's reactivity system detects!

## Testing

1. Bookmark a post
2. Icon should now FILL immediately
3. Unbookmark
4. Icon should UNFILL

Same for:
- Like (heart icon)
- Reblog (reblog icon)

## If Still Broken

Check:
1. Is post object reactive in store?
2. Are feeds using `ref()` or `reactive()`?
3. Component prop passing correct?

Worst case: Replace entire post object instead of mutating:
```typescript
const index = feed.posts.findIndex(p => p.id === postId)
if (index !== -1) {
  feed.posts[index] = { ...feed.posts[index], is_bookmarked: true }
}
```

---

**Test it now!** Should work with Object.assign fix! ✅

