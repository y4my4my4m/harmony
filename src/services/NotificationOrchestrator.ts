/**
 * NotificationOrchestrator - DEPRECATED
 * 
 * This service has been replaced by automatic database triggers.
 * All notification creation is now handled server-side via PostgreSQL triggers
 * that automatically detect events (messages, reactions, mentions) and create
 * notifications with proper business logic, DND handling, and preference checking.
 * 
 * The client-side notification store now only handles:
 * - Real-time subscription to notifications
 * - UI display (toasts, desktop notifications, sounds)
 * - Preference management
 * - Context-aware notification filtering
 * 
 * This provides a Discord-like architecture where the database handles all
 * notification business logic automatically and consistently.
 */

// This file is kept for reference but all functions are deprecated
// Remove when confident the new system is working properly

export class NotificationOrchestrator {
  // All methods deprecated - database triggers handle notification creation automatically
}