import { 
  Client as DiscordClient, 
  GatewayIntentBits, 
  Message as DiscordMessage, 
  Webhook, 
  TextChannel, 
  Partials, 
  GuildMember,
  SlashCommandBuilder,
  REST,
  Routes,
  ChatInputCommandInteraction,
  AutocompleteInteraction
} from 'discord.js'
import { HarmonyClient } from './HarmonyClient.js'
import { MessageTranslator } from './MessageTranslator.js'
import { ChannelMapper } from './ChannelMapper.js'
import * as dotenv from 'dotenv'

dotenv.config()

// Initialize components
const mapper = new ChannelMapper('./config/bridge-config.yml')
const config = mapper.getConfig()

// Validate required configuration
if (!config.harmony?.baseUrl) {
  throw new Error('Configuration error: harmony.baseUrl is required in bridge-config.yml')
}

const harmonyBaseUrl = new URL(config.harmony.baseUrl)
if (!harmonyBaseUrl.hostname || harmonyBaseUrl.hostname === 'localhost') {
  console.warn('⚠️  Warning: harmony.baseUrl is set to localhost - federation mentions will use localhost domain')
}

const translator = new MessageTranslator()
translator.setHarmonyDomain(harmonyBaseUrl.hostname)

// Webhook cache for puppeting
const webhookCache = new Map<string, Webhook>()

// Message ID mapping: Discord message ID -> Harmony message ID
const discordToHarmonyMessages = new Map<string, string>()
// Message ID mapping: Harmony message ID -> Discord message ID
const harmonyToDiscordMessages = new Map<string, string>()

// =====================================================
// DISCORD MEMBER CACHE
// =====================================================
// Cache Discord members for mention lookups: lowercase username -> Discord ID
const discordMemberCache = new Map<string, string>()
// Also store full member info for autosuggest API
interface CachedDiscordMember {
  id: string
  username: string
  displayName: string
  avatarUrl: string
}
const discordMemberDetails = new Map<string, CachedDiscordMember>()

/**
 * Get all cached Discord members (for autosuggest API)
 */
export function getDiscordMembers(): CachedDiscordMember[] {
  return Array.from(discordMemberDetails.values())
}

/**
 * Get Discord member cache for username -> ID lookups
 */
export function getDiscordMemberIdCache(): Map<string, string> {
  return discordMemberCache
}

/**
 * Add or update a member in the cache
 */
function cacheMember(member: GuildMember) {
  const username = member.user.username.toLowerCase()
  discordMemberCache.set(username, member.id)
  
  discordMemberDetails.set(member.id, {
    id: member.id,
    username: member.user.username,
    displayName: member.displayName || member.user.username,
    avatarUrl: member.user.displayAvatarURL({ size: 128 })
  })
}

/**
 * Remove a member from the cache by ID
 */
function uncacheMemberById(memberId: string, username: string) {
  discordMemberCache.delete(username.toLowerCase())
  discordMemberDetails.delete(memberId)
}

// =====================================================
// HARMONY USER CACHE (for Discord autocomplete)
// =====================================================
interface CachedHarmonyUser {
  id: string
  username: string
  displayName: string
  avatarUrl: string | null
}
const harmonyUserCache = new Map<string, CachedHarmonyUser>()

/**
 * Fetch Harmony users for the bridged server
 * Called on startup and periodically
 */
