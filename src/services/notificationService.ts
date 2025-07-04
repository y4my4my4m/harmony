import { supabase } from '@/supabase'
import { useNotificationStore } from '@/stores/useNotification'
import type { NotificationType, NotificationData } from '@/types'

// Enhanced notification service with comprehensive features
export const subscribeToServerNotifications = async (userId: string, serverId: string) => {
  const channel = supabase.channel(`notificationsFromServer-${serverId}`, {
    config: {
      broadcast: { self: true },
    },
  }).subscribe()

  channel.on('broadcast', { event: 'mention' }, (payload) => {
    console.log("received mention broadcast in server:", payload)
    handleServerNotification(payload, 'mention')
  })

  channel.on('broadcast', { event: 'reaction' }, (payload) => {
    console.log("received reaction broadcast in server:", payload)
    handleServerNotification(payload, 'reaction')
  })

  channel.on('broadcast', { event: 'reply' }, (payload) => {
    console.log("received reply broadcast in server:", payload)
    handleServerNotification(payload, 'reply')
  })

  channel.on('broadcast', { event: 'server_update' }, (payload) => {
    console.log("received server update broadcast:", payload)
    handleServerNotification(payload, 'server_update')
  })

  return channel
}

export const unsubscribeToServerNotifications = async (userId: string, serverId: string) => {
  supabase.channel(`notificationsFromServer-${serverId}`).unsubscribe()
}

export const broadcastInServer = async (
  event: string, 
  serverId: string, 
  data: NotificationData = {}
) => {
  const channel = supabase.channel(`notificationsFromServer-${serverId}`)
  
  channel.send({
    type: 'broadcast',
    event,
    payload: {
      serverId,
      ...data
    }
  })
}

// Enhanced notification creation functions
export const createMentionNotification = async (
  mentionedUserId: string,
  fromUserId: string,
  messageId: string,
  serverId: string,
  channelId: string,
  messageContent: string,
  fromUsername: string,
  fromAvatarUrl?: string,
  serverName?: string,
  channelName?: string
) => {
  const notificationStore = useNotificationStore()
  
  const title = `${fromUsername} mentioned you`
  const message = `in #${channelName || 'unknown'}: ${truncateMessage(messageContent)}`
  
  const data: NotificationData = {
    message_id: messageId,
    server_id: serverId,
    channel_id: channelId,
    user_id: fromUserId,
    username: fromUsername,
    avatar_url: fromAvatarUrl,
    server_name: serverName,
    channel_name: channelName
  }

  return await notificationStore.createNotification(
    mentionedUserId,
    'mention',
    title,
    message,
    data
  )
}

export const createDMNotification = async (
  recipientUserId: string,
  fromUserId: string,
  messageId: string,
  conversationId: string,
  messageContent: string,
  fromUsername: string,
  fromAvatarUrl?: string
) => {
  const notificationStore = useNotificationStore()
  
  const title = `New message from ${fromUsername}`
  const message = truncateMessage(messageContent)
  
  const data: NotificationData = {
    message_id: messageId,
    conversation_id: conversationId,
    user_id: fromUserId,
    username: fromUsername,
    avatar_url: fromAvatarUrl
  }

  return await notificationStore.createNotification(
    recipientUserId,
    'dm',
    title,
    message,
    data
  )
}

export const createReactionNotification = async (
  messageAuthorId: string,
  fromUserId: string,
  messageId: string,
  serverId: string,
  channelId: string,
  emojiName: string,
  fromUsername: string,
  fromAvatarUrl?: string,
  serverName?: string,
  channelName?: string
) => {
  // Don't notify if user reacted to their own message
  if (messageAuthorId === fromUserId) return null
  
  const notificationStore = useNotificationStore()
  
  const title = `${fromUsername} reacted to your message`
  const message = `with ${emojiName} in #${channelName || 'unknown'}`
  
  const data: NotificationData = {
    message_id: messageId,
    server_id: serverId,
    channel_id: channelId,
    user_id: fromUserId,
    username: fromUsername,
    avatar_url: fromAvatarUrl,
    server_name: serverName,
    channel_name: channelName,
    emoji_name: emojiName
  }

  return await notificationStore.createNotification(
    messageAuthorId,
    'reaction',
    title,
    message,
    data
  )
}

export const createReplyNotification = async (
  originalMessageAuthorId: string,
  fromUserId: string,
  messageId: string,
  replyToMessageId: string,
  serverId: string,
  channelId: string,
  messageContent: string,
  fromUsername: string,
  fromAvatarUrl?: string,
  serverName?: string,
  channelName?: string
) => {
  // Don't notify if user replied to their own message
  if (originalMessageAuthorId === fromUserId) return null
  
  const notificationStore = useNotificationStore()
  
  const title = `${fromUsername} replied to your message`
  const message = `in #${channelName || 'unknown'}: ${truncateMessage(messageContent)}`
  
  const data: NotificationData = {
    message_id: messageId,
    reply_to_message_id: replyToMessageId,
    server_id: serverId,
    channel_id: channelId,
    user_id: fromUserId,
    username: fromUsername,
    avatar_url: fromAvatarUrl,
    server_name: serverName,
    channel_name: channelName
  }

  return await notificationStore.createNotification(
    originalMessageAuthorId,
    'reply',
    title,
    message,
    data
  )
}

