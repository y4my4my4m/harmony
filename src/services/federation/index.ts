/** Federation decision and server services. */
export { FederationDecisionService, federationDecisionService } from './FederationDecisionService'
export type { 
  FederationDecision, 
  FederationDecisionServiceError 
} from './FederationDecisionService'

// Handles remote server discovery, join/leave, and sync
export {
  FederationServerService,
  federationServerService,
  parseInviteUrl,
  remoteServerUuid,
} from './FederationServerService'
export type { 
  RemoteServer, 
  RemoteChannel,
  InviteInfo,
  JoinServerResult,
  LeaveServerResult,
  DiscoverServerResult,
  DirectoryServer,
  DirectoryPage,
  DirectoryPeer,
  DirectoryRefusal,
  AdvertisedServer,
  AdvertisedPage,
} from './FederationServerService'