async function refreshHarmonyUserCache() {
  console.log('🔄 Refreshing Harmony user cache...')
  
  // Check if serverId is configured
  if (!config.harmony.serverId) {
    console.error('❌ harmony.serverId not configured in bridge-config.yml!')
    console.error('   Add: serverId: "YOUR_HARMONY_SERVER_UUID" under harmony section')
    return
  }
  
  const url = `${config.harmony.apiUrl}/api/v1/servers/${config.harmony.serverId}/members?limit=1000`
  console.log(`📡 Fetching from: ${url}`)
  
  try {
    const response = await fetch(url, {
      headers: {
        'Authorization': `Bot ${config.harmony.token}`
      }
    })
    
    console.log(`📡 Response status: ${response.status}`)
    
    if (!response.ok) {
      const errorText = await response.text()
      console.error('❌ Failed to fetch Harmony users:', errorText)
      return
    }
    
    const members = await response.json() as any[]
    console.log(`📡 Received ${members.length} members from API`)
    
    harmonyUserCache.clear()
    
    for (const member of members) {
      if (member.user) {
        harmonyUserCache.set(member.user.id, {
          id: member.user.id,
          username: member.user.username || 'unknown',
          displayName: member.user.display_name || member.user.username || 'Unknown',
          avatarUrl: member.user.avatar || null
        })
      }
    }
    
    console.log(`✅ Harmony user cache: ${harmonyUserCache.size} users`)
    
    // Log first few users for debugging
    const firstUsers = Array.from(harmonyUserCache.values()).slice(0, 3)
    firstUsers.forEach(u => console.log(`   👤 ${u.displayName} (@${u.username})`))
  } catch (error) {
    console.error('❌ Error fetching Harmony users:', error)
  }
}

/**
 * Get Harmony users matching a query (for autocomplete)
 */
function searchHarmonyUsers(query: string): CachedHarmonyUser[] {
  const lowerQuery = query.toLowerCase()
  const results: CachedHarmonyUser[] = []
  
  for (const user of harmonyUserCache.values()) {
    if (
      user.username.toLowerCase().includes(lowerQuery) ||
      user.displayName.toLowerCase().includes(lowerQuery)
    ) {
      results.push(user)
      if (results.length >= 25) break // Discord autocomplete limit
    }
  }
  
  return results
}

// Track ready states for bridge data registration
let discordReady = false
let harmonyReady = false

/**
 * Register bridge data with the Harmony gateway
 * Called when both Discord and Harmony are ready
 */
function registerBridgeDataWithGateway() {
  if (!discordReady || !harmonyReady) {
    console.log(`⏳ Bridge data registration waiting: Discord=${discordReady}, Harmony=${harmonyReady}`)
    return
  }
  
  // Build channel data with members for each mapping
  const channels = config.channelMappings.map(mapping => ({
    harmonyChannelId: mapping.harmony,
    discordChannelId: mapping.discord,
    members: Array.from(discordMemberDetails.values()).map(m => ({
      id: m.id,
      username: m.username,
      displayName: m.displayName,
      avatarUrl: m.avatarUrl,
      source: 'discord' as const
    }))
  }))
  
  console.log('╔════════════════════════════════════════╗')
  console.log('║   🌉 Registering Bridge Data          ║')
  console.log('╠════════════════════════════════════════╣')
  console.log(`║   Channels: ${channels.length}`)
  console.log(`║   Discord Members: ${discordMemberDetails.size}`)
  channels.forEach(ch => {
    console.log(`║   📍 ${ch.harmonyChannelId.substring(0, 8)}... <-> Discord ${ch.discordChannelId}`)
  })
  console.log('╚════════════════════════════════════════╝')
  
  harmonyClient.registerBridgeData(channels)
}

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
    GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.GuildMembers  // Required for member cache
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
  
  // Mark Harmony as ready and register bridge data if Discord is also ready
  harmonyReady = true
  registerBridgeDataWithGateway()
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
    
    // Convert Harmony MessageParts to Discord format (with member cache for mention lookups)
    const contentText = translator.harmonyToDiscord(msg, discordMemberCache)
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
  console.log(`📝 Harmony message updated:`, { 
    id: msg.id, 
    channel_id: msg.channel_id,
    content: msg.content?.substring?.(0, 50) || JSON.stringify(msg.content_raw)?.substring(0, 50),
    metadata: msg.metadata,
    mappingExists: harmonyToDiscordMessages.has(msg.id),
    totalMappings: harmonyToDiscordMessages.size
  });
  
  // Don't bridge messages that came from Discord (prevent loops!)
  if (msg.metadata?.bridge_source === 'discord') {
    console.log('⏭️  Skipping message from Discord (preventing loop)')
    return
  }
  
  // Skip "[deleted]" edits - the MESSAGE_DELETE event will handle actual deletion
  const contentText = msg.content || ''
  const contentRaw = msg.content_raw || []
  const isDeleted = contentText === '[deleted]' || 
    (Array.isArray(contentRaw) && contentRaw.length === 1 && contentRaw[0]?.text === '[deleted]')
  
  if (isDeleted) {
    console.log('⏭️  Skipping [deleted] content - waiting for MESSAGE_DELETE event')
    return
  }
  
  // Get Discord message ID from mapping
  const discordMessageId = harmonyToDiscordMessages.get(msg.id)
  if (!discordMessageId) {
    console.log(`⚠️  No message mapping found for Harmony message ${msg.id}`)
    console.log(`   Current mappings:`, Array.from(harmonyToDiscordMessages.keys()).slice(0, 5))
    return
  }
  
  console.log(`✅ Found mapping: Harmony ${msg.id} -> Discord ${discordMessageId}`)
  
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
    
    // Convert content (with member cache for mention lookups)
    const contentText = translator.harmonyToDiscord(msg, discordMemberCache)
    
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
  console.log(`🗑️ Harmony message deleted:`, { 
    id: msg.id, 
    channel_id: msg.channel_id,
    metadata: msg.metadata,
    mappingExists: harmonyToDiscordMessages.has(msg.id),
    totalMappings: harmonyToDiscordMessages.size
  });
  
  // Don't bridge messages that came from Discord (prevent loops!)
  if (msg.metadata?.bridge_source === 'discord') {
    console.log('⏭️  Skipping message from Discord (preventing loop)')
    return
  }
  
  // Get Discord message ID from mapping
  const discordMessageId = harmonyToDiscordMessages.get(msg.id)
  if (!discordMessageId) {
    console.log(`⚠️  No message mapping found for Harmony message ${msg.id}`)
    console.log(`   Current mappings:`, Array.from(harmonyToDiscordMessages.keys()).slice(0, 5))
    return
  }
  
  console.log(`✅ Found mapping: Harmony ${msg.id} -> Discord ${discordMessageId}`)
  
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
    console.log(`🗑️ Attempting to delete Discord message ${discordMessageId} via webhook...`)
    await webhook.deleteMessage(discordMessageId)
    
    console.log(`✅ Harmony -> Discord delete SUCCESS: Message ${discordMessageId} deleted from Discord`)
    
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

