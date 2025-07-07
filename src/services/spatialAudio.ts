/**
 * Spatial Audio Service
 * Handles 2D spatial audio effects using Web Audio API
 */

import { useSpatialAudioStore } from '@/stores/spatialAudio';

interface SpatialAudioNode {
  userId: string;
  gainNode: GainNode;
  pannerNode: PannerNode | StereoPannerNode;
  convolver?: ConvolverNode;
  source?: MediaElementAudioSourceNode;
  audioElement?: HTMLAudioElement;
}

export class SpatialAudioService {
  private audioContext: AudioContext | null = null;
  private spatialNodes: Map<string, SpatialAudioNode> = new Map();
  private destination: AudioNode | null = null;
  private listenerUserId: string | null = null;
  private isInitialized = false;

  // =============================================================================
  // INITIALIZATION
  // =============================================================================

  async initialize(): Promise<void> {
    if (this.isInitialized) return;

    try {
      this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
      
      // Always try to resume the audio context
      if (this.audioContext.state !== 'running') {
        console.log('🎧 AudioContext state:', this.audioContext.state, '- attempting to resume...');
        await this.audioContext.resume();
        console.log('🎧 AudioContext resumed, new state:', this.audioContext.state);
      }
      
      this.destination = this.audioContext.destination;
      this.isInitialized = true;
      
      console.log('🎧 Spatial Audio Service initialized successfully', {
        sampleRate: this.audioContext.sampleRate,
        state: this.audioContext.state,
        destination: !!this.destination
      });
    } catch (error) {
      console.error('Failed to initialize spatial audio:', error);
      throw error;
    }
  }

  // Force resume AudioContext (call this before spatial effects)
  async ensureAudioContextRunning(): Promise<void> {
    if (!this.audioContext) {
      await this.initialize();
      return;
    }

    if (this.audioContext.state !== 'running') {
      console.log('🎧 Forcing AudioContext resume, current state:', this.audioContext.state);
      try {
        await this.audioContext.resume();
        console.log('🎧 AudioContext force resumed, new state:', this.audioContext.state);
      } catch (error) {
        console.error('🎧 Failed to resume AudioContext:', error);
      }
    }
  }

  // Debug method to check audio routing
  debugAudioRouting(): void {
    console.log('🎧 === AUDIO ROUTING DEBUG ===');
    console.log('AudioContext state:', this.audioContext?.state);
    console.log('AudioContext sample rate:', this.audioContext?.sampleRate);
    console.log('Number of spatial nodes:', this.spatialNodes.size);
    
    this.spatialNodes.forEach((node, userId) => {
      console.log(`🎧 User ${userId}:`, {
        hasSource: !!node.source,
        hasGainNode: !!node.gainNode,
        hasPannerNode: !!node.pannerNode,
        hasConvolver: !!node.convolver,
        gainValue: node.gainNode?.gain.value,
        panValue: node.pannerNode instanceof StereoPannerNode ? node.pannerNode.pan.value : 'N/A',
        audioElementPaused: node.audioElement?.paused,
        audioElementMuted: node.audioElement?.muted,
        audioElementVolume: node.audioElement?.volume,
        audioElementSrc: node.audioElement?.src?.slice(-50) // Last 50 chars
      });
    });
    console.log('🎧 === END DEBUG ===');
  }

  // =============================================================================
  // USER MANAGEMENT
  // =============================================================================

  setListener(userId: string): void {
    this.listenerUserId = userId;
    console.log('🎧 Set spatial audio listener:', userId);
  }

