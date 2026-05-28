# Bot Messages Support - Implementation Summary

## Problem
The bot gateway was trying to insert messages with `user_id` set to the bot's ID, but bots aren't in the `profiles` table - they're in the `bots` table. This caused a foreign key constraint violation:

```
Key (user_id)=(86a48e68-1c97-4ffe-ab96-307ad8f99cde) is not present in table "profiles".
```

## Solution
Added proper support for bot messages by:

1. **Database Schema Changes** - Run `db_schema/add_bot_messages_support.sql`
   - Make `user_id` nullable in `messages` table
   - Add `bot_id` column to `messages` table
   - Add constraint: exactly one of `user_id` or `bot_id` must be set
   - Add indexes for bot message queries
   - Same changes for `reactions` table
   
2. **Code Changes** - Already applied to `bot-gateway/src/api/BotRestAPI.ts`
   - `sendMessage`: Use `bot_id` instead of `user_id`
   - `getMessages`: Join with both `profiles` and `bots` tables
   - `editMessage`: Check `bot_id` instead of `user_id`
   - `deleteMessage`: Check `bot_id` instead of `user_id`
   - `addReaction`: Use `bot_id` instead of `user_id`
   - `formatMessage`: Handle both user and bot authors

## How to Apply

### 1. Run the Database Migration

```bash
# Connect to your Supabase database and run:
psql <your-connection-string> -f db_schema/add_bot_messages_support.sql
```

Or copy the contents of `db_schema/add_bot_messages_support.sql` and run it in the Supabase SQL Editor.

### 2. Restart the Bot Gateway

```bash
cd bot-gateway
npm run dev
```

### 3. Test the Discord Bridge

```bash
# In another terminal
cd bot-plugins/discord-bridge
npm run dev
```

Send a message from Discord and it should now successfully bridge to Harmony!

## What Changed

### Messages Table Structure

**Before:**
- `user_id` UUID NOT NULL → references `profiles(id)`

**After:**
- `user_id` UUID NULL → references `profiles(id)` (optional)
- `bot_id` UUID NULL → references `bots(id)` (optional)
- Constraint: exactly one of `user_id` or `bot_id` must be set

### Reactions Table Structure

**Before:**
- `user_id` UUID NOT NULL → references `profiles(id)`

**After:**
- `user_id` UUID NULL → references `profiles(id)` (optional)
- `bot_id` UUID NULL → references `bots(id)` (optional)
- Constraint: exactly one of `user_id` or `bot_id` must be set

### API Response Format

The `formatMessage` function now returns:

```typescript
{
  id: string,
  channel_id: string,
  author: {
    id: string,
    username: string,
    display_name: string,
    avatar: string,
    bot: boolean  // NEW: true if this is a bot message
  },
  content: string,
  timestamp: string,
  edited_timestamp: string | null,
  mentions: string[]
}
```

## Testing Checklist

- [ ] Run `db_schema/add_bot_messages_support.sql`
- [ ] Restart bot gateway
- [ ] Restart Discord bridge
- [ ] Send message from Discord → Harmony
- [ ] Verify message appears in Harmony
- [ ] Edit bot message
- [ ] Delete bot message
- [ ] Add reaction from bot
- [ ] Verify bot messages have `bot: true` flag

## Troubleshooting

### If you get "column bot_id does not exist"
Make sure you ran the SQL migration script.

### If you get "permission denied"
Make sure the `service_role` key is configured correctly in `.env`:
```
SUPABASE_SERVICE_ROLE_KEY=your-service-role-key-here
```

### If messages still fail to insert
Check the bot gateway console for detailed error messages. The issue might be with permissions or RLS policies.

