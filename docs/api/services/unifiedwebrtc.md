# unifiedWebRTC Service

**File:** `src/services/unifiedWebRTC.ts`

## Overview

```mermaid
graph TB
    subgraph "unifiedWebRTC Service"
        USERMEDIASTATE[UserMediaState]
        USERCONNECTION[UserConnection]
        SIGNALINGMESSAGE[SignalingMessage]
        CHANNELSTATE[ChannelState]
        UNIFIEDWEBRTCSERVICE[UnifiedWebRTCService]
        UNIFIEDWEBRTC[unifiedWebRTC]
    end
    
    subgraph "Functions"
        UPDATELEVEL[updateLevel()]
    end
    
    subgraph "Interfaces"
        USERMEDIASTATE[UserMediaState]
        USERCONNECTION[UserConnection]
        SIGNALINGMESSAGE[SignalingMessage]
        CHANNELSTATE[ChannelState]
    end
```

## Exports

- **UserMediaState** - No description
- **UserConnection** - No description
- **SignalingMessage** - No description
- **ChannelState** - No description
- **UnifiedWebRTCService** - No description
- **unifiedWebRTC** - No description

## Functions

### `updateLevel()`

No description available.

**Parameters:**
None

**Returns:** Unknown

```typescript
const updateLevel = () =>
```


## Classes

### UnifiedWebRTCService

No description available.

**Methods:**
None

**Properties:**
- `channelId`
- `null`
- `currentUserId`
- `null`
- `signalChannel`
- `null`
- `localStream`
- `null`
- `localMediaState`
- `UserMediaState`
- `userId`
- `isAudioEnabled`
- `isVideoEnabled`
- `isScreenSharing`
- `isMuted`
- `isDeafened`
- `isSpeaking`
- `audioLevel`


## Interfaces

### UserMediaState

No description available.

```typescript
export interface UserMediaState {
  userId: string;
  isAudioEnabled: boolean;
  isVideoEnabled: boolean;
  isScreenSharing: boolean;
  isMuted: boolean;
  isDeafened: boolean;
  isSpeaking: boolean;
  audioLevel: number;
}
```

### UserConnection

No description available.

```typescript
export interface UserConnection {
  userId: string;
  peerConnection: RTCPeerConnection;
  mediaState: UserMediaState;
  remoteStream: MediaStream | null;
  audioElement: HTMLAudioElement | null;
  connectionState: RTCPeerConnectionState;
  iceConnectionState: RTCIceConnectionState;
}
```

### SignalingMessage

No description available.

```typescript
export interface SignalingMessage {
  type: 'offer' | 'answer' | 'ice-candidate' | 'user-joined' | 'user-left' | 'media-state' | 'state-sync';
  from: string;
  to?: string;
  data: any;
  timestamp: number;
}
```

### ChannelState

No description available.

```typescript
export interface ChannelState {
  participants: UserMediaState[];
  channelId: string;
}
```






## Source Code Insights

**File Size:** 41898 characters
**Lines of Code:** 1245
**Imports:** 2

## Usage Example

```typescript
import { UserMediaState, UserConnection, SignalingMessage, ChannelState, UnifiedWebRTCService, unifiedWebRTC } from '@/services/unifiedWebRTC.ts'

// Example usage
updateLevel()
```

---

*This documentation was automatically generated from the source code.*