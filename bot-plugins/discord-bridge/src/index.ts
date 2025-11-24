import { Client as DiscordClient, GatewayIntentBits, Message as DiscordMessage, Webhook, TextChannel } from 'discord.js'
import { HarmonyClient } from './HarmonyClient.js'
import { MessageTranslator } from './MessageTranslator.js'
import { ChannelMapper } from './ChannelMapper.js'
import * as dotenv from 'dotenv'

dotenv.config()

// Initialize components
const mapper = new ChannelMapper('./config/bridge-config.yml')
const config = mapper.getConfig()
const translator = new MessageTranslator()

// Webhook cache for puppeting
const webhookCache = new Map<string, Webhook>()

// Get or create webhook for channel (for puppeting)
async function getOrCreateWebhook(channelId: string): Promise<Webhook | null> {
  try {
    // Return cached webhook
    if (webhookCache.has(channelId)) {
      return webhookCache.get(channelId)!
    }
    
    const channel = await discordClient.channels.fetch(channelId) as TextChannel
    if (!channel || !channel.isTextBased()) {
      return null
    }
    
    // Find existing Harmony Bridge webhook
    const webhooks = await channel.fetchWebhooks()
    let webhook = webhooks.find(wh => wh.name === 'Harmony Bridge')
    
    // Create if doesn't exist
    if (!webhook) {
      console.log(`🔨 Creating webhook for channel ${channelId}`)
      webhook = await channel.createWebhook({
        name: 'Harmony Bridge',
        avatar: 'https://raw.githubusercontent.com/your-repo/harmony/main/public/icon.png' // Optional: your Harmony icon
      })
    }
    
    webhookCache.set(channelId, webhook)
    return webhook
  } catch (error) {
    console.error(`❌ Failed to get/create webhook for ${channelId}:`, error)
    return null
  }
}

// (Future use: Generate unique username to avoid collisions with Discord users)
// async function generateUniqueUsername(baseUsername: string, guildId: string): Promise<string> {
//   // TODO: Implement proper collision detection with caching
//   // For now, always add -harmony suffix to avoid any potential collisions
//   // This is what Matrix-Discord bridge does too
//   return `${baseUsername} [H]`
// }

// Initialize Discord client
const discordClient = new DiscordClient({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent
  ]
})

// Initialize Harmony client
const harmonyClient = new HarmonyClient(
  config.harmony.token,
  config.harmony.gatewayUrl,
  config.harmony.apiUrl
)

// =====================================================
// DISCORD -> HARMONY
// =====================================================

discordClient.on('messageCreate', async (msg: DiscordMessage) => {
  // Ignore bot messages
  if (msg.author.bot) return
  
  // Check if channel is mapped
  const harmonyChannelId = mapper.getHarmonyChannel(msg.channelId)
  if (!harmonyChannelId) return
  
  if (!mapper.shouldBridgeFromDiscord(msg.channelId)) return
  
  try {
    // Translate message content using MessageParts format
    const contentParts = translator.discordToHarmonyParts(msg)
    
    // Extract Discord user metadata for puppeting
    const metadata = translator.extractDiscordUserMetadata(msg)
    
    // Send to Harmony with MessageParts array
    await harmonyClient.sendMessage(harmonyChannelId, contentParts, metadata)
    console.log(`✅ Discord -> Harmony: ${msg.author.username} in #${msg.channel}`)
  } catch (error) {
    console.error('❌ Failed to bridge Discord -> Harmony:', error)
  }
})

// Handle Discord reactions
discordClient.on('messageReactionAdd', async (reaction, user) => {
  // Ignore bot reactions
  if (user.bot) return
  
  // Check if channel is mapped
  const harmonyChannelId = mapper.getHarmonyChannel(reaction.message.channelId)
  if (!harmonyChannelId) return
  
  if (!mapper.shouldBridgeFromDiscord(reaction.message.channelId)) return
  
  try {
    // Get emoji (Unicode or custom)
    const emoji = reaction.emoji.name || ''
    
    // TODO: Need to store Discord message ID -> Harmony message ID mapping
    // For now, we can't bridge reactions because we don't have the Harmony message ID
    console.log(`🎭 Discord reaction added: ${emoji} (not bridged - requires message ID mapping)`)
  } catch (error) {
    console.error('❌ Failed to bridge reaction Discord -> Harmony:', error)
  }
})

