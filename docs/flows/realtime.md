# Real-time Updates

## Overview

Harmony uses Supabase Realtime (built on PostgreSQL's replication) for live data delivery. The `RealtimeConnectionManager` service provides a resilient wrapper with automatic reconnection and status tracking.

## Subscription Architecture

```mermaid
graph TD
    RCM[RealtimeConnectionManager] --> CH1[Channel: messages]
    RCM --> CH2[Channel: presence]
    RCM --> CH3[Channel: notifications]
    RCM --> CH4[Channel: typing_indicators]
    RCM --> CH5[Channel: megolm_session_shares]

    CH1 --> Store1[useChat / useDM Store]
    CH2 --> Store2[userDataService]
    CH3 --> Store3[useNotification Store]
    CH4 --> Store4[TypingIndicatorService]
    CH5 --> Store5[Encryption Services]
```

## Subscribing to Tables

`RealtimeConnectionManager` provides typed subscription methods:

```mermaid
sequenceDiagram
    participant Comp as Component/Store
    participant RCM as RealtimeConnectionManager
    participant SB as Supabase Client
    participant DB as PostgreSQL

    Comp->>RCM: subscribeToTable(channel, table, filter, callbacks)
    RCM->>SB: channel.on('postgres_changes', config)
    SB->>DB: Listen on replication slot
    DB-->>SB: Row change event (INSERT/UPDATE/DELETE)
    SB-->>RCM: Callback with payload
    RCM-->>Comp: Execute registered callback
```

### Subscription Types

| Method | Use Case |
|--------|----------|
| `subscribeToTable()` | Listen for INSERT, UPDATE, DELETE on a single table |
| `subscribeToMultipleTables()` | Multiple tables on one channel |
| `subscribe()` | Legacy single-event subscription |

### Filtering

Subscriptions can filter by column values to receive only relevant events:

```typescript
manager.subscribeToTable('chat-messages', 'messages', {
  filter: `channel_id=eq.${channelId}`,
  event: 'INSERT',
  callback: (payload) => handleNewMessage(payload.new)
})
```

## Connection Lifecycle

```mermaid
stateDiagram-v2
    [*] --> disconnected
    disconnected --> connecting: subscribe()
    connecting --> connected: Success
    connecting --> error: Failure
    connected --> reconnecting: Connection lost
    reconnecting --> connected: Reconnect success
    reconnecting --> error: Max retries
    error --> connecting: Health check reset
    connected --> disconnected: unsubscribe()
```

### Per-Channel Status

Each channel tracks its own connection status:

| Status | Meaning |
|--------|---------|
| `disconnected` | Not subscribed |
| `connecting` | Initial connection attempt |
| `connected` | Actively receiving events |
| `reconnecting` | Connection lost, attempting recovery |
| `error` | Failed after max retries |

## Reconnection Strategy

```mermaid
flowchart TD
    LOST[Connection Lost] --> ATTEMPT[Reconnect attempt]
    ATTEMPT --> SUCCESS{Connected?}
    SUCCESS -->|Yes| SYNC[Resume subscriptions]
    SUCCESS -->|No| BACKOFF[Exponential backoff]
    BACKOFF --> CHECK{Max retries?}
    CHECK -->|No| WAIT["Wait (1s base, 2x factor, 30s max, 20% jitter)"]
    WAIT --> ATTEMPT
    CHECK -->|Yes| ERROR[Mark as error]
    ERROR --> HEALTH[Health check timer: 60s]
    HEALTH --> STALE{"Error > 3 min?"}
    STALE -->|Yes| RESET[Reset and retry]
    STALE -->|No| HEALTH
```

### Backoff Parameters

| Parameter | Value |
|-----------|-------|
| Base delay | 1 second |
| Max delay | 30 seconds |
| Factor | 2x |
| Max retries | 10 |
| Jitter | 20% |

### Rapid Close Detection

If 3 connections close within a short period, the manager backs off for 30 seconds to avoid overwhelming the server.

## Auth Integration

```mermaid
flowchart TD
    AUTH[Auth state change] --> EVENT{Event type?}
    EVENT -->|SIGNED_OUT| UNSUB[Unsubscribe all channels]
    EVENT -->|SIGNED_IN| RESUB[Resubscribe as needed]
    EVENT -->|TOKEN_REFRESHED| KEEP[Keep existing subscriptions]
```

On `SIGNED_OUT`, all realtime subscriptions are cleaned up immediately.

## Presence

User presence is tracked through Supabase Realtime presence channels:

```mermaid
sequenceDiagram
    participant User as User
    participant UDS as userDataService
    participant RT as Supabase Realtime
    participant Others as Other Users

    User->>UDS: Set status (online/away/dnd/invisible)
    UDS->>RT: Broadcast presence state
    RT-->>Others: Presence update
    Others->>Others: Update UI (avatar indicators)

    loop Every heartbeat interval
        UDS->>RT: Session heartbeat (keep alive)
    end
```

### Presence States

| Status | Visible to Others | Receives Notifications |
|--------|-------------------|----------------------|
| Online | Yes | Yes |
| Away | Yes (as away) | Yes |
| Do Not Disturb | Yes (as DND) | Suppressed |
| Invisible | No (appears offline) | Yes |

## Key Realtime Channels

| Channel | Table(s) | Purpose |
|---------|----------|---------|
| Chat messages | `messages` | New/edited/deleted messages in a channel |
| DM messages | `messages` | Direct message delivery |
| Notifications | `notifications` | Real-time notification delivery |
| Typing | `typing_indicators` | Typing status in channels/DMs |
| Presence | Realtime presence | Online/offline status |
| Encryption keys | `megolm_session_shares` | Key sharing for E2EE |
| Reactions | `message_reactions` | Message reaction updates |

## Monitoring

```typescript
const manager = RealtimeConnectionManager.getInstance()

// Get debug info for all channels
const debug = manager.getDebugInfo()

// Monitor specific channel status
manager.onStatusChange('my-channel', (status) => {
  console.log('Status:', status)
})

// Get current status
const status = manager.getStatus('my-channel')
```

## Health Check

A 60-second health check timer monitors long-lived error states:

- If a channel has been in `error` status for more than 3 minutes, it resets and attempts reconnection
- This handles cases where the network recovers but the subscription wasn't automatically restored

---

*See also: [Chat Message Flow](./chat) for how messages use realtime, and [Authentication Flow](./auth) for session management.*
