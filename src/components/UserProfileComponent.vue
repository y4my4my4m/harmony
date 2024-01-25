<template>
  <div class="user-profile">
    <img :src="profile?.avatar_url" alt="User Avatar" class="avatar">
    <div class="user-info">
      <p class="user-name">{{ profile?.display_name }}</p>

      <div class="user-status" @click="toggleStatusDropdown">
        <span :class="getUserStatusClass(profile?.status ?? 0)"></span>
        <span>{{ getUserStatusText(profile?.status ?? 0) }}</span>
      </div>
    </div>

    <div class="buttons">
      <div class="icon-button" @click="toggleMic" :class="{ muted: !isMicActive }"><MicIcon :isMicActive="isMicActive" /></div>
      <div class="icon-button" @click="toggleHeadphones" :class="{ muted: !isHeadphonesActive }"><HeadphonesIcon :isHeadphonesActive="isHeadphonesActive" /></div>
      <div class="icon-button settings" @click="goToSettings"><SettingsIcon/></div>
    </div>

    <div class="status-dropdown" v-if="showStatusDropdown">
      <select v-model="selectedStatus" @change="updateStatus">
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
      const micOnSound = ref(new Audio('/assets/sounds/mic_on.mp3'));
      const micOffSound = ref(new Audio('/assets/sounds/mic_off.mp3'));
      const cameraOnSound = ref(new Audio('/assets/sounds/camera_on.mp3'));
      const cameraOffSound = ref(new Audio('/assets/sounds/camera_off.mp3'));
      const isMicActive = ref(false);
      const isHeadphonesActive = ref(true);
      
      const authStore = useAuthStore();
      const profile = ref<User | null>(null);

      const showStatusDropdown = ref(false);

      const toggleMic = () => {
        isMicActive.value = !isMicActive.value;
        if (!isMicActive.value) {
          micOffSound.value.volume = 0.5;
          micOffSound.value.play();
        } else {
          micOnSound.value.volume = 0.5;
          micOnSound.value.play();
        }
      };

      const toggleHeadphones = () => {
        isHeadphonesActive.value = !isHeadphonesActive.value;
        if (!isHeadphonesActive.value) {
          isMicActive.value = false;
          cameraOffSound.value.volume = 0.5;
          cameraOffSound.value.play();
        } else {
          // TODO: only turn back on the mic if it was already set to "on" (observe the inspiration app's behaviour for this)
          cameraOnSound.value.volume = 0.5;
          cameraOnSound.value.play();
        }
      };

      const toggleStatusDropdown = () => {
        showStatusDropdown.value = !showStatusDropdown.value;
      };

      const onClickOutside = (event: any) => {
        if (!event.target.closest('.user-profile')) {
          showStatusDropdown.value = false;
        }
      };

      const selectedStatus = ref(profile.value?.status || UserStatus.Offline);

      const updateStatus = async () => {
        if (authStore.session?.user) {
          await updateUserStatus(authStore.session.user.id, selectedStatus.value);
          // Update the profile status locally
          if (profile.value)
            profile.value.status = selectedStatus.value;
        }
      };

      const router = useRouter();

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

.avatar {
  width: 36px;
  height: 36px;
  border-radius: 50%;
}

.user-info {
  flex-grow: 1;
  margin-left: 10px;
}

.user-name {
  font-weight: bold;
  color: white;
}

.user-status {
  display: flex;
  align-items: center;
  color: #8e9094;
  font-size:10px;
}

.status-online {
  background-color: #43b581; /* Online status color */
}

.status-away {
  background-color: #faa81a; /* Away status color */
}

.status-busy {
  background-color: #f04747; /* Busy status color */
}

.status-offline {
  background-color: #747f8d; /* Offline status color */
}

.status-online, .status-away, .status-busy, .status-offline {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  margin-right: 5px;
}


.buttons {
  display:flex;
  align-items:center;
  justify-content:space-between;
}
.icon-button {
  /* background: none; */
  /* border: none; */
  color: white;
  cursor: pointer;
  padding: 4px;
  margin: 2px;
  /* border-radius: 4px; */
  transition: 0.2s ease-in-out;
  display:flex;
}
/* .icon-button.muted {
  opacity:0.65;
  background:rgba(255,0,0,0.35);
}
.settings {
  filter: grayscale(1) brightness(0.65)
} */
.status-dropdown {
  position: absolute;
  bottom: 100%; /* Position above the user profile */
  left: 50%;
  transform: translateX(-50%);
  background-color: #2f3136;
  border-radius: 8px;
  box-shadow: 0 2px 10px rgba(0, 0, 0, 0.2);
  z-index: 10;
}

.status-dropdown select {
  width: 100%;
  padding: 8px;
  border: none;
  border-radius: 8px;
  background-color: #202225;
  color: white;
  cursor: pointer;
}

.status-dropdown select:focus {
  outline: none;
}

/* Optional: style the options */
.status-dropdown option {
  background-color: #2f3136;
  color: white;
}
@media (max-width: 768px) {
  .user-profile {
    width: 0;
    overflow: hidden;
    padding: 0;
    display: none;
  }
  .user-profile.open {
    width: calc(100% - 60px)
  }
}
</style>