discordClient.on('messageReactionRemove', async (reaction, user) => {
  // Ignore bot reactions
  if (user.bot) return
  
  // Check if channel is mapped
  const harmonyChannelId = mapper.getHarmonyChannel(reaction.message.channelId)
  if (!harmonyChannelId) return
  
  if (!mapper.shouldBridgeFromDiscord(reaction.message.channelId)) return
  
  try {
    // Get emoji (Unicode or custom)
    const emoji = reaction.emoji.name || ''
    
    // TODO: Need to store Discord message ID -> Harmony message ID mapping
    console.log(`🎭 Discord reaction removed: ${emoji} (not bridged - requires message ID mapping)`)
  } catch (error) {
    console.error('❌ Failed to bridge reaction Discord -> Harmony:', error)
  }
})

// Handle Discord message edits
if (config.settings.syncEdits) {
  discordClient.on('messageUpdate', async (oldMsg, newMsg) => {
    if (!newMsg.author || newMsg.author.bot) return
    
    const harmonyChannelId = mapper.getHarmonyChannel(newMsg.channelId)
    if (!harmonyChannelId) return
    
    // Note: Harmony doesn't support message editing via bot API yet
    // This would require storing message ID mappings
    console.log('📝 Discord message edited (not bridged - requires ID mapping)')
  })
}

// Handle Discord message deletes
if (config.settings.syncDeletes) {
  discordClient.on('messageDelete', async (_msg) => {
    // Similar to edits - requires message ID mapping
    console.log('🗑️ Discord message deleted (not bridged - requires ID mapping)')
  })
}

// =====================================================
// HARMONY -> DISCORD
// =====================================================

harmonyClient.on('ready', (data: any) => {
  console.log(`✅ Harmony bot connected: ${data.bot.username} (${data.bot.id})`);
  
  // Store bot ID for filtering
  (harmonyClient as any).botId = data.bot.id;
  
  // Subscribe to all mapped Harmony channels
  for (const mapping of config.channelMappings) {
    console.log(`📡 Subscribing to Harmony channel: ${mapping.name || mapping.harmony}`);
    // Gateway will automatically dispatch events for channels the bot has access to
  }
});

harmonyClient.on('messageCreate', async (msg: any) => {
  console.log(`📨 Received Harmony message:`, {
    author: msg.author?.username,
    authorId: msg.author?.id,
    avatar: msg.author?.avatar,
    isBot: msg.author?.bot,
    bridge_source: msg.metadata?.bridge_source,
    channelId: msg.channel_id,
    content: msg.content,
    content_raw: msg.content_raw
  });
  
  // Don't bridge messages that came from Discord (prevent loops!)
  if (msg.metadata?.bridge_source === 'discord') {
    console.log('⏭️  Skipping message from Discord (preventing loop)')
    return
  }
  
  // Don't bridge messages from this bot (avoid loops)
  const botId = (harmonyClient as any).botId
  if (msg.author?.id === botId) {
    console.log('⏭️  Skipping own message')
    return
  }
  
  // Don't bridge other bot messages (except Discord users)
  if (msg.author?.bot && !msg.author?.discord_user) {
    console.log('⏭️  Skipping bot message')
    return
  }
  
  // Check if channel is mapped
  const discordChannelId = mapper.getDiscordChannel(msg.channel_id)
  if (!discordChannelId) {
    console.log('⏭️  Channel not mapped')
    return
  }
  
  console.log(`📍 Mapped to Discord channel: ${discordChannelId}`);
  
  if (!mapper.shouldBridgeFromHarmony(msg.channel_id)) {
    console.log('⏭️  Bridging disabled for this channel')
    return
  }
  
  try {
    console.log(`🔨 Fetching Discord channel...`);
    // Get Discord channel to find guild ID
    const discordChannel = await discordClient.channels.fetch(discordChannelId) as TextChannel
    if (!discordChannel || !discordChannel.guild) {
      console.error('❌ Discord channel not found or not in a guild')
      return
    }
    
    console.log(`✅ Got Discord channel in guild: ${discordChannel.guild.name}`);
    
    // Get webhook for puppeting
    console.log(`🔨 Getting webhook...`);
    const webhook = await getOrCreateWebhook(discordChannelId)
    
    if (!webhook) {
      console.error('❌ Could not get webhook, message not sent')
      return
    }
    
    console.log(`✅ Got webhook: ${webhook.name}`);
    
    // Generate unique username (simple suffix)
    const baseUsername = msg.author?.display_name || msg.author?.username || 'Harmony User'
    const uniqueUsername = `${baseUsername} [H]` // Simple suffix for Harmony users
    console.log(`✅ Username: ${uniqueUsername}`);
    
    // Avatar URL is already complete from Supabase storage
    // Discord won't be able to fetch localhost URLs, so skip avatar in local dev
    const avatarURL = msg.author?.avatar?.startsWith('http://localhost') ? undefined : msg.author?.avatar
    
    // Ensure content is a string (might be array of MessageParts)
    const contentText = msg.content
    if (!contentText || contentText.trim() === '') {
      console.error('❌ Message content is empty, cannot send to Discord')
      return
    }
    
    console.log(`🎨 Puppeting as ${uniqueUsername} with avatar: ${avatarURL || 'default'}`)
    console.log(`📝 Message content: "${contentText}"`)
    
    // Send via webhook (puppeting!)
    const webhookResult = await webhook.send({
      content: contentText,
      username: uniqueUsername,
      avatarURL: avatarURL,
      allowedMentions: { parse: [] } // Prevent mention abuse
    })
    
    console.log(`✅ Webhook sent! Message ID: ${webhookResult.id}`)
    console.log(`✅ Harmony -> Discord (puppeted): ${uniqueUsername} in #${discordChannelId}`)
  } catch (error) {
    console.error('❌ Failed to bridge Harmony -> Discord:', error)
  }
})

