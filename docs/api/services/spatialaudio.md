# spatialAudio Service

**File:** `src/services/spatialAudio.ts`

## Overview

```mermaid
graph TB
    subgraph "spatialAudio Service"
        SPATIALAUDIOSERVICE[SpatialAudioService]
        SPATIALAUDIOSERVICE[spatialAudioService]
    end
    
    subgraph "Functions"
        UPDATELOOP[updateLoop()]
    end
    
    subgraph "Interfaces"
        SPATIALAUDIONODE[SpatialAudioNode]
        IMPULSERESPONSECACHE[ImpulseResponseCache]
    end
```

## Exports

- **SpatialAudioService** - No description
- **spatialAudioService** - No description

## Functions

### `updateLoop()`

No description available.

**Parameters:**
None

**Returns:** Unknown

```typescript
const updateLoop = () =>
```


## Classes

### SpatialAudioService

No description available.

**Methods:**
- `Map`

**Properties:**
- `audioContext`
- `null`
- `spatialNodes`
- `destination`
- `null`
- `listenerUserId`
- `null`
- `isInitialized`
- `impulseResponseCache`
- `ImpulseResponseCache`


## Interfaces

### SpatialAudioNode

No description available.

```typescript
interface SpatialAudioNode {
  userId: string;
  gainNode: GainNode;
  pannerNode: PannerNode | StereoPannerNode;
  convolver?: ConvolverNode;
  source: MediaStreamAudioSourceNode;
  mediaStream: MediaStream;
  isConnected: boolean;
  lastGain: number;
  lastPanning: number;
}
```

### ImpulseResponseCache

No description available.

```typescript
interface ImpulseResponseCache {
  [roomSize: string]: AudioBuffer;
}
```






## Source Code Insights

**File Size:** 35764 characters
**Lines of Code:** 1026
**Imports:** 1

## Usage Example

```typescript
import { SpatialAudioService, spatialAudioService } from '@/services/spatialAudio.ts'

// Example usage
updateLoop()
```

---

*This documentation was automatically generated from the source code.*