discordClient.on('ready', async () => {
  console.log(`✅ Discord bot connected: ${discordClient.user?.tag}`)
  
  // Populate member cache from configured guild
  if (config.discord.guildId) {
    try {
      const guild = await discordClient.guilds.fetch(config.discord.guildId)
      console.log(`📥 Fetching members for guild: ${guild.name}`)
      
      // Fetch all members (required for proper cache population)
      const members = await guild.members.fetch()
      members.forEach(member => {
        if (!member.user.bot) {
          cacheMember(member)
        }
      })
      
      console.log(`✅ Cached ${discordMemberCache.size} Discord members for mention lookups`)
      
      // Register slash commands for this guild
      await registerSlashCommands(config.discord.guildId)
    } catch (error) {
      console.error('❌ Failed to fetch guild members:', error)
    }
  }
  
  // Fetch Harmony users for autocomplete
  await refreshHarmonyUserCache()
  
  // Refresh Harmony user cache periodically (every 5 minutes)
  setInterval(refreshHarmonyUserCache, 5 * 60 * 1000)
  
  // Mark Discord as ready and register bridge data if Harmony is also ready
  discordReady = true
  registerBridgeDataWithGateway()
})

// Keep member cache updated and re-register with gateway
discordClient.on('guildMemberAdd', (member) => {
  if (!member.user.bot) {
    cacheMember(member)
    console.log(`👋 Added member to cache: ${member.user.username}`)
    // Re-register bridge data with updated members
    registerBridgeDataWithGateway()
  }
})

discordClient.on('guildMemberRemove', (member) => {
  uncacheMemberById(member.id, member.user.username)
  console.log(`👋 Removed member from cache: ${member.user.username}`)
  // Re-register bridge data with updated members
  registerBridgeDataWithGateway()
})

