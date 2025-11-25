# Message Editing Fixes

This document summarizes the fixes applied to resolve three critical issues with message editing in the chat application.

## Issues Fixed

### 1. ✅ Edited messages don't show "edited" indicator
**Problem**: When users edited messages, there was no visual indication that the message had been modified.

**Solution**: 
- Added an "(edited)" indicator next to the timestamp in `MessageDisplay.vue`
- Created `isMessageEdited()` helper function that compares `created_at` and `updated_at` timestamps
- Added CSS styling for the edited indicator with hover effects
- Shows tooltip with exact edit timestamp when hovering over "(edited)"

**Files Modified**:
- `src/components/MessageDisplay.vue` - Added UI indicator and helper function
- `src/types.ts` - Added `updated_at?: Date` field to `Message` interface

### 2. ✅ `updated_at` field is wrong database type
**Problem**: The `updated_at` column in the messages table was defined as `time` instead of `timestamptz`, causing timezone issues and preventing proper edit tracking.

**Solution**:
- Created migration script `db_schema/fix_message_editing.sql` that:
  - Drops the old `updated_at` column
  - Recreates it as `timestamptz` with proper default value (`NOW()`)
  - Backfills existing messages with `created_at` value
  - Sets column as `NOT NULL` after backfill
  - Adds descriptive comment to the column

**Files Created**:
- `db_schema/fix_message_editing.sql` - Migration script

### 3. ✅ Editing encrypted messages breaks decryption
**Problem**: When a user edited their own encrypted message, they could no longer decrypt it. This happened because the edit operation wasn't re-encrypting the content properly for all recipients including the sender.

**Root Cause**:
The original `editMessage()` function in `CoreMessageService.ts` only updated the content without checking if the message was encrypted. This meant:
- Encrypted messages were being replaced with plaintext content
- Even if re-encrypted, the sender wasn't included in the recipient list
- Encryption metadata was lost during the edit

**Solution**:
Enhanced `CoreMessageService.editMessage()` to:
1. **Fetch the original message** to check its encryption status
2. **Preserve encryption** - If original was encrypted, re-encrypt the edited content
3. **Include self** - Ensure sender is in recipient list so they can decrypt their own message
4. **Re-encrypt for all recipients** - Use the original `encrypted_for` list from encryption metadata
5. **Update all encryption fields** - Update `encrypted`, `content`, and `encryption_metadata`

**Implementation Details**:
```typescript
// Before: Simple content update
.update({ content: newContent })

// After: Smart encryption-aware update
if (originalMessage.encrypted) {
  const recipientIds = originalMessage.encryption_metadata.encrypted_for || []
  if (!recipientIds.includes(currentUser.id)) {
    recipientIds.push(currentUser.id)  // CRITICAL: Include self!
  }
  const encryptedData = await encryptionService.encryptMessage(newContent, recipientIds)
  finalContent = encryptedData.content
  encrypted = true
  encryptionMetadata = encryptedData.encryption_metadata
}
.update({ 
  content: finalContent,
  encrypted,
  encryption_metadata: encryptionMetadata 
})
```

**Files Modified**:
- `src/services/core/CoreMessageService.ts` - Enhanced `editMessage()` method

## Database Trigger

The migration also creates a trigger that automatically updates `updated_at` whenever message content changes:

```sql
CREATE OR REPLACE FUNCTION update_messages_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.content IS DISTINCT FROM OLD.content THEN
    NEW.updated_at = NOW();
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER messages_updated_at_trigger
  BEFORE UPDATE ON messages
  FOR EACH ROW
  EXECUTE FUNCTION update_messages_updated_at();
```

This ensures `updated_at` is automatically set by the database, making it reliable across all clients and preventing manual timestamp manipulation.

## How to Apply

### 1. Run the Database Migration
```bash
# Connect to your Supabase database and run:
psql $DATABASE_URL -f db_schema/fix_message_editing.sql
```

### 2. Verify the Changes
The migration includes verification queries that will show:
- The `updated_at` column is now `timestamptz` type
- The trigger is properly installed

### 3. Test the Fixes
1. **Test Edited Indicator**: 
   - Send a message
   - Edit it
   - Verify "(edited)" appears next to the timestamp
   - Hover to see the exact edit time

2. **Test Encrypted Message Editing**:
   - Enable E2EE for a server or DM
   - Send an encrypted message
   - Edit the message
   - Verify you can still decrypt it after editing
   - Verify other users can still decrypt it

## Technical Notes

### Encryption Flow for Edited Messages
1. Fetch original message to check if it was encrypted
2. If encrypted, extract the original recipient list from `encryption_metadata.encrypted_for`
3. Ensure sender is included in recipient list (critical for self-decryption)
4. Use `MessageEncryptionService.encryptMessage()` to re-encrypt new content
5. Update message with new encrypted content and metadata

### Why Include Self in Recipients?
The hybrid encryption system (AES-GCM + Signal Protocol) encrypts the symmetric key separately for each recipient. When editing, if the sender isn't in the recipient list, they won't have an encrypted key for themselves, making the message undecryptable even for the author.

### Edit Detection Logic
```typescript
isMessageEdited(message): boolean {
  const createdAt = new Date(message.created_at).getTime()
  const updatedAt = new Date(message.updated_at).getTime()
  // Allow 1 second tolerance for DB timing differences
  return updatedAt - createdAt > 1000
}
```

## Compatibility

These changes are:
- ✅ **Backward compatible** - Old messages without `updated_at` will simply not show the edited indicator
- ✅ **Non-destructive** - Migration backfills existing messages with safe defaults
- ✅ **Secure** - Encryption is preserved and enhanced, not broken

## Related Files

- `src/components/MessageDisplay.vue` - UI display of edited indicator
- `src/components/UnifiedMessageContent.vue` - Message content rendering (unchanged)
- `src/services/core/CoreMessageService.ts` - Core message editing logic
- `src/services/encryption/MessageEncryptionService.ts` - Encryption/decryption (unchanged)
- `src/stores/useChat.ts` - Message state management (unchanged)
- `src/types.ts` - TypeScript type definitions
- `db_schema/fix_message_editing.sql` - Database migration

## Future Improvements

Consider adding:
- Edit history tracking (store previous versions)
- Edit count limit or time window restrictions
- Visual diff showing what changed
- Notification to other users when a message they saw is edited


