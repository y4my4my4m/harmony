# RPC Functions Cleanup TODO

## Overview
During the db_schema/init migration work, we discovered 9 RPC functions that are called by the frontend but don't exist in production (`supabase_minimal.sql`). These need to either be implemented properly or the frontend code needs to be updated.

## Missing Functions Analysis

### 1. `create_federated_profile`
**Called from:** `src/services/activityPubService.ts:1729`
**Purpose:** Create a profile for a federated (remote) user discovered via ActivityPub
**Parameters:**
- `p_username`: text
- `p_display_name`: text
- `p_domain`: text
- `p_avatar_url`: text
- `p_banner_url`: text
- `p_bio`: text
- `p_federated_id`: text
- `p_inbox_url`: text
- `p_outbox_url`: text
- `p_followers_url`: text

**Status:** ⚠️ NEEDS IMPLEMENTATION - Critical for federation
**Recommendation:** Implement this function - it's needed for federating with remote users

---

### 2. `get_activitypub_conversation_context`
**Called from:** `src/services/ConversationService.ts:84`
**Purpose:** Get context for an ActivityPub conversation (ancestors/descendants)
**Parameters:**
- `post_id`: uuid

**Status:** ⚠️ NEEDS IMPLEMENTATION - Used for threaded conversations
**Recommendation:** Implement - needed for viewing conversation threads

---

### 3. `get_activitypub_conversation_thread`
**Called from:** `src/services/ConversationService.ts:50`
**Purpose:** Get all posts in an ActivityPub conversation thread
**Parameters:**
- `in_conversation_root_id`: text

**Status:** ⚠️ NEEDS IMPLEMENTATION - Used for viewing full threads
**Recommendation:** Implement - needed for conversation view

---

### 4. `get_emoji_usage_analytics`
**Called from:** `src/services/emojiService.ts:77`
**Purpose:** Get detailed emoji usage analytics for a server
**Parameters:**
- `p_server_id`: uuid
- `p_user_id`: uuid (optional)
- `p_limit`: integer

**Status:** 🟡 LOW PRIORITY - Analytics feature
**Recommendation:** Can be stubbed or implemented later

---

### 5. `get_most_used_emojis`
**Called from:** `src/services/emojiService.ts:518`
**Purpose:** Get most frequently used emojis for caching
**Parameters:**
- `server_ids`: uuid[] (optional)
- `limit`: integer

**Status:** 🟡 MEDIUM PRIORITY - Used for emoji suggestions
**Recommendation:** Implement a basic version using emoji_usage table

---

### 6. `get_user_emoji_stats`
**Called from:** `src/services/emojiService.ts:98`
**Purpose:** Get user's personal emoji usage statistics
**Parameters:**
- `p_user_id`: uuid
- `p_server_id`: uuid (optional)
- `p_limit`: integer

**Status:** 🟡 LOW PRIORITY - User stats feature
**Recommendation:** Can be stubbed or implemented later

---

### 7. `reset_daily_hashtag_counters`
**Called from:** `src/services/TrendingService.ts:609`
**Purpose:** Reset daily counters for hashtag trending calculation
**Parameters:** None

**Status:** 🟡 MEDIUM PRIORITY - Background maintenance task
**Recommendation:** Implement - needed for trending feature accuracy

---

### 8. `update_hashtag_trending_scores`
**Called from:** `src/services/TrendingService.ts:596`
**Purpose:** Update trending scores for hashtags
**Parameters:** None

**Status:** 🟡 MEDIUM PRIORITY - Background maintenance task
**Recommendation:** Implement - needed for trending feature

---

### 9. `update_trending_posts`
**Called from:** `src/services/TrendingService.ts:597`
**Purpose:** Update trending posts rankings
**Parameters:** None

**Status:** 🟡 MEDIUM PRIORITY - Background maintenance task
**Recommendation:** Implement - needed for trending feature

---

## Priority Summary

### 🔴 Critical (Block core functionality)
- `create_federated_profile` - Required for federation to work

### 🟠 High Priority (Affects user experience)
- `get_activitypub_conversation_context` - Threaded conversations
- `get_activitypub_conversation_thread` - Conversation view

### 🟡 Medium Priority (Feature completeness)
- `get_most_used_emojis` - Emoji suggestions
- `reset_daily_hashtag_counters` - Trending accuracy
- `update_hashtag_trending_scores` - Trending feature
- `update_trending_posts` - Trending feature

### 🟢 Low Priority (Nice to have)
- `get_emoji_usage_analytics` - Admin analytics
- `get_user_emoji_stats` - User statistics

---

## Actions Taken

1. Created stub functions in `db_schema/migrations/stub_missing_functions.sql` that return empty/default values to prevent errors
2. These stubs should be replaced with proper implementations

## Files to Update

- `db_schema/init/13_functions_rpc_extended.sql` - Add proper implementations
- `src/services/emojiService.ts` - Consider graceful degradation
- `src/services/TrendingService.ts` - Consider graceful degradation
- `src/services/activityPubService.ts` - Needs proper create_federated_profile
- `src/services/ConversationService.ts` - Needs conversation functions

---

## Notes

- The stub functions are temporary and should be replaced with proper implementations
- Consider whether some of these features should be removed from the frontend if they won't be implemented
- The trending functions are likely called by a background job/cron, not directly by users