  async setupSpatialForUser(userId: string, audioElement?: HTMLAudioElement): Promise<void> {
    console.log('🎧 setupSpatialForUser called for user:', userId, 'audioElement:', !!audioElement, 'listenerUserId:', this.listenerUserId);
    
    if (!this.audioContext) {
      console.warn('Spatial audio not initialized');
      return;
    }

    // Safeguard: Don't process the listener's own stream
    if (userId === this.listenerUserId) {
      console.warn('Attempted to setup spatial audio for listener - skipping');
      return;
    }

    if (!audioElement) {
      console.warn('No audio element provided for user:', userId);
      return;
    }

    // Ensure AudioContext is running before setting up audio routing
    await this.ensureAudioContextRunning();

    // Ensure audio context is running
    if (this.audioContext.state !== 'running') {
      console.log('🎧 AudioContext not running, attempting to resume for user:', userId);
      this.audioContext.resume().then(() => {
        console.log('🎧 AudioContext resumed, retrying setup for user:', userId);
        this.setupSpatialForUser(userId, audioElement);
      }).catch(error => {
        console.error('Failed to resume AudioContext:', error);
      });
      return;
    }

    console.log('🎧 Setting up spatial audio for user:', userId, {
      audioElementSrc: audioElement.src || 'No src',
      audioElementSrcObject: !!audioElement.srcObject,
      audioElementPaused: audioElement.paused,
      audioElementMuted: audioElement.muted,
      audioElementVolume: audioElement.volume,
      audioElementReadyState: audioElement.readyState,
      audioContextState: this.audioContext.state
    });
    
    try {
      // Check if we already have a node for this user
      const existingNode = this.spatialNodes.get(userId);
      let source: MediaElementAudioSourceNode;
      
      if (existingNode?.source && existingNode.audioElement === audioElement) {
        // Reuse existing source node - don't disconnect it
        source = existingNode.source;
        console.log('🎧 Reusing existing MediaElementSource for user:', userId);
        
        // Disconnect the existing audio graph but keep the source
        existingNode.gainNode.disconnect();
        existingNode.pannerNode.disconnect();
        if (existingNode.convolver) {
          existingNode.convolver.disconnect();
        }
      } else {
        // Remove existing node completely if it exists
        this.removeUserCompletely(userId);
        
        // Create new audio source from HTMLAudioElement
        try {      // IMPORTANT: When we create a MediaElementSourceNode, the audio element
      // stops playing directly to speakers and must be routed through Web Audio API
      console.log('🎧 Creating MediaElementSource for user:', userId, '- audio will be routed through spatial audio');
      
      // CRITICAL CHECK: Verify the audio element is not muted and has volume
      console.log('🎧 BEFORE MediaElementSource - Audio element state:', {
        paused: audioElement.paused,
        muted: audioElement.muted,
        volume: audioElement.volume,
        srcObject: !!audioElement.srcObject,
        readyState: audioElement.readyState
      });
      
      source = this.audioContext.createMediaElementSource(audioElement);
      
      // CRITICAL CHECK: After creating MediaElementSource, the audio should stop playing directly
      console.log('🎧 AFTER MediaElementSource - Audio element state:', {
        paused: audioElement.paused,
        muted: audioElement.muted,
        volume: audioElement.volume
      });
      
      console.log('🎧 Created new MediaElementSource for user:', userId, '- audio is now routed through Web Audio API');
        } catch (error) {
          if (error instanceof DOMException && error.name === 'InvalidStateError') {
            console.error('🎧 Audio element already connected for user:', userId, '- this should not happen with our current setup');
            // The audio element is already connected to a different MediaElementSourceNode
            // This means we have a logic error in our setup/cleanup
            return;
          }
          throw error;
        }
      }
      
      // Create gain node for volume control
      const gainNode = this.audioContext.createGain();
      gainNode.gain.value = 1; // Start at full volume
      
      // Create panner node for spatial positioning
      const pannerNode = this.createPannerNode();
      
      // Optional: Create convolver for reverb
      let convolver: ConvolverNode | undefined;
      const spatialStore = useSpatialAudioStore();
      if (spatialStore.settings.enableReverb) {
        convolver = this.createReverbNode();
      }

      // Connect audio graph
      source.connect(gainNode);
      console.log('🎧 Connected source to gain node for user:', userId);
      
      if (convolver) {
        gainNode.connect(convolver);
        convolver.connect(pannerNode);
        console.log('🎧 Connected audio graph with reverb for user:', userId);
      } else {
        gainNode.connect(pannerNode);
        console.log('🎧 Connected audio graph without reverb for user:', userId);
      }
      
      pannerNode.connect(this.destination!);
      console.log('🎧 Connected to audio destination for user:', userId);

      // IMPORTANT: When we create a MediaElementSourceNode, the audio element
      // should automatically stop playing directly to speakers and route through Web Audio API.
      // However, to be absolutely sure, let's explicitly manage playback:
      
      // First, ensure the audio element is playing (required for MediaElementSourceNode)
      // We need to use the original play method since we might have overridden it
      const originalPlay = (audioElement as any)._originalPlay || audioElement.play.bind(audioElement);
      
      if (audioElement.paused) {
        console.log('🎧 Starting audio playback for user:', userId);
        try {
          // CRITICAL: Keep the audio element muted to prevent direct playback
          // The MediaElementSourceNode will still process the audio even if muted
          audioElement.muted = true;
          await originalPlay();
          console.log('🎧 Audio playback started for user:', userId, '(muted for spatial routing)');
        } catch (error) {
          console.error('🎧 Failed to start audio playback for user:', userId, error);
        }
      } else {
        console.log('🎧 Audio element already playing for user:', userId, '- ensuring muted for spatial routing only');
        // CRITICAL: Ensure muted to prevent direct audio playback
        audioElement.muted = true;
      }

      // Ensure the audio element volume is at maximum since we're controlling volume through gainNode
      audioElement.volume = 1.0;
      console.log('🎧 Audio element configured for user:', userId, '- muted for direct playback, volume controlled by gainNode');

      // Store the nodes
      this.spatialNodes.set(userId, {
        userId,
        gainNode,
        pannerNode,
        convolver,
        source,
        audioElement
      });

      console.log('🎧 Spatial audio set up for user:', userId);
      
      // Debug audio routing
      this.debugAudioRouting();
      
      // Apply initial spatial effects
      await this.updateSpatialEffects();
    } catch (error) {
      console.error('Failed to setup spatial audio for user:', userId, error);
    }
  }

