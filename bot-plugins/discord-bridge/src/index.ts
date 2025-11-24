import { Client as DiscordClient, GatewayIntentBits, Message as DiscordMessage } from 'discord.js'
import { HarmonyClient } from './HarmonyClient.js'
import { MessageTranslator } from './MessageTranslator.js'
import { ChannelMapper } from './ChannelMapper.js'
import * as dotenv from 'dotenv'

dotenv.config()

// Initialize components
const mapper = new ChannelMapper('./config/bridge-config.yml')
const config = mapper.getConfig()
const translator = new MessageTranslator()

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
  config.harmony.gatewayUrl
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
    // Translate message
    let content = translator.discordToHarmony(msg)
    
    // Add attachments if enabled
    if (config.settings.syncAttachments) {
      const attachments = translator.extractAttachments(msg)
      if (attachments.length > 0) {
        content += translator.formatAttachments(attachments)
      }
    }
    
    // Send to Harmony
    await harmonyClient.sendMessage(harmonyChannelId, content)
    console.log(`✅ Discord -> Harmony: ${msg.author.username} in #${msg.channel}`)
  } catch (error) {
    console.error('❌ Failed to bridge Discord -> Harmony:', error)
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
  discordClient.on('messageDelete', async (msg) => {
    // Similar to edits - requires message ID mapping
    console.log('🗑️ Discord message deleted (not bridged - requires ID mapping)')
  })
}

// =====================================================
// HARMONY -> DISCORD
// =====================================================

harmonyClient.on('ready', (data: any) => {
  console.log(`✅ Harmony bot connected: ${data.bot.username}`)
})

harmonyClient.on('messageCreate', async (msg: any) => {
  // Don't bridge messages from bots (including this bridge)
  if (msg.author?.id === config.harmony.token) return
  
  // Check if already from Discord (avoid loops)
  if (msg.content.includes('[Discord]')) return
  
  // Check if channel is mapped
  const discordChannelId = mapper.getDiscordChannel(msg.channel_id)
  if (!discordChannelId) return
  
  if (!mapper.shouldBridgeFromHarmony(msg.channel_id)) return
  
  try {
    // Get Discord channel
    const discordChannel = await discordClient.channels.fetch(discordChannelId) as any
    
    if (!discordChannel || !discordChannel.isTextBased()) {
      console.error('❌ Discord channel not found or not text-based')
      return
    }
    
    // Translate message
    const content = translator.harmonyToDiscord(msg)
    
    // Send to Discord
    await discordChannel.send(content)
    console.log(`✅ Harmony -> Discord: ${msg.author?.username || 'unknown'} in #${msg.channel_id}`)
  } catch (error) {
    console.error('❌ Failed to bridge Harmony -> Discord:', error)
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

