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
        FN_UPDATELOOP[updateLoop]
    end
    
    subgraph "Interfaces"
        INT_SPATIALAUDIONODE[SpatialAudioNode]
        INT_IMPULSERESPONSECACHE[ImpulseResponseCache]
    end
    
    subgraph "Classes"
        CLS_SPATIALAUDIOSERVICE[SpatialAudioService]
    end
```


## Exports

- **SpatialAudioService** - class export
- **spatialAudioService** - const export

## Functions

### `updateLoop()`

No description available.

**Parameters:**
None

**Returns:** `Unknown`

```typescript
const updateLoop = () =>
```


## Classes

### SpatialAudioService

No description available.

**Methods:**
- `constructor`
- `initialize`
- `catch`
- `createMasterAudioChain`
- `preloadImpulseResponses`
- `setListener`
- `setupSpatialForUser`
- `createAudioProcessingChain`
- `removeUser`
- `disconnectAudioChain`
- `updateSpatialEffects`
- `resetToDefaultAudio`
- `setUserGain`
- `setUserPanning`
- `setUser3DPosition`
- `updateUserPosition`
- `startSpatialUpdates`
- `stopSpatialUpdates`
- `createPannerNode`
- `createReverbNode`
- `createImpulseResponse`
- `loadExternalImpulseResponse`
- `enableSpatialAudio`
- `disableSpatialAudio`
- `updateSettings`
- `getStatus`
- `debugAudioState`
- `destroy`

**Properties:**
- `audioContext`
- `spatialNodes`
- `destination`
- `listenerUserId`
- `isInitialized`
- `impulseResponseCache`
- `masterGainNode`
- `compressorNode`
- `optimization`
- `lastUpdateTime`
- `updateThrottleMs`
- `updates`
- `animationFrameId`
- `INITIALIZATION`
- `context`
- `latency`
- `latencyHint`
- `sampleRate`
- `chain`
- `true`
- `initialized`
- `state`
- `baseLatency`
- `outputLatency`
- `enabling`
- `spatialStore`
- `Note`
- `audio`
- `error`
- `control`
- `dynamics`
- `30`
- `knee`
- `4`
- `chains`
- `sizes`
- `roomSizes`
- `key`
- `responses`
- `MANAGEMENT`
- `calculations`
- `userId`
- `listener`
- `directly`
- `streams`
- `mediaStream`
- `check`
- `user`
- `tracks`
- `audioTracks`
- `exists`
- `source`
- `effect`
- `channelCount`
- `count`
- `monoSource`
- `splitter`
- `merger`
- `mono`
- `channel`
- `i`
- `processingChain`
- `configuration`
- `spatialNode`
- `gainNode`
- `outputGain`
- `pannerNode`
- `convolver`
- `isConnected`
- `lastGain`
- `lastPanning`
- `hasReverb`
- `pannerType`
- `effects`
- `Chain`
- `processing`
- `inputGain`
- `positioning`
- `panner`
- `reverb`
- `resources`
- `node`
- `safely`
- `tracking`
- `glitches`
- `false`
- `disconnection`
- `EFFECTS`
- `performance`
- `now`
- `enabled`
- `self`
- `listenerPos`
- `userPos`
- `set`
- `gain`
- `panning`
- `available`
- `volume`
- `pan`
- `PannerNode`
- `curves`
- `falloff`
- `dbGain`
- `linearGain`
- `distortion`
- `clampedGain`
- `clicks`
- `currentTime`
- `transitionTime`
- `responsiveness`
- `range`
- `clampedPanning`
- `dramaticPanning`
- `scaling`
- `x`
- `y`
- `z`
- `transitions`
- `browsers`
- `is`
- `space`
- `centerX`
- `overlay`
- `centerY`
- `center`
- `dx`
- `dy`
- `angle`
- `radians`
- `radius`
- `intensity`
- `minRadius`
- `maxRadius`
- `audioX`
- `audioY`
- `level`
- `audioZ`
- `angleDegrees`
- `recalculation`
- `store`
- `running`
- `updateLoop`
- `null`
- `CREATION`
- `capabilities`
- `0`
- `HRTF`
- `1`
- `settings`
- `panningModel`
- `distanceModel`
- `refDistance`
- `maxDistance`
- `rolloffFactor`
- `binauralIntensity`
- `360`
- `API`
- `fallback`
- `response`
- `one`
- `cacheKey`
- `impulseResponse`
- `length`
- `impulse`
- `ambience`
- `2`
- `channelData`
- `characteristics`
- `normalizedTime`
- `sound`
- `earlyDecay`
- `lateDecay`
- `3`
- `earlyReflection`
- `noise`
- `highFreqRolloff`
- `rolloff`
- `filteredNoise`
- `earlyComponent`
- `lateComponent`
- `variation`
- `arrayBuffer`
- `audioBuffer`
- `from`
- `METHODS`
- `initialization`
- `disconnected`
- `done`
- `nodes`
- `loop`
- `IMPORTANT`
- `HTMLAudioElement`
- `ORDER`
- `CRITICAL`
- `needed`
- `changed`
- `shouldHaveReverb`
- `undefined`
- `size`
- `newConvolver`
- `oldConvolver`
- `status`
- `isEnabled`
- `activeUsers`
- `audioContextState`
- `State`
- `Initialized`
- `Connected`
- `value`
- `type`
- `model`
- `factor`
- `distance`
- `Position`
- `stream`
- `setting`
- `positions`
- `muted`
- `connections`
- `CLEANUP`
- `userIds`
- `cache`
- `AudioContext`


## Interfaces

### SpatialAudioNode

No description available.

```typescript
interface SpatialAudioNode {

  userId: string;
  gainNode: GainNode; // Input gain
  outputGain: GainNode; // Output gain (before compressor)
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

**File Size:** 42022 characters
**Lines of Code:** 1162
**Imports:** 2

## Usage Example

```typescript
import { SpatialAudioService, spatialAudioService } from '@/services/spatialAudio'

// Example usage
updateLoop()
```

---

*This documentation was automatically generated from the source code.*