<template>
  <div class="user-profile" ref="targetRef">
    <Avatar 
      :src="profile?.avatar_url"
      size="md"
      :status="getStatusForAvatar(currentStatus)"
    />
    <div class="user-info">
      <p class="user-name">{{ profile?.display_name }}</p>
      <div class="user-status-container" @click="toggleStatusDropdown">
        <div class="status-dot" :class="getUserStatusClass(currentStatus)"></div>
        <span class="status-text">{{ getUserStatusText(currentStatus) }}</span>
        <svg class="dropdown-arrow" :class="{ rotated: showStatusDropdown }" width="12" height="8" viewBox="0 0 12 8" fill="currentColor">
          <path d="M6 6L10.5 1.5L9 0L6 3L3 0L1.5 1.5L6 6Z"/>
        </svg>
      </div>
    </div>

    <div class="buttons">
      <div 
        class="icon-button" 
        @click="toggleMic" 
        :class="{ 
          muted: !isMicActive,
          'voice-active': isInVoiceChannel
        }"
        :title="isMicActive ? 'Mute' : 'Unmute'"
      >
        <MicIcon v-if="isMicActive" />
        <MicMutedIcon v-else />
      </div>
      <div 
        class="icon-button" 
        @click="toggleHeadphones" 
        :class="{ 
          muted: !isHeadphonesActive,
          'voice-active': isInVoiceChannel
        }"
        :title="isHeadphonesActive ? 'Deafen' : 'Undeafen'"
      >
        <HeadphonesIcon :isHeadphonesActive="isHeadphonesActive" />
      </div>
      <div class="icon-button settings" @click="goToSettings" title="Settings"><SettingsIcon/></div>
    </div>

    <div class="status-dropdown" v-if="showStatusDropdown">
      <div 
        v-for="status in statusOptions" 
        :key="status.value"
        class="status-option"
        :class="{ active: currentStatus === status.value }"
        @click="selectStatus(status.value)"
      >
        <div class="status-dot" :class="status.class"></div>
        <span class="status-text">{{ status.label }}</span>
        <span v-if="currentStatus === status.value" class="checkmark">✓</span>
      </div>
    </div>
  </div>
</template>

