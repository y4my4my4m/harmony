import { defineStore } from 'pinia';

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
      enabled: false,
      maxDistance: 300,
      rolloffFactor: 1,
      panningModel: 'equalpower',
      distanceModel: 'inverse',
      enableReverb: false,
      roomSize: 0.5
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
      
      const distance = (state as any).getDistanceBetween(userId1, userId2);
      const maxDistance = state.settings.maxDistance;
      
      if (distance >= maxDistance) return 0;
      
      switch (state.settings.distanceModel) {
        case 'linear':
          return Math.max(0, 1 - (distance / maxDistance));
        case 'inverse':
          return 1 / (1 + state.settings.rolloffFactor * distance / 50);
        case 'exponential':
          return Math.pow(Math.max(0, 1 - distance / maxDistance), state.settings.rolloffFactor);
        default:
          return 1;
      }
    },
    
    // Calculate panning (-1 to 1, left to right)
    getPanning: (state) => (userId1: string, userId2: string): number => {
      if (!state.settings.enabled) return 0;
      
      const pos1 = state.userPositions.get(userId1);
      const pos2 = state.userPositions.get(userId2);
      
      if (!pos1 || !pos2) return 0;
      
      const dx = pos2.x - pos1.x;
      const maxPan = state.settings.maxDistance / 2;
      
      return Math.max(-1, Math.min(1, dx / maxPan));
    }
  },

  // =============================================================================
  // ACTIONS
  // =============================================================================
  
  actions: {
    // Toggle spatial audio on/off
    toggleSpatialAudio(): void {
      this.settings.enabled = !this.settings.enabled;
      
      // Import and call spatial audio service
      import('@/services/spatialAudio').then(({ spatialAudioService }) => {
        if (!this.settings.enabled) {
          // If disabling, reset all audio effects
          spatialAudioService.disableSpatialAudio();
        } else {
          // If enabling, apply spatial effects
          spatialAudioService.enableSpatialAudio();
        }
      });
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
    
    // Initialize user at random position
    initializeUserPosition(userId: string): void {
      if (this.userPositions.has(userId)) return;
      
      // Place user at random position within bounds
      const centerX = this.panelSize.width / 2;
      const centerY = this.panelSize.height / 2;
      const radius = Math.min(this.panelSize.width, this.panelSize.height) / 4;
      
      const angle = Math.random() * 2 * Math.PI;
      const distance = Math.random() * radius;
      
      const x = centerX + Math.cos(angle) * distance;
      const y = centerY + Math.sin(angle) * distance;
      
      this.setUserPosition(userId, x, y);
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
      console.log('Resetting spatial audio effects');
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
