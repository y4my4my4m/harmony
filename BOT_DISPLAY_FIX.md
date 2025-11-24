# Bot Messages Display Fix

## Issues Fixed

### 1. Messages were empty ✅
**Problem**: Bot gateway was using `value` instead of `text` for message content
**Solution**: Changed `formatContent()` to use `{type: 'text', text: content}` instead of `{type: 'text', value: content}`

### 2. Bot names showed as "Bot-{id}" ✅
**Problem**: No bot data caching implementation
**Solution**: Added bot data cache with automatic fetching in MessageDisplay.vue

## Files Changed

### Backend
**bot-gateway/src/api/BotRestAPI.ts**
- Line 506: Changed `value: content` to `text: content`
- Line 602: Added support for both `text` and `value` for compatibility

### Frontend
**src/components/MessageDisplay.vue**
- Added `botDataCache` ref for caching bot information
- Added `fetchBotData()` function to load bot data from database
- Updated `getBotDisplayName()` to fetch and use real bot names
- Updated `getBotAvatarUrl()` to use real bot avatars

## How It Works

### Message Content Format
```typescript
// Correct format (frontend expects):
[{ type: 'text', text: 'Hello from Discord!' }]

// Old incorrect format:
[{ type: 'text', value: 'Hello from Discord!' }]
```

### Bot Data Caching
1. When a bot message is displayed, `getBotDisplayName()` checks the cache
2. If not cached, it triggers `fetchBotData()` to load from database
3. Once loaded, the display name updates reactively
4. Cache persists for the session

## Testing

1. **Restart bot gateway**:
```bash
cd bot-gateway
npm run dev
```

2. **Refresh browser** (Ctrl+F5 or Cmd+Shift+R)

3. **Test Discord → Harmony**:
   - Send message from Discord
   - Should show actual bot name (e.g., "discord-bridge")
   - Should show message content
   - Should have "BOT" badge

4. **Test Harmony → Discord**:
   - Send message from Harmony
   - Should appear in Discord
   - Should show username

## Expected Result

Before:
```
[Bot-86a48e68] BOT
(empty message)
```

After:
```
[discord-bridge] BOT  3:03 PM
Hello from Discord!
```

## Database Query

The bot data is fetched with:
```sql
SELECT id, username, display_name, avatar_url 
FROM bots 
WHERE id = $botId
```

## Performance Notes

- Bot data is fetched on-demand (lazy loading)
- Cached per session (no repeated queries)
- Reactive updates (Vue computed refs)
- Minimal database impact

## Next Steps

✅ Messages display with content
✅ Bot names show correctly
✅ Bot avatars load
⏳ TODO: Implement mention translation (Discord ↔ Harmony)
⏳ TODO: Add bot webhook support for rich embeds

