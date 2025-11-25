import { Client as DiscordClient, GatewayIntentBits, Message as DiscordMessage, Webhook, TextChannel, Partials } from 'discord.js'
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

// Message ID mapping: Discord message ID -> Harmony message ID
const discordToHarmonyMessages = new Map<string, string>()
// Message ID mapping: Harmony message ID -> Discord message ID
const harmonyToDiscordMessages = new Map<string, string>()

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
    GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageReactions
  ],
  partials: [Partials.Message, Partials.Channel, Partials.Reaction]
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
    
    // Store Discord message ID in metadata for reaction mapping
    metadata.discord_message_id = msg.id
    
    // Send to Harmony with MessageParts array
    const result = await harmonyClient.sendMessage(harmonyChannelId, contentParts, metadata)
    
    // Store message ID mapping for reactions
    if (result?.message?.id) {
      discordToHarmonyMessages.set(msg.id, result.message.id)
      harmonyToDiscordMessages.set(result.message.id, msg.id)
      console.log(`📌 Stored message mapping: Discord ${msg.id} <-> Harmony ${result.message.id}`)
    }
    
    console.log(`✅ Discord -> Harmony: ${msg.author.username} in #${msg.channel}`)
  } catch (error) {
    console.error('❌ Failed to bridge Discord -> Harmony:', error)
  }
})

// Handle Discord reactions
discordClient.on('messageReactionAdd', async (reaction, user) => {
  // Ignore bot reactions
  if (user.bot) return
  
  // Fetch partial reaction
  if (reaction.partial) {
    try {
      await reaction.fetch()
    } catch (error) {
      console.error('❌ Failed to fetch reaction:', error)
      return
    }
  }
  
  // Check if channel is mapped
  const harmonyChannelId = mapper.getHarmonyChannel(reaction.message.channelId)
  if (!harmonyChannelId) return
  
  if (!mapper.shouldBridgeFromDiscord(reaction.message.channelId)) return
  
  // Check if syncReactions is enabled in config
  if (!config.settings.syncReactions) {
    console.log('⏭️  Reaction syncing disabled in config')
    return
  }
  
  try {
    // Get the Harmony message ID from our mapping
    const harmonyMessageId = discordToHarmonyMessages.get(reaction.message.id)
    if (!harmonyMessageId) {
      console.log(`⚠️  No message mapping found for Discord message ${reaction.message.id}`)
      return
    }
    
    // Get bot ID for emoji creation
    const botId = (harmonyClient as any).botId
    if (!botId) {
      console.error('❌ Bot ID not available')
      return
    }
    
    // Get emoji (Unicode or custom)
    let emojiIdentifier: string | null = null
    
    if (reaction.emoji.id) {
      // Custom Discord emoji - find or create it in Harmony (same as ActivityPub does)
      const emojiName = reaction.emoji.name || 'unknown'
      const isAnimated = reaction.emoji.animated || false
      console.log(`🎭 Discord custom emoji: ${emojiName} (ID: ${reaction.emoji.id}, animated: ${isAnimated})`)
      
      // Find or create the emoji in Harmony
      emojiIdentifier = await harmonyClient.findOrCreateDiscordEmoji(
        emojiName,
        reaction.emoji.id,
        isAnimated,
        botId
      )
      
      if (!emojiIdentifier) {
        console.error(`❌ Could not create/find Discord emoji: ${emojiName}`)
        return
      }
    } else {
      // Unicode emoji
      emojiIdentifier = reaction.emoji.name || ''
      console.log(`🎭 Discord Unicode emoji: ${emojiIdentifier}`)
    }
    
    if (!emojiIdentifier) {
      console.error('❌ Could not determine emoji identifier')
      return
    }
    
    // Prepare Discord user metadata for attribution
    const reactionMetadata = {
      discord_user: {
        id: user.id,
        username: user.username,
        discriminator: user.discriminator,
        display_name: user.globalName || user.username,
        avatar_url: user.displayAvatarURL({ size: 128 })
      },
      bridge_source: 'discord'
    }
    
    // Add reaction to Harmony message with Discord user metadata
    await harmonyClient.addReaction(harmonyChannelId, harmonyMessageId, emojiIdentifier, reactionMetadata)
    console.log(`✅ Discord -> Harmony reaction: ${emojiIdentifier} on message ${harmonyMessageId}`)
  } catch (error: any) {
    console.error('❌ Failed to bridge reaction Discord -> Harmony:', error.message)
  }
})