<script lang="ts">
  import { defineComponent, ref, onMounted, onBeforeUnmount, computed } from 'vue';
  import { useAuthStore } from '@/stores/auth';
  import { useServerUsersStore } from '@/stores/useServerUsers';
  import { useUnifiedVoiceChannelStore } from '@/stores/unifiedVoiceChannel';
  import { getProfileWithAvatarUrl } from '@/services/profileService';
  import { useRouter } from 'vue-router';
  import type { User } from '@/types';
  import { updateUserStatus } from '@/services/profileService';
  import { UserStatus } from '@/types';
  import MicIcon from '@/components/icons/Mic.vue';
  import MicMutedIcon from '@/components/icons/MicMuted.vue';
  import HeadphonesIcon from '@/components/icons/Headphones.vue';
  import SettingsIcon from '@/components/icons/Settings.vue';
  import Avatar from '@/components/common/Avatar.vue';
  
  export default defineComponent({
    name: 'UserProfileComponent',
    components: {
      MicIcon,
      MicMutedIcon,
      HeadphonesIcon,
      SettingsIcon,
      Avatar
    },
    setup() {
      const authStore = useAuthStore();
      const serverUsersStore = useServerUsersStore();
      const voiceChannelStore = useUnifiedVoiceChannelStore();
      const router = useRouter();
      const profile = ref<User | null>(null);
      const showStatusDropdown = ref(false);
      const selectedStatus = ref(UserStatus.Offline);
      const targetRef = ref<HTMLElement | null>(null);

      // Make status reactive to store changes
      const currentStatus = computed(() => {
        if (!authStore.session?.user?.id) return UserStatus.Offline;
        return serverUsersStore.userProfiles[authStore.session.user.id]?.status ?? UserStatus.Offline;
      });

      const statusOptions = [
        { value: UserStatus.Online, label: 'Online', class: 'status-online' },
        { value: UserStatus.Away, label: 'Away', class: 'status-away' },
        { value: UserStatus.Busy, label: 'Do Not Disturb', class: 'status-busy' },
        { value: UserStatus.Offline, label: 'Invisible', class: 'status-offline' }
      ];

      // Use unified voice system only
      const isMicActive = computed(() => {
        return !voiceChannelStore.localState.isMuted;
      });
      
      const isHeadphonesActive = computed(() => {
        return !voiceChannelStore.localState.isDeafened;
      });
      
      const isInVoiceChannel = computed(() => {
        return voiceChannelStore.isConnected;
      });
      
      // Voice sound effects (proper ones for voice, not camera)
      const micOnSound = ref(new Audio('/assets/sounds/mic_on.mp3'));
      const micOffSound = ref(new Audio('/assets/sounds/mic_off.mp3'));

      const toggleMic = async () => {
        try {
          const wasMuted = voiceChannelStore.localState.isMuted;
          await voiceChannelStore.toggleMute();
          
          // Play appropriate sound effect
          const sound = wasMuted ? micOnSound.value : micOffSound.value;
          sound.volume = 0.35;
          sound.play().catch(e => console.log('Could not play sound:', e));
        } catch (error) {
          console.error('Failed to toggle mute:', error);
        }
      };

      const toggleHeadphones = async () => {
        try {
          const wasDeafened = voiceChannelStore.localState.isDeafened;
          await voiceChannelStore.toggleDeafen();
          
          // Play appropriate sound effect
          // Deafening always results in muting, so play mute sound
          const sound = wasDeafened ? micOnSound.value : micOffSound.value;
          sound.volume = 0.35;
          sound.play().catch(e => console.log('Could not play sound:', e));
        } catch (error) {
          console.error('Failed to toggle deafen:', error);
        }
      };

      const toggleStatusDropdown = () => {
        showStatusDropdown.value = !showStatusDropdown.value;
      };

      const selectStatus = async (status: UserStatus) => {
        selectedStatus.value = status;
        await updateStatus();
        showStatusDropdown.value = false;
      };

      const onClickOutside = (event: any) => {
        if (targetRef.value && !targetRef.value.contains(event.target)) {
          showStatusDropdown.value = false;
        }
      };

      const updateStatus = async () => {
        if (authStore.session?.user) {
          await updateUserStatus(authStore.session.user.id, selectedStatus.value);
          // Update the profile status locally
          if (profile.value)
            profile.value.status = selectedStatus.value;
        }
      };

      // refactor those into helper functions that can be used globally or something
      const getUserStatusClass = (status: UserStatus) => {
        switch (status) {
          case UserStatus.Online:
            return 'status-online';
          case UserStatus.Away:
            return 'status-away';
          case UserStatus.Busy:
            return 'status-busy';
          case UserStatus.Offline:
          default:
            return 'status-offline';
        }
      };

      const getUserStatusText = (status: UserStatus) => {
        switch (status) {
          case UserStatus.Online:
            return 'Online';
          case UserStatus.Away:
            return 'Away';
          case UserStatus.Busy:
            return 'Do Not Disturb';
          case UserStatus.Offline:
          default:
            return 'Invisible';
        }
      };

      const goToSettings = () => {
        router.push({ name: 'UserSettings' });
      };

      onMounted(async () => {
        if (authStore.session?.user) {
          profile.value = await getProfileWithAvatarUrl(authStore.session.user.id);
          selectedStatus.value = profile.value?.status || UserStatus.Offline;
        }
        document.addEventListener('click', onClickOutside);
      });
      onBeforeUnmount(() => {
        document.removeEventListener('click', onClickOutside);
      });

      const getStatusForAvatar = (status: UserStatus): 'online' | 'away' | 'busy' | 'offline' => {
        switch (status) {
          case UserStatus.Online:
            return 'online';
          case UserStatus.Away:
            return 'away';
          case UserStatus.Busy:
            return 'busy';
          case UserStatus.Offline:
          default:
            return 'offline';
        }
      };

      return { 
        profile, 
        goToSettings, 
        selectedStatus, 
        updateStatus, 
        showStatusDropdown, 
        toggleStatusDropdown, 
        getUserStatusClass, 
        getUserStatusText,
        toggleMic,
        toggleHeadphones,
        isMicActive,
        isHeadphonesActive,
        isInVoiceChannel,
        selectStatus,
        targetRef,
        currentStatus,
        statusOptions,
        getStatusForAvatar
      };
    },
  });
  </script>

