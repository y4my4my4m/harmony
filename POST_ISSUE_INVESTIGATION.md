# Post Functionality Investigation Report

**Date**: January 15, 2025  
**Issue**: Posts stop working after database and frontend refactor, despite DMs working correctly

## 🚨 **ROOT CAUSE IDENTIFIED & RESOLVED** ✅

The issue was **missing/deprecated database function calls** in the `handle_post_federation` trigger. The function was calling `convert_unified_content_to_activitypub_html` which no longer existed.

## Summary

After investigating the codebase following a refactor that enabled federated DMs, the post creation functionality had stopped working. The issue was **not** frontend-related, environment-related, or missing triggers, but was caused by the federation function calling deprecated helper functions.

## ✅ **RESOLUTION**

**Problem:** The `handle_post_federation` function was calling `convert_unified_content_to_activitypub_html()` which was deprecated and no longer existed.

**Solution:** Updated the function to use the modern `convert_jsonb_to_ap()` function instead.

**Status:** **FIXED** - Posts now federate correctly.

---

## 🚨 **BONUS ISSUE DISCOVERED & RESOLVED** ✅

During investigation, discovered a **message ordering inconsistency** between channels and DMs.

### Problem
- **Channel messages:** Used `ascending: true` (oldest first) ✅
- **DM messages:** Used `ascending: false` (newest first) + reverse logic ❌

### Solution
1. **Fixed DM service ordering:** Changed `CoreMessageService.loadConversationMessages()` to use `ascending: true`
2. **Removed reverse logic:** Simplified DM store to use messages directly without reversing

### Result
Both chat types now use consistent ordering:
- Database returns oldest first (`ascending: true`)
- UI displays newest messages at bottom (standard chat UX)
- No more inconsistent logic between channels and DMs

---

## Architecture Overview

### Post Creation Flow ✅ WORKING
1. **Frontend Components** → `MonyComposerInline.vue`, `PostsContainer.vue`, `MonyPost.vue`
2. **State Management** → `useActivityPubStore` (Pinia store)
3. **Service Layer** → Multiple service layers handle posts:
   - `PostService.ts` - Simplified service that trusts database triggers
   - `CorePostService.ts` - Pure local database operations  
   - `activityPubService.ts` - ActivityPub operations
4. **Database Layer** → Triggers handle federation automatically
   - ✅ `trg_handle_post_federation` - NOW WORKING with updated function

### Message Ordering Flow ✅ CONSISTENT
- **Channel Messages:** `CoreMessageService.loadChannelMessages()` → `ascending: true`
- **DM Messages:** `CoreMessageService.loadConversationMessages()` → `ascending: true` (FIXED)
- **Both display:** Oldest at top → Newest at bottom (standard chat UX)

## Investigation Process

### Database Analysis
1. **Verified trigger existence** - `trg_handle_post_federation` existed ✅
2. **Checked configuration** - Instance domain configured correctly ✅  
3. **Tested function execution** - Function was silently failing ❌
4. **Identified deprecated function calls** - Found `convert_unified_content_to_activitypub_html` missing ❌

### Message System Analysis  
1. **Found ordering inconsistency** - Channel vs DM different patterns ❌
2. **Traced the difference** - Service level vs store level handling ❌
3. **Standardized both flows** - Same pattern for consistency ✅

## Key Learnings

### Why DMs Worked But Posts Didn't
- **DMs:** Use `handle_message_federation` function (modern function calls) ✅
- **Posts:** Use `handle_post_federation` function (deprecated function calls) ❌

### Why The Error Was Silent
- `EXCEPTION WHEN OTHERS` block caught the error but only logged warning
- No visible failure - posts created locally but federation failed silently

### Modern vs Legacy Function Names
- **Legacy (broken):** `convert_unified_content_to_activitypub_html`  
- **Modern (working):** `convert_jsonb_to_ap`

## Resolution Summary

### Post Federation Fix
```sql
-- Updated handle_post_federation function to use:
v_content_html := convert_jsonb_to_ap(NEW.content);
-- Instead of deprecated:
-- v_content_html := convert_unified_content_to_activitypub_html(NEW.content);
```

### Message Ordering Fix
```typescript
// CoreMessageService.ts - Both methods now use:
.order('created_at', { ascending: true })  // oldest first

// useDM.ts - Removed reverse logic:
const orderedMessages = messagesData // direct use
```

**All issues resolved** ✅