# Debug Fix - Discord Puppeting Issues

## Issues Fixed

### Issue 1: Discord user info not displaying
**Problem**: Messages still showed "Discord Bridge" instead of Discord username
**Root Cause**: EventDispatcher wasn't including message metadata in MESSAGE_CREATE events
**Fix**: 
- EventDispatcher now checks for `discord_user` in metadata
- If found, uses Discord user info for author field
- Sets `discord_user: true` flag on author
- Includes full metadata in MESSAGE_CREATE event

### Issue 2: Harmony → Discord not working
**Problem**: Messages from Harmony weren't appearing in Discord
**Root Cause**: Bridge was skipping all bot messages, including Discord puppeted ones
**Fix**:
- Updated skip logic: `if (msg.author?.bot && !msg.author?.discord_user)`
- Now allows Discord puppeted messages through
- Added extensive debug logging

## Changes Made

### bot-gateway/src/gateway/EventDispatcher.ts
```typescript
// Now checks for discord_user in metadata
if (message.metadata?.discord_user) {
  // Use Discord user info for author
  const discordUser = message.metadata.discord_user
  author = {
    id: discordUser.id,
    username: discordUser.username,
    display_name: discordUser.display_name,
    avatar: discordUser.avatar_url,
    bot: false, // Treat as regular user
    discord_user: true // Flag for detection
  }
}
```

### bot-plugins/discord-bridge/src/index.ts
```typescript
// Allow Discord puppeted messages through
if (msg.author?.bot && !msg.author?.discord_user) {
  console.log('⏭️  Skipping bot message')
  return
}
```

### bot-gateway/src/api/BotRestAPI.ts
- Added metadata logging: `console.log('🔍 Received metadata:', JSON.stringify(metadata, null, 2))`

### src/components/MessageDisplay.vue
- Added debug logging to see what metadata messages have
- Logs when Discord user metadata is found

## Testing Steps

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

3. **Refresh browser** (Ctrl+F5)

4. **Test Discord → Harmony**:
   - Send message from Discord
   - Check bot gateway console for: `🔍 Received metadata:`
   - Check browser console for: `✅ Discord user found:`
   - Should now show Discord username and avatar

5. **Test Harmony → Discord**:
   - Send message in Harmony
   - Check bridge console for: `📨 Received Harmony message:`
   - Should appear in Discord as `[Harmony] username: message`

## Expected Console Output

### Bot Gateway (Discord → Harmony)
```
🔍 Received metadata: {
  "discord_user": {
    "id": "123456789",
    "username": "y4my4m",
    "display_name": "y4my4m",
    "avatar_url": "https://cdn.discordapp.com/..."
  },
  "bridge_source": "discord"
}
```

### Discord Bridge (Harmony → Discord)
```
📨 Received Harmony message: {
  author: 'y4my4m',
  authorId: 'user-uuid',
  isBot: false,
  channelId: 'channel-uuid',
  content: 'test message'
}
✅ Harmony -> Discord: y4my4m in #channel-uuid
```

### Browser Console (Frontend)
```
✅ Discord user found: {
  id: '123456789',
  username: 'y4my4m',
  display_name: 'y4my4m',
  avatar_url: 'https://cdn.discordapp.com/...'
}
```

## What Should Now Work

✅ Discord messages show actual Discord username
✅ Discord messages show actual Discord avatar
✅ Discord messages have "DISCORD" badge
✅ Harmony messages bridge to Discord
✅ No message loops
✅ Discord puppeted messages not bridged back to Discord

