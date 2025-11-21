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

// =============================================================================
// TYPES
// =============================================================================

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

interface ImpulseResponseCache {
  [roomSize: string]: AudioBuffer;
}

// =============================================================================
// SPATIAL AUDIO SERVICE
// =============================================================================

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

  // =============================================================================
  // INITIALIZATION
  // =============================================================================

  /**
   * Initialize spatial audio system with optimized audio context
   * Only creates AudioContext when spatial audio is enabled
   */
  async initialize(): Promise<void> {
    if (this.isInitialized) return;

    const spatialStore = useSpatialAudioStore();
    
    // Only initialize if spatial audio is enabled
    if (!spatialStore.settings.enabled) {
      console.log('🎧 Spatial audio disabled - skipping AudioContext creation');
      return;
    }

    try {
      // Create AudioContext with optimized settings for low latency
      this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)({
        latencyHint: 'interactive', // Prioritize low latency for voice chat
        sampleRate: 48000 // Standard for high-quality audio
      });
      
      // Resume context if suspended (required by browsers)
      if (this.audioContext.state === 'suspended') {
        await this.audioContext.resume();
      }
      
      // Create professional audio processing chain
      await this.createMasterAudioChain();
      
      this.isInitialized = true;
      
      console.log('🎧 Professional Spatial Audio Service initialized:', {
        sampleRate: this.audioContext.sampleRate,
        state: this.audioContext.state,
        baseLatency: this.audioContext.baseLatency,
        outputLatency: this.audioContext.outputLatency
      });
      
      // Pre-load impulse responses if reverb is enabled
      if (spatialStore.settings.enableReverb) {
        await this.preloadImpulseResponses();
      }
      
      // Note: Update loop is started only when spatial audio is enabled via enableSpatialAudio()
      
    } catch (error) {
      console.error('❌ Failed to initialize spatial audio:', error);
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
    
    // Set destination for individual audio chains
    this.destination = this.audioContext.destination;
    
    console.log('🎛️ Master audio processing chain created with professional dynamics');
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
      console.log('🎧 Pre-loaded impulse responses for room sizes:', roomSizes);
    } catch (error) {
      console.warn('⚠️ Failed to pre-load impulse responses:', error);
    }
  }

  // =============================================================================
  // USER MANAGEMENT
  // =============================================================================

  /**
   * Set the listener (local user) for spatial audio calculations
   */
  setListener(userId: string): void {
    this.listenerUserId = userId;
    console.log('🎧 Set spatial audio listener:', userId);
  }

  /**
   * Setup spatial audio for a remote user using MediaStream directly
   * This creates a professional audio processing chain for WebRTC streams
   */
  async setupSpatialForUser(userId: string, mediaStream: MediaStream): Promise<void> {
    if (!this.audioContext || !this.destination) {
      console.warn('⚠️ Spatial audio not initialized - call initialize() first');
      return;
    }

    // Safety check: Don't process the listener's own stream
    if (userId === this.listenerUserId) {
      console.warn('⚠️ Attempted to setup spatial audio for listener - skipping');
      return;
    }

    if (!mediaStream) {
      console.warn('⚠️ No media stream provided for user:', userId);
      return;
    }

    // Check if stream has audio tracks
    const audioTracks = mediaStream.getAudioTracks();
    if (audioTracks.length === 0) {
      console.warn('⚠️ No audio tracks in stream for user:', userId);
      return;
    }

    console.log('🎧 Setting up professional spatial audio for user:', userId);
    
    try {
      // Remove existing node if it exists
      this.removeUser(userId);

      // Create audio source directly from MediaStream (better quality than HTMLAudioElement)
      const source = this.audioContext.createMediaStreamSource(mediaStream);
      
      // Convert stereo to mono for better spatial audio effect
      const audioTracks = mediaStream.getAudioTracks();
      const channelCount = audioTracks[0]?.getSettings().channelCount || 2;
      console.log(`🎧 Audio source channel count: ${channelCount}`);
      
      // If stereo, create a mono downmix for spatial audio
      let monoSource: AudioNode = source;
      if (channelCount > 1) {
        const splitter = this.audioContext.createChannelSplitter(channelCount);
        const merger = this.audioContext.createChannelMerger(1); // Merge to mono
        source.connect(splitter);
        // Connect all channels to a single output channel
        for (let i = 0; i < channelCount; i++) {
          splitter.connect(merger, i, 0);
        }
        monoSource = merger;
        console.log('🎧 Converted stereo to mono for spatial audio');
      }
      
      // Create professional audio processing chain
      const processingChain = await this.createAudioProcessingChain(monoSource);
      
      // Store the complete node configuration
      const spatialNode: SpatialAudioNode = {
        userId,
        gainNode: processingChain.inputGain,
        pannerNode: processingChain.panner,
        convolver: processingChain.convolver,
        source,
        mediaStream,
        isConnected: true,
        lastGain: 1.0,
        lastPanning: 0.0
      };

      this.spatialNodes.set(userId, spatialNode);

      console.log('✅ Professional spatial audio setup complete for user:', userId, {
        hasReverb: !!processingChain.convolver,
        pannerType: processingChain.panner.constructor.name,
        audioTracks: audioTracks.length
      });
      
      // Apply initial spatial effects
      this.updateSpatialEffects();
      
    } catch (error) {
      console.error('❌ Failed to setup spatial audio for user:', userId, error);
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
    const inputGain = this.audioContext.createGain();
    inputGain.gain.value = 1.0;
    
    // Output gain for final volume control
    const outputGain = this.audioContext.createGain();
    outputGain.gain.value = 1.0;
    
    // Create panner for spatial positioning
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
      console.log('🎧 Removing spatial audio for user:', userId);
      
      // Disconnect all audio nodes safely
      this.disconnectAudioChain(node);
      
      // Remove from tracking
      this.spatialNodes.delete(userId);
      
      console.log('✅ Successfully removed spatial audio for user:', userId);
    } catch (error) {
      console.error('❌ Failed to remove spatial audio for user:', userId, error);
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
      console.warn('⚠️ Error during audio chain disconnection:', error);
    }
  }

  // =============================================================================
  // SPATIAL EFFECTS
  // =============================================================================

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
      
      // Get actual user positions for accurate positioning
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
      
      // Reset 3D position to center if using PannerNode
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
          console.warn('⚠️ Failed to reset 3D position for user:', userId, error);
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
      // Apply professional audio curve for natural volume falloff
      const dbGain = gain === 0 ? -Infinity : 20 * Math.log10(gain);
      const linearGain = dbGain === -Infinity ? 0 : Math.pow(10, dbGain / 20);
      
      // Clamp gain to prevent audio distortion
      const clampedGain = Math.max(0, Math.min(1, linearGain));
      
      // Smooth gain transition to avoid audio clicks
      const currentTime = this.audioContext.currentTime;
      const transitionTime = 0.05; // 50ms transition for responsiveness
      
      node.gainNode.gain.setTargetAtTime(clampedGain, currentTime, transitionTime);
    } catch (error) {
      console.error('❌ Failed to set gain for user:', userId, error);
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
      
      const currentTime = this.audioContext.currentTime;
      const transitionTime = 0.05; // 50ms transition for responsiveness
      
      if (node.pannerNode instanceof StereoPannerNode) {
        // Simple stereo panning for 2D spatial audio
        node.pannerNode.pan.setTargetAtTime(clampedPanning, currentTime, transitionTime);
      } else if (node.pannerNode instanceof PannerNode) {
        // 3D positioning mapped to 2D space with proper distance modeling
        const distance = Math.abs(clampedPanning) * 3; // Scale for 3D positioning
        const x = clampedPanning * 8;
        const y = 0;
        const z = -Math.max(1, distance); // Keep in front of listener
        
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
      console.error('❌ Failed to set panning for user:', userId, error);
    }
  }

  /**
   * Set user 3D position directly (more accurate than panning alone)
   */
  private setUser3DPosition(userId: string, x: number, y: number): void {
    const node = this.spatialNodes.get(userId);
    if (!node || !this.audioContext || !node.isConnected) return;
    if (!(node.pannerNode instanceof PannerNode)) return; // Only works with PannerNode

    try {
      const spatialStore = useSpatialAudioStore();
      
      // Convert 2D screen coordinates to 3D audio space
      // Scale positions to reasonable audio distances with increased multiplier for more dramatic effect
      const scale = 5.0; // Increased multiplier for even stronger spatial effect
      const audioX = (x - 300) * scale / 30; // More aggressive scaling
      const audioY = (y - 200) * scale / 30; // More aggressive scaling
      const audioZ = -1; // Closer to listener for better effect
      
      const currentTime = this.audioContext.currentTime;
      const transitionTime = 0.05;
      
      // Apply 3D positioning
      if (node.pannerNode.positionX) {
        node.pannerNode.positionX.setTargetAtTime(audioX, currentTime, transitionTime);
        node.pannerNode.positionY.setTargetAtTime(audioY, currentTime, transitionTime);
        node.pannerNode.positionZ.setTargetAtTime(audioZ, currentTime, transitionTime);
      } else {
        // Fallback for older browsers
        node.pannerNode.setPosition(audioX, audioY, audioZ);
      }
      
      console.log(`🎧 Set 3D position for ${userId}: screen(${x},${y}) -> audio(${audioX.toFixed(2)},${audioY.toFixed(2)},${audioZ})`);
    } catch (error) {
      console.error('❌ Failed to set 3D position for user:', userId, error);
    }
  }

  // =============================================================================
  // POSITION MANAGEMENT
  // =============================================================================

  /**
   * Update user position and trigger spatial effects recalculation
   */
  updateUserPosition(userId: string, x: number, y: number): void {
    if (!this.isInitialized) {
      console.warn('⚠️ Spatial audio not initialized - position update ignored');
      return;
    }

    const spatialStore = useSpatialAudioStore();
    
    // Update position in store
    spatialStore.setUserPosition(userId, x, y);
    
    // Immediately trigger spatial effects update for responsive positioning
    this.updateSpatialEffects();
    
    console.log(`🎧 Updated position for ${userId}: (${x}, ${y})`);
  }

  /**
   * Start continuous spatial audio updates (call once when spatial audio is enabled)
   */
  startSpatialUpdates(): void {
    if (this.animationFrameId) {
      return; // Already running
    }

    const updateLoop = () => {
      if (this.isInitialized) {
        this.updateSpatialEffects();
        this.animationFrameId = requestAnimationFrame(updateLoop);
      } else {
        this.animationFrameId = null;
      }
    };
    
    this.animationFrameId = requestAnimationFrame(updateLoop);
    console.log('🎧 Started spatial audio update loop');
  }

  /**
   * Stop continuous spatial audio updates
   */
  stopSpatialUpdates(): void {
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
      console.log('🎧 Stopped spatial audio update loop');
    }
  }

  // =============================================================================
  // AUDIO NODE CREATION
  // =============================================================================

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
      return pannerNode;
    }
    
    // Use PannerNode for advanced spatial positioning with HRTF
    const pannerNode = this.audioContext.createPanner();
    
    // Configure panner for optimal spatial audio with HRTF
    pannerNode.panningModel = 'HRTF'; // Use HRTF for better 3D positioning
    pannerNode.distanceModel = spatialStore.settings.distanceModel;
    pannerNode.refDistance = 1;
    pannerNode.maxDistance = 150; // Increased from 50 for more dramatic effect
    pannerNode.rolloffFactor = 2.5; // Increased from 1 for stronger distance falloff
    
    // Optimize for 2D audio (omnidirectional cone)
    pannerNode.coneInnerAngle = 360;
    pannerNode.coneOuterAngle = 360;
    pannerNode.coneOuterGain = 1;
    
    // Set initial position (center in front of listener)
    pannerNode.setPosition(0, 0, -1);
    pannerNode.setOrientation(0, 0, -1);
    
    // Set listener position and orientation for proper spatial audio
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
   */
  private createImpulseResponse(roomSize: number): AudioBuffer {
    if (!this.audioContext) throw new Error('AudioContext not initialized');

    const sampleRate = this.audioContext.sampleRate;
    const length = Math.floor(sampleRate * roomSize * 1.5); // Room size affects reverb length
    const impulse = this.audioContext.createBuffer(2, length, sampleRate);
    
    // Generate realistic reverb impulse response with professional characteristics
    for (let channel = 0; channel < 2; channel++) {
      const channelData = impulse.getChannelData(channel);
      
      for (let i = 0; i < length; i++) {
        // Create decaying noise with realistic room characteristics
        const normalizedTime = i / length;
        
        // Multi-stage exponential decay for natural reverb
        const earlyDecay = Math.pow(1 - normalizedTime, 1.5 + roomSize * 0.5);
        const lateDecay = Math.pow(1 - normalizedTime, 3 + roomSize);
        
        // Combine early and late reflections
        const earlyReflection = normalizedTime < 0.05 ? 
          Math.sin(normalizedTime * Math.PI * 40) * 0.4 : 0;
        
        // Generate colored noise with frequency response
        const noise = (Math.random() * 2 - 1);
        const highFreqRolloff = 1 - normalizedTime * 0.7; // Natural high frequency absorption
        const filteredNoise = noise * highFreqRolloff;
        
        // Combine components with professional reverb characteristics
        const earlyComponent = (filteredNoise + earlyReflection) * earlyDecay * 0.3;
        const lateComponent = filteredNoise * lateDecay * 0.15;
        
        channelData[i] = (earlyComponent + lateComponent) * (channel === 0 ? 1.0 : 0.9); // Slight stereo variation
      }
    }
    
    console.log(`🎧 Created professional impulse response: ${length} samples, room size: ${roomSize}`);
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
      
      console.log(`🎧 Loaded external impulse response from: ${url}`);
      return audioBuffer;
    } catch (error) {
      console.warn(`⚠️ Failed to load external impulse response: ${url}`, error);
      throw error;
    }
  }

  // =============================================================================
  // CONTROL METHODS
  // =============================================================================

  /**
   * Enable spatial audio effects with proper initialization
   */
  async enableSpatialAudio(): Promise<void> {
    console.log('🎧 Enabling spatial audio...');
    
    // Initialize audio context if not already done
    if (!this.isInitialized) {
      await this.initialize();
    }
    
    const spatialStore = useSpatialAudioStore();
    
    // Re-enable reverb for existing users if reverb is enabled
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
            console.log('🎧 Re-enabled reverb for user:', userId);
          } catch (error) {
            console.error('❌ Failed to re-enable reverb for user:', userId, error);
          }
        }
      }
    }
    
    // Start continuous spatial updates
    this.startSpatialUpdates();
    
    // Apply current spatial effects
    this.updateSpatialEffects();
    console.log('✅ Spatial audio enabled');
  }

  /**
   * Disable spatial audio effects (reset to normal audio)
   */
  disableSpatialAudio(): void {
    console.log('🎧 Disabling spatial audio...');
    
    // Stop spatial update loop
    this.stopSpatialUpdates();
    
    // Reset all audio effects to defaults
    this.resetToDefaultAudio();
    
    // Disable reverb for all users while spatial audio is off
    this.spatialNodes.forEach((node, userId) => {
      if (node.convolver) {
        try {
          // Disconnect reverb and reconnect without it
          node.convolver.disconnect();
          node.gainNode.disconnect();
          node.gainNode.connect(node.pannerNode);
          
          // Keep convolver reference for when spatial audio is re-enabled
          console.log('🎧 Disabled reverb for user:', userId);
        } catch (error) {
          console.error('❌ Failed to disable reverb for user:', userId, error);
        }
      }
    });
    
    console.log('✅ Spatial audio disabled');
  }

  /**
   * Update settings and recreate audio nodes as needed
   */
  async updateSettings(): Promise<void> {
    console.log('🎧 Updating spatial audio settings...');
    
    // Update spatial effects with new settings
    this.updateSpatialEffects();
    
    const spatialStore = useSpatialAudioStore();
    
    // Update reverb nodes if settings changed
    for (const [userId, node] of this.spatialNodes) {
      const shouldHaveReverb = spatialStore.settings.enableReverb;
      const hasReverb = !!node.convolver;
      
      if (shouldHaveReverb && !hasReverb) {
        // Add reverb
        try {
          const convolver = await this.createReverbNode(spatialStore.settings.roomSize);
          
          // Reconnect audio graph with reverb
          node.gainNode.disconnect();
          node.gainNode.connect(convolver);
          convolver.connect(node.pannerNode);
          
          node.convolver = convolver;
          console.log('✅ Added reverb for user:', userId);
        } catch (error) {
          console.error('❌ Failed to add reverb for user:', userId, error);
        }
      } else if (!shouldHaveReverb && hasReverb) {
        // Remove reverb
        try {
          if (node.convolver) {
            node.convolver.disconnect();
            node.convolver = undefined;
          }
          
          // Reconnect audio graph without reverb
          node.gainNode.disconnect();
          node.gainNode.connect(node.pannerNode);
          
          console.log('✅ Removed reverb for user:', userId);
        } catch (error) {
          console.error('❌ Failed to remove reverb for user:', userId, error);
        }
      } else if (hasReverb && node.convolver) {
        // Update existing reverb with new room size
        try {
          const newConvolver = await this.createReverbNode(spatialStore.settings.roomSize);
          const oldConvolver = node.convolver;
          
          // Replace convolver in the chain
          oldConvolver.disconnect();
          node.gainNode.disconnect();
          node.gainNode.connect(newConvolver);
          newConvolver.connect(node.pannerNode);
          
          node.convolver = newConvolver;
          console.log('✅ Updated reverb for user:', userId);
        } catch (error) {
          console.error('❌ Failed to update reverb for user:', userId, error);
        }
      }
    }
    
    console.log('✅ Spatial audio settings updated');
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
    console.log('🔍 Spatial Audio Debug State:');
    console.log('- Initialized:', this.isInitialized);
    console.log('- AudioContext state:', this.audioContext?.state || 'not-created');
    console.log('- Active spatial nodes:', this.spatialNodes.size);
    console.log('- Update loop running:', !!this.animationFrameId);
    
    this.spatialNodes.forEach((node, userId) => {
      console.log(`- User ${userId}:`, {
        connected: node.isConnected,
        hasGain: !!node.gainNode,
        hasPanner: !!node.pannerNode,
        hasConvolver: !!node.convolver,
        lastGain: node.lastGain,
        lastPanning: node.lastPanning
      });
    });
    
    const spatialStore = useSpatialAudioStore();
    console.log('- Spatial audio enabled in store:', spatialStore.settings.enabled);
    console.log('- User positions:', Array.from(spatialStore.userPositions.entries()));
  }

  // =============================================================================
  // CLEANUP
  // =============================================================================

  /**
   * Destroy spatial audio service and cleanup all resources
   */
  async destroy(): Promise<void> {
    console.log('🎧 Destroying spatial audio service...');
    
    // Stop update loop
    if (this.animationFrameId) {
      cancelAnimationFrame(this.animationFrameId);
      this.animationFrameId = null;
    }
    
    // Remove all users and disconnect audio chains
    const userIds = Array.from(this.spatialNodes.keys());
    for (const userId of userIds) {
      this.removeUser(userId);
    }
    
    // Clear cache
    this.impulseResponseCache = {};
    
    // Disconnect compressor node
    if (this.compressorNode) {
      try {
        this.compressorNode.disconnect();
      } catch (error) {
        console.warn('⚠️ Error disconnecting compressor node:', error);
      }
      this.compressorNode = null;
    }
    
    // Disconnect master gain node
    if (this.masterGainNode) {
      try {
        this.masterGainNode.disconnect();
      } catch (error) {
        console.warn('⚠️ Error disconnecting master gain node:', error);
      }
      this.masterGainNode = null;
    }
    
    // Close audio context
    if (this.audioContext && this.audioContext.state !== 'closed') {
      try {
        await this.audioContext.close();
        console.log('✅ AudioContext closed successfully');
      } catch (error) {
        console.warn('⚠️ Error closing AudioContext:', error);
      }
    }
    
    // Reset all state
    this.audioContext = null;
    this.destination = null;
    this.listenerUserId = null;
    this.isInitialized = false;
    this.lastUpdateTime = 0;
    
    console.log('✅ Professional Spatial Audio Service destroyed');
  }
}

// Export singleton instance
export const spatialAudioService = new SpatialAudioService();