// Handle Harmony reactions
harmonyClient.on('reactionAdd', async (data: any) => {
  console.log(`🎭 Harmony reaction added:`, data)
  
  // Don't bridge reactions from Discord (prevent loops!)
  if (data.metadata?.bridge_source === 'discord') {
    console.log('⏭️  Skipping reaction from Discord (preventing loop)')
    return
  }
  
  // Check if channel is mapped
  const discordChannelId = mapper.getDiscordChannel(data.channel_id)
  if (!discordChannelId) {
    console.log('⏭️  Channel not mapped')
    return
  }
  
  if (!mapper.shouldBridgeFromHarmony(data.channel_id)) {
    console.log('⏭️  Bridging disabled for this channel')
    return
  }
  
  try {
    // TODO: Need to store Harmony message ID -> Discord message ID mapping
    // For now, we can't bridge reactions because we don't have the Discord message ID
    console.log(`🎭 Harmony reaction added (not bridged - requires message ID mapping)`)
  } catch (error) {
    console.error('❌ Failed to bridge reaction Harmony -> Discord:', error)
  }
})

harmonyClient.on('reactionRemove', async (data: any) => {
  console.log(`🎭 Harmony reaction removed:`, data)
  
  // Don't bridge reactions from Discord (prevent loops!)
  if (data.metadata?.bridge_source === 'discord') {
    console.log('⏭️  Skipping reaction from Discord (preventing loop)')
    return
  }
  
  // Check if channel is mapped
  const discordChannelId = mapper.getDiscordChannel(data.channel_id)
  if (!discordChannelId) {
    console.log('⏭️  Channel not mapped')
    return
  }
  
  if (!mapper.shouldBridgeFromHarmony(data.channel_id)) {
    console.log('⏭️  Bridging disabled for this channel')
    return
  }
  
  try {
    // TODO: Need to store Harmony message ID -> Discord message ID mapping
    console.log(`🎭 Harmony reaction removed (not bridged - requires message ID mapping)`)
  } catch (error) {
    console.error('❌ Failed to bridge reaction Harmony -> Discord:', error)
  }
})

// =====================================================
// STARTUP
// =====================================================

console.log('╔════════════════════════════════════════╗')
console.log('║   🌉 Discord-Harmony Bridge           ║')
console.log('╠════════════════════════════════════════╣')
console.log(`║   Mappings: ${config.channelMappings.length} channels            ║`)
console.log('╚════════════════════════════════════════╝')

// Start Discord client
discordClient.login(config.discord.token).catch(error => {
  console.error('❌ Failed to login to Discord:', error)
  process.exit(1)
})

discordClient.on('ready', () => {
  console.log(`✅ Discord bot connected: ${discordClient.user?.tag}`)
})

// Start Harmony client
harmonyClient.connect().catch(error => {
  console.error('❌ Failed to connect to Harmony:', error)
  process.exit(1)
})

// Graceful shutdown
process.on('SIGTERM', shutdown)
process.on('SIGINT', shutdown)

function shutdown() {
  console.log('📥 Shutting down bridge...')
  discordClient.destroy()
  harmonyClient.disconnect()
  process.exit(0)
}

