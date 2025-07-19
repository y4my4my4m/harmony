/**
 * Harmony Services - Local-first service layer
 * 
 * This provides a clean abstraction layer between the frontend and database
 * with consistent patterns:
 * - Local-first operations (immediate UI updates)
 * - Background federation (async, optional)
 * - Consistent error handling
 * - Type-safe service interfaces
 */

// Core services
export { postService, PostService } from './PostService'
export type { CreatePostData, UpdatePostData, PostServiceError } from './PostService'

export { messageService, MessageService } from './MessageService'
export type { SendMessageData, MessageServiceError } from './MessageService'

export { interactionService, InteractionService } from './InteractionService'
export type { 
  InteractionServiceError, 
  FollowResult, 
  BlockResult, 
  MuteResult 
} from './InteractionService'

// Legacy services (to be migrated)
export { activityPubService, ActivityPubService } from './activityPubService'

// Service aggregator for easy access
export const services = {
  posts: postService,
  messages: messageService,
  interactions: interactionService,
  // Legacy
  activityPub: activityPubService
} as const

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

/**
 * MIGRATION GUIDE:
 * 
 * Instead of direct Supabase calls:
 * ```ts
 * const { data, error } = await supabase.from('posts').insert(...)
 * ```
 * 
 * Use the service layer:
 * ```ts
 * import { services } from '@/services'
 * 
 * try {
 *   const post = await services.posts.createPost({
 *     content: [...],
 *     visibility: 'public'
 *   })
 * } catch (error) {
 *   // Handle error with consistent error format
 * }
 * ```
 * 
 * Benefits:
 * - Local-first operations (immediate UI updates)
 * - Background federation (async, doesn't block UI)
 * - Consistent error handling across all operations
 * - Type-safe service interfaces
 * - Easy testing and mocking
 */