  addUser(userId: string, audioElement: HTMLAudioElement): void {
    if (!this.audioContext || !this.destination) {
      console.warn('Spatial audio not initialized');
      return;
    }

    // NOTE: This should ONLY be called for REMOTE user streams, 
    // never for the local user's own microphone stream
    
    // Safeguard: Don't process the listener's own stream
    if (userId === this.listenerUserId) {
      console.warn('Attempted to add listener\'s own stream to spatial audio - skipping');
      return;
    }
    
    // Use setupSpatialForUser instead
    this.setupSpatialForUser(userId, audioElement);
  }

  removeUser(userId: string): void {
    const node = this.spatialNodes.get(userId);
    if (!node) return;

    try {
      // Disconnect all nodes (but leave source connected to avoid InvalidStateError)
      if (node.source) {
        // Only disconnect the source from our audio graph, don't disconnect from the audio element
        node.source.disconnect();
      }
      node.gainNode.disconnect();
      node.pannerNode.disconnect();
      if (node.convolver) {
        node.convolver.disconnect();
      }

      this.spatialNodes.delete(userId);
      console.log('🎧 Removed spatial audio for user:', userId);
    } catch (error) {
      console.error('Failed to remove spatial audio for user:', userId, error);
    }
  }

  // Helper method to completely remove a user including the source node
  private removeUserCompletely(userId: string): void {
    const node = this.spatialNodes.get(userId);
    if (!node) return;

    try {
      // Disconnect all nodes including the source
      if (node.source) {
        node.source.disconnect();
      }
      node.gainNode.disconnect();
      node.pannerNode.disconnect();
      if (node.convolver) {
        node.convolver.disconnect();
      }

      this.spatialNodes.delete(userId);
      console.log('🎧 Completely removed spatial audio for user:', userId);
    } catch (error) {
      console.error('Failed to completely remove spatial audio for user:', userId, error);
    }
  }

  // =============================================================================
  // SPATIAL EFFECTS
  // =============================================================================

