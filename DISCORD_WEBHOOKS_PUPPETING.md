# Discord Webhooks for Puppeting (Harmony → Discord)

## Current State
- ✅ Discord → Harmony: Works! Shows Discord user's name/avatar
- ❌ Harmony → Discord: Shows `[Harmony] username: message` (not puppeting)

## What Matrix-Discord Bridge Does
Uses **Discord Webhooks** to send messages that appear as different users:
```
[Matrix User]  ← Avatar from Matrix
actual message content
```

## How to Implement

### 1. Discord Bridge Side

**Create/Get Webhook for Channel:**
```typescript
// In DiscordBridge
private webhookCache = new Map<string, Webhook>();

async getOrCreateWebhook(channelId: string): Promise<Webhook> {
  if (this.webhookCache.has(channelId)) {
    return this.webhookCache.get(channelId)!;
  }
  
  const channel = await discordClient.channels.fetch(channelId);
  if (!channel.isTextBased()) throw new Error('Not a text channel');
  
  // Find existing bridge webhook or create new one
  const webhooks = await channel.fetchWebhooks();
  let webhook = webhooks.find(wh => wh.name === 'Harmony Bridge');
  
  if (!webhook) {
    webhook = await channel.createWebhook({
      name: 'Harmony Bridge',
      avatar: 'https://your-harmony-instance.com/icon.png'
    });
  }
  
  this.webhookCache.set(channelId, webhook);
  return webhook;
}
```

**Send via Webhook (Puppeting):**
```typescript
harmony Client.on('messageCreate', async (msg: any) => {
  // ... existing checks ...
  
  try {
    const webhook = await getOrCreateWebhook(discordChannelId);
    
    // Send as the Harmony user (puppeting!)
    await webhook.send({
      content: msg.content,
      username: msg.author?.display_name || msg.author?.username || 'Harmony User',
      avatarURL: msg.author?.avatar || 'https://harmony.example.com/default_avatar.png',
      allowedMentions: { parse: [] } // Prevent mention abuse
    });
    
    console.log(`✅ Harmony -> Discord (puppeted): ${msg.author?.username}`);
  } catch (error) {
    console.error('❌ Failed to puppet message:', error);
  }
});
```

### 2. Benefits

✅ **Looks native** - Each Harmony user appears as a "real" Discord user
✅ **Avatars sync** - Shows Harmony profile pictures
✅ **Usernames sync** - Shows Harmony display names
✅ **No prefix needed** - No more `[Harmony] username:` prefix
✅ **Professional** - Exactly like Matrix-Discord bridge

### 3. Limitations

⚠️ **Can't @mention back** - Discord users can't directly mention Harmony users (webhook limitation)
⚠️ **No reactions** - Reactions from Discord won't work on puppeted messages
⚠️ **One webhook per channel** - Need to manage webhook lifecycle

### 4. Example Result

**Before:**
```
Harmony-Bridge BOT  3:26 PM
[Harmony] y4my4m: hey
[Harmony] y4my4m: hey
[Harmony] y4my4m: hey
```

**After (with webhooks):**
```
y4my4m  APP  3:26 PM  ← Uses Harmony avatar
hey

y4my4m  APP  3:26 PM
hey
```

The "APP" badge appears because it's a webhook, which is perfect!

### 5. Implementation Priority

1. **High**: Implement webhook puppeting for Harmony → Discord
2. **Medium**: Cache webhooks to avoid rate limits
3. **Low**: Handle webhook cleanup when bridge stops
4. **Optional**: Mention translation (complex)

## Next Steps

1. Add webhook management to Discord bridge
2. Update Harmony → Discord message handler to use webhooks
3. Pass user avatar/display_name from Harmony
4. Test with multiple users

This will make it look EXACTLY like Matrix-Discord bridge! 🎉