discordClient.on('messageReactionRemove', async (reaction, user) => {
  // Ignore bot reactions
  if (user.bot) return
  
  // Fetch partial reaction
  if (reaction.partial) {
    try {
      await reaction.fetch()
    } catch (error) {
      console.error('❌ Failed to fetch reaction:', error)
      return
    }
  }
  
  // Check if channel is mapped
  const harmonyChannelId = mapper.getHarmonyChannel(reaction.message.channelId)
  if (!harmonyChannelId) return
  
  if (!mapper.shouldBridgeFromDiscord(reaction.message.channelId)) return
  
  // Check if syncReactions is enabled in config
  if (!config.settings.syncReactions) {
    console.log('⏭️  Reaction syncing disabled in config')
    return
  }
  
  try {
    // Get the Harmony message ID from our mapping
    const harmonyMessageId = discordToHarmonyMessages.get(reaction.message.id)
    if (!harmonyMessageId) {
      console.log(`⚠️  No message mapping found for Discord message ${reaction.message.id}`)
      return
    }
    
    // Get bot ID for emoji lookup
    const botId = (harmonyClient as any).botId
    if (!botId) {
      console.error('❌ Bot ID not available')
      return
    }
    
    // Get emoji (Unicode or custom)
    let emojiIdentifier: string | null = null
    
    if (reaction.emoji.id) {
      // Custom Discord emoji - need to look it up in Harmony (same as add)
      const emojiName = reaction.emoji.name || 'unknown'
      const isAnimated = reaction.emoji.animated || false
      console.log(`🎭 Discord custom emoji: ${emojiName} (ID: ${reaction.emoji.id})`)
      
      // Find the emoji in Harmony (should already exist from when it was added)
      emojiIdentifier = await harmonyClient.findOrCreateDiscordEmoji(
        emojiName,
        reaction.emoji.id,
        isAnimated,
        botId
      )
      
      if (!emojiIdentifier) {
        console.error(`❌ Could not find Discord emoji: ${emojiName}`)
        return
      }
    } else {
      // Unicode emoji
      emojiIdentifier = reaction.emoji.name || ''
      console.log(`🎭 Discord Unicode emoji: ${emojiIdentifier}`)
    }
    
    if (!emojiIdentifier) {
      console.error('❌ Could not determine emoji identifier')
      return
    }
    
    // Remove reaction from Harmony message
    await harmonyClient.removeReaction(harmonyChannelId, harmonyMessageId, emojiIdentifier)
    console.log(`✅ Discord -> Harmony reaction removed: ${emojiIdentifier} from message ${harmonyMessageId}`)
  } catch (error: any) {
    console.error('❌ Failed to bridge reaction removal Discord -> Harmony:', error.message)
  }
})

// Handle Discord message edits
if (config.settings.syncEdits) {
  discordClient.on('messageUpdate', async (oldMsg, newMsg) => {
    if (!newMsg.author || newMsg.author.bot) return
    
    const harmonyChannelId = mapper.getHarmonyChannel(newMsg.channelId)
    if (!harmonyChannelId) return
    
    try {
      // Get Harmony message ID from mapping
      const harmonyMessageId = discordToHarmonyMessages.get(newMsg.id)
      if (!harmonyMessageId) {
        console.log(`⚠️  No message mapping found for Discord message ${newMsg.id}`)
        return
      }
      
      // Translate the new content
      const contentParts = translator.discordToHarmonyParts(newMsg)
      
      // Edit the message in Harmony
      await harmonyClient.editMessage(harmonyMessageId, contentParts)
      console.log(`✅ Discord -> Harmony edit: Message ${harmonyMessageId}`)
    } catch (error) {
      console.error('❌ Failed to bridge edit Discord -> Harmony:', error)
    }
  })
}