  async updateSpatialEffects(): Promise<void> {
    if (!this.listenerUserId) {
      console.log('🎧 No listener set, skipping spatial effects update');
      return;
    }

    // Ensure AudioContext is running
    await this.ensureAudioContextRunning();

    const spatialStore = useSpatialAudioStore();
    
    // Only apply spatial effects if spatial audio is enabled
    if (!spatialStore.settings.enabled) {
      console.log('🎧 Spatial audio disabled, skipping effects update');
      return;
    }
    
    console.log(`🎧 Updating spatial effects for ${this.spatialNodes.size} users`);
    
    this.spatialNodes.forEach((node, userId) => {
      if (userId === this.listenerUserId) return; // Don't apply effects to self
      
      // Calculate spatial parameters
      const gain = spatialStore.getAudioGain(this.listenerUserId!, userId);
      const panning = spatialStore.getPanning(this.listenerUserId!, userId);
      
      // Apply gain
      this.setUserGain(userId, gain);
      
      // Apply panning
      this.setUserPanning(userId, panning);
    });
  }

  private setUserGain(userId: string, gain: number): void {
    const node = this.spatialNodes.get(userId);
    if (!node || !this.audioContext) return;

    try {
      // Smooth gain transition to avoid clicks
      const currentTime = this.audioContext.currentTime;
      node.gainNode.gain.setTargetAtTime(gain, currentTime, 0.1);
      console.log(`🔊 Setting gain for ${userId}: ${gain.toFixed(3)}`);
    } catch (error) {
      console.error('Failed to set gain for user:', userId, error);
    }
  }

  private setUserPanning(userId: string, panning: number): void {
    const node = this.spatialNodes.get(userId);
    if (!node || !this.audioContext) return;

    try {
      const currentTime = this.audioContext.currentTime;
      
      if (node.pannerNode instanceof StereoPannerNode) {
        // Use StereoPannerNode for simple stereo panning
        node.pannerNode.pan.setTargetAtTime(panning, currentTime, 0.1);
        console.log(`🎛️ Setting stereo panning for ${userId}: ${panning.toFixed(3)}`);
      } else if (node.pannerNode instanceof PannerNode) {
        // Use PannerNode for 3D positioning (simplified to 2D)
        const distance = Math.abs(panning) * 10; // Scale for 3D positioning
        node.pannerNode.setPosition(panning * 10, 0, -distance);
        console.log(`🎛️ Setting 3D panning for ${userId}: position(${(panning * 10).toFixed(1)}, 0, ${-distance.toFixed(1)})`);
      }
    } catch (error) {
      console.error('Failed to set panning for user:', userId, error);
    }
  }

  // =============================================================================
  // AUDIO NODE CREATION
  // =============================================================================

  private createPannerNode(): PannerNode | StereoPannerNode {
    if (!this.audioContext) throw new Error('Audio context not initialized');

    const spatialStore = useSpatialAudioStore();
    
    // Use StereoPannerNode for simple 2D panning
    if (spatialStore.settings.panningModel === 'equalpower') {
      const pannerNode = this.audioContext.createStereoPanner();
      pannerNode.pan.value = 0;
      return pannerNode;
    }
    
    // Use PannerNode for more advanced 3D positioning
    const pannerNode = this.audioContext.createPanner();
    pannerNode.panningModel = spatialStore.settings.panningModel;
    pannerNode.distanceModel = spatialStore.settings.distanceModel;
    pannerNode.refDistance = 1;
    pannerNode.maxDistance = spatialStore.settings.maxDistance;
    pannerNode.rolloffFactor = spatialStore.settings.rolloffFactor;
    pannerNode.coneInnerAngle = 360;
    pannerNode.coneOuterAngle = 0;
    pannerNode.coneOuterGain = 0;
    
    // Set initial position
    pannerNode.setPosition(0, 0, -1);
    pannerNode.setOrientation(0, 0, -1);
    
    return pannerNode;
  }

  private createReverbNode(): ConvolverNode {
    if (!this.audioContext) throw new Error('Audio context not initialized');

    const convolver = this.audioContext.createConvolver();
    const spatialStore = useSpatialAudioStore();
    
    // Create impulse response for reverb
    const impulseResponse = this.createImpulseResponse(
      this.audioContext.sampleRate,
      spatialStore.settings.roomSize
    );
    
    convolver.buffer = impulseResponse;
    return convolver;
  }

