/**
 * Spatial Audio Service
 *
 * 2D spatial audio for WebRTC voice chat. MediaStreams feed the Web Audio
 * graph directly; no HTMLAudioElement is involved on this path.
 *
 * Per-user chain: MediaStreamSource -> inputGain -> [Convolver] -> Panner ->
 * outputGain -> Compressor -> MasterGain -> destination.
 *
 * AudioContext is created lazily by initialize(). Position updates are
 * throttled to updateThrottleMs. Reverb comes from a generated impulse
 * response, cached per room size.
 *
 * The DRY signal from the WebRTC audio elements plays whenever spatial audio
 * is disabled; disableSpatialAudio() tears down the WET graph so both are
 * never audible at once.
 *
 * Usage: initialize(), setListener(localUserId), then
 * setupSpatialForUser(userId, mediaStream) per remote user and
 * updateUserPosition(userId, x, y) on movement. destroy() releases everything.
 */

import { useSpatialAudioStore } from '@/stores/spatialAudio';
import { debug } from '@/utils/debug'

// TYPES

interface SpatialAudioNode {
  userId: string;
  gainNode: GainNode; // Input gain: spatial distance attenuation
  outputGain: GainNode; // Output gain: per-user volume, before the compressor
  pannerNode: PannerNode | StereoPannerNode;
  convolver?: ConvolverNode;
  source: MediaStreamAudioSourceNode;
  mediaStream: MediaStream;
  isConnected: boolean;
  lastGain: number;
  lastPanning: number;
}

interface ImpulseResponseCache {
  [roomSize: string]: AudioBuffer;
}

// SPATIAL AUDIO SERVICE

export class SpatialAudioService {
  private audioContext: AudioContext | null = null;
  private spatialNodes: Map<string, SpatialAudioNode> = new Map();
  private destination: AudioDestinationNode | null = null;
  private listenerUserId: string | null = null;
  private isInitialized = false;
  private impulseResponseCache: ImpulseResponseCache = {};
  private masterGainNode: GainNode | null = null;
  private compressorNode: DynamicsCompressorNode | null = null;
  
  private lastUpdateTime = 0;
  private readonly updateThrottleMs = 16; // 16ms ~= 60Hz
  private animationFrameId: number | null = null;

  // INITIALIZATION

  /**
   * Creates the AudioContext and master chain regardless of the enabled
   * setting, so toggling spatial audio does not pay context startup cost.
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) return;

    try {
      debug.log('Initializing Spatial Audio Service...');
      
      this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)({
        latencyHint: 'interactive', // Lowest latency hint for voice
        sampleRate: 48000 // Hz; matches WebRTC Opus output
      });
      
      // Autoplay policy starts the context suspended until a user gesture.
      if (this.audioContext.state === 'suspended') {
        await this.audioContext.resume();
      }
      
      await this.createMasterAudioChain();
      
      this.isInitialized = true;
      
      debug.log('Professional Spatial Audio Service initialized:', {
        sampleRate: this.audioContext.sampleRate,
        state: this.audioContext.state,
        baseLatency: this.audioContext.baseLatency,
        outputLatency: this.audioContext.outputLatency
      });
      
      const spatialStore = useSpatialAudioStore();
      if (spatialStore.settings.enableReverb) {
        await this.preloadImpulseResponses();
      }
      
      
    } catch (error) {
      debug.error('Failed to initialize spatial audio:', error);
      throw error;
    }
  }

  private async createMasterAudioChain(): Promise<void> {
    if (!this.audioContext) return;
    
    // Master gain doubles as the deafen control; see setDeafened().
    this.masterGainNode = this.audioContext.createGain();
    this.masterGainNode.gain.value = 1.0;
    
    this.compressorNode = this.audioContext.createDynamicsCompressor();
    this.compressorNode.threshold.value = -24;    // dBFS
    this.compressorNode.knee.value = 30;          // dB, soft knee
    this.compressorNode.ratio.value = 4;          // 4:1
    this.compressorNode.attack.value = 0.003;     // 3ms
    this.compressorNode.release.value = 0.25;     // 250ms
    
    // compressor -> master gain -> destination
    this.compressorNode.connect(this.masterGainNode);
    this.masterGainNode.connect(this.audioContext.destination);
    
    this.destination = this.audioContext.destination;
    
    debug.log('Master audio processing chain created with professional dynamics');
  }

  private async preloadImpulseResponses(): Promise<void> {
    if (!this.audioContext) return;
    
    const roomSizes = [0.2, 0.5, 1.0, 1.5, 2.0]; // Room size values offered by the UI
    
    try {
      for (const size of roomSizes) {
        const key = size.toString();
        this.impulseResponseCache[key] = this.createImpulseResponse(size);
      }
      debug.log('Pre-loaded impulse responses for room sizes:', roomSizes);
    } catch (error) {
      debug.warn('Failed to pre-load impulse responses:', error);
    }
  }

  // USER MANAGEMENT

  /** The listener is the local user; their own stream is never spatialized. */
  setListener(userId: string): void {
    this.listenerUserId = userId;
    debug.log('Set spatial audio listener:', userId);
  }

