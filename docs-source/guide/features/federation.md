# ActivityPub Federation

Harmony implements the ActivityPub protocol to enable federation with other social platforms like Mastodon, Pleroma, and Misskey.

## Federation Architecture

```mermaid
graph TB
    subgraph "Harmony Server"
        LOCAL_USER[Local User]
        ACTIVITYPUB_SERVICE[ActivityPub Service]
        EDGE_FUNCTIONS[Supabase Edge Functions]
        DATABASE[(Database)]
    end
    
    subgraph "Remote Servers"
        MASTODON[Mastodon]
        MISSKEY[Misskey]
        PLEROMA[Pleroma]
        OTHER[Other ActivityPub Servers]
    end
    
    LOCAL_USER --> ACTIVITYPUB_SERVICE
    ACTIVITYPUB_SERVICE --> EDGE_FUNCTIONS
    EDGE_FUNCTIONS --> DATABASE
    
    EDGE_FUNCTIONS <--> MASTODON
    EDGE_FUNCTIONS <--> MISSKEY
    EDGE_FUNCTIONS <--> PLEROMA
    EDGE_FUNCTIONS <--> OTHER
`

## ActivityPub Implementation

### Actor Model

```typescript
interface Actor {
  "@context": "https://www.w3.org/ns/activitystreams"
  type: "Person" | "Group" | "Service"
  id: string
  preferredUsername: string
  name: string
  summary: string
  inbox: string
  outbox: string
  followers: string
  following: string
  publicKey: {
    id: string
    owner: string
    publicKeyPem: string
  }
}
`

### Activity Types

```typescript
// Create Activity (for posts/messages)
interface CreateActivity {
  "@context": "https://www.w3.org/ns/activitystreams"
  type: "Create"
  id: string
  actor: string
  object: Note | Article
  to: string[]
  cc: string[]
  published: string
}

// Follow Activity
interface FollowActivity {
  type: "Follow"
  id: string
  actor: string
  object: string
}

// Like Activity (for reactions)
interface LikeActivity {
  type: "Like"
  id: string
  actor: string
  object: string
  content?: string
  "_misskey_reaction"?: string
}

// Move Activity (account migration); object is the actor, target lists it in alsoKnownAs
interface MoveActivity {
  type: "Move"
  id: string
  actor: string
  object: string
  target: string
}
`

## Message Federation

### Outgoing Messages

```typescript
// When a user sends a message to a federated channel
export async function federateMessage(message: Message) {
  const activity: CreateActivity = {
    "@context": "https://www.w3.org/ns/activitystreams",
    type: "Create",
    id: `${BASE_URL}/activities/${message.id}`,
    actor: `${BASE_URL}/users/${message.author.id}`,
    object: {
      type: "Note",
      id: `${BASE_URL}/notes/${message.id}`,
      content: message.content,
      published: message.created_at,
      to: message.visibility === 'public' ? ["https://www.w3.org/ns/activitystreams#Public"] : [],
      cc: await getFollowers(message.author.id)
    },
    to: message.visibility === 'public' ? ["https://www.w3.org/ns/activitystreams#Public"] : [],
    cc: await getFollowers(message.author.id),
    published: message.created_at
  }
  
  // Send to all federated followers
  const followers = await getFederatedFollowers(message.author.id)
  for (const follower of followers) {
    await sendActivity(follower.inbox_url, activity)
  }
}
`

### Incoming Activities

```typescript
// Edge function to handle incoming ActivityPub activities
export async function handleInboxActivity(activity: Activity) {
  switch (activity.type) {
    case 'Create':
      await handleCreateActivity(activity as CreateActivity)
      break
    case 'Follow':
      await handleFollowActivity(activity as FollowActivity)
      break
    case 'Like':
      await handleLikeActivity(activity as LikeActivity)
      break
    case 'Announce':
      await handleAnnounceActivity(activity as AnnounceActivity)
      break
  }
}

async function handleCreateActivity(activity: CreateActivity) {
  const note = activity.object
  
  // Verify the activity signature
  const isValid = await verifySignature(activity)
  if (!isValid) {
    throw new Error('Invalid signature')
  }
  
  // Store the federated message
  await supabase.from('federated_messages').insert({
    activity_id: activity.id,
    content: note.content,
    author_uri: activity.actor,
    published_at: note.published,
    original_json: activity
  })
}
`

## Reaction Federation