  private createImpulseResponse(sampleRate: number, roomSize: number): AudioBuffer {
    if (!this.audioContext) throw new Error('Audio context not initialized');

    const length = sampleRate * roomSize; // Room size in seconds
    const impulse = this.audioContext.createBuffer(2, length, sampleRate);
    
    for (let channel = 0; channel < 2; channel++) {
      const channelData = impulse.getChannelData(channel);
      for (let i = 0; i < length; i++) {
        const decay = Math.pow(1 - i / length, 2);
        channelData[i] = (Math.random() * 2 - 1) * decay;
      }
    }
    
    return impulse;
  }

  // =============================================================================
  // CONTROL METHODS
  // =============================================================================

  enableSpatialAudio(): void {
    console.log('🎧 Spatial audio enabled');
    
    const spatialStore = useSpatialAudioStore();
    
    // Ensure audio context is running
    if (this.audioContext && this.audioContext.state !== 'running') {
      console.log('🎧 Resuming AudioContext for spatial audio...');
      this.audioContext.resume().then(() => {
        console.log('🎧 AudioContext resumed, applying spatial effects');
        this.updateSpatialEffects();
      });
    } else {
      this.updateSpatialEffects();
    }
    
    // Re-enable reverb if it was disabled
    if (spatialStore.settings.enableReverb) {
      this.spatialNodes.forEach((node, userId) => {
        if (!node.convolver) {
          try {
            const convolver = this.createReverbNode();
            
            // Reconnect audio graph with reverb
            node.gainNode.disconnect();
            node.gainNode.connect(convolver);
            convolver.connect(node.pannerNode);
            
            node.convolver = convolver;
            console.log('🎧 Re-enabled reverb for user:', userId);
          } catch (error) {
            console.error('Failed to re-enable reverb for user:', userId, error);
          }
        }
      });
    }
  }

  disableSpatialAudio(): void {
    console.log('🎧 Spatial audio disabled');
    
    // Reset all audio effects to defaults
    this.spatialNodes.forEach((node, userId) => {
      this.setUserGain(userId, 1); // Full volume
      this.setUserPanning(userId, 0); // Center pan
      
      // Disable reverb while spatial audio is off
      if (node.convolver) {
        try {
          node.convolver.disconnect();
          node.gainNode.disconnect();
          node.gainNode.connect(node.pannerNode);
        } catch (error) {
          console.error('Failed to disable reverb for user:', userId, error);
        }
      }
    });
    
    // Enable direct audio playback as fallback
    this.enableDirectAudioPlayback();
  }

  updateSettings(): void {
    // Update spatial effects with new settings
    this.updateSpatialEffects();
    
    // Recreate any convolver nodes if reverb settings changed
    const spatialStore = useSpatialAudioStore();
    this.spatialNodes.forEach((node, userId) => {
      // Check if reverb setting changed
      const shouldHaveReverb = spatialStore.settings.enableReverb;
      const hasReverb = !!node.convolver;
      
      if (shouldHaveReverb && !hasReverb) {
        // Add reverb
        try {
          const convolver = this.createReverbNode();
          
          // Reconnect audio graph with reverb
          node.gainNode.disconnect();
          node.gainNode.connect(convolver);
          convolver.connect(node.pannerNode);
          
          node.convolver = convolver;
          console.log('🎧 Added reverb for user:', userId);
        } catch (error) {
          console.error('Failed to add reverb for user:', userId, error);
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
          
          console.log('🎧 Removed reverb for user:', userId);
        } catch (error) {
          console.error('Failed to remove reverb for user:', userId, error);
        }
      }
    });
  }

  // Force immediate spatial effects update (public method for testing)
  forceUpdateSpatialEffects(): void {
    console.log('🎧 Force updating spatial effects...');
    
    // Ensure audio context is running
    if (this.audioContext && this.audioContext.state !== 'running') {
      this.audioContext.resume().then(() => {
        this.updateSpatialEffects();
      });
    } else {
      this.updateSpatialEffects();
    }
  }

  // =============================================================================
  // CLEANUP
  // =============================================================================

  destroy(): void {
    // Remove all users
    this.spatialNodes.forEach((_, userId) => {
      this.removeUserCompletely(userId);
    });
    
    // Close audio context
    if (this.audioContext && this.audioContext.state !== 'closed') {
      this.audioContext.close();
    }
    
    this.audioContext = null;
    this.destination = null;
    this.listenerUserId = null;
    this.isInitialized = false;
    
    console.log('🎧 Spatial Audio Service destroyed');
  }