  /** Builds the per-user processing chain from a remote WebRTC MediaStream. */
  async setupSpatialForUser(userId: string, mediaStream: MediaStream): Promise<void> {
    if (!this.audioContext || !this.destination) {
      debug.warn('Spatial audio not initialized - call initialize() first');
      return;
    }

    // Spatializing the listener's own stream would feed back local mic audio.
    if (userId === this.listenerUserId) {
      debug.warn('Attempted to setup spatial audio for listener - skipping');
      return;
    }

    if (!mediaStream) {
      debug.warn('No media stream provided for user:', userId);
      return;
    }

    const audioTracks = mediaStream.getAudioTracks();
    if (audioTracks.length === 0) {
      debug.warn('No audio tracks in stream for user:', userId);
      return;
    }

    debug.log('Setting up professional spatial audio for user:', userId);
    
    try {
      this.removeUser(userId);

      const audioTracks = mediaStream.getAudioTracks();
      debug.log(`Stream has ${audioTracks.length} audio tracks:`);
      audioTracks.forEach((track, i) => {
        debug.log(`   Track ${i}: id=${track.id.substring(0, 8)}..., label=${track.label}, enabled=${track.enabled}, muted=${track.muted}, readyState=${track.readyState}`);
      });
      
      if (audioTracks.length === 0) {
        debug.warn('No audio tracks to process for spatial audio!');
        return;
      }
      
      const liveTracks = audioTracks.filter(t => t.readyState === 'live' && t.enabled);
      if (liveTracks.length === 0) {
        debug.warn('No live/enabled audio tracks for spatial audio!');
      }

      const source = this.audioContext.createMediaStreamSource(mediaStream);
      
      // HRTF PannerNode downmixes to mono internally. The chain forces mono at
      // inputGain so the downmix uses Web Audio's equal-power channel
      // interpretation rather than naive channel summing.
      const processingChain = await this.createAudioProcessingChain(source);
      
      const spatialNode: SpatialAudioNode = {
        userId,
        gainNode: processingChain.inputGain,
        outputGain: processingChain.outputGain,
        pannerNode: processingChain.panner,
        convolver: processingChain.convolver,
        source,
        mediaStream,
        isConnected: true,
        lastGain: 1.0,
        lastPanning: 0.0
      };

      this.spatialNodes.set(userId, spatialNode);

      // Autoplay policy can suspend the context between setup calls.
      if (this.audioContext.state === 'suspended') {
        debug.log('AudioContext was suspended, resuming...');
        await this.audioContext.resume();
      }
      debug.log('AudioContext state:', this.audioContext.state);
      
      debug.log('Professional spatial audio setup complete for user:', userId, {
        audioContextState: this.audioContext.state,
        hasReverb: !!processingChain.convolver,
        pannerType: processingChain.panner.constructor.name,
        audioTracks: audioTracks.length
      });
      
      this.updateSpatialEffects();
      
    } catch (error) {
      debug.error('Failed to setup spatial audio for user:', userId, error);
      throw error;
    }
  }

