/**
 * Core Services - Pure local operations
 * 
 * Contains only local database operations with NO federation logic:
 * - Messages (CRUD, reactions, loading)
 * - Posts
 * - Profiles
 * - Interactions (follow, block, mute, etc.)
 * 
 * NO FEDERATION CONCERNS in any core service:
 * - No ap_activities insertions
 * - No federation condition checks
 * - No ActivityPub protocol handling
 * - Pure local Supabase operations only
 */

// Phase 1A: Core Message Service ✅ COMPLETED
export { CoreMessageService, coreMessageService } from './CoreMessageService'
export type { SendMessageData, CoreMessageServiceError, SendOptions } from './CoreMessageService'

// Phase 1B: Core Post Service ✅ COMPLETED
export { CorePostService, corePostService } from './CorePostService'
export type { CreatePostData, UpdatePostData, CorePostServiceError } from './CorePostService'

// Phase 1C: Core Profile Service ✅ COMPLETED (ENTERPRISE SECURITY)
export { CoreProfileService, coreProfileService } from './CoreProfileService'
export type { 
  ProfileData, 
  CoreProfileServiceError, 
  ProfileSearchOptions, 
  UserStats 
} from './CoreProfileService'

// Phase 1D: Core Interaction Service ✅ COMPLETED (ENTERPRISE SECURITY)
export { CoreInteractionService, coreInteractionService } from './CoreInteractionService'
export type { 
  FollowResult, 
  BlockResult, 
  MuteResult, 
  UserRelationship, 
  CoreInteractionServiceError, 
  BasicUser, 
  FollowRequestUser, 
  PaginatedUsers 
} from './CoreInteractionService'