// Handle Discord message deletes
if (config.settings.syncDeletes) {
  discordClient.on('messageDelete', async (msg) => {
    if (msg.author?.bot) return
    
    const harmonyChannelId = mapper.getHarmonyChannel(msg.channelId)
    if (!harmonyChannelId) return
    
    try {
      // Get Harmony message ID from mapping
      const harmonyMessageId = discordToHarmonyMessages.get(msg.id)
      if (!harmonyMessageId) {
        console.log(`⚠️  No message mapping found for Discord message ${msg.id}`)
        return
      }
      
      // Delete the message in Harmony
      await harmonyClient.deleteMessage(harmonyMessageId)
      console.log(`✅ Discord -> Harmony delete: Message ${harmonyMessageId}`)
      
      // Clean up mapping
      discordToHarmonyMessages.delete(msg.id)
      harmonyToDiscordMessages.delete(harmonyMessageId)
    } catch (error) {
      console.error('❌ Failed to bridge delete Discord -> Harmony:', error)
    }
  })
}

// =====================================================
// HARMONY -> DISCORD
// =====================================================

harmonyClient.on('ready', async (data: any) => {
  console.log(`✅ Harmony bot connected: ${data.bot.username} (${data.bot.id})`);
  
  // Store bot ID for filtering
  (harmonyClient as any).botId = data.bot.id;
  
  // Subscribe to all mapped Harmony channels and load recent messages for mapping
  for (const mapping of config.channelMappings) {
    console.log(`📡 Subscribing to Harmony channel: ${mapping.name || mapping.harmony}`);
    
    // Load recent messages to restore message ID mappings
    try {
      console.log(`📥 Loading recent messages from ${mapping.name || mapping.harmony}...`);
      const recentMessages = await harmonyClient.loadRecentMessages(mapping.harmony, 100);
      
      let restoredCount = 0;
      for (const msg of recentMessages) {
        if (msg.metadata?.discord_message_id && msg.id) {
          const discordMsgId = msg.metadata.discord_message_id;
          discordToHarmonyMessages.set(discordMsgId, msg.id);
          harmonyToDiscordMessages.set(msg.id, discordMsgId);
          restoredCount++;
        }
      }
      
      if (restoredCount > 0) {
        console.log(`✅ Restored ${restoredCount} message mappings from ${mapping.name || mapping.harmony}`);
      }
    } catch (error) {
      console.error(`❌ Failed to load recent messages from ${mapping.name || mapping.harmony}:`, error);
    }
  }
});

harmonyClient.on('messageCreate', async (msg: any) => {
  console.log(`📨 Received Harmony message:`, {
    author: msg.author?.username,
    authorId: msg.author?.id,
    avatar: msg.author?.avatar,
    isBot: msg.author?.bot,
    bridge_source: msg.metadata?.bridge_source,
    discord_message_id: msg.metadata?.discord_message_id,
    channelId: msg.channel_id,
    content: msg.content,
    content_raw: msg.content_raw
  });
  
  // If this message came from Discord and has the Discord message ID in metadata, store the mapping
  if (msg.metadata?.discord_message_id && msg.id) {
    const discordMsgId = msg.metadata.discord_message_id
    discordToHarmonyMessages.set(discordMsgId, msg.id)
    harmonyToDiscordMessages.set(msg.id, discordMsgId)
    console.log(`📌 Restored message mapping from metadata: Discord ${discordMsgId} <-> Harmony ${msg.id}`)
  }
  
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
    
    // Avatar URL is now fully-qualified by the bot gateway
    // Discord won't be able to fetch localhost URLs, so skip avatar in local dev
    const avatarURL = msg.author?.avatar?.startsWith('http://localhost') ? undefined : msg.author?.avatar
    
    // Convert Harmony MessageParts to Discord format
    const contentText = translator.harmonyToDiscord(msg)
    if (!contentText || contentText.trim() === '') {
      console.error('❌ Message content is empty after translation, cannot send to Discord')
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
    
    // Store message ID mapping for reactions
    if (webhookResult?.id && msg.id) {
      harmonyToDiscordMessages.set(msg.id, webhookResult.id)
      discordToHarmonyMessages.set(webhookResult.id, msg.id)
      console.log(`📌 Stored message mapping: Harmony ${msg.id} <-> Discord ${webhookResult.id}`)
    }
    
    console.log(`✅ Webhook sent! Message ID: ${webhookResult.id}`)
    console.log(`✅ Harmony -> Discord (puppeted): ${uniqueUsername} in #${discordChannelId}`)
  } catch (error) {
    console.error('❌ Failed to bridge Harmony -> Discord:', error)
  }
})