  /**
   * Chain: source -> inputGain -> [convolver] -> panner -> outputGain ->
   * compressor -> destination. The convolver is present only with reverb on.
   */
  private async createAudioProcessingChain(source: AudioNode) {
    if (!this.audioContext) throw new Error('AudioContext not available');
    
    const spatialStore = useSpatialAudioStore();
    
    // Mono downmix so the PannerNode receives consistent mono input.
    // channelInterpretation 'speakers' downmixes equal-power, so no amplitude
    // doubling.
    const inputGain = this.audioContext.createGain();
    inputGain.channelCount = 1;
    inputGain.channelCountMode = 'explicit';
    inputGain.channelInterpretation = 'speakers';
    inputGain.gain.value = 1.0;
    
    const outputGain = this.audioContext.createGain();
    outputGain.gain.value = 1.0;
    
    const panner = this.createPannerNode();
    
    let convolver: ConvolverNode | undefined;
    if (spatialStore.settings.enableReverb) {
      convolver = await this.createReverbNode(spatialStore.settings.roomSize);
    }
    
    source.connect(inputGain);
    
    if (convolver) {
      inputGain.connect(convolver);
      convolver.connect(panner);
    } else {
      inputGain.connect(panner);
    }
    
    panner.connect(outputGain);
    
    if (this.compressorNode) {
      outputGain.connect(this.compressorNode);
    } else {
      outputGain.connect(this.destination!);
    }
    
    return {
      source,
      inputGain,
      convolver,
      panner,
      outputGain
    };
  }

  removeUser(userId: string): void {
    const node = this.spatialNodes.get(userId);
    if (!node) return;

    try {
      debug.log('Removing spatial audio for user:', userId);
      
      this.disconnectAudioChain(node);
      
      this.spatialNodes.delete(userId);
      
      debug.log('Successfully removed spatial audio for user:', userId);
    } catch (error) {
      debug.error('Failed to remove spatial audio for user:', userId, error);
    }
  }

  private disconnectAudioChain(node: SpatialAudioNode): void {
    try {
      // Reverse signal order; disconnecting upstream first leaves audible tails.
      if (node.convolver) {
        node.convolver.disconnect();
      }
      
      node.pannerNode.disconnect();
      node.gainNode.disconnect();
      
      if (node.source) {
        node.source.disconnect();
      }
      
      node.isConnected = false;
    } catch (error) {
      debug.warn('Error during audio chain disconnection:', error);
    }
  }

  // SPATIAL EFFECTS

  /** Recomputes gain and position for every remote user. Throttled. */
  updateSpatialEffects(): void {
    if (!this.listenerUserId) return;

    const now = performance.now();
    if (now - this.lastUpdateTime < this.updateThrottleMs) {
      return;
    }
    this.lastUpdateTime = now;

    const spatialStore = useSpatialAudioStore();
    
    if (!spatialStore.settings.enabled) {
      this.resetToDefaultAudio();
      return;
    }
    
    this.spatialNodes.forEach((node, userId) => {
      if (userId === this.listenerUserId) return;
      
      const listenerPos = spatialStore.getUserPosition(this.listenerUserId!);
      const userPos = spatialStore.getUserPosition(userId);
      
      if (!listenerPos || !userPos) {
        // No positions: fall back to store-computed gain and stereo pan.
        const gain = spatialStore.getAudioGain(this.listenerUserId!, userId);
        const panning = spatialStore.getPanning(this.listenerUserId!, userId);
        
        if (Math.abs(gain - node.lastGain) > 0.005) {
          this.setUserGain(userId, gain);
          node.lastGain = gain;
        }
        
        if (Math.abs(panning - node.lastPanning) > 0.005) {
          this.setUserPanning(userId, panning);
          node.lastPanning = panning;
        }
        return;
      }
      
      const gain = spatialStore.getAudioGain(this.listenerUserId!, userId);
      
      // 0.005 linear gain deadband suppresses per-frame ramp scheduling.
      if (Math.abs(gain - node.lastGain) > 0.005) {
        this.setUserGain(userId, gain);
        node.lastGain = gain;
      }
      
      this.setUser3DPosition(userId, userPos.x, userPos.y);
    });
  }

  /** Flattens every node to unity gain, centre pan, position (0, 0, -1). */
  private resetToDefaultAudio(): void {
    this.spatialNodes.forEach((node, userId) => {
      this.setUserGain(userId, 1.0);
      this.setUserPanning(userId, 0.0);
      
      if (node.pannerNode instanceof PannerNode) {
        try {
          if (node.pannerNode.positionX) {
            node.pannerNode.positionX.setValueAtTime(0, this.audioContext!.currentTime);
            node.pannerNode.positionY.setValueAtTime(0, this.audioContext!.currentTime);
            node.pannerNode.positionZ.setValueAtTime(-1, this.audioContext!.currentTime);
          } else {
            node.pannerNode.setPosition(0, 0, -1);
          }
        } catch (error) {
          debug.warn('Failed to reset 3D position for user:', userId, error);
        }
      }
      
      node.lastGain = 1.0;
      node.lastPanning = 0.0;
    });
  }

