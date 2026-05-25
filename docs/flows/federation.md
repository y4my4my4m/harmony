# Federation Flow

## Overview

Harmony federates with other ActivityPub-compatible platforms (Mastodon, Pleroma, Misskey, etc.) through a Node.js federation backend. Local database operations trigger federation activities asynchronously via a job queue.

## Outbound Federation

```mermaid
sequenceDiagram
    participant User as User Action
    participant DB as PostgreSQL
    participant Trigger as DB Trigger
    participant Queue as BullMQ Queue
    participant FedBE as Federation Backend
    participant Remote as Remote Instance

    User->>DB: Local operation (post, follow, etc.)
    DB->>Trigger: After INSERT/UPDATE
    Trigger->>Queue: queue_federation_job(activity)
    Note over Queue: Job stored in PostgreSQL
    FedBE->>Queue: Poll for jobs
    Queue-->>FedBE: Activity payload
    FedBE->>FedBE: Build ActivityPub JSON-LD
    FedBE->>FedBE: Sign with HTTP Signatures
    FedBE->>Remote: POST to inbox
    alt Delivery success
        Remote-->>FedBE: 200/202 Accept
        FedBE->>Queue: Mark job complete
    else Delivery failure
        Remote-->>FedBE: Error/timeout
        FedBE->>Queue: Retry with backoff
    end
```

### Federated Activity Types

| Local Action | ActivityPub Activity |
|-------------|---------------------|
| Create post | `Create` → `Note` |
| Edit post | `Update` → `Note` |
| Delete post | `Delete` → `Note` |
| Follow user | `Follow` |
| Unfollow | `Undo` → `Follow` |
| Favorite | `Like` |
| Reblog | `Announce` |
| Block | `Block` |
| Reply | `Create` → `Note` (with `inReplyTo`) |

## Inbound Federation

```mermaid
sequenceDiagram
    participant Remote as Remote Instance
    participant Nginx as Nginx
    participant FedBE as Federation Backend
    participant DB as PostgreSQL

    Remote->>Nginx: POST /inbox (signed)
    Nginx->>FedBE: Forward with Signature headers
    FedBE->>FedBE: Verify HTTP Signature
    alt Signature valid
        FedBE->>FedBE: Parse ActivityPub JSON-LD
        FedBE->>FedBE: Check instance block list
        FedBE->>DB: Process activity
        FedBE-->>Remote: 202 Accepted
    else Signature invalid
        FedBE-->>Remote: 401 Unauthorized
    end
```

### Processing Inbound Activities

| Incoming Activity | Database Effect |
|------------------|-----------------|
| `Create` → `Note` | Insert into posts (federated) |
| `Follow` | Insert follow request/relationship |
| `Like` | Insert favorite |
| `Announce` | Insert reblog |
| `Delete` | Soft-delete the referenced object |
| `Undo` → `Follow` | Remove follow relationship |
| `Undo` → `Like` | Remove favorite |
| `Block` | Record block, hide content |

## Discovery

### WebFinger

```mermaid
sequenceDiagram
    participant Remote as Remote Instance
    participant Nginx as Nginx
    participant FedBE as Federation Backend
    participant DB as PostgreSQL

    Remote->>Nginx: GET /.well-known/webfinger?resource=acct:user@domain
    Nginx->>FedBE: Forward request
    FedBE->>DB: Look up user by handle
    DB-->>FedBE: Profile data
    FedBE-->>Remote: WebFinger JSON (links to actor)
```

Response includes links to the user's ActivityPub actor URL and profile page.

### NodeInfo

```mermaid
sequenceDiagram
    participant Remote as Remote Instance
    participant FedBE as Federation Backend
    participant DB as PostgreSQL

    Remote->>FedBE: GET /.well-known/nodeinfo
    FedBE-->>Remote: NodeInfo discovery (links to /nodeinfo/2.1)
    Remote->>FedBE: GET /nodeinfo/2.1
    FedBE->>DB: Count users, posts
    DB-->>FedBE: Stats
    FedBE-->>Remote: NodeInfo (software, protocols, stats)
```

### Content Negotiation

User profile URLs (`/users/{handle}`) serve different content based on the `Accept` header:

```mermaid
flowchart TD
    REQ[GET /users/alice] --> CHECK{Accept header?}
    CHECK -->|"activity+json / ld+json"| AP[Federation Backend: Actor JSON]
    CHECK -->|"text/html / other"| REDIRECT["302 → /social/profile/alice"]
```

## Server Federation (Groups)

Harmony servers are represented as ActivityPub Groups:

- Endpoint: `/servers/{id}`
- Supports Group actors with inbox/outbox
- Channel messages can be federated as group activities
- Remote users can discover and interact with server content

## Job Queue Details

### With BullMQ (`USE_BULLMQ_QUEUE=true`)

- Jobs stored in PostgreSQL (same database as application data)
- Reliable: survives server restarts
- Retry with exponential backoff on delivery failure
- `queue_federation_job()` uses `pg_notify` to bridge jobs into BullMQ

### Without BullMQ

- Database listeners process events synchronously
- Simpler but less reliable (events can be lost on restart)

## Security

- **HTTP Signatures**: All outbound requests are signed; inbound signatures are verified
- **Instance blocking**: Blocked instances (via admin panel) are rejected at the inbox
- **Instance trust**: Trusted instances get priority delivery
- **Rate limiting**: Configurable per-endpoint rate limits
- **Content sanitization**: Inbound content is sanitized before storage

---

*See also: [Authentication Flow](./auth) for user identity, and [Real-time Updates](./realtime) for how federated content reaches clients.*
