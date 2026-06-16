/** Core services: local DB operations only. */
export { CoreMessageService, coreMessageService } from './CoreMessageService'
export type { SendMessageData, CoreMessageServiceError, SendOptions } from './CoreMessageService'

export { CorePostService, corePostService } from './CorePostService'
export type { CreatePostData, UpdatePostData, CorePostServiceError } from './CorePostService'

export { CoreProfileService, coreProfileService } from './CoreProfileService'
export type { 
  ProfileData, 
  CoreProfileServiceError, 
  ProfileSearchOptions, 
  UserStats 
} from './CoreProfileService'

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