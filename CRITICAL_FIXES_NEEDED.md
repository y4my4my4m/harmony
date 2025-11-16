# Critical Fixes Needed - User Feedback

## Issues to Fix

### 1. ✅ Global Call Listener (FIXED)
- Moved to app-level watch (runs regardless of route)
- Fixed RLS permission error on `user_blocks` table
- Now uses `maybeSingle()` and graceful error handling

### 2. 🔧 Double Loading Spinners (NEEDS FIX)
**Problem**: Two loading indicators when sending messages
- First one: Ugly, appears under message
- Second one: Nice (purple), but also under message instead of inline

**Need to investigate**:
- Where is the first spinner coming from?
- Why is the inline CSS not working?

**Temporary workaround**: Comment out the first spinner

### 3. 🔧 Emoji Rendering Broken (NEEDS FIX)
**Problem**: New emojis show as `:pog:` text instead of images

**Root Cause**: 
- `parseTextForEmojis()` in `unifiedContentProcessing.ts` line 390-401
- Tries to fetch emoji by shortcode from database
- Query might be failing or returning wrong format
- Falls back to showing text

**Need to check**:
- Is emoji data being fetched correctly?
- Is emoji.url being set properly?
- Is getEmojiUrl() working?

**Files to investigate**:
- `src/utils/unifiedContentProcessing.ts` (emoji parsing)
- `src/components/UnifiedMessageContent.vue` (emoji rendering)
- `src/services/emojiService.ts` (emoji fetching)

###  4. 🔧 RLS Policy Missing for `user_blocks`

**Error**: `permission denied for table user_blocks`

**Need SQL**:
```sql
-- Allow users to check if they've blocked someone
CREATE POLICY "Users can view own blocks"
ON user_blocks
FOR SELECT
USING (auth.uid() = blocker_id);

-- Allow users to check if they're blocked
CREATE POLICY "Users can check if blocked"
ON user_blocks
FOR SELECT
USING (auth.uid() = blocked_user_id);
```

---

## Action Items

1. **URGENT**: Fix global call listener (DONE ✅)
2. **HIGH**: Debug and fix double loading spinners
3. **HIGH**: Fix emoji rendering for new emojis
4. **MEDIUM**: Add RLS policies for `user_blocks` table

---

## Testing Required

After fixes:
- [ ] Send message - only ONE loading spinner, inline to the right
- [ ] Type `:pog:` - should show emoji image
- [ ] Receive call while in Chat view
- [ ] Receive call while in ActivityPub view
- [ ] Receive call while in Settings
- [ ] Block check doesn't throw RLS errors


