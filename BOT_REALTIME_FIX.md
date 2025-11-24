# Bot Messages Fix - Real-time Support

## Issue
Messages weren't appearing after the initial bot_id implementation because:
1. Real-time subscription handlers weren't setting `bot_id` field
2. SearchService wasn't including `bot_id` in message transforms

## Files Fixed

### src/stores/useChat.ts
- Added `bot_id: payload.new.bot_id` to all real-time message handlers:
  - Temp message replacement (line 629)
  - New message INSERT (line 657)
  - Message UPDATE (line 692)

### src/services/SearchService.ts
- Added `bot_id: msg.bot_id` to message transformation (line 188)

## Testing

1. **Refresh the browser** (Ctrl+F5 or Cmd+Shift+R)
2. Send a message from Harmony - should appear immediately
3. Send a message from Discord - should appear with BOT badge
4. Check old messages - should show correct usernames (not "Bot-...")

## What Should Work Now

✅ Real-time message updates
✅ Bot messages show with BOT badge
✅ User messages show with username
✅ Discord ↔ Harmony bridging
✅ Message search includes bot messages

## Debug Console

Check browser console for:
```
🟢 Real-time INSERT received: {...}
📝 Real-time message processed...
```

Check bot gateway console for:
```
📨 Dispatched MESSAGE_CREATE to X bots
```

Check Discord bridge console for:
```
📨 Received Harmony message from User123...
✅ Harmony -> Discord: User123 in #channel
```