  // Test method for debugging - call from browser console
  async testAudioContext(): Promise<void> {
    console.log('🎧 === TESTING AUDIO CONTEXT ===');
    
    if (!this.audioContext) {
      console.log('❌ No AudioContext created');
      return;
    }
    
    console.log('AudioContext state:', this.audioContext.state);
    console.log('AudioContext sample rate:', this.audioContext.sampleRate);
    
    // Try to resume if needed
    if (this.audioContext.state !== 'running') {
      console.log('Attempting to resume AudioContext...');
      try {
        await this.audioContext.resume();
        console.log('✅ AudioContext resumed, new state:', this.audioContext.state);
      } catch (error) {
        console.error('❌ Failed to resume AudioContext:', error);
      }
    }
    
    // Create a test oscillator to verify audio is working
    try {
      const oscillator = this.audioContext.createOscillator();
      const gainNode = this.audioContext.createGain();
      
      oscillator.connect(gainNode);
      gainNode.connect(this.audioContext.destination);
      
      oscillator.frequency.setValueAtTime(440, this.audioContext.currentTime); // A4 note
      gainNode.gain.setValueAtTime(0.1, this.audioContext.currentTime); // Low volume
      
      oscillator.start(this.audioContext.currentTime);
      oscillator.stop(this.audioContext.currentTime + 0.5); // 500ms beep
      
      console.log('🎵 Test tone should play if AudioContext is working');
    } catch (error) {
      console.error('❌ Failed to create test tone:', error);
    }
    
    this.debugAudioRouting();
  }

  // Debug method to manually scan for remote users and set up spatial audio
  async debugScanForRemoteUsers(): Promise<void> {
    console.log('🎧 === SCANNING FOR REMOTE USERS ===');
    
    // Import the voice store to check for users
    const { useUnifiedVoiceChannelStore } = await import('@/stores/unifiedVoiceChannel');
    const voiceStore = useUnifiedVoiceChannelStore();
    
    console.log('Voice channel connected:', voiceStore.isConnected);
    console.log('All users count:', voiceStore.allUsers.length);
    console.log('Remote streams count:', voiceStore.remoteStreams.size);
    console.log('Listener user ID:', this.listenerUserId);
    
    // Check each remote user
    voiceStore.allUsers.forEach(user => {
      if (user.userId !== this.listenerUserId) {
        console.log(`🎧 Remote user found: ${user.userId}`, {
          isAudioEnabled: user.isAudioEnabled,
          hasStream: voiceStore.remoteStreams.has(user.userId)
        });
        
        // Try to get their audio element
        const audioElement = (window as any).unifiedWebRTC?.getUserAudioElement(user.userId);
        console.log(`🎧 Audio element for ${user.userId}:`, !!audioElement);
        
        if (audioElement) {
          console.log(`🎧 Audio element details for ${user.userId}:`, {
            src: audioElement.src || 'No src',
            srcObject: !!audioElement.srcObject,
            paused: audioElement.paused,
            muted: audioElement.muted,
            volume: audioElement.volume,
            readyState: audioElement.readyState
          });
          
          // Try to set up spatial audio for this user
          this.setupSpatialForUser(user.userId, audioElement);
        }
      }
    });
    
    console.log('🎧 === END SCAN ===');
  }

  // Fallback method to enable direct audio playback when spatial audio is disabled
  async enableDirectAudioPlayback(): Promise<void> {
    console.log('🔊 Enabling direct audio playback (spatial audio disabled)');
    
    // Import the voice store to get all remote users
    const { useUnifiedVoiceChannelStore } = await import('@/stores/unifiedVoiceChannel');
    const voiceStore = useUnifiedVoiceChannelStore();
    
    // Start playback for all remote users that don't have spatial audio
    voiceStore.allUsers.forEach(async (user) => {
      if (user.userId !== this.listenerUserId) {
        const audioElement = (window as any).unifiedWebRTC?.getUserAudioElement(user.userId);
        if (audioElement && !this.spatialNodes.has(user.userId)) {
          console.log('🔊 Restoring direct playback for user:', user.userId);
          try {
            // Restore the original play method
            if ((audioElement as any)._originalPlay) {
              audioElement.play = (audioElement as any)._originalPlay;
            }
            
            // Unmute and start playback
            audioElement.muted = false;
            if (audioElement.paused) {
              await audioElement.play();
              console.log('🔊 Direct playback started for user:', user.userId);
            }
          } catch (error) {
            console.error('🔊 Failed to start direct playback for user:', user.userId, error);
          }
        }
      }
    });
  }

