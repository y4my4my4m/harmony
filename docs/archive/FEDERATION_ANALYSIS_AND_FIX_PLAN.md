# ActivityPub Emoji Reactions Federation Analysis & Fix Plan

## Issues Identified

### 1. Naming Convention Violations

**Problem**: The current functions use "professional" prefix, which violates the established naming conventions.

**Current problematic names**:
- `should_federate_post_reaction` (in professional_federation_functions.sql)
- `create_post_reaction_federation_activity` (in professional_federation_functions.sql)
- `remove_post_reaction_federation_activity` (in professional_federation_functions.sql)

**Existing naming patterns in codebase**:
- Post-related functions: `add_post_emoji_reaction`, `remove_post_emoji_reaction`, `get_post_emoji_reactions`
- Federation functions: `handle_post_federation`, `handle_post_reactions_federation`, `handle_message_federation`
- Activity functions: `create_activitypub_note_activity`, `queue_activity_for_federation`

**Proposed fixes**:
- `should_federate_post_reaction` → Keep as is (follows pattern)
- `create_post_reaction_federation_activity` → `create_post_reaction_activity`
- `remove_post_reaction_federation_activity` → `create_post_reaction_undo_activity`

### 2. Database Schema Verification

**✅ Confirmed**: The `posts` table DOES have an `is_local` column:
```sql
is_local boolean DEFAULT true,
```

The federation logic correctly checks this column to determine if posts are local or federated.

### 3. DRY Convention Analysis

**Current DRY patterns in codebase**:
- Function parameters use consistent `p_` prefix: `p_user_id`, `p_post_id`, `p_emoji_id`
- Return types are consistent: TABLE() for bulk operations, boolean for success/failure
- Error handling uses consistent RAISE EXCEPTION patterns
- Federation checks follow same pattern: check user permissions → check post locality → create activity

**✅ Assessment**: The current implementation largely follows DRY conventions, but the "professional" naming needs to be removed.

## Root Cause of Federation Issues

### Current Federation Flow

1. **Trigger-based**: `handle_unified_interaction_federation()` trigger on `post_interactions` table
2. **Database-driven**: Federation activities are created in database functions  
3. **Queue-based**: Activities are queued via `queue_activity_for_federation()`

### **🚨 CRITICAL ISSUE FOUND**

The current federation function `handle_unified_interaction_federation()` **DOES NOT** properly handle emoji reactions!

**Current problematic code**:
```sql
activity_type := CASE 
    WHEN NEW.interaction_type = 'favorite' THEN 'Like'
    WHEN NEW.interaction_type = 'reblog' THEN 'Announce' 
    ELSE 'Like'  -- ❌ This treats ALL emoji reactions as basic "Like"
END;
```

**What's happening**:
1. ✅ Emoji reactions are correctly stored in `post_interactions` with `interaction_type = 'emoji_reaction'`
2. ❌ Federation function treats emoji reactions as basic "Like" activities
3. ❌ No emoji metadata (name, URL, custom emoji) is included in federated activities
4. ❌ Misskey/Pleroma instances receive generic "Like" instead of "EmojiReact"

### Missing Components

1. **EmojiReact Activity Type**: Should use ActivityPub `EmojiReact` type for emoji reactions
2. **Emoji Metadata**: Must include emoji name, URL, and custom emoji data
3. **Misskey Compatibility**: Misskey expects specific emoji format in activities

## Next Steps

1. ✅ Rename functions to remove "professional" prefix
2. 🔍 Investigate ActivityPub EmojiReact format compatibility
3. 🔍 Test federation with Misskey/Pleroma instances
4. 🔍 Verify custom emoji federation metadata
5. 📝 Document proper federation flow

## Action Items

### **🚨 CRITICAL FIX REQUIRED**

**Problem**: The federation function treats all emoji reactions as basic "Like" activities.

**Solution**: Update `handle_unified_interaction_federation()` to properly handle emoji reactions:

```sql
-- Fix the activity type detection
activity_type := CASE 
    WHEN NEW.interaction_type = 'favorite' THEN 'Like'
    WHEN NEW.interaction_type = 'reblog' THEN 'Announce'
    WHEN NEW.interaction_type = 'emoji_reaction' THEN 'EmojiReact'  -- ✅ ADD THIS
    ELSE 'Like'
END;

-- Add emoji metadata for EmojiReact activities
-- Include emoji name, URL, and custom emoji content in activity_data
```

### Immediate Fixes

1. **Fix Federation Function**: Update `handle_unified_interaction_federation()` to handle emoji reactions
2. **Add Emoji Metadata**: Include emoji data in federated activities
3. **Test ActivityPub Format**: Ensure EmojiReact activities match Misskey/Pleroma expectations

### Testing Plan

1. **Local Testing**: Verify reactions work between local users ✅
2. **Federation Testing**: Test with known Misskey/Pleroma instances
3. **Custom Emoji Testing**: Verify custom emoji federate correctly  
4. **Real-time Testing**: Confirm real-time updates work for federated reactions

## Conclusion

The main issues are:
1. ❌ Poor naming conventions (easy fix)
2. ✅ Schema is correct (`is_local` column exists)
3. ✅ DRY conventions are mostly followed
4. ❓ ActivityPub format compatibility needs investigation

The federation system is architecturally sound but may have format/compatibility issues with other ActivityPub implementations.
