# unifiedVoiceChannel Store

**File:** `src/stores/unifiedVoiceChannel.ts`

## Overview

```mermaid
graph TB
    subgraph "unifiedVoiceChannel Store"
        USEUNIFIEDVOICECHANNELSTORE[useUnifiedVoiceChannelStore]
    end
    
    
    
    subgraph "Interfaces"
        VOICECHANNELSTATE[VoiceChannelState]
    end
```

## Exports

- **useUnifiedVoiceChannelStore** - No description





## Interfaces

### VoiceChannelState

No description available.

```typescript
interface VoiceChannelState {
  // Connection info
  currentChannelId: string | null;
  currentServerId: string | null;
  currentChannelName: string | null;
  isConnected: boolean;
  
  // Users and their states
  allUsers: UserMediaState[];
  localState: UserMediaState;
  
  // Streams
  localStream: MediaStream | null;
  remoteStreams: Map<string, MediaStream>;
  
  // UI state
  isOverlayVisible: boolean;
  layoutMode: 'grid' | 'speaker' | 'gallery';
}
```






## Source Code Insights

**File Size:** 20987 characters
**Lines of Code:** 641
**Imports:** 9

## Usage Example

```typescript
import { useUnifiedVoiceChannelStore } from '@/stores/unifiedVoiceChannel.ts'

// Example usage
// Use the exported functionality
```

---

*This documentation was automatically generated from the source code.*