  /** Applies spatial distance attenuation on inputGain. */
  private setUserGain(userId: string, gain: number): void {
    const node = this.spatialNodes.get(userId);
    if (!node || !this.audioContext || !node.isConnected) return;

    try {
      const dbGain = gain === 0 ? -Infinity : 20 * Math.log10(gain);
      const linearGain = dbGain === -Infinity ? 0 : Math.pow(10, dbGain / 20);
      
      const clampedGain = Math.max(0, Math.min(1, linearGain));
      
      const currentTime = this.audioContext.currentTime;
      // setTargetAtTime time constant, seconds. Ramping avoids clicks.
      const transitionTime = 0.05;
      
      node.gainNode.gain.setTargetAtTime(clampedGain, currentTime, transitionTime);
    } catch (error) {
      debug.error('Failed to set gain for user:', userId, error);
    }
  }

  /**
   * Per-user volume from the UI slider. Applied on outputGain so it stacks
   * with the spatial distance attenuation held on inputGain.
   * @param volume 0-200 UI scale; 100 is unity.
   */
  setUserVolume(userId: string, volume: number): void {
    const node = this.spatialNodes.get(userId);
    if (!node || !this.audioContext || !node.isConnected) return;

    try {
      const linearGain = Math.max(0, Math.min(2, volume / 100));
      const currentTime = this.audioContext.currentTime;
      node.outputGain.gain.setTargetAtTime(linearGain, currentTime, 0.05);
    } catch (error) {
      debug.error('Failed to set spatial volume for user:', userId, error);
    }
  }

  /** Legacy 1D panning path, used when no 2D positions exist. */
  private setUserPanning(userId: string, panning: number): void {
    const node = this.spatialNodes.get(userId);
    if (!node || !this.audioContext || !node.isConnected) return;

    try {
      const clampedPanning = Math.max(-1, Math.min(1, panning));
      
      // Exponent 0.6 widens the low end of the pan range.
      const dramaticPanning = Math.sign(clampedPanning) * Math.pow(Math.abs(clampedPanning), 0.6);
      
      const currentTime = this.audioContext.currentTime;
      const transitionTime = 0.05; // setTargetAtTime time constant, seconds
      
      if (node.pannerNode instanceof StereoPannerNode) {
        node.pannerNode.pan.setTargetAtTime(dramaticPanning, currentTime, transitionTime);
      } else if (node.pannerNode instanceof PannerNode) {
        // Pan mapped onto the x axis in metres; y is ear level.
        const x = dramaticPanning * 10;
        const y = 0;
        const z = -0.5; // Close to the listener, maximising L/R separation
        
        if (node.pannerNode.positionX) {
          node.pannerNode.positionX.setTargetAtTime(x, currentTime, transitionTime);
          node.pannerNode.positionY.setTargetAtTime(y, currentTime, transitionTime);
          node.pannerNode.positionZ.setTargetAtTime(z, currentTime, transitionTime);
        } else {
          // Pre-AudioParam PannerNode API; no ramping available.
          node.pannerNode.setPosition(x, y, z);
        }
      }
    } catch (error) {
      debug.error('Failed to set panning for user:', userId, error);
    }
  }

  /**
   * Places a user on a circle around the listener in the horizontal plane.
   * binauralIntensity scales the circle radius.
   */
  private setUser3DPosition(userId: string, x: number, y: number): void {
    const node = this.spatialNodes.get(userId);
    if (!node || !this.audioContext || !node.isConnected) return;
    if (!(node.pannerNode instanceof PannerNode)) return; // StereoPannerNode has no position

    try {
      const spatialStore = useSpatialAudioStore();
      
      // Screen pixels to Web Audio metres. Origin is the voice overlay centre.
      const centerX = 300; // px
      const centerY = 200; // px
      
      const dx = x - centerX;
      const dy = y - centerY;
      const angle = Math.atan2(dx, dy); // radians, 0 = directly in front of the listener
      
      // binauralIntensity 0..1 maps to the circle radius in metres.
      const intensity = spatialStore.settings.binauralIntensity;
      const minRadius = 0.5; // m
      const maxRadius = 3;   // m
      const radius = minRadius + (maxRadius - minRadius) * intensity;
      
      const audioX = Math.sin(angle) * radius; // metres, left (-) to right (+)
      const audioY = 0; // ear level
      const audioZ = -Math.cos(angle) * radius; // metres, front (-) to back (+)
      
      const currentTime = this.audioContext.currentTime;
      const transitionTime = 0.05;
      
      if (node.pannerNode.positionX) {
        node.pannerNode.positionX.setTargetAtTime(audioX, currentTime, transitionTime);
        node.pannerNode.positionY.setTargetAtTime(audioY, currentTime, transitionTime);
        node.pannerNode.positionZ.setTargetAtTime(audioZ, currentTime, transitionTime);
      } else {
        // Pre-AudioParam PannerNode API; no ramping available.
        node.pannerNode.setPosition(audioX, audioY, audioZ);
      }
      
    } catch (error) {
      debug.error('Failed to set 3D position for user:', userId, error);
    }
  }