<style scoped>
.user-profile {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  background: var(--h-black-dark);
  padding: 10px;
  border-top: 1px solid rgba(255, 255, 255, 0.1);
  /* Remove position: fixed since it's now inside the left sidebar container */
}

.avatar-container {
  position: relative;
}

.avatar {
  width: 36px;
  height: 36px;
  border-radius: 50%;
}

.status-indicator {
  width: 10px;
  height: 10px;
  position: absolute;
  bottom: 0;
  right: 0;
  border: 2px solid var(--h-black-dark);
  border-radius: 50%;
}

.status-online {
  background-color: #43b581;
}

.status-away {
  background-color: #faa81a;
}

.status-busy {
  background-color: #f04747;
}

.status-offline {
  background-color: #747f8d;
}

.user-info {
  flex-grow: 1;
  margin-left: 10px;
}

.user-name {
  font-weight: bold;
  color: white;
  margin: 0 0 4px 0;
  font-size: 0.9em;
}

.user-status-container {
  display: flex;
  align-items: center;
  cursor: pointer;
  font-size: 0.8em;
  color: #b3b3b3;
  padding: 4px 6px;
  border-radius: 3px;
  transition: background 0.2s;
  margin-right: 10px;
}

.user-status-container:hover {
  background: rgba(255, 255, 255, 0.1);
}

.buttons {
  display: flex;
  gap: 4px;
}

.icon-button {
  width: 32px;
  height: 32px;
  border-radius: 4px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  transition: all 0.15s ease;
  color: #b9bbbe;
}

.icon-button:hover {
  background-color: rgba(79, 84, 92, 0.4);
  color: #dcddde;
}

.icon-button.muted {
  background-color: #f04747;
  color: #ffffff;
}

.icon-button.muted:hover {
  background-color: #d73c3c;
}

.icon-button.voice-active {
  border: 1px solid rgba(88, 101, 242, 0.3);
  box-shadow: 0 0 4px rgba(88, 101, 242, 0.2);
}

.icon-button.voice-active:hover {
  border-color: rgba(88, 101, 242, 0.5);
  box-shadow: 0 0 6px rgba(88, 101, 242, 0.3);
}

.icon-button.settings:hover {
  background-color: rgba(79, 84, 92, 0.6);
}

.status-dropdown {
  position: absolute;
  bottom: calc(100% + 8px);
  left: 10px;
  right: 10px;
  background: #18191c;
  border-radius: 8px;
  padding: 6px;
  box-shadow: 0 8px 16px rgba(0, 0, 0, 0.4);
  border: 1px solid #202225;
  z-index: 1000;
  animation: slideUp 0.15s ease-out;
}

@keyframes slideUp {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}

.status-option {
  display: flex;
  align-items: center;
  padding: 8px 10px;
  cursor: pointer;
  border-radius: 4px;
  transition: background 0.2s;
  font-size: 0.875rem;
  color: #dcddde;
}

.status-option:hover {
  background: #4f545c;
}

.status-option.active {
  background: #5865f2;
  color: white;
}

.status-option .status-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  margin-right: 10px;
  flex-shrink: 0;
}

.status-text {
  flex-grow: 1;
  font-weight: 500;
}

.checkmark {
  margin-left: auto;
  color: white;
  font-weight: bold;
  font-size: 0.9rem;
}

.dropdown-arrow {
  margin-left: 4px;
  transition: transform 0.2s;
  opacity: 0.7;
}

.dropdown-arrow.rotated {
  transform: rotate(180deg);
}

@media screen and (max-width: 768px) {
  .user-profile {
    width: 100%;
    padding: 8px;
  }
  
  .user-name {
    font-size: 0.8em;
  }
  
  .icon-button {
    width: 28px;
    height: 28px;
  }
}
</style>