discordClient.on('guildMemberUpdate', (oldMember, newMember) => {
  // Update cache if username or display name changed
  if (oldMember.user.username !== newMember.user.username || 
      oldMember.displayName !== newMember.displayName) {
    // Remove old entry
    uncacheMemberById(oldMember.id, oldMember.user.username)
    // Add new entry if not a bot
    if (!newMember.user.bot) {
      cacheMember(newMember)
    }
    // Re-register bridge data with updated members
    registerBridgeDataWithGateway()
  }
})

// =====================================================
// SLASH COMMANDS
// =====================================================

/**
 * Register slash commands with Discord
 */
async function registerSlashCommands(guildId: string) {
  // Helper to add user options to a command
  const addUserOptions = (builder: SlashCommandBuilder) => {
    return builder
      .addStringOption(option =>
        option
          .setName('user')
          .setDescription('Harmony user to mention')
          .setRequired(true)
          .setAutocomplete(true)
      )
      .addStringOption(option =>
        option
          .setName('message')
          .setDescription('Your message')
          .setRequired(false)
      )
      .addStringOption(option =>
        option
          .setName('user2')
          .setDescription('Additional user to mention')
          .setRequired(false)
          .setAutocomplete(true)
      )
      .addStringOption(option =>
        option
          .setName('user3')
          .setDescription('Additional user to mention')
          .setRequired(false)
          .setAutocomplete(true)
      )
      .addStringOption(option =>
        option
          .setName('user4')
          .setDescription('Additional user to mention')
          .setRequired(false)
          .setAutocomplete(true)
      )
      .addStringOption(option =>
        option
          .setName('user5')
          .setDescription('Additional user to mention')
          .setRequired(false)
          .setAutocomplete(true)
      )
  }
  
  const commands = [
    addUserOptions(
      new SlashCommandBuilder()
        .setName('mention')
        .setDescription('Mention Harmony user(s) with a message')
    ),
    addUserOptions(
      new SlashCommandBuilder()
        .setName('m')
        .setDescription('Quick mention Harmony user(s)')
    )
  ]

  try {
    const rest = new REST({ version: '10' }).setToken(config.discord.token)
    
    console.log('🔧 Registering slash commands...')
    
    await rest.put(
      Routes.applicationGuildCommands(discordClient.user!.id, guildId),
      { body: commands.map(cmd => cmd.toJSON()) }
    )
    
    console.log('✅ Slash commands registered: /mention, /m')
  } catch (error) {
    console.error('❌ Failed to register slash commands:', error)
  }
}