  // POSITION MANAGEMENT

  /** x, y are voice overlay screen pixels. */
  updateUserPosition(userId: string, x: number, y: number): void {
    if (!this.isInitialized) {
      debug.warn('Spatial audio not initialized - position update ignored');
      return;
    }

    const spatialStore = useSpatialAudioStore();
    
    spatialStore.setUserPosition(userId, x, y);
    
    this.updateSpatialEffects();
    
    debug.log(`Updated position for ${userId}: (${x}, ${y})`);
  }

  /**
   * @deprecated No-op. Spatial effects update on position change, not from an
   * animation frame loop. Retained for API compatibility.
   */
  startSpatialUpdates(): void {
    debug.log('Spatial audio updates now triggered by position changes (no animation loop)');
  }

  /**
   * @deprecated Cancels animationFrameId if some caller still set one.
   * Retained for API compatibility.
   */
  stopSpatialUpdates(): void {
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
  }

  // AUDIO NODE CREATION

  private createPannerNode(): PannerNode | StereoPannerNode {
    if (!this.audioContext) throw new Error('AudioContext not initialized');

    const spatialStore = useSpatialAudioStore();
    
    // 'equalpower' uses StereoPannerNode: 1D pan, cheaper than HRTF convolution.
    if (spatialStore.settings.panningModel === 'equalpower') {
      const pannerNode = this.audioContext.createStereoPanner();
      pannerNode.pan.value = 0;
      debug.log('Created StereoPannerNode for equalpower panning');
      return pannerNode;
    }
    
    const pannerNode = this.audioContext.createPanner();
    
    // rolloffFactor 0 disables the panner's own distance attenuation.
    // updateSpatialEffects() applies distance gain on inputGain; leaving both
    // active attenuates twice and halves the output level.
    pannerNode.panningModel = 'HRTF';
    pannerNode.distanceModel = 'inverse';
    pannerNode.refDistance = 1;
    pannerNode.maxDistance = 10000;
    pannerNode.rolloffFactor = 0;
    
    debug.log('Created PannerNode with settings:', {
      panningModel: pannerNode.panningModel,
      distanceModel: pannerNode.distanceModel,
      refDistance: pannerNode.refDistance,
      maxDistance: pannerNode.maxDistance,
      rolloffFactor: pannerNode.rolloffFactor,
      binauralIntensity: spatialStore.settings.binauralIntensity
    });
    
    // Omnidirectional: full 360 degree cone, no off-axis attenuation.
    pannerNode.coneInnerAngle = 360;
    pannerNode.coneOuterAngle = 360;
    pannerNode.coneOuterGain = 1;
    
    pannerNode.setPosition(0, 0, -1);
    pannerNode.setOrientation(0, 0, -1);
    
    if (this.audioContext.listener) {
      if (this.audioContext.listener.positionX) {
        // Listener at origin, facing -Z, up +Y.
        this.audioContext.listener.positionX.value = 0;
        this.audioContext.listener.positionY.value = 0;
        this.audioContext.listener.positionZ.value = 0;
        this.audioContext.listener.forwardX.value = 0;
        this.audioContext.listener.forwardY.value = 0;
        this.audioContext.listener.forwardZ.value = -1;
        this.audioContext.listener.upX.value = 0;
        this.audioContext.listener.upY.value = 1;
        this.audioContext.listener.upZ.value = 0;
      } else {
        // Pre-AudioParam AudioListener API.
        this.audioContext.listener.setPosition(0, 0, 0);
        this.audioContext.listener.setOrientation(0, 0, -1, 0, 1, 0);
      }
    }
    
    return pannerNode;
  }

