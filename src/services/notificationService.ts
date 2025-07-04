import { supabase } from '@/supabase'
import type { NotificationType } from '@/types'

// 🔔 CLEANED UP: Removed duplicate notification functions - now using NotificationOrchestrator
// Legacy broadcast system - kept for backward compatibility but simplified
export const subscribeToServerNotifications = async (userId: string, serverId: string) => {
  console.log('⚠️ subscribeToServerNotifications is deprecated - notifications now handled by NotificationOrchestrator')
  return null
}

export const unsubscribeToServerNotifications = async (userId: string, serverId: string) => {
  console.log('⚠️ unsubscribeToServerNotifications is deprecated')
}

export const broadcastInServer = async (
  event: string, 
  serverId: string, 
  data: any = {}
) => {
  console.log('⚠️ broadcastInServer is deprecated - notifications now handled by NotificationOrchestrator')
  // Keeping minimal implementation for backward compatibility
}

// Legacy function for backward compatibility
export const listenInServer = async (event: string, serverId: string) => {
  console.log('⚠️ listenInServer is deprecated, notifications are now handled automatically by NotificationOrchestrator')
}

// 🗑️ REMOVED: All duplicate notification creation functions 
// (createMentionNotification, createDMNotification, etc.)
// These are now handled by the NotificationOrchestrator which:
// - Provides consistent notification logic
// - Handles rate limiting and deduplication  
// - Triggers immediate desktop notifications
// - Integrates with service worker properly
// - Eliminates DRY violations

// The NotificationOrchestrator replaces these functions:
// ❌ createMentionNotification -> ✅ notificationOrchestrator.handleMessageEvent()
// ❌ createDMNotification -> ✅ notificationOrchestrator.handleMessageEvent() 
// ❌ createReactionNotification -> ✅ notificationOrchestrator.handleReactionEvent()
// ❌ createReplyNotification -> ✅ notificationOrchestrator.handleMessageEvent()
// ❌ createServerInviteNotification -> ✅ notificationOrchestrator.handleServerInviteEvent()
// ❌ createVoiceChannelNotification -> ✅ notificationOrchestrator.handleVoiceEvent()

// Utility functions moved to NotificationOrchestrator for better organization