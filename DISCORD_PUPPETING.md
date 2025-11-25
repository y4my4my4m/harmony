# Discord Bridge - Puppeting Implementation

## Overview
Implemented Matrix-style "puppeting" where Discord messages appear with the actual Discord user's name and avatar, not the bridge bot's identity.

## How It Works

### Before (Basic Bridge)
```
[Discord Bridge] BOT  3:05 PM
[Discord] y4my4m: hello
```

### After (Puppeting)
```
[y4my4m] DISCORD  3:05 PM
hello
```

## Implementation Details

### 1. Bridge Side (Discord → Harmony)

**bot-plugins/discord-bridge/src/index.ts**
- Extracts Discord user metadata (username, display_name, avatar_url)
- Sends metadata with message to Harmony API
- Content is clean (no `[Discord] username:` prefix)

**bot-plugins/discord-bridge/src/MessageTranslator.ts**
- New method: `extractDiscordUserMetadata()` 
- Captures: id, username, discriminator, display_name, avatar_url
- Marks message with `bridge_source: 'discord'`

**bot-plugins/discord-bridge/src/HarmonyClient.ts**
- Updated `sendMessage()` to accept optional metadata parameter
- Passes metadata to bot gateway API

### 2. Bot Gateway Side

**bot-gateway/src/api/BotRestAPI.ts**
- Accepts `metadata` in POST body
- Merges bridge metadata with standard bot metadata
- Stores in `messages.metadata` column

### 3. Frontend Side

**src/components/MessageDisplay.vue**
- New function: `hasDiscordUserMetadata()` - checks if message has Discord user data
- New function: `getDiscordUserInfo()` - extracts Discord user from metadata
- Updated `getAuthorDisplayName()` - shows Discord username if available
- Updated `getAuthorAvatarUrl()` - shows Discord avatar if available
- Updated `getAuthorColor()` - uses Discord blurple (#7289DA) for Discord users
- Shows "DISCORD" badge instead of "BOT" badge for puppeted messages

## Metadata Structure

```typescript
{
  bot: true,
  created_via: 'bot_api',
  discord_user: {
    id: '123456789',
    username: 'y4my4m',
    discriminator: '0',
    display_name: 'y4my4m',
    avatar_url: 'https://cdn.discordapp.com/avatars/...'
  },
  bridge_source: 'discord'
}
```

## Visual Changes

### Badge System
- **Regular Bot**: Blue badge `BOT`
- **Discord User**: Blurple badge `DISCORD` 
- **Color**: Discord users get #7289DA color

### Avatar & Name
- Shows actual Discord user avatar (fetched from Discord CDN)
- Shows Discord display_name (or username if no display_name)

## Files Changed

### Backend
1. `bot-gateway/src/api/BotRestAPI.ts` - Accept and store metadata
2. `bot-plugins/discord-bridge/src/index.ts` - Extract and send metadata
3. `bot-plugins/discord-bridge/src/MessageTranslator.ts` - Add metadata extraction
4. `bot-plugins/discord-bridge/src/HarmonyClient.ts` - Support metadata parameter

### Frontend  
5. `src/components/MessageDisplay.vue` - Display Discord user info from metadata

## Testing

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

4. **Send message from Discord**:
   - Should show Discord username
   - Should show Discord avatar
   - Should have "DISCORD" badge
   - Should have Discord blurple color

## Benefits

✅ **Natural appearance** - Discord users look like real Harmony users
✅ **Avatar sync** - Shows actual Discord profile pictures
✅ **Clear indication** - DISCORD badge shows message source
✅ **User identity** - Each Discord user has unique appearance
✅ **Matrix-style** - Works like professional bridge systems

## Future Enhancements

### Phase 2: Mentions
- [ ] Make Discord users mentionable
- [ ] Add Discord users to autocomplete
- [ ] Translate mentions Harmony → Discord

### Phase 3: Profile Views
- [ ] Click Discord user → show mini-profile with Discord info
- [ ] Show "This user is on Discord" indicator
- [ ] Option to open Discord profile

### Phase 4: Presence
- [ ] Sync Discord online status
- [ ] Show "Playing X" status from Discord
- [ ] Custom Discord statuses

## Troubleshooting

### Discord usernames not showing
- Check browser console for metadata
- Verify `message.metadata.discord_user` exists
- Check bot gateway logs for metadata in INSERT

### Discord avatars not loading
- Discord CDN URLs might be blocked
- Check CORS policies
- Verify avatar_url in metadata is valid

### Still shows "Discord Bridge" name
- Hard refresh browser (Ctrl+F5)
- Check if `hasDiscordUserMetadata()` returns true
- Verify metadata structure matches expected format

## Database Impact

**No schema changes required!**
- Uses existing `messages.metadata` JSONB column
- Backward compatible
- Existing messages unaffected

