/**
 * Federation Services - Clean ActivityPub federation logic
 * 
 * Contains only federation operations with NO local database operations:
 * - FederationDecisionService: "Should this federate?" logic
 * - FederationActivityService: ActivityPub activity creation and insertion
 * 
 * INTEGRATION WITH YOUR ARCHITECTURE:
 * - ✅ Works with your existing ap_activities table
 * - ✅ Uses your existing content conversion functions  
 * - ✅ Compatible with your existing edge function pipeline
 * - ✅ Respects your local-first design patterns
 * 
 * ORCHESTRATION READY:
 * - Clean separation from core services
 * - Testable federation logic
 * - Professional service patterns
 * - Ready for Phase 3 orchestration
 */

// Phase 2A: Federation Decision Service ✅ COMPLETED
export { FederationDecisionService, federationDecisionService } from './FederationDecisionService'
export type { 
  FederationDecision, 
  FederationDecisionServiceError 
} from './FederationDecisionService'

// Phase 2B: Federation Activity Service ✅ COMPLETED  
export { FederationActivityService, federationActivityService } from './FederationActivityService'
export type { 
  ActivityCreationResult, 
  FederationActivityServiceError 
} from './FederationActivityService'

// Phase 2C: Federation Server Service ✅ COMPLETED
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

// Phase 2D: Unified Federation Service (COMING IN FUTURE)
// Will orchestrate decision + activity services together
// export { FederationService, federationService } from './FederationService'