  // Debug method to test if spatial audio is actually working
  async testSpatialAudioRouting(): Promise<void> {
    console.log('🎧 === TESTING SPATIAL AUDIO ROUTING ===');
    
    if (this.spatialNodes.size === 0) {
      console.log('❌ No spatial audio nodes to test');
      return;
    }
    
    // First, check if audio elements are muted or paused
    this.spatialNodes.forEach((node, userId) => {
      console.log(`🎧 CRITICAL CHECK for user ${userId}:`, {
        audioElementMuted: node.audioElement?.muted,
        audioElementPaused: node.audioElement?.paused,
        audioElementVolume: node.audioElement?.volume,
        audioElementSrcObject: !!node.audioElement?.srcObject,
        gainNodeValue: node.gainNode?.gain.value,
        pannerNodeValue: node.pannerNode instanceof StereoPannerNode ? node.pannerNode.pan.value : 'N/A'
      });
      
      // CRITICAL: Audio element MUST be muted to prevent direct playback
      // MediaElementSourceNode processes audio even when the element is muted
      if (!node.audioElement?.muted) {
        console.error(`❌ CRITICAL: Audio element for ${userId} is NOT MUTED! This causes audio doubling!`);
        console.log(`🎧 Forcing audio element mute for ${userId} to prevent direct playback`);
        if (node.audioElement) {
          node.audioElement.muted = true;
        }
      } else {
        console.log(`✅ Audio element for ${userId} is correctly muted - only Web Audio API routing`);
      }
    });
    
    // For each spatial node, temporarily set extreme values to test if routing works
    this.spatialNodes.forEach((node, userId) => {
      console.log(`🎧 Testing routing for user: ${userId}`);
      
      // Test 1: Set gain to 0.1 (very low) for 2 seconds
      console.log(`🎧 Test 1: Setting gain to 0.1 for ${userId}`);
      node.gainNode.gain.setValueAtTime(0.1, this.audioContext!.currentTime);
      
      // Test 2: Set extreme panning for 2 seconds
      if (node.pannerNode instanceof StereoPannerNode) {
        console.log(`🎧 Test 2: Setting panning to -1.0 (full left) for ${userId}`);
        node.pannerNode.pan.setValueAtTime(-1.0, this.audioContext!.currentTime);
      }
      
      // Reset after 2 seconds
      setTimeout(() => {
        console.log(`🎧 Resetting audio effects for ${userId}`);
        node.gainNode.gain.setValueAtTime(1.0, this.audioContext!.currentTime);
        if (node.pannerNode instanceof StereoPannerNode) {
          node.pannerNode.pan.setValueAtTime(0.0, this.audioContext!.currentTime);
        }
        
        // Restore original mute state if it was muted
        const originallyMuted = (window as any).unifiedWebRTC?.localMediaState?.isDeafened || false;
        if (node.audioElement && originallyMuted) {
          console.log(`🎧 Restoring mute state for ${userId}`);
          node.audioElement.muted = true;
        }
      }, 2000);
    });
    
    console.log('🎧 If you heard the audio get quieter and pan left, then routing is working!');
    console.log('🎧 If you heard no change, then audio is still playing directly through HTMLAudioElement');
    console.log('🎧 === END ROUTING TEST ===');
  }

  // =============================================================================
  // CLEANUP
  // =============================================================================
}

// Export singleton instance
export const spatialAudioService = new SpatialAudioService();

// Make available globally for debugging
if (typeof window !== 'undefined') {
  (window as any).spatialAudioService = spatialAudioService;
}
