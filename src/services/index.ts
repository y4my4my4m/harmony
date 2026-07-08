// Service-layer barrel. Pulls the local-first service classes/instances
// into one place so callers can `import { services } from '@/services'`.

import { postService } from './PostService'
import { messageService } from './MessageService'
import { interactionService } from './InteractionService'
import { profileService } from './ProfileService'
import { notificationService } from './NotificationService'
import { activityPubService } from './activityPubService'
import { roleService } from './RoleService'
import { threadService } from './ThreadService'
import { loggingService } from './LoggingService'
import { gifService } from './GifService'
import { debug } from '@/utils/debug'

// Re-export services and types. Some historical aliases (`PostServiceError`,
// `SendMessageData`, etc.) were removed when the service layer was split
// into `core/*`; the re-exports below intentionally limit themselves to the
// types that still exist on the source modules. Older imports must update.
export { postService, PostService } from './PostService'
export type { CreatePostData, UpdatePostData } from './PostService'

export { messageService, MessageService } from './MessageService'
export type { CreateChannelMessageData, CreateDMMessageData } from './MessageService'

export { interactionService, InteractionService } from './InteractionService'
export type { FollowResult, RelationshipInfo } from './InteractionService'

export { profileService, ProfileService } from './ProfileService'
export type { ProfileServiceError, ProfileData } from './ProfileService'

export { notificationService, NotificationService } from './NotificationService'
export type { 
  NotificationServiceError, 
  NotificationResult 
} from './NotificationService'

// Legacy services (to be migrated)
export { activityPubService, ActivityPubService } from './activityPubService'

// Role and permission services
export { roleService } from './RoleService'
export type { 
  ServerRole, 
  UserRole, 
  ChannelPermissionOverride,
  CreateRoleParams,
  UpdateRoleParams 
} from './RoleService'
export { Permission, PERMISSION_CATEGORIES, PERMISSION_DESCRIPTIONS } from './RoleService'

// Permissions service (uses RoleService)
export * from './permissionsService'

// Thread service
export { threadService } from './ThreadService'
export type {
  CreateThreadParams,
  UpdateThreadParams,
  ThreadWithDetails,
  ThreadMessagesResult
} from './ThreadService'

// Logging service
export { loggingService, log } from './LoggingService'
export type { LogLevel, LogCategory, LogEntry, LoggingConfig } from './LoggingService'

// GIF service
export { gifService, GifService } from './GifService'
export type { GifFavorite, FavoriteGif } from './GifService'

// Service aggregator for easy access
export const services = {
  posts: postService,
  messages: messageService,
  interactions: interactionService,
  profiles: profileService,
  notifications: notificationService,
  roles: roleService,
  threads: threadService,
  logging: loggingService,
  gifs: gifService,
  // Legacy
  activityPub: activityPubService
} as const

// DEBUG: Export debug methods (remove in production).
// Cast `messageService` to `any` because the legacy `debugConversation` and
// the older positional `loadConversationMessages(id, limit)` shape have been
// removed from the typed surface but are kept here for ad-hoc dev tooling.
export const debugServices = {
  debugConversation: (conversationId: string) => (messageService as any).debugConversation?.(conversationId),
  debugMessages: async (conversationId: string) => {
    debug.log('Manual debug for conversation:', conversationId)
    await (messageService as any).debugConversation?.(conversationId)
    try {
      const result = await (messageService as any).loadConversationMessages(conversationId, { limit: 20 })
      debug.log('Manual debug result:', result)
      return result
    } catch (error) {
      debug.error('Manual debug failed:', error)
      throw error
    }
  }
}

// Common patterns for all services
export interface ServiceError {
  code: string
  message: string
  details?: any
}

// Loading states helper
export interface LoadingState<T> {
  data: T | null
  loading: boolean
  error: ServiceError | null
}

export function createLoadingState<T>(initialData: T | null = null): LoadingState<T> {
  return {
    data: initialData,
    loading: false,
    error: null
  }
}

export function setLoading<T>(state: LoadingState<T>): LoadingState<T> {
  return {
    ...state,
    loading: true,
    error: null
  }
}

export function setSuccess<T>(state: LoadingState<T>, data: T): LoadingState<T> {
  return {
    data,
    loading: false,
    error: null
  }
}

export function setError<T>(state: LoadingState<T>, error: ServiceError): LoadingState<T> {
  return {
    ...state,
    loading: false,
    error
  }
}