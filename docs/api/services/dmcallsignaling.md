# DMCallSignaling Service

**File:** `src/services/DMCallSignaling.ts`

## Overview

```mermaid
graph TB
    subgraph "DMCallSignaling Service"
        CALLSIGNAL[CallSignal]
        ACTIVECALL[ActiveCall]
        DMCALLSIGNALING[dmCallSignaling]
    end
    
    subgraph "Interfaces"
        INT_CALLSIGNAL[CallSignal]
        INT_ACTIVECALL[ActiveCall]
    end
    
    subgraph "Classes"
        CLS_DMCALLSIGNALINGSERVICE[DMCallSignalingService]
    end
```


## Exports

- **CallSignal** - interface export
- **ActiveCall** - interface export
- **dmCallSignaling** - const export



## Classes

### DMCallSignalingService

No description available.

**Methods:**
- `sendSignal`
- `initiateCall`
- `sendSignalToUser`
- `handleCallTimeout`
- `acceptCall`
- `declineCall`
- `endCall`
- `joinCall`
- `leaveCall`
- `getActiveCall`
- `hasActiveCall`
- `getCallParticipants`
- `cleanup`

**Properties:**
- `channels`
- `activeCalls`
- `listeners`
- `CALL_TIMEOUT_MS`
- `conversation`
- `onSignal`
- `channelName`
- `listener`
- `exist`
- `channel`
- `event`
- `signal`
- `type`
- `from`
- `callType`
- `status`
- `payload`
- `timeout`
- `conversationId`
- `callerId`
- `receiverIds`
- `timestamp`
- `timer`
- `timeoutTimer`
- `call`
- `channelId`
- `participants`
- `startedAt`
- `tempChannel`
- `user`
- `reason`
- `userId`
- `answered`
- `undefined`
- `caller`
- `exists`
- `calls`
- `timers`


## Interfaces

### CallSignal

No description available.

```typescript
interface CallSignal {

  type: 'initiate' | 'accept' | 'decline' | 'end' | 'join' | 'leave' | 'busy' | 'timeout'
  callerId: string
  callType: 'voice' | 'video'
  timestamp: number
  conversationId: string
  reason?: 'timeout' | 'busy' | 'blocked' | 'dnd' // Decline/busy reasons

}
```

### ActiveCall

No description available.

```typescript
interface ActiveCall {

  conversationId: string
  channelId: string // dm-{conversationId}
  callType: 'voice' | 'video'
  callerId: string
  participants: string[] // user IDs currently in call
  startedAt: Date
  timeoutTimer?: number // Timer ID for call timeout

}
```








## Source Code Insights

**File Size:** 10889 characters
**Lines of Code:** 409
**Imports:** 3

## Usage Example

```typescript
import { CallSignal, ActiveCall, dmCallSignaling } from '@/services/DMCallSignaling'

// Example usage
// Use the exported functionality
```

---

*This documentation was automatically generated from the source code.*