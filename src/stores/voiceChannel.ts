// src/stores/voiceChannelStore.ts
import { defineStore } from 'pinia';
import type { Profile } from '@/types';

interface ProfilePosition {
  x: number;
  y: number;
}

interface VoiceChannelState {
  profiles: Profile[]; // Assuming you have a Profile type
  positions: Record<string, ProfilePosition>;
}

export const useVoiceChannelStore = defineStore('voiceChannel', {
  state: (): VoiceChannelState => ({
    profiles: [],
    positions: {},
  }),
  actions: {
    setProfilePosition(profileId: string, position: ProfilePosition) {
      this.positions[profileId] = position;
    },
    // Other actions like adding/removing profiles, etc.
  },
});

// Remember to import and use this store in your Pinia setup in main.js/ts
