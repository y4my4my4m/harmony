/** Federation decision, activity, and server services. */
export { FederationDecisionService, federationDecisionService } from './FederationDecisionService'
export type { 
  FederationDecision, 
  FederationDecisionServiceError 
} from './FederationDecisionService'

export { FederationActivityService, federationActivityService } from './FederationActivityService'
export type { 
  ActivityCreationResult, 
  FederationActivityServiceError 
} from './FederationActivityService'

// Handles remote server discovery, join/leave, and sync
export { FederationServerService, federationServerService } from './FederationServerService'
export type { 
  RemoteServer, 
  RemoteChannel,
  InviteInfo,
  JoinServerResult,
  LeaveServerResult,
  DiscoverServerResult 
} from './FederationServerService'