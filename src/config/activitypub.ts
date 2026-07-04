import type { FederatedUser } from '@/types';

const INSTANCE_DOMAIN = import.meta.env.VITE_DOMAIN as string || (typeof window !== 'undefined' ? window.location.hostname : 'localhost');

// ActivityPub configuration for federation
export const ACTIVITYPUB_CONFIG = {
  domain: INSTANCE_DOMAIN,
  baseUrl: `https://${INSTANCE_DOMAIN}`,
  
  // Federation backend API base URL
  federationApiUrl: '/api/federation',
  
  // Federation endpoints
  endpoints: {
    webfinger: '/.well-known/webfinger',
    nodeinfo: '/.well-known/nodeinfo',
    nodeinfoVersion: '/nodeinfo/2.1',
    actor: '/users/{username}',
    inbox: '/users/{username}/inbox',
    sharedInbox: '/api/activitypub/inbox'
  },
  
  // Supabase function configuration
  supabase: {
    functions: {
      actor: 'actor',
      inbox: 'inbox', 
      webfinger: 'webfinger',
      nodeinfo: 'nodeinfo'
    }
  },
  
  // Content types
  contentTypes: {
    activityJson: 'application/activity+json',
    ldJson: 'application/ld+json; profile="https://www.w3.org/ns/activitystreams"',
    jrd: 'application/jrd+json'
  }
} as const;

// ActivityPub Actor interface
export interface ActivityPubActor {
  '@context': string | string[];
  id: string;
  type: 'Person' | 'Service' | 'Group';
  preferredUsername: string;
  name?: string;
  summary?: string;
  icon?: {
    type: 'Image';
    mediaType: string;
    url: string;
  };
  inbox: string;
  outbox: string;
  following: string;
  followers: string;
  featured?: string;
  publicKey: {
    id: string;
    owner: string;
    publicKeyPem: string;
  };
  endpoints?: {
    sharedInbox?: string;
  };
  url?: string;
}

// WebFinger response interface
export interface WebFingerResponse {
  subject: string;
  links: Array<{
    rel: string;
    type?: string;
    href: string;
  }>;
}

// NodeInfo response interface
export interface NodeInfoResponse {
  version: string;
  software: {
    name: string;
    version: string;
    repository?: string;
  };
  protocols: string[];
  services: {
    outbound: string[];
    inbound: string[];
  };
  usage: {
    users: {
      total: number;
      activeMonth: number;
      activeHalfyear: number;
    };
    localPosts: number;
    localComments: number;
  };
  openRegistrations: boolean;
  metadata: {
    nodeName: string;
    nodeDescription: string;
    maintainer?: {
      name: string;
      email: string;
    };
  };
}

// Helper to build actor URL
export function getActorUrl(username: string): string {
  return `${ACTIVITYPUB_CONFIG.baseUrl}/users/${username}`;
}

// Helper to build webfinger resource
export function getWebfingerResource(username: string): string {
  return `acct:${username}@${ACTIVITYPUB_CONFIG.domain}`;
}

// Helper to check if a URL is from our domain
export function isLocalActor(actorUrl: string): boolean {
  return actorUrl.startsWith(ACTIVITYPUB_CONFIG.baseUrl);
}

export function generateActorJson(user: FederatedUser): ActivityPubActor {
  const actorId = getActorUrl(user.username);
  
  return {
    '@context': [
      'https://www.w3.org/ns/activitystreams',
      'https://w3id.org/security/v1'
    ],
    id: actorId,
    type: 'Person',
    preferredUsername: user.username,
    name: user.display_name || user.username,
    summary: user.bio || '',
    icon: user.avatar_url ? {
      type: 'Image',
      mediaType: 'image/jpeg',
      url: user.avatar_url.startsWith('http') ? user.avatar_url : `${ACTIVITYPUB_CONFIG.baseUrl}${user.avatar_url}`
    } : undefined,
    image: (user as any).banner_url ? {
      type: 'Image',
      mediaType: 'image/jpeg',
      url: (user as any).banner_url.startsWith('http') ? (user as any).banner_url : `${ACTIVITYPUB_CONFIG.baseUrl}${(user as any).banner_url}`
    } : undefined,
    inbox: `${actorId}/inbox`,
    outbox: `${actorId}/outbox`,
    following: `${actorId}/following`,
    followers: `${actorId}/followers`,
    featured: `${actorId}/featured`,
    publicKey: {
      id: `${actorId}#main-key`,
      owner: actorId,
      publicKeyPem: user.public_key || ''
    },
    endpoints: {
      sharedInbox: `${ACTIVITYPUB_CONFIG.baseUrl}/api/activitypub/inbox`
    },
    url: `${ACTIVITYPUB_CONFIG.baseUrl}/social/profile/${user.username}`
  } as ActivityPubActor;
}

export function generateWebFingerJson(username: string): WebFingerResponse {
  const resource = getWebfingerResource(username);
  const actorUrl = getActorUrl(username);
  
  return {
    subject: resource,
    links: [
      {
        rel: 'self',
        type: 'application/activity+json',
        href: actorUrl
      },
      {
        rel: 'http://webfinger.net/rel/profile-page',
        type: 'text/html',
        href: actorUrl
      }
    ]
  };
}

export function generateNodeInfoJson(stats?: {
  userCount?: number;
  postCount?: number;
  activeMonth?: number;
  activeHalfyear?: number;
}): NodeInfoResponse {
  return {
    version: '2.1',
    software: {
      name: 'harmony',
      version: '1.0.0',
      repository: 'https://github.com/harmony-social/harmony'
    },
    protocols: ['activitypub'],
    services: {
      outbound: [],
      inbound: []
    },
    usage: {
      users: {
        total: stats?.userCount || 0,
        activeMonth: stats?.activeMonth || 0,
        activeHalfyear: stats?.activeHalfyear || 0
      },
      localPosts: stats?.postCount || 0,
      localComments: 0
    },
    openRegistrations: true,
    metadata: {
      nodeName: 'Harmony',
      nodeDescription: 'A federated social network built for meaningful connections',
      maintainer: {
        name: 'Harmony Team',
        email: `admin@${INSTANCE_DOMAIN}`
      }
    }
  };
}

export function wantsActivityPub(acceptHeader: string): boolean {
  return acceptHeader.includes('application/activity+json') || 
         acceptHeader.includes('application/ld+json');
}

export function wantsWebFinger(acceptHeader: string): boolean {
  return acceptHeader.includes('application/jrd+json') ||
         acceptHeader.includes('application/json');
}

export default ACTIVITYPUB_CONFIG;
