# Bot Messages - Complete Implementation

## Problems Fixed

### 1. Bot messages weren't displaying in the UI ✅
- **Problem**: Frontend looked up `message.user_id` but bot messages use `bot_id`
- **Solution**: 
  - Added `bot_id` to Message type (made `user_id` optional)
  - Created helper functions `getAuthorDisplayName()`, `getAuthorAvatarUrl()`, `getAuthorColor()` that handle both users and bots
  - Added "BOT" badge to bot messages
  - Updated MessageDisplay.vue to use new helpers

### 2. Harmony → Discord messages weren't bridging ✅  
- **Problem**: EventDispatcher was skipping ALL bot messages (line 99-101)
- **Solution**: Removed the blanket skip, now bots receive all messages and filter their own

### 3. Bot info wasn't included in MESSAGE_CREATE events ✅
- **Problem**: EventDispatcher only looked up `profiles` table, not `bots` table
- **Solution**: Updated `formatMessage()` to check both `user_id` and `bot_id` and fetch from appropriate table

### 4. Discord bridge was filtering messages incorrectly ✅
- **Problem**: Compared `msg.author.id` to bot token string (always false)
- **Solution**: Store bot ID on ready event and use it to filter

## Files Changed

### Backend

1. **bot-gateway/src/gateway/EventDispatcher.ts**
   - Removed blanket skip of bot messages
   - Updated `formatMessage()` to handle both users and bots
   - Added `bot: true/false` flag to author object

2. **bot-plugins/discord-bridge/src/index.ts**
   - Store bot ID from READY event
   - Use bot ID to filter own messages
   - Added debug logging for message flow

### Frontend

3. **src/types.ts**
   - Made `user_id` optional
   - Added `bot_id?: string` field to Message interface

4. **src/components/MessageDisplay.vue**
   - Added helper functions for bot display
   - Updated message header to handle both users and bots
   - Added "BOT" badge with styling
   - Created unified `getAuthor*()` functions

## How to Test

1. **Restart bot gateway**:
```bash
cd bot-gateway
npm run dev
```

2. **Restart Discord bridge**:
```bash
cd bot-plugins/discord-bridge
npm run dev
```

3. **Test Discord → Harmony**:
   - Send a message in Discord
   - Should appear in Harmony with "BOT" badge
   - Should show bot name and avatar

4. **Test Harmony → Discord**:
   - Send a message in Harmony
   - Should appear in Discord
   - Bot should NOT bridge its own messages

## Expected Behavior

### Discord → Harmony
```
Discord: @user123: "Hello from Discord!"
Harmony: [Unknown User BOT] Hello from Discord!
```

### Harmony → Discord
```
Harmony: @user456: "Hello from Harmony!"
Discord: [Harmony] user456: Hello from Harmony!
```

## Known Limitations

1. **Bot avatars/names not loaded yet**: 
   - Currently shows placeholder "Bot-{id}" and default avatar
   - **TODO**: Implement proper bot data caching/fetching in frontend
   - **TODO**: Add bot display_name and avatar_url to bots table if not present

2. **Mentions not working yet**:
   - Discord → Harmony mentions work (shown as text)
   - Harmony → Discord mentions not implemented
   - **TODO**: Implement mention translation in MessageTranslator

## Next Steps

### High Priority
- [ ] Implement bot data caching in frontend (similar to user profiles)
- [ ] Add bot display names and avatars to database
- [ ] Test with multiple bots to ensure filtering works correctly

### Medium Priority
- [ ] Implement mention translation (Discord ↔ Harmony)
- [ ] Add webhook support for embeds and rich messages
- [ ] Implement message edit/delete bridging (requires message ID mapping)

### Low Priority
- [ ] Add bot presence updates
- [ ] Implement bot command discovery
- [ ] Add bot rate limiting indicators

## Troubleshooting

### Bot messages not appearing in Harmony
1. Check bot gateway console for MESSAGE_CREATE dispatch logs
2. Verify bot has `read_messages` permission in server
3. Check if message has author info in the event

### Messages not bridging to Discord
1. Check Discord bridge console for "Received Harmony message" logs
2. Verify bot ID is being stored correctly on READY
3. Check if bot is filtering its own messages correctly

### "Unknown User" showing instead of bot name
1. This is expected for now (limitation #1)
2. Bot data caching needs to be implemented
3. Check database has display_name for bot

## Debug Logging

Both services now have extensive debug logging:

**Bot Gateway:**
```
🔍 Bot discord-bridge attempting to send message to channel...
🔍 Channel lookup: channelId=..., serverId=..., error=...
🔍 Permission check result: true
📨 Dispatched MESSAGE_CREATE to 1 bots
```

**Discord Bridge:**
```
📨 Received Harmony message from User123 (user-id)
⏭️  Skipping bot message
✅ Harmony -> Discord: User123 in #channel
```

