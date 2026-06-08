import { defineStore } from 'pinia';
import { debug } from '@/utils/debug'

// =============================================================================
// TYPES
// =============================================================================

export interface UserPosition {
  userId: string;
  x: number;
  y: number;
  z?: number; // For future 3D support
}

export interface SpatialAudioSettings {
  enabled: boolean;
  maxDistance: number;
  rolloffFactor: number;
  panningModel: 'equalpower' | 'HRTF';
  distanceModel: 'linear' | 'inverse' | 'exponential';
  enableReverb: boolean;
  roomSize: number;
  binauralIntensity: number; // 0-1, controls how dramatic the binaural effect is
}

interface SpatialAudioState {
  // Settings
  settings: SpatialAudioSettings;
  
  // UI State
  isPanelVisible: boolean;
  panelSize: { width: number; height: number };
  gridScale: number;
  
  // User positions
  userPositions: Map<string, UserPosition>;
  
  // Dragging state
  isDragging: boolean;
  draggedUserId: string | null;
  dragOffset: { x: number; y: number };
}

// =============================================================================
// STORE
// =============================================================================

export const useSpatialAudioStore = defineStore('spatialAudio', {
  state: (): SpatialAudioState => ({
    settings: {
      enabled: true, // Enable by default for testing
      maxDistance: 300,
      rolloffFactor: 1,
      panningModel: 'HRTF', // HRTF panning from 2D X/Y layout (PannerNode; Z unused in UI)
      distanceModel: 'inverse',
      enableReverb: false,
      roomSize: 0.5,
      binauralIntensity: 0.7 // 70% intensity by default - balanced between subtle and dramatic
    },
    
    isPanelVisible: false,
    panelSize: { width: 600, height: 400 },
    gridScale: 1,
    
    userPositions: new Map(),
    
    isDragging: false,
    draggedUserId: null,
    dragOffset: { x: 0, y: 0 }
  }),

  // =============================================================================
  // GETTERS
  // =============================================================================
  
  getters: {
    // Get position for specific user
    getUserPosition: (state) => (userId: string): UserPosition | null => {
      return state.userPositions.get(userId) || null;
    },
    
    // Get all positions as array
    allPositions: (state): UserPosition[] => {
      return Array.from(state.userPositions.values());
    },
    
    // Calculate distance between two users
    getDistanceBetween: (state) => (userId1: string, userId2: string): number => {
      const pos1 = state.userPositions.get(userId1);
      const pos2 = state.userPositions.get(userId2);
      
      if (!pos1 || !pos2) return state.settings.maxDistance;
      
      const dx = pos1.x - pos2.x;
      const dy = pos1.y - pos2.y;
      return Math.sqrt(dx * dx + dy * dy);
    },
    
    // Calculate audio gain based on distance
    getAudioGain: (state) => (userId1: string, userId2: string): number => {
      if (!state.settings.enabled) return 1;
      
      const pos1 = state.userPositions.get(userId1);
      const pos2 = state.userPositions.get(userId2);
      
      if (!pos1 || !pos2) return 1;
      
      const dx = pos1.x - pos2.x;
      const dy = pos1.y - pos2.y;
      const distance = Math.sqrt(dx * dx + dy * dy);
      const maxDistance = state.settings.maxDistance;
      
      if (distance >= maxDistance) return 0;
      
      let gain = 1;
      switch (state.settings.distanceModel) {
        case 'linear':
          gain = Math.max(0, 1 - (distance / maxDistance));
          break;
        case 'inverse':
          gain = 1 / (1 + state.settings.rolloffFactor * distance / 50);
          break;
        case 'exponential':
          gain = Math.pow(Math.max(0, 1 - distance / maxDistance), state.settings.rolloffFactor);
          break;
        default:
          gain = 1;
      }
      
      // Note: Removed per-frame debug logging for performance
      return gain;
    },
    
    // Calculate panning (-1 to 1, left to right)
    getPanning: (state) => (userId1: string, userId2: string): number => {
      if (!state.settings.enabled) return 0;
      
      const pos1 = state.userPositions.get(userId1);
      const pos2 = state.userPositions.get(userId2);
      
      if (!pos1 || !pos2) return 0;
      
      const dx = pos2.x - pos1.x;
      const maxPan = state.settings.maxDistance / 2;
      
      const panning = Math.max(-1, Math.min(1, dx / maxPan));
      // Only log occasionally to avoid spam
      if (Math.random() < 0.1) {
        debug.log(`🎧 Audio panning for ${userId2}: ${panning.toFixed(3)} (dx: ${dx.toFixed(1)}px)`);
      }
      return panning;
    }
  },

  // =============================================================================
  // ACTIONS
  // =============================================================================
  
  actions: {
    // Toggle spatial audio on/off with proper AudioContext management
    async toggleSpatialAudio(): Promise<void> {
      this.settings.enabled = !this.settings.enabled;
      
      debug.log('🎧 Toggling spatial audio:', this.settings.enabled ? 'ON' : 'OFF');
      
      try {
        // Import services - use webrtcManager for transport-agnostic audio control
        const { spatialAudioService } = await import('@/services/spatialAudio');
        const { webrtcManager } = await import('@/services/webrtcManager');
        
        if (this.settings.enabled) {
          // First disable traditional audio to prevent double output
          webrtcManager.setTraditionalAudioEnabled(false);
          debug.log('🔇 Traditional audio disabled');
          
          // Then enable spatial audio - this will create AudioContext if needed
          await spatialAudioService.enableSpatialAudio();
          debug.log('🎧 Spatial audio enabled');
          
          // Setup spatial audio for any existing users
          const allUsers = webrtcManager.getAllUsers();
          const localUserId = webrtcManager.getLocalState().userId;
          
          // Initialize local user position at center if not set
          if (!this.userPositions.has(localUserId)) {
            this.initializeUserPosition(localUserId, true); // true = isLocalUser
          }
          
          for (const user of allUsers) {
            if (user.userId !== localUserId) {
              // Initialize remote user position if not set
              if (!this.userPositions.has(user.userId)) {
                this.initializeUserPosition(user.userId, false); // false = remote user
                debug.log(`🎧 Initialized position for user: ${user.userId}`);
              }
              
              const userStream = webrtcManager.getUserStream(user.userId);
              if (userStream) {
                debug.log(`🎧 Setting up spatial audio for existing user: ${user.userId}`);
                await spatialAudioService.setupSpatialForUser(user.userId, userStream);
              }
            }
          }
          
          // Force an immediate spatial effects update
          spatialAudioService.updateSpatialEffects();
          debug.log('🎧 Initial spatial effects applied');
          
        } else {
          // Disable spatial audio but keep AudioContext for potential re-enabling
          spatialAudioService.disableSpatialAudio();
          debug.log('🎧 Spatial audio disabled');
          
          // Re-enable traditional HTMLAudioElement playback
          webrtcManager.setTraditionalAudioEnabled(true);
          debug.log('🔊 Traditional audio re-enabled');
        }
        
        debug.log('✅ Spatial audio toggle completed');
      } catch (error) {
        debug.error('❌ Failed to toggle spatial audio:', error);
        // Revert the setting on error
        this.settings.enabled = !this.settings.enabled;
        throw error;
      }
    },
    
    // Initialize spatial audio when first needed
    async initializeSpatialAudio(): Promise<void> {
      if (!this.settings.enabled) {
        debug.log('🎧 Spatial audio disabled - skipping initialization');
        return;
      }
      
      try {
        const { spatialAudioService } = await import('@/services/spatialAudio');
        await spatialAudioService.initialize();
        debug.log('✅ Spatial audio initialized');
      } catch (error) {
        debug.error('❌ Failed to initialize spatial audio:', error);
        throw error;
      }
    },
    
    // Toggle panel visibility
    togglePanel(): void {
      this.isPanelVisible = !this.isPanelVisible;
    },
    
    // Show/hide panel
    showPanel(): void {
      this.isPanelVisible = true;
    },
    
    hidePanel(): void {
      this.isPanelVisible = false;
    },
    
    // Update user position
    setUserPosition(userId: string, x: number, y: number, z?: number): void {
      this.userPositions.set(userId, { userId, x, y, z });
    },
    
    // Remove user position
    removeUserPosition(userId: string): void {
      this.userPositions.delete(userId);
    },
    
    // Initialize user at position (local user at center, remote users random)
    initializeUserPosition(userId: string, isLocalUser: boolean = false): void {
      if (this.userPositions.has(userId)) return;
      
      const centerX = this.panelSize.width / 2;
      const centerY = this.panelSize.height / 2;
      
      if (isLocalUser) {
        // Local user (listener) always at center
        this.setUserPosition(userId, centerX, centerY);
        debug.log(`🎧 Initialized LOCAL user at center: (${centerX}, ${centerY})`);
      } else {
        // Remote users at random positions around center
        const radius = Math.min(this.panelSize.width, this.panelSize.height) / 4;
        
        const angle = Math.random() * 2 * Math.PI;
        const distance = Math.random() * radius;
        
        const x = centerX + Math.cos(angle) * distance;
        const y = centerY + Math.sin(angle) * distance;
        
        this.setUserPosition(userId, x, y);
        debug.log(`🎧 Initialized remote user at random: (${x.toFixed(0)}, ${y.toFixed(0)})`);
      }
    },
    
    // Start dragging a user
    startDrag(userId: string, startX: number, startY: number): void {
      this.isDragging = true;
      this.draggedUserId = userId;
      
      const userPos = this.userPositions.get(userId);
      if (userPos) {
        this.dragOffset = {
          x: startX - userPos.x,
          y: startY - userPos.y
        };
      }
    },
    
    // Update drag position
    updateDrag(x: number, y: number): void {
      if (!this.isDragging || !this.draggedUserId) return;
      
      const newX = Math.max(20, Math.min(this.panelSize.width - 20, x - this.dragOffset.x));
      const newY = Math.max(20, Math.min(this.panelSize.height - 20, y - this.dragOffset.y));
      
      this.setUserPosition(this.draggedUserId, newX, newY);
    },
    
    // End dragging
    endDrag(): void {
      this.isDragging = false;
      this.draggedUserId = null;
      this.dragOffset = { x: 0, y: 0 };
    },
    
    // Update panel size
    setPanelSize(width: number, height: number): void {
      this.panelSize = { width, height };
    },
    
    // Update settings
    updateSettings(newSettings: Partial<SpatialAudioSettings>): void {
      this.settings = { ...this.settings, ...newSettings };
    },
    
    // Reset all audio effects (called when disabling spatial audio)
    resetAudioEffects(): void {
      debug.log('Resetting spatial audio effects');
      // Import and call spatial audio service
      import('@/services/spatialAudio').then(({ spatialAudioService }) => {
        spatialAudioService.disableSpatialAudio();
      });
    },
    
    // Clear all positions (when leaving channel)
    clearAllPositions(): void {
      this.userPositions.clear();
    },
    
    // Reset to default state
    reset(): void {
      this.isPanelVisible = false;
      this.userPositions.clear();
      this.isDragging = false;
      this.draggedUserId = null;
      this.dragOffset = { x: 0, y: 0 };
    }
  }
});