A post holds one favourite per person. An emoji reaction implies the reactor's favourite;
removing the last reaction removes a favourite the reaction implied, and unfavouriting
removes the person's reactions. What a delivery carries depends on the receiving
software (`federation-backend/src/activitypub/postEngagement.ts`). It is read from
`federated_instances.software`: a value an admin set is used as is; otherwise the
instance's NodeInfo, read again weekly, and failing that the actor and object documents
fetched from it (Misskey's `isCat` and `_misskey_*` terms, Pleroma and Akkoma's litepub
context, GoToSocial's namespace):

| Receiving software | Favourite | Reaction | Removing one of several reactions |
|---|---|---|---|
| Mastodon, glitch-soc, GoToSocial | `Like` | nothing | nothing |
| Misskey and forks (Sharkey, Firefish, Iceshrimp, CherryPick, ...) | bare `Like` | `Like` with `_misskey_reaction`, the newest held reaction | `Like` with the next reaction |
| Pleroma, Akkoma, Harmony, anything else | `Like` | `EmojiReact` | `Undo` of that `EmojiReact` |

Mastodon and GoToSocial drop the favourite on any `Undo Like`, and Misskey deletes the
actor's single reaction on any `Undo`, so a reaction's removal never reaches them as an
`Undo`. A Misskey delivery is built when each attempt is sent, retries included, from the
person's reactions at that moment; a retry with nothing left to send is cancelled. Unfavouriting sends `Undo` of the favourite's `Like`, and, to Pleroma-family
servers, an `Undo` of each `EmojiReact`.

Inbound, a `Like` without an emoji (or with ❤) is the favourite; a `Like` with
`_misskey_reaction` or `content`, and an `EmojiReact`, are reactions, which imply the
remote actor's favourite.

Limits: a person holds at most `max_post_reactions_per_user` (admin setting, default 10)
different emoji on a post, and a chat message holds at most 20 different emoji. Remote
reactions past either limit are dropped.

## Server Discovery

### WebFinger

```typescript
// WebFinger endpoint for user discovery
export async function handleWebFingerRequest(resource: string) {
  const username = extractUsername(resource)
  const user = await getUserByUsername(username)
  
  if (!user) {
    return new Response('Not found', { status: 404 })
  }
  
  return Response.json({
    subject: `acct:${username}@${DOMAIN}`,
    links: [
      {
        rel: "self",
        type: "application/activity+json",
        href: `${BASE_URL}/users/${user.id}`
      }
    ]
  })
}
`

### Server-to-Server Discovery

```typescript
// Discover remote servers through user interactions
async function discoverRemoteServer(actorUri: string) {
  const url = new URL(actorUri)
  const serverDomain = url.hostname
  
  // Check if we already know about this server
  let server = await getKnownServer(serverDomain)
  
  if (!server) {
    // Discover server capabilities
    const nodeInfo = await fetchNodeInfo(serverDomain)
    
    server = await createKnownServer({
      domain: serverDomain,
      software: nodeInfo.software.name,
      version: nodeInfo.software.version,
      capabilities: nodeInfo.protocols
    })
  }
  
  return server
}
`

## Security & Verification

### HTTP Signatures

```typescript
import { verifySignature } from './crypto'

export async function verifyActivitySignature(
  activity: Activity,
  signature: string,
  headers: Headers
): Promise<boolean> {
  const actor = await fetchActor(activity.actor)
  const publicKey = actor.publicKey.publicKeyPem
  
  return verifySignature({
    signature,
    headers,
    publicKey,
    method: 'POST',
    path: '/inbox'
  })
}
`

### Content Validation

```typescript
export function validateActivity(activity: Activity): boolean {
  // Check required fields
  if (!activity.type || !activity.id || !activity.actor) {
    return false
  }
  
  // Validate activity type
  const validTypes = ['Create', 'Update', 'Delete', 'Follow', 'Accept', 'Reject', 'Like', 'Announce']
  if (!validTypes.includes(activity.type)) {
    return false
  }
  
  // Additional validation based on activity type
  switch (activity.type) {
    case 'Create':
      return validateCreateActivity(activity as CreateActivity)
    case 'Follow':
      return validateFollowActivity(activity as FollowActivity)
    default:
      return true
  }
}
`

## Federation Settings

### Server Configuration

```typescript
interface FederationConfig {
  enabled: boolean
  allowList: string[]  // Allowed servers
  blockList: string[]  // Blocked servers
  autoAcceptFollows: boolean
  publicTimeline: boolean
  mediaProxyEnabled: boolean
}

export const federationConfig: FederationConfig = {
  enabled: true,
  allowList: [], // Empty = allow all
  blockList: ['spam.example'],
  autoAcceptFollows: true,
  publicTimeline: true,
  mediaProxyEnabled: true
}
`

### User Privacy Controls

```typescript
interface UserFederationSettings {
  federationEnabled: boolean
  publicProfile: boolean
  allowMentions: boolean
  allowFollows: boolean
  blockedServers: string[]
}
`

---

> 📝 **Next Steps**: Learn about [Voice Features](./voice.md) to understand voice chat implementation.