  private async createReverbNode(roomSize: number): Promise<ConvolverNode> {
    if (!this.audioContext) throw new Error('AudioContext not initialized');

    const convolver = this.audioContext.createConvolver();
    
    const cacheKey = roomSize.toString();
    let impulseResponse = this.impulseResponseCache[cacheKey];
    
    if (!impulseResponse) {
      impulseResponse = this.createImpulseResponse(roomSize);
      this.impulseResponseCache[cacheKey] = impulseResponse;
    }
    
    convolver.buffer = impulseResponse;
    convolver.normalize = true; // Equal-power normalization; keeps level constant across room sizes
    
    return convolver;
  }

  /**
   * Synthesizes a 2-channel decaying-noise impulse response. Coefficients are
   * tuned by ear for room ambience, not measured from a real space.
   */
  private createImpulseResponse(roomSize: number): AudioBuffer {
    if (!this.audioContext) throw new Error('AudioContext not initialized');

    const sampleRate = this.audioContext.sampleRate;
    const length = Math.floor(sampleRate * roomSize * 0.8); // 0.8 s of tail per unit roomSize
    const impulse = this.audioContext.createBuffer(2, length, sampleRate);
    
    for (let channel = 0; channel < 2; channel++) {
      const channelData = impulse.getChannelData(channel);
      
      for (let i = 0; i < length; i++) {
        const normalizedTime = i / length;
        
        // Larger rooms decay more steeply; late tail steeper than early.
        const earlyDecay = Math.pow(1 - normalizedTime, 2 + roomSize * 0.3);
        const lateDecay = Math.pow(1 - normalizedTime, 4 + roomSize * 0.5);
        
        // Early reflections confined to the first 3% of the tail.
        const earlyReflection = normalizedTime < 0.03 ? 
          Math.sin(normalizedTime * Math.PI * 50) * 0.2 : 0;
        
        const noise = (Math.random() * 2 - 1);
        const highFreqRolloff = 1 - normalizedTime * 0.5; // linear amplitude taper to 0.5 at the tail end
        const filteredNoise = noise * highFreqRolloff;
        
        const earlyComponent = (filteredNoise + earlyReflection) * earlyDecay * 0.15;
        const lateComponent = filteredNoise * lateDecay * 0.08;
        
        channelData[i] = (earlyComponent + lateComponent) * (channel === 0 ? 1.0 : 0.95); // right channel 5% down for stereo width
      }
    }
    
    debug.log(`Created realistic room reverb: ${length} samples, room size: ${roomSize}`);
    return impulse;
  }

  /** Loads an impulse response WAV. No caller; createImpulseResponse() is used instead. */
  private async loadExternalImpulseResponse(url: string): Promise<AudioBuffer> {
    if (!this.audioContext) throw new Error('AudioContext not initialized');
    
    try {
      const response = await fetch(url);
      const arrayBuffer = await response.arrayBuffer();
      const audioBuffer = await this.audioContext.decodeAudioData(arrayBuffer);
      
      debug.log(`Loaded external impulse response from: ${url}`);
      return audioBuffer;
    } catch (error) {
      debug.warn(`Failed to load external impulse response: ${url}`, error);
      throw error;
    }
  }

  // CONTROL METHODS

  /** Rebuilds any chain torn down by disableSpatialAudio(). */
  async enableSpatialAudio(): Promise<void> {
    debug.log('Enabling spatial audio...');
    
    if (!this.isInitialized) {
      await this.initialize();
    }
    
    const spatialStore = useSpatialAudioStore();
    
    for (const [userId, node] of this.spatialNodes) {
      if (!node.isConnected) {
        try {
          debug.log(`Reconnecting spatial audio chain for user: ${userId}`);
          
          node.source.connect(node.gainNode);
          
          if (node.convolver && spatialStore.settings.enableReverb) {
            node.gainNode.connect(node.convolver);
            node.convolver.connect(node.pannerNode);
          } else {
            node.gainNode.connect(node.pannerNode);
          }
          
          node.pannerNode.connect(node.outputGain);
          
          if (this.compressorNode) {
            node.outputGain.connect(this.compressorNode);
          } else {
            node.outputGain.connect(this.destination!);
          }
          
          node.isConnected = true;
          
        } catch (error) {
          debug.error(`Failed to reconnect spatial audio for user ${userId}:`, error);
        }
      }
    }
    
    if (spatialStore.settings.enableReverb) {
      for (const [userId, node] of this.spatialNodes) {
        if (!node.convolver) {
          try {
            const convolver = await this.createReverbNode(spatialStore.settings.roomSize);
            
            // Splice the convolver between gain and panner.
            node.gainNode.disconnect();
            node.gainNode.connect(convolver);
            convolver.connect(node.pannerNode);
            
            node.convolver = convolver;
            debug.log('Re-enabled reverb for user:', userId);
          } catch (error) {
            debug.error('Failed to re-enable reverb for user:', userId, error);
          }
        }
      }
    }
    
    this.startSpatialUpdates();
    
    this.updateSpatialEffects();
    debug.log('Spatial audio enabled - WET signal active');
  }

