import { defineStore } from 'pinia';
import { debug } from '@/utils/debug'

export interface UserPosition {
  userId: string;
  x: number;
  y: number;
  z?: number;
}

export interface SpatialAudioSettings {
  enabled: boolean;
  maxDistance: number;
  rolloffFactor: number;
  panningModel: 'equalpower' | 'HRTF';
  distanceModel: 'linear' | 'inverse' | 'exponential';
  enableReverb: boolean;
  roomSize: number;
  binauralIntensity: number;
}

interface SpatialAudioState {
  settings: SpatialAudioSettings;
  isPanelVisible: boolean;
  panelSize: { width: number; height: number };
  gridScale: number;
  userPositions: Map<string, UserPosition>;
  isDragging: boolean;
  draggedUserId: string | null;
  dragOffset: { x: number; y: number };
}

export const useSpatialAudioStore = defineStore('spatialAudio', {
  state: (): SpatialAudioState => ({
    settings: {
      enabled: true,
      maxDistance: 300,
      rolloffFactor: 1,
      panningModel: 'HRTF',
      distanceModel: 'inverse',
      enableReverb: false,
      roomSize: 0.5,
      binauralIntensity: 0.7,
    },
    isPanelVisible: false,
    panelSize: { width: 600, height: 400 },
    gridScale: 1,
    userPositions: new Map(),
    isDragging: false,
    draggedUserId: null,
    dragOffset: { x: 0, y: 0 }
  }),

  getters: {
    getUserPosition: (state) => (userId: string): UserPosition | null => {
      return state.userPositions.get(userId) || null;
    },

    allPositions: (state): UserPosition[] => {
      return Array.from(state.userPositions.values());
    },

    getDistanceBetween: (state) => (userId1: string, userId2: string): number => {
      const pos1 = state.userPositions.get(userId1);
      const pos2 = state.userPositions.get(userId2);

      if (!pos1 || !pos2) return state.settings.maxDistance;

      const dx = pos1.x - pos2.x;
      const dy = pos1.y - pos2.y;
      return Math.sqrt(dx * dx + dy * dy);
    },

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

      return gain;
    },

    getPanning: (state) => (userId1: string, userId2: string): number => {
      if (!state.settings.enabled) return 0;

      const pos1 = state.userPositions.get(userId1);
      const pos2 = state.userPositions.get(userId2);

      if (!pos1 || !pos2) return 0;

      const dx = pos2.x - pos1.x;
      const maxPan = state.settings.maxDistance / 2;

      const panning = Math.max(-1, Math.min(1, dx / maxPan));
      if (Math.random() < 0.1) {
        debug.log(`🎧 Audio panning for ${userId2}: ${panning.toFixed(3)} (dx: ${dx.toFixed(1)}px)`);
      }
      return panning;
    }
  },

  actions: {
    async toggleSpatialAudio(): Promise<void> {
      this.settings.enabled = !this.settings.enabled;

      debug.log('🎧 Toggling spatial audio:', this.settings.enabled ? 'ON' : 'OFF');

      try {
        const { spatialAudioService } = await import('@/services/spatialAudio');
        const { webrtcManager } = await import('@/services/webrtcManager');

        if (this.settings.enabled) {
          webrtcManager.setTraditionalAudioEnabled(false);
          debug.log('🔇 Traditional audio disabled');

          await spatialAudioService.enableSpatialAudio();
          debug.log('🎧 Spatial audio enabled');

          const allUsers = webrtcManager.getAllUsers();
          const localUserId = webrtcManager.getLocalState().userId;

          if (!this.userPositions.has(localUserId)) {
            this.initializeUserPosition(localUserId, true);
          }

          for (const user of allUsers) {
            if (user.userId !== localUserId) {
              if (!this.userPositions.has(user.userId)) {
                this.initializeUserPosition(user.userId, false);
                debug.log(`🎧 Initialized position for user: ${user.userId}`);
              }

              // Mic only - the combined stream can also carry screenshare
              // audio, which must stay stereo and out of the spatial graph
              const micStream = webrtcManager.getUserMicStream(user.userId);
              if (micStream) {
                debug.log(`🎧 Setting up spatial audio for existing user: ${user.userId}`);
                await spatialAudioService.setupSpatialForUser(user.userId, micStream);
              }
            }
          }

          spatialAudioService.updateSpatialEffects();
          debug.log('🎧 Initial spatial effects applied');

        } else {
          spatialAudioService.disableSpatialAudio();
          debug.log('🎧 Spatial audio disabled');

          webrtcManager.setTraditionalAudioEnabled(true);
          debug.log('🔊 Traditional audio re-enabled');
        }

        debug.log('✅ Spatial audio toggle completed');
      } catch (error) {
        debug.error('❌ Failed to toggle spatial audio:', error);
        this.settings.enabled = !this.settings.enabled;
        throw error;
      }
    },

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

    togglePanel(): void {
      this.isPanelVisible = !this.isPanelVisible;
    },

    showPanel(): void {
      this.isPanelVisible = true;
    },

    hidePanel(): void {
      this.isPanelVisible = false;
    },

    setUserPosition(userId: string, x: number, y: number, z?: number): void {
      this.userPositions.set(userId, { userId, x, y, z });
    },

    removeUserPosition(userId: string): void {
      this.userPositions.delete(userId);
    },

    initializeUserPosition(userId: string, isLocalUser: boolean = false): void {
      if (this.userPositions.has(userId)) return;

      const centerX = this.panelSize.width / 2;
      const centerY = this.panelSize.height / 2;

      if (isLocalUser) {
        this.setUserPosition(userId, centerX, centerY);
        debug.log(`🎧 Initialized LOCAL user at center: (${centerX}, ${centerY})`);
      } else {
        const radius = Math.min(this.panelSize.width, this.panelSize.height) / 4;
        const angle = Math.random() * 2 * Math.PI;
        const distance = Math.random() * radius;
        const x = centerX + Math.cos(angle) * distance;
        const y = centerY + Math.sin(angle) * distance;

        this.setUserPosition(userId, x, y);
        debug.log(`🎧 Initialized remote user at random: (${x.toFixed(0)}, ${y.toFixed(0)})`);
      }
    },

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

    updateDrag(x: number, y: number): void {
      if (!this.isDragging || !this.draggedUserId) return;

      const newX = Math.max(20, Math.min(this.panelSize.width - 20, x - this.dragOffset.x));
      const newY = Math.max(20, Math.min(this.panelSize.height - 20, y - this.dragOffset.y));

      this.setUserPosition(this.draggedUserId, newX, newY);
    },

    endDrag(): void {
      this.isDragging = false;
      this.draggedUserId = null;
      this.dragOffset = { x: 0, y: 0 };
    },

    setPanelSize(width: number, height: number): void {
      this.panelSize = { width, height };
    },

    updateSettings(newSettings: Partial<SpatialAudioSettings>): void {
      this.settings = { ...this.settings, ...newSettings };
    },

    resetAudioEffects(): void {
      debug.log('Resetting spatial audio effects');
      import('@/services/spatialAudio').then(({ spatialAudioService }) => {
        spatialAudioService.disableSpatialAudio();
      });
    },

    clearAllPositions(): void {
      this.userPositions.clear();
    },

    reset(): void {
      this.isPanelVisible = false;
      this.userPositions.clear();
      this.isDragging = false;
      this.draggedUserId = null;
      this.dragOffset = { x: 0, y: 0 };
    }
  }
});