// Handle Harmony message updates
harmonyClient.on('messageUpdate', async (msg: any) => {
  console.log(`📝 Harmony message updated:`, { id: msg.id, channel_id: msg.channel_id });
  
  // Don't bridge messages that came from Discord (prevent loops!)
  if (msg.metadata?.bridge_source === 'discord') {
    console.log('⏭️  Skipping message from Discord (preventing loop)')
    return
  }
  
  // Get Discord message ID from mapping
  const discordMessageId = harmonyToDiscordMessages.get(msg.id)
  if (!discordMessageId) {
    console.log('⚠️  No message mapping found for Harmony message', msg.id)
    return
  }
  
  // Get Discord channel from mapping
  const discordChannelId = mapper.getDiscordChannel(msg.channel_id)
  if (!discordChannelId) {
    console.log('⏭️  Channel not mapped')
    return
  }
  
  if (!mapper.shouldBridgeFromHarmony(msg.channel_id)) {
    console.log('⏭️  Bridging disabled for this channel')
    return
  }
  
  try {
    // Get the webhook message to edit it
    const discordChannel = await discordClient.channels.fetch(discordChannelId) as TextChannel
    if (!discordChannel) {
      console.error('❌ Discord channel not found')
      return
    }
    
    const webhook = await getOrCreateWebhook(discordChannelId)
    if (!webhook) {
      console.error('❌ Could not get webhook')
      return
    }
    
    // Convert content
    const contentText = translator.harmonyToDiscord(msg)
    
    // Edit the webhook message
    await webhook.editMessage(discordMessageId, {
      content: contentText
    })
    
    console.log(`✅ Harmony -> Discord edit: Message ${discordMessageId}`)
  } catch (error) {
    console.error('❌ Failed to bridge edit Harmony -> Discord:', error)
  }
})

// Handle Harmony message deletes
harmonyClient.on('messageDelete', async (msg: any) => {
  console.log(`🗑️ Harmony message deleted:`, { id: msg.id, channel_id: msg.channel_id });
  
  // Don't bridge messages that came from Discord (prevent loops!)
  if (msg.metadata?.bridge_source === 'discord') {
    console.log('⏭️  Skipping message from Discord (preventing loop)')
    return
  }
  
  // Get Discord message ID from mapping
  const discordMessageId = harmonyToDiscordMessages.get(msg.id)
  if (!discordMessageId) {
    console.log('⚠️  No message mapping found for Harmony message', msg.id)
    return
  }
  
  // Get Discord channel from mapping
  const discordChannelId = mapper.getDiscordChannel(msg.channel_id)
  if (!discordChannelId) {
    console.log('⏭️  Channel not mapped')
    return
  }
  
  if (!mapper.shouldBridgeFromHarmony(msg.channel_id)) {
    console.log('⏭️  Bridging disabled for this channel')
    return
  }
  
  try {
    // Get the webhook to delete the message
    const discordChannel = await discordClient.channels.fetch(discordChannelId) as TextChannel
    if (!discordChannel) {
      console.error('❌ Discord channel not found')
      return
    }
    
    const webhook = await getOrCreateWebhook(discordChannelId)
    if (!webhook) {
      console.error('❌ Could not get webhook')
      return
    }
    
    // Delete the webhook message
    await webhook.deleteMessage(discordMessageId)
    
    console.log(`✅ Harmony -> Discord delete: Message ${discordMessageId}`)
    
    // Clean up mapping
    harmonyToDiscordMessages.delete(msg.id)
    discordToHarmonyMessages.delete(discordMessageId)
  } catch (error) {
    console.error('❌ Failed to bridge delete Harmony -> Discord:', error)
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