export const createServerInviteNotification = async (
  invitedUserId: string,
  fromUserId: string,
  serverId: string,
  inviteId: string,
  serverName: string,
  fromUsername: string,
  fromAvatarUrl?: string
) => {
  const notificationStore = useNotificationStore()
  
  const title = `Server invite from ${fromUsername}`
  const message = `You've been invited to join ${serverName}`
  
  const data: NotificationData = {
    server_id: serverId,
    invite_id: inviteId,
    user_id: fromUserId,
    username: fromUsername,
    avatar_url: fromAvatarUrl,
    server_name: serverName
  }

  return await notificationStore.createNotification(
    invitedUserId,
    'server_invite',
    title,
    message,
    data
  )
}

export const createVoiceChannelNotification = async (
  userId: string,
  serverId: string,
  channelId: string,
  event: 'join' | 'leave',
  username: string,
  channelName: string,
  serverName?: string,
  avatarUrl?: string
) => {
  const notificationStore = useNotificationStore()
  
  const title = event === 'join' 
    ? `${username} joined voice chat`
    : `${username} left voice chat`
  const message = `in ${channelName}`
  
  const data: NotificationData = {
    server_id: serverId,
    channel_id: channelId,
    user_id: userId,
    username: username,
    avatar_url: avatarUrl,
    server_name: serverName,
    channel_name: channelName,
    voice_event: event
  }

  return await notificationStore.createNotification(
    userId,
    'voice_channel_activity',
    title,
    message,
    data
  )
}

export const createEmojiAddedNotification = async (
  serverMemberIds: string[],
  fromUserId: string,
  serverId: string,
  emojiId: string,
  emojiName: string,
  fromUsername: string,
  serverName: string,
  fromAvatarUrl?: string
) => {
  const notificationStore = useNotificationStore()
  
  const title = `New emoji added: :${emojiName}:`
  const message = `${fromUsername} added a new emoji to ${serverName}`
  
  const data: NotificationData = {
    server_id: serverId,
    emoji_id: emojiId,
    user_id: fromUserId,
    username: fromUsername,
    avatar_url: fromAvatarUrl,
    server_name: serverName,
    emoji_name: emojiName
  }

  // Create notification for all server members except the one who added it
  const promises = serverMemberIds
    .filter(memberId => memberId !== fromUserId)
    .map(memberId => 
      notificationStore.createNotification(
        memberId,
        'emoji_added',
        title,
        message,
        data
      )
    )

  return await Promise.all(promises)
}

// Helper function to handle incoming server notifications
const handleServerNotification = (payload: any, type: NotificationType) => {
  const notificationStore = useNotificationStore()
  
  // Extract notification data from payload
  const { serverId, to, from, content, messageId, username, avatar_url, server_name, channel_name } = payload.payload
  
  // Show toast notification for immediate feedback
  const title = getNotificationTitle(type, username)
  const message = getNotificationMessage(type, content, channel_name)
  
  notificationStore.showToast(
    type,
    title,
    message,
    4000,
    avatar_url
  )
  
  // Play sound
  notificationStore.playNotificationSound(type)
}

// Utility functions
const truncateMessage = (content: string, maxLength = 100): string => {
  if (typeof content === 'string') {
    return content.length > maxLength 
      ? content.substring(0, maxLength) + '...'
      : content
  }
  
  // Handle message parts array
  if (Array.isArray(content)) {
    const textParts = content
      .filter(part => part.type === 'text')
      .map(part => part.text)
      .join(' ')
    
    return textParts.length > maxLength 
      ? textParts.substring(0, maxLength) + '...'
      : textParts
  }
  
  return 'New message'
}

const getNotificationTitle = (type: NotificationType, username: string): string => {
  switch (type) {
    case 'mention':
      return `${username} mentioned you`
    case 'dm':
      return `New message from ${username}`
    case 'reaction':
      return `${username} reacted to your message`
    case 'reply':
      return `${username} replied to your message`
    case 'voice_channel_activity':
      return `${username} joined voice chat`
    case 'server_invite':
      return `Server invite from ${username}`
    case 'emoji_added':
      return `New emoji added`
    default:
      return 'New notification'
  }
}

const getNotificationMessage = (type: NotificationType, content?: string, channelName?: string): string => {
  const channel = channelName ? `#${channelName}` : 'channel'
  
  switch (type) {
    case 'mention':
      return `in ${channel}: ${truncateMessage(content || '')}`
    case 'dm':
      return truncateMessage(content || '')
    case 'reaction':
      return `in ${channel}`
    case 'reply':
      return `in ${channel}: ${truncateMessage(content || '')}`
    case 'voice_channel_activity':
      return `in ${channelName || 'voice channel'}`
    case 'server_invite':
      return content || 'You\'ve been invited to join a server'
    case 'emoji_added':
      return content || 'A new emoji has been added'
    default:
      return content || ''
  }
}

// Legacy function for backward compatibility
export const listenInServer = async (event: string, serverId: string) => {
  console.log('⚠️ listenInServer is deprecated, notifications are now handled automatically')
}