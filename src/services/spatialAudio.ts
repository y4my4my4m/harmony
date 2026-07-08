/**
 * Professional Spatial Audio Service
 * 
 * This service provides high-quality 2D spatial audio processing for WebRTC voice chat.
 * It creates an AudioContext only when spatial audio is enabled and uses MediaStreams
 * directly for optimal performance and low latency.
 * 
 * Architecture:
 * - AudioContext created on-demand (lazy initialization)
 * - Professional audio chain: MediaStreamSource → Gain → [Convolver] → Panner → MasterGain → Compressor → Destination
 * - Supports reverb via impulse response convolution
 * - Throttled position updates (~60fps) for smooth performance
 * - Clean integration with Pinia stores and WebRTC service
 * 
 * Key Features:
 * - Direct MediaStream processing (no HTMLAudioElement)
 * - Impulse response-based reverb system
 * - Distance-based attenuation and panning
 * - Professional dynamic range compression
 * - Memory efficient with proper cleanup
 * - Prevents double audio output when switching modes
 * 
 * Integration:
 * - Use spatialAudioService.initialize() before first use
 * - Call setupSpatialForUser(userId, mediaStream) for each remote user
 * - Update positions via updateUserPosition(userId, x, y)
 * - Toggle via enable/disable methods
 * - Cleanup via cleanup() when done
 * 
 * @example
 * ```typescript
 * // Initialize the service
 * await spatialAudioService.initialize();
 * spatialAudioService.setListener('currentUserId');
 * 
 * // Setup spatial audio for a remote user
 * const userStream = webrtc.getUserStream('remoteUserId');
 * spatialAudioService.setupSpatialForUser('remoteUserId', userStream);
 * 
 * // Update user position
 * spatialAudioService.updateUserPosition('remoteUserId', 100, 50);
 * ```
 */

import { useSpatialAudioStore } from '@/stores/spatialAudio';
import { debug } from '@/utils/debug'