  /**
   * Tears down every per-user chain. Without this the WET spatial output and
   * the DRY HTMLAudioElement output both play.
   */
  disableSpatialAudio(): void {
    debug.log('Disabling spatial audio...');
    
    this.stopSpatialUpdates();
    
    this.spatialNodes.forEach((node, userId) => {
      try {
        debug.log(`Disconnecting spatial audio chain for user: ${userId}`);
        
        // Reverse signal order. outputGain goes first: that cuts the path to
        // the destination before upstream nodes are torn down.
        if (node.outputGain) {
          node.outputGain.disconnect();
        }
        
        if (node.pannerNode) {
          node.pannerNode.disconnect();
        }
        
        if (node.convolver) {
          node.convolver.disconnect();
        }
        
        if (node.gainNode) {
          node.gainNode.disconnect();
        }
        
        if (node.source) {
          node.source.disconnect();
        }
        
        node.isConnected = false;
        
      } catch (error) {
        debug.warn(`Error disconnecting spatial audio for user ${userId}:`, error);
      }
    });
    
    debug.log('Spatial audio disabled - all WET signals disconnected, DRY signal only');
  }

  /** Adds, removes or rebuilds each user's convolver to match the store. */
  async updateSettings(): Promise<void> {
    debug.log('Updating spatial audio settings...');
    
    this.updateSpatialEffects();
    
    const spatialStore = useSpatialAudioStore();
    
    for (const [userId, node] of this.spatialNodes) {
      const shouldHaveReverb = spatialStore.settings.enableReverb;
      const hasReverb = !!node.convolver;
      
      if (shouldHaveReverb && !hasReverb) {
        try {
          const convolver = await this.createReverbNode(spatialStore.settings.roomSize);
          
          // Splice the convolver between gain and panner.
          node.gainNode.disconnect();
          node.gainNode.connect(convolver);
          convolver.connect(node.pannerNode);
          
          node.convolver = convolver;
          debug.log('Added reverb for user:', userId);
        } catch (error) {
          debug.error('Failed to add reverb for user:', userId, error);
        }
      } else if (!shouldHaveReverb && hasReverb) {
        try {
          if (node.convolver) {
            node.convolver.disconnect();
            node.convolver = undefined;
          }
          
          node.gainNode.disconnect();
          node.gainNode.connect(node.pannerNode);
          
          debug.log('Removed reverb for user:', userId);
        } catch (error) {
          debug.error('Failed to remove reverb for user:', userId, error);
        }
      } else if (hasReverb && node.convolver) {
        try {
          const newConvolver = await this.createReverbNode(spatialStore.settings.roomSize);
          const oldConvolver = node.convolver;
          
          // Room size changed; swap in an impulse response for the new size.
          oldConvolver.disconnect();
          node.gainNode.disconnect();
          node.gainNode.connect(newConvolver);
          newConvolver.connect(node.pannerNode);
          
          node.convolver = newConvolver;
          debug.log('Updated reverb for user:', userId);
        } catch (error) {
          debug.error('Failed to update reverb for user:', userId, error);
        }
      }
    }
    
    debug.log('Spatial audio settings updated');
  }

  /** Deafen control: gates the master gain, leaving the graph intact. */
  setDeafened(deafened: boolean): void {
    if (!this.masterGainNode || !this.audioContext) return;
    
    const targetGain = deafened ? 0 : 1.0;
    this.masterGainNode.gain.setTargetAtTime(targetGain, this.audioContext.currentTime, 0.015);
    debug.log(`Spatial audio ${deafened ? 'deafened (gain→0)' : 'undeafened (gain→1)'}`);
  }

  getStatus(): {
    isInitialized: boolean;
    isEnabled: boolean;
    activeUsers: number;
    audioContextState: string;
  } {
    const spatialStore = useSpatialAudioStore();
    
    return {
      isInitialized: this.isInitialized,
      isEnabled: spatialStore.settings.enabled,
      activeUsers: this.spatialNodes.size,
      audioContextState: this.audioContext?.state || 'not-created'
    };
  }

