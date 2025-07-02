<template>
  <div class="user-profile" ref="targetRef">
    <div class="avatar-container">
      <img :src="profile?.avatar_url" alt="User Avatar" class="avatar">
      <span :class="getUserStatusClass(profile?.status ?? 0)" class="status-indicator"></span>
    </div>
    <div class="user-info">
      <p class="user-name">{{ profile?.display_name }}</p>
      <div class="user-status-container" @click="toggleStatusDropdown">
        <span>{{ getUserStatusText(profile?.status ?? 0) }}</span>
      </div>
    </div>

    <div class="buttons">
      <div class="icon-button" @click="toggleMic" :class="{ muted: !isMicActive }"><MicIcon :isMicActive="isMicActive" /></div>
      <div class="icon-button" @click="toggleHeadphones" :class="{ muted: !isHeadphonesActive }"><HeadphonesIcon :isHeadphonesActive="isHeadphonesActive" /></div>
      <div class="icon-button settings" @click="goToSettings"><SettingsIcon/></div>
    </div>

    <div class="status-dropdown" v-if="showStatusDropdown">
      <select v-model="selectedStatus" @change="handleStatusChange">
        <option value="1">Online</option>
        <option value="2">Away</option>
        <option value="3">Do Not Disturb</option>
        <option value="0">Invisible</option>
      </select>
    </div>
  </div>
</template>

<script lang="ts">
  import { defineComponent, ref, onMounted, onBeforeUnmount } from 'vue';
  import { useAuthStore } from '@/stores/auth';
  import { getProfileWithAvatarUrl } from '@/services/profileService';
  import { useRouter } from 'vue-router';
  import type { User } from '@/types';
  import { updateUserStatus } from '@/services/profileService';
  import { UserStatus } from '@/types';
  import MicIcon from '@/components/icons/Mic.vue';
  import HeadphonesIcon from '@/components/icons/Headphones.vue';
  import SettingsIcon from '@/components/icons/Settings.vue';
  
  export default defineComponent({
    components: {
      MicIcon,
      HeadphonesIcon,
      SettingsIcon
    },
    setup() {
      const authStore = useAuthStore();
      const router = useRouter();
      const profile = ref<User | null>(null);
      const showStatusDropdown = ref(false);
      const selectedStatus = ref(UserStatus.Offline);
      const isMicActive = ref(false);
      const isHeadphonesActive = ref(true);
      const targetRef = ref<HTMLElement | null>(null);

      // Audio effects
      const cameraOnSound = ref(new Audio('/assets/sounds/camera_on.mp3'));
      const cameraOffSound = ref(new Audio('/assets/sounds/camera_off.mp3'));

      const toggleMic = () => {
        isMicActive.value = !isMicActive.value;
        if (!isHeadphonesActive.value) {
          isMicActive.value = false;
          cameraOffSound.value.volume = 0.35;
          cameraOffSound.value.play();
        } else {
          // TODO: only turn back on the mic if it was already set to "on" (observe the inspiration app's behaviour for this)
          cameraOnSound.value.volume = 0.35;
          cameraOnSound.value.play();
        }
      };

      const toggleHeadphones = () => {
        isHeadphonesActive.value = !isHeadphonesActive.value;
        if (!isHeadphonesActive.value) {
          isMicActive.value = false;
          cameraOffSound.value.volume = 0.35;
          cameraOffSound.value.play();
        } else {
          // TODO: only turn back on the mic if it was already set to "on" (observe the inspiration app's behaviour for this)
          cameraOnSound.value.volume = 0.35;
          cameraOnSound.value.play();
        }
      };

      const toggleStatusDropdown = () => {
        showStatusDropdown.value = !showStatusDropdown.value;
      };

      const handleStatusChange = async () => {
        await updateStatus();
        showStatusDropdown.value = false; // Close dropdown after selection
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
            return 'Offline';
        }
      };
      const goToSettings = () => {
        router.push({ name: 'Profile' });
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
        handleStatusChange,
        targetRef
      };
    },
  });
  </script>

<style scoped>
.user-profile {
  display: flex;
  align-items: center;
  justify-content: space-between;
  position: fixed;
  bottom: 0;
  width: 240px;
  background: var(--h-black-dark);
  padding: 10px;
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
}

.buttons {
  display: flex;
  gap: 4px;
}

.status-dropdown {
  position: absolute;
  bottom: 100%;
  left: 10px;
  right: 10px;
  background: var(--h-black-dark);
  border-radius: 4px;
  padding: 8px;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
}

.status-dropdown .input-base {
  font-size: 0.9em;
  padding: 6px;
}

@media screen and (max-width: 768px) {
  .user-profile {
    width: 0;
    overflow: hidden;
    padding: 0;
    display: none;
  }
  .user-profile.open {
    width: calc(100% - 60px);
    display: flex;
    padding: 10px;
  }
}
</style>
