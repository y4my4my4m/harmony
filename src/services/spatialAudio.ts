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
      
      if (this.audioContext.state === 'suspended') {
        await this.audioContext.resume();
      }
      
      this.destination = this.audioContext.destination;
      this.isInitialized = true;
      
      console.log('🎧 Spatial Audio Service initialized');
    } catch (error) {
      console.error('Failed to initialize spatial audio:', error);
      throw error;
    }
  }

  // =============================================================================
  // USER MANAGEMENT
  // =============================================================================

  setListener(userId: string): void {
    this.listenerUserId = userId;
    console.log('🎧 Set spatial audio listener:', userId);
  }

  setupSpatialForUser(userId: string, audioElement?: HTMLAudioElement): void {
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

    console.log('🎧 Setting up spatial audio for user:', userId);
    
    try {
      // Remove existing node if it exists
      this.removeUser(userId);

      // Create audio source from HTMLAudioElement
      const source = this.audioContext.createMediaElementSource(audioElement);
      
      // Create gain node for volume control
      const gainNode = this.audioContext.createGain();
      
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
      
      if (convolver) {
        gainNode.connect(convolver);
        convolver.connect(pannerNode);
      } else {
        gainNode.connect(pannerNode);
      }
      
      pannerNode.connect(this.destination!);

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
      
      // Apply initial spatial effects
      this.updateSpatialEffects();
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
      // Disconnect all nodes
      if (node.source) {
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

  // =============================================================================
  // SPATIAL EFFECTS
  // =============================================================================

  updateSpatialEffects(): void {
    if (!this.listenerUserId) return;

    const spatialStore = useSpatialAudioStore();
    
    // Only apply spatial effects if spatial audio is enabled
    if (!spatialStore.settings.enabled) {
      return;
    }
    
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
      } else if (node.pannerNode instanceof PannerNode) {
        // Use PannerNode for 3D positioning (simplified to 2D)
        const distance = Math.abs(panning) * 10; // Scale for 3D positioning
        node.pannerNode.setPosition(panning * 10, 0, -distance);
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
    
    this.updateSpatialEffects();
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

  // =============================================================================
  // CLEANUP
  // =============================================================================

  destroy(): void {
    // Remove all users
    this.spatialNodes.forEach((_, userId) => {
      this.removeUser(userId);
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
}

// Export singleton instance
export const spatialAudioService = new SpatialAudioService();