// TYPES

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
  
  // Performance optimization
  private lastUpdateTime = 0;
  private readonly updateThrottleMs = 16; // ~60fps updates
  private animationFrameId: number | null = null;

  // INITIALIZATION

  /**
   * Initialize spatial audio system with optimized audio context
   * Creates AudioContext regardless of enabled state (for faster toggle)
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) return;

    try {
      debug.log('Initializing Spatial Audio Service...');
      
      this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)({
        latencyHint: 'interactive', // Prioritize low latency for voice chat
        sampleRate: 48000 // Standard for high-quality audio
      });
      
      // Resume context if suspended (required by browsers)
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
      
      // Pre-load impulse responses for faster reverb enabling
      const spatialStore = useSpatialAudioStore();
      if (spatialStore.settings.enableReverb) {
        await this.preloadImpulseResponses();
      }
      
      // Note: Update loop is started only when spatial audio is enabled via enableSpatialAudio()
      
    } catch (error) {
      debug.error('Failed to initialize spatial audio:', error);
      throw error;
    }
  }

  /**
   * Create professional master audio processing chain
   */
  private async createMasterAudioChain(): Promise<void> {
    if (!this.audioContext) return;
    
    // Master gain for overall volume control
    this.masterGainNode = this.audioContext.createGain();
    this.masterGainNode.gain.value = 1.0;
    
    // Compressor for professional audio dynamics
    this.compressorNode = this.audioContext.createDynamicsCompressor();
    this.compressorNode.threshold.value = -24;    // Start compression at -24dB
    this.compressorNode.knee.value = 30;          // Soft knee
    this.compressorNode.ratio.value = 4;          // 4:1 compression ratio
    this.compressorNode.attack.value = 0.003;     // Fast attack (3ms)
    this.compressorNode.release.value = 0.25;     // Medium release (250ms)
    
    // Connect the master chain: input -> compressor -> master gain -> destination
    this.compressorNode.connect(this.masterGainNode);
    this.masterGainNode.connect(this.audioContext.destination);
    
    this.destination = this.audioContext.destination;
    
    debug.log('Master audio processing chain created with professional dynamics');
  }

  /**
   * Pre-load impulse responses for different room sizes
   */
  private async preloadImpulseResponses(): Promise<void> {
    if (!this.audioContext) return;
    
    const roomSizes = [0.2, 0.5, 1.0, 1.5, 2.0]; // Different room sizes
    
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

  /**
   * Set the listener (local user) for spatial audio calculations
   */
  setListener(userId: string): void {
    this.listenerUserId = userId;
    debug.log('Set spatial audio listener:', userId);
  }

  /**
   * Setup spatial audio for a remote user using MediaStream directly
   * This creates a professional audio processing chain for WebRTC streams
   */
  async setupSpatialForUser(userId: string, mediaStream: MediaStream): Promise<void> {
    if (!this.audioContext || !this.destination) {
      debug.warn('Spatial audio not initialized - call initialize() first');
      return;
    }

    // Safety check: Don't process the listener's own stream
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

      // Create audio source directly from MediaStream (better quality than HTMLAudioElement)
      const source = this.audioContext.createMediaStreamSource(mediaStream);
      
      // PannerNode with HRTF natively downmixes to mono internally.
      // We force the input gain node to mono so the downmix happens cleanly
      // through the Web Audio API's built-in channel interpretation rules
      // (proper equal-power attenuation instead of naive channel summing).
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

      // Ensure AudioContext is running (browser autoplay policies)
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
   * Create professional audio processing chain
   * Chain: source -> input gain -> [convolver] -> panner -> output gain -> compressor -> destination
   */
  private async createAudioProcessingChain(source: AudioNode) {
    if (!this.audioContext) throw new Error('AudioContext not available');
    
    const spatialStore = useSpatialAudioStore();
    
    // Input gain for volume control before processing
    // Force mono downmix here so the PannerNode receives consistent mono input.
    // channelInterpretation 'speakers' uses equal-power downmix (no amplitude doubling).
    const inputGain = this.audioContext.createGain();
    inputGain.channelCount = 1;
    inputGain.channelCountMode = 'explicit';
    inputGain.channelInterpretation = 'speakers';
    inputGain.gain.value = 1.0;
    
    // Output gain for final volume control
    const outputGain = this.audioContext.createGain();
    outputGain.gain.value = 1.0;
    
    const panner = this.createPannerNode();
    
    // Optional convolver for reverb
    let convolver: ConvolverNode | undefined;
    if (spatialStore.settings.enableReverb) {
      convolver = await this.createReverbNode(spatialStore.settings.roomSize);
    }
    
    // Connect the processing chain
    source.connect(inputGain);
    
    if (convolver) {
      // With reverb: source -> input gain -> convolver -> panner -> output gain -> compressor
      inputGain.connect(convolver);
      convolver.connect(panner);
    } else {
      // Without reverb: source -> input gain -> panner -> output gain -> compressor
      inputGain.connect(panner);
    }
    
    panner.connect(outputGain);
    
    // Connect to compressor if available, otherwise directly to destination
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

  /**
   * Remove user from spatial audio and cleanup resources
   */
  removeUser(userId: string): void {
    const node = this.spatialNodes.get(userId);
    if (!node) return;

    try {
      debug.log('Removing spatial audio for user:', userId);
      
      // Disconnect all audio nodes safely
      this.disconnectAudioChain(node);
      
      this.spatialNodes.delete(userId);
      
      debug.log('Successfully removed spatial audio for user:', userId);
    } catch (error) {
      debug.error('Failed to remove spatial audio for user:', userId, error);
    }
  }

  /**
   * Safely disconnect audio processing chain
   */
  private disconnectAudioChain(node: SpatialAudioNode): void {
    try {
      // Disconnect in reverse order to avoid audio glitches
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

  /**
   * Update spatial effects for all users with optimized performance
   */
  updateSpatialEffects(): void {
    if (!this.listenerUserId) return;

    // Throttle updates for performance
    const now = performance.now();
    if (now - this.lastUpdateTime < this.updateThrottleMs) {
      return;
    }
    this.lastUpdateTime = now;

    const spatialStore = useSpatialAudioStore();
    
    // Only apply spatial effects if enabled
    if (!spatialStore.settings.enabled) {
      this.resetToDefaultAudio();
      return;
    }
    
    this.spatialNodes.forEach((node, userId) => {
      if (userId === this.listenerUserId) return; // Skip self
      
      const listenerPos = spatialStore.getUserPosition(this.listenerUserId!);
      const userPos = spatialStore.getUserPosition(userId);
      
      if (!listenerPos || !userPos) {
        // Fallback to legacy panning if no positions set
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
      
      // Use proper 3D positioning when positions are available
      const gain = spatialStore.getAudioGain(this.listenerUserId!, userId);
      
      // Only update if values changed significantly (performance optimization)
      if (Math.abs(gain - node.lastGain) > 0.005) {
        this.setUserGain(userId, gain);
        node.lastGain = gain;
      }
      
      // Set 3D position directly instead of just panning
      this.setUser3DPosition(userId, userPos.x, userPos.y);
    });
  }

  /**
   * Reset all audio to default (no spatial effects)
   */
  private resetToDefaultAudio(): void {
    this.spatialNodes.forEach((node, userId) => {
      this.setUserGain(userId, 1.0); // Full volume
      this.setUserPanning(userId, 0.0); // Center pan
      
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

  /**
   * Set user gain with smooth transitions and professional audio curves
   */
  private setUserGain(userId: string, gain: number): void {
    const node = this.spatialNodes.get(userId);
    if (!node || !this.audioContext || !node.isConnected) return;

    try {
      const dbGain = gain === 0 ? -Infinity : 20 * Math.log10(gain);
      const linearGain = dbGain === -Infinity ? 0 : Math.pow(10, dbGain / 20);
      
      // Clamp gain to prevent audio distortion
      const clampedGain = Math.max(0, Math.min(1, linearGain));
      
      // Smooth gain transition to avoid audio clicks
      const currentTime = this.audioContext.currentTime;
      const transitionTime = 0.05; // 50ms transition for responsiveness
      
      node.gainNode.gain.setTargetAtTime(clampedGain, currentTime, transitionTime);
    } catch (error) {
      debug.error('Failed to set gain for user:', userId, error);
    }
  }

  /**
   * Set per-user volume (from the UI volume slider).
   * Applied on outputGain so it stacks with spatial distance attenuation
   * without conflicting with the inputGain used for spatial effects.
   * @param volume 0-200, where 100 is normal (matches the UI scale)
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

  /**
   * Set user panning with smooth transitions and accurate spatial positioning
   */
  private setUserPanning(userId: string, panning: number): void {
    const node = this.spatialNodes.get(userId);
    if (!node || !this.audioContext || !node.isConnected) return;

    try {
      // Clamp panning to valid range
      const clampedPanning = Math.max(-1, Math.min(1, panning));
      
      const dramaticPanning = Math.sign(clampedPanning) * Math.pow(Math.abs(clampedPanning), 0.6);
      
      const currentTime = this.audioContext.currentTime;
      const transitionTime = 0.05; // 50ms transition for responsiveness
      
      if (node.pannerNode instanceof StereoPannerNode) {
        // Simple stereo panning for 2D spatial audio with dramatic effect
        node.pannerNode.pan.setTargetAtTime(dramaticPanning, currentTime, transitionTime);
      } else if (node.pannerNode instanceof PannerNode) {
        // 3D positioning mapped to 2D space with aggressive scaling
        const x = dramaticPanning * 10; // Scale up for more dramatic effect
        const y = 0;
        const z = -0.5; // Very close to listener for maximum panning
        
        // Use smooth position transitions
        if (node.pannerNode.positionX) {
          node.pannerNode.positionX.setTargetAtTime(x, currentTime, transitionTime);
          node.pannerNode.positionY.setTargetAtTime(y, currentTime, transitionTime);
          node.pannerNode.positionZ.setTargetAtTime(z, currentTime, transitionTime);
        } else {
          // Fallback for older browsers
          node.pannerNode.setPosition(x, y, z);
        }
      }
    } catch (error) {
      debug.error('Failed to set panning for user:', userId, error);
    }
  }

  /**
   * Set user 3D position directly (more accurate than panning alone)
   * Positions users on a circle around listener for binaural audio effect
   * The binauralIntensity setting controls how dramatic the effect is
   */
  private setUser3DPosition(userId: string, x: number, y: number): void {
    const node = this.spatialNodes.get(userId);
    if (!node || !this.audioContext || !node.isConnected) return;
    if (!(node.pannerNode instanceof PannerNode)) return; // Only works with PannerNode

    try {
      const spatialStore = useSpatialAudioStore();
      
      // Convert 2D screen coordinates to 3D audio space
      // Position users on a CIRCLE around listener for binaural audio
      const centerX = 300; // Center of typical voice overlay
      const centerY = 200;
      
      const dx = x - centerX;
      const dy = y - centerY;
      const angle = Math.atan2(dx, dy); // Angle in radians
      
      // Binaural intensity controls the radius (0.0 = center/subtle, 1.0 = far/dramatic)
      // Smaller radius = more subtle positional effect
      // Larger radius = more dramatic left/right separation
      const intensity = spatialStore.settings.binauralIntensity;
      const minRadius = 0.5; // At 0 intensity, very close (subtle)
      const maxRadius = 3;   // At 1.0 intensity, far (dramatic)
      const radius = minRadius + (maxRadius - minRadius) * intensity;
      
      const audioX = Math.sin(angle) * radius; // Left (-) to Right (+)
      const audioY = 0; // Keep at ear level
      const audioZ = -Math.cos(angle) * radius; // Front (-) to Back (+)
      
      const currentTime = this.audioContext.currentTime;
      const transitionTime = 0.05;
      
      if (node.pannerNode.positionX) {
        node.pannerNode.positionX.setTargetAtTime(audioX, currentTime, transitionTime);
        node.pannerNode.positionY.setTargetAtTime(audioY, currentTime, transitionTime);
        node.pannerNode.positionZ.setTargetAtTime(audioZ, currentTime, transitionTime);
      } else {
        // Fallback for older browsers
        node.pannerNode.setPosition(audioX, audioY, audioZ);
      }
      
      // Note: Removed per-frame debug logging for performance
      // Uncomment for debugging: debug.log(`Set binaural position for ${userId}: angle ${(angle * 180 / Math.PI).toFixed(0)}°`);
    } catch (error) {
      debug.error('Failed to set 3D position for user:', userId, error);
    }
  }

  // POSITION MANAGEMENT

  /**
   * Update user position and trigger spatial effects recalculation
   */
  updateUserPosition(userId: string, x: number, y: number): void {
    if (!this.isInitialized) {
      debug.warn('Spatial audio not initialized - position update ignored');
      return;
    }

    const spatialStore = useSpatialAudioStore();
    
    spatialStore.setUserPosition(userId, x, y);
    
    // Immediately trigger spatial effects update for responsive positioning
    this.updateSpatialEffects();
    
    debug.log(`Updated position for ${userId}: (${x}, ${y})`);
  }

  /**
   * @deprecated Animation frame loop removed for performance.
   * Spatial effects are now updated only when positions change.
   * Kept for API compatibility but does nothing.
   */
  startSpatialUpdates(): void {
    // No-op: We no longer use an animation frame loop.
    // Spatial effects are updated on-demand when positions change.
    debug.log('Spatial audio updates now triggered by position changes (no animation loop)');
  }

  /**
   * @deprecated Animation frame loop removed for performance.
   * Kept for API compatibility but does nothing.
   */
  stopSpatialUpdates(): void {
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
  }

  // AUDIO NODE CREATION

  /**
   * Create optimized panner node based on settings and browser capabilities
   */
  private createPannerNode(): PannerNode | StereoPannerNode {
    if (!this.audioContext) throw new Error('AudioContext not initialized');

    const spatialStore = useSpatialAudioStore();
    
    // Use StereoPannerNode for simple 2D panning (more efficient and widely supported)
    if (spatialStore.settings.panningModel === 'equalpower') {
      const pannerNode = this.audioContext.createStereoPanner();
      pannerNode.pan.value = 0; // Start at center
      debug.log('Created StereoPannerNode for equalpower panning');
      return pannerNode;
    }
    
    // Use PannerNode for advanced spatial positioning with HRTF
    const pannerNode = this.audioContext.createPanner();
    
    // Configure panner using settings from store.
    // Distance attenuation is handled manually via the inputGain node in
    // updateSpatialEffects(), so disable the PannerNode's own distance model
    // to avoid double-attenuation (which was cutting volume to ~50%).
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
    
    // Optimize for 2D audio (omnidirectional cone)
    pannerNode.coneInnerAngle = 360;
    pannerNode.coneOuterAngle = 360;
    pannerNode.coneOuterGain = 1;
    
    pannerNode.setPosition(0, 0, -1);
    pannerNode.setOrientation(0, 0, -1);
    
    if (this.audioContext.listener) {
      if (this.audioContext.listener.positionX) {
        // Modern API
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
        // Legacy API fallback
        this.audioContext.listener.setPosition(0, 0, 0);
        this.audioContext.listener.setOrientation(0, 0, -1, 0, 1, 0);
      }
    }
    
    return pannerNode;
  }

  /**
   * Create high-quality convolver node with cached impulse response
   */
  private async createReverbNode(roomSize: number): Promise<ConvolverNode> {
    if (!this.audioContext) throw new Error('AudioContext not initialized');

    const convolver = this.audioContext.createConvolver();
    
    // Use cached impulse response or create new one
    const cacheKey = roomSize.toString();
    let impulseResponse = this.impulseResponseCache[cacheKey];
    
    if (!impulseResponse) {
      impulseResponse = this.createImpulseResponse(roomSize);
      this.impulseResponseCache[cacheKey] = impulseResponse;
    }
    
    convolver.buffer = impulseResponse;
    convolver.normalize = true; // Normalize for consistent volume
    
    return convolver;
  }

  /**
   * Create professional impulse response for realistic reverb
   * Optimized for realistic room ambience rather than dramatic effects
   */
  private createImpulseResponse(roomSize: number): AudioBuffer {
    if (!this.audioContext) throw new Error('AudioContext not initialized');

    const sampleRate = this.audioContext.sampleRate;
    const length = Math.floor(sampleRate * roomSize * 0.8); // Reduced from 1.5 for shorter, more natural reverb
    const impulse = this.audioContext.createBuffer(2, length, sampleRate);
    
    for (let channel = 0; channel < 2; channel++) {
      const channelData = impulse.getChannelData(channel);
      
      for (let i = 0; i < length; i++) {
        const normalizedTime = i / length;
        
        // Gentler decay for natural room sound
        const earlyDecay = Math.pow(1 - normalizedTime, 2 + roomSize * 0.3); // Reduced from 1.5
        const lateDecay = Math.pow(1 - normalizedTime, 4 + roomSize * 0.5); // Reduced from 3
        
        // Subtle early reflections for room ambience
        const earlyReflection = normalizedTime < 0.03 ? 
          Math.sin(normalizedTime * Math.PI * 50) * 0.2 : 0; // Reduced from 0.4
        
        const noise = (Math.random() * 2 - 1);
        const highFreqRolloff = 1 - normalizedTime * 0.5; // More natural rolloff
        const filteredNoise = noise * highFreqRolloff;
        
        // Combine components with subtle reverb characteristics (more realistic)
        const earlyComponent = (filteredNoise + earlyReflection) * earlyDecay * 0.15; // Reduced from 0.3
        const lateComponent = filteredNoise * lateDecay * 0.08; // Reduced from 0.15
        
        channelData[i] = (earlyComponent + lateComponent) * (channel === 0 ? 1.0 : 0.95); // Slight stereo variation
      }
    }
    
    debug.log(`Created realistic room reverb: ${length} samples, room size: ${roomSize}`);
    return impulse;
  }

  /**
   * Load external impulse response file for professional reverb (optional enhancement)
   */
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

  /**
   * Enable spatial audio effects with proper initialization
   * Reconnects spatial audio nodes if they were disconnected
   */
  async enableSpatialAudio(): Promise<void> {
    debug.log('Enabling spatial audio...');
    
    if (!this.isInitialized) {
      await this.initialize();
    }
    
    const spatialStore = useSpatialAudioStore();
    
    // Reconnect any disconnected spatial audio nodes
    for (const [userId, node] of this.spatialNodes) {
      if (!node.isConnected) {
        try {
          debug.log(`Reconnecting spatial audio chain for user: ${userId}`);
          
          // Reconnect the audio chain
          node.source.connect(node.gainNode);
          
          if (node.convolver && spatialStore.settings.enableReverb) {
            node.gainNode.connect(node.convolver);
            node.convolver.connect(node.pannerNode);
          } else {
            node.gainNode.connect(node.pannerNode);
          }
          
          // Reconnect panner to outputGain
          node.pannerNode.connect(node.outputGain);
          
          // Reconnect outputGain to compressor/destination
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
    
    // Re-enable or update reverb for existing users if reverb is enabled
    if (spatialStore.settings.enableReverb) {
      for (const [userId, node] of this.spatialNodes) {
        if (!node.convolver) {
          try {
            const convolver = await this.createReverbNode(spatialStore.settings.roomSize);
            
            // Reconnect audio graph with reverb
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
   * Disable spatial audio effects (reset to normal audio)
   * Disconnects all spatial audio nodes to prevent double audio (dry + wet)
   */
  disableSpatialAudio(): void {
    debug.log('Disabling spatial audio...');
    
    this.stopSpatialUpdates();
    
    // Disconnect ALL spatial audio nodes to prevent hearing WET signal
    // When disabled, only the DRY signal from HTMLAudioElement should play
    this.spatialNodes.forEach((node, userId) => {
      try {
        debug.log(`Disconnecting spatial audio chain for user: ${userId}`);
        
        // Disconnect the entire audio chain IN REVERSE ORDER
        // Disconnect outputGain first - this cuts off audio to destination!
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

  /**
   * Update settings and recreate audio nodes as needed
   */
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
          
          // Reconnect audio graph with reverb
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
          
          // Reconnect audio graph without reverb
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
          
          // Replace convolver in the chain
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

  /**
   * Mute/unmute the entire spatial audio output (used by deafen)
   */
  setDeafened(deafened: boolean): void {
    if (!this.masterGainNode || !this.audioContext) return;
    
    const targetGain = deafened ? 0 : 1.0;
    this.masterGainNode.gain.setTargetAtTime(targetGain, this.audioContext.currentTime, 0.015);
    debug.log(`Spatial audio ${deafened ? 'deafened (gain→0)' : 'undeafened (gain→1)'}`);
  }

  /**
   * Get current spatial audio status
   */
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

  /**
   * Debug method to check audio output state
   */
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

  /**
   * Destroy spatial audio service and cleanup all resources
   */
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
    
    // Disconnect compressor node
    if (this.compressorNode) {
      try {
        this.compressorNode.disconnect();
      } catch (error) {
        debug.warn('Error disconnecting compressor node:', error);
      }
      this.compressorNode = null;
    }
    
    // Disconnect master gain node
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

// Export singleton instance
export const spatialAudioService = new SpatialAudioService();

// Expose to window for debugging in console
if (typeof window !== 'undefined') {
  (window as any).spatialAudioService = spatialAudioService;
  debug.log('spatialAudioService exposed to window for debugging');
}