// Handle slash command interactions
discordClient.on('interactionCreate', async (interaction) => {
  // Handle autocomplete for user fields
  if (interaction.isAutocomplete()) {
    const autocomplete = interaction as AutocompleteInteraction
    const focusedOption = autocomplete.options.getFocused(true)
    
    // Handle user, user2, user3, user4, user5 autocomplete
    if (focusedOption.name.startsWith('user')) {
      const query = focusedOption.value
      console.log(`🔍 Autocomplete: "${query}", cache: ${harmonyUserCache.size}`)
      
      const matches = searchHarmonyUsers(query)
      
      await autocomplete.respond(
        matches.map(user => ({
          name: `${user.displayName} (@${user.username})`,
          value: user.id
        }))
      )
    }
    return
  }
  
  // Handle slash command execution
  if (interaction.isChatInputCommand()) {
    const command = interaction as ChatInputCommandInteraction
    
    if (command.commandName === 'mention' || command.commandName === 'm') {
      // Get all user IDs from the options
      const userIds = [
        command.options.getString('user', true),
        command.options.getString('user2', false),
        command.options.getString('user3', false),
        command.options.getString('user4', false),
        command.options.getString('user5', false)
      ].filter(Boolean) as string[]
      
      const message = command.options.getString('message', false) || ''
      
      console.log(`🔔 Slash command: users=${userIds.length}, message="${message}"`)
      
      // Get the Discord channel mapping
      const harmonyChannelId = mapper.getHarmonyChannel(command.channelId)
      if (!harmonyChannelId) {
        await command.reply({ 
          content: '❌ This channel is not bridged to Harmony.', 
          ephemeral: true 
        })
        return
      }
      
      // Build content parts: mentions first, then message
      const contentParts: any[] = []
      const mentionedUsers: CachedHarmonyUser[] = []
      
      // Add all user mentions
      for (const userId of userIds) {
        const harmonyUser = harmonyUserCache.get(userId)
        if (harmonyUser) {
          contentParts.push({
            type: 'mention',
            userId: harmonyUser.id,
            username: harmonyUser.username,
            domain: null,
            isLocal: true,
            displayName: harmonyUser.displayName
          })
          mentionedUsers.push(harmonyUser)
          console.log(`🔔 Adding mention: @${harmonyUser.username}`)
        }
      }
      
      // Add space between mentions and message if both exist
      if (mentionedUsers.length > 0 && message) {
        contentParts.push({ type: 'text', text: ' ' })
      }
      
      // Parse message for Discord emojis
      if (message) {
        const emojiRegex = /<(a?):(\w+):(\d+)>/g
        let lastIndex = 0
        let match
        
        while ((match = emojiRegex.exec(message)) !== null) {
          // Add text before emoji
          if (match.index > lastIndex) {
            contentParts.push({ type: 'text', text: message.substring(lastIndex, match.index) })
          }
          
          // Add emoji part
          const isAnimated = match[1] === 'a'
          const emojiName = match[2]
          const emojiId = match[3]
          const emojiUrl = `https://cdn.discordapp.com/emojis/${emojiId}.${isAnimated ? 'gif' : 'png'}`
          
          console.log(`🎨 Emoji: :${emojiName}: → ${emojiUrl}`)
          
          contentParts.push({
            type: 'emoji',
            emoji: {
              name: emojiName,
              url: emojiUrl,
              id: null,
              domain: 'discord.com',
              display_name: emojiName
            }
          })
          
          lastIndex = emojiRegex.lastIndex
        }
        
        // Add remaining text
        if (lastIndex < message.length) {
          contentParts.push({ type: 'text', text: message.substring(lastIndex) })
        } else if (lastIndex === 0) {
          // No emojis found, add whole message
          contentParts.push({ type: 'text', text: message })
        }
      }
      
      // Build Discord display text - extract domain from config baseUrl
      const harmonyDomain = new URL(config.harmony.baseUrl).hostname
      const mentionDisplay = mentionedUsers.map(u => `@${u.username}@${harmonyDomain}`).join(' ')
      const discordDisplayText = message ? `${mentionDisplay} ${message}` : mentionDisplay
      
      console.log(`📤 Sending ${contentParts.length} parts to Harmony`)
      
      // Get Discord user metadata for attribution
      const member = command.member as GuildMember
      const discordMetadata = {
        discord_user: {
          id: command.user.id,
          username: command.user.username,
          discriminator: command.user.discriminator,
          display_name: member?.displayName || command.user.username,
          avatar_url: command.user.displayAvatarURL({ size: 256 })
        },
        bridge_source: 'discord'
      }
      
      try {
        // Send directly to Harmony with proper mention parts
        const harmonyMsg = await harmonyClient.sendMessage(
          harmonyChannelId,
          contentParts,
          discordMetadata
        )
        
        console.log(`✅ Slash command sent to Harmony`)
        
        // Also send to Discord channel so other Discord users see it
        const webhook = await getOrCreateWebhook(command.channelId)
        if (webhook) {
          const webhookMsg = await webhook.send({
            content: discordDisplayText,
            username: (member?.displayName || command.user.username) + ' [H]',
            avatarURL: command.user.displayAvatarURL()
          })
          
          // Store message mapping
          if (harmonyMsg?.id && webhookMsg?.id) {
            discordToHarmonyMessages.set(webhookMsg.id, harmonyMsg.id)
            harmonyToDiscordMessages.set(harmonyMsg.id, webhookMsg.id)
          }
        }
        
        // Acknowledge the command
        const mentionList = mentionedUsers.map(u => `@${u.username}`).join(', ')
        await command.reply({ 
          content: `✅ Mentioned ${mentionList} in Harmony`, 
          ephemeral: true 
        })
      } catch (error: any) {
        console.error('❌ Failed to send message:', error)
        await command.reply({ 
          content: `❌ Failed to send: ${error.message}`, 
          ephemeral: true 
        })
      }
    }
  }
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