  /** Console-only dump; reachable via window.spatialAudioService. */
  debugAudioState(): void {
    debug.log('Spatial Audio Debug State:');
    debug.log('- Initialized:', this.isInitialized);
    debug.log('- AudioContext state:', this.audioContext?.state || 'not-created');
    debug.log('- Active spatial nodes:', this.spatialNodes.size);
    debug.log('- Update loop running:', !!this.animationFrameId);
    debug.log('- Listener user:', this.listenerUserId);
    
    this.spatialNodes.forEach((node, userId) => {
      debug.log(`\nUser ${userId}:`);
      debug.log('  - Connected:', node.isConnected);
      debug.log('  - Has gain node:', !!node.gainNode);
      debug.log('  - Gain value:', node.gainNode?.gain.value);
      debug.log('  - Has panner:', !!node.pannerNode);
      debug.log('  - Panner type:', node.pannerNode?.constructor.name);
      
      if (node.pannerNode instanceof PannerNode) {
        debug.log('  - Panning model:', node.pannerNode.panningModel);
        debug.log('  - Distance model:', node.pannerNode.distanceModel);
        debug.log('  - Rolloff factor:', node.pannerNode.rolloffFactor);
        debug.log('  - Max distance:', node.pannerNode.maxDistance);
        debug.log('  - Position:', {
          x: node.pannerNode.positionX?.value || 0,
          y: node.pannerNode.positionY?.value || 0,
          z: node.pannerNode.positionZ?.value || 0
        });
      }
      
      debug.log('  - Has convolver:', !!node.convolver);
      debug.log('  - Has media stream:', !!node.mediaStream);
      debug.log('  - Media stream tracks:', node.mediaStream?.getTracks().length || 0);
      debug.log('  - Last gain:', node.lastGain);
      debug.log('  - Last panning:', node.lastPanning);
    });
    
    const spatialStore = useSpatialAudioStore();
    debug.log('\nSpatial Store State:');
    debug.log('- Spatial audio enabled in store:', spatialStore.settings.enabled);
    debug.log('- Panning model setting:', spatialStore.settings.panningModel);
    debug.log('- Distance model setting:', spatialStore.settings.distanceModel);
    debug.log('- Rolloff factor setting:', spatialStore.settings.rolloffFactor);
    debug.log('- Max distance setting:', spatialStore.settings.maxDistance);
    debug.log('- User positions:', Array.from(spatialStore.userPositions.entries()));
    
    debug.log('\nChecking traditional audio elements...');
    const { unifiedWebRTC } = require('@/services/unifiedWebRTC');
    const connections = unifiedWebRTC.getAllUsers();
    connections.forEach((user: any) => {
      debug.log(`- User ${user.userId}: audioElement exists?`, !!user.audioElement);
    });
  }

  // CLEANUP

  async destroy(): Promise<void> {
    debug.log('Destroying spatial audio service...');
    
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
    
    const userIds = Array.from(this.spatialNodes.keys());
    for (const userId of userIds) {
      this.removeUser(userId);
    }
    
    this.impulseResponseCache = {};
    
    if (this.compressorNode) {
      try {
        this.compressorNode.disconnect();
      } catch (error) {
        debug.warn('Error disconnecting compressor node:', error);
      }
      this.compressorNode = null;
    }
    
    if (this.masterGainNode) {
      try {
        this.masterGainNode.disconnect();
      } catch (error) {
        debug.warn('Error disconnecting master gain node:', error);
      }
      this.masterGainNode = null;
    }
    
    if (this.audioContext && this.audioContext.state !== 'closed') {
      try {
        await this.audioContext.close();
        debug.log('AudioContext closed successfully');
      } catch (error) {
        debug.warn('Error closing AudioContext:', error);
      }
    }
    
    this.audioContext = null;
    this.destination = null;
    this.listenerUserId = null;
    this.isInitialized = false;
    this.lastUpdateTime = 0;
    
    debug.log('Professional Spatial Audio Service destroyed');
  }
}

export const spatialAudioService = new SpatialAudioService();

// window handle for console inspection; nothing in the app reads it.
if (typeof window !== 'undefined') {
  (window as any).spatialAudioService = spatialAudioService;
  debug.log('spatialAudioService exposed to window for debugging');
}