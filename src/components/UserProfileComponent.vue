<template>
  <div class="user-profile">
    <img :src="profile?.avatar_url" alt="User Avatar" class="avatar">
    <div class="user-info">
      <p class="user-name">{{ profile?.display_name }}</p>
      <div class="user-status-container" @click="toggleStatusDropdown">
        <span :class="getUserStatusClass(profile?.status ?? 0)" class="user-status"></span>
        <span>{{ getUserStatusText(profile?.status ?? 0) }}</span>
      </div>
    </div>

    <div class="buttons">
      <button class="icon-button" @click="toggleMic" :class="{ muted: !isMicActive }">
        <MicIcon :isMicActive="isMicActive" />
      </button>
      <button class="icon-button" @click="toggleHeadphones" :class="{ muted: !isHeadphonesActive }">
        <HeadphonesIcon :isHeadphonesActive="isHeadphonesActive" />
      </button>
      <button class="icon-button settings" @click="goToSettings">
        <SettingsIcon/>
      </button>
    </div>

    <div class="status-dropdown" v-if="showStatusDropdown">
      <select v-model="selectedStatus" @change="updateStatus" class="input-base">
        <option value="1">Online</option>
        <option value="2">Away</option>
        <option value="3">Do Not Disturb</option>
        <option value="0">Invisible</option>
      </select>
    </div>
  </div>
</template>

<script lang="ts">
import { defineComponent, ref, onMounted } from 'vue'
import { useAuthStore } from '@/stores/auth'
import { getProfileWithAvatarUrl, updateUserStatus } from '@/services/profileService'
import { useRouter } from 'vue-router'
import { useUserProfile } from '@/composables/useUserProfile'
import { useAudioEffects, useClickOutside } from '@/composables/useCommonUI'
import type { User } from '@/types'
import { UserStatus } from '@/types'
import MicIcon from '@/components/icons/Mic.vue'
import HeadphonesIcon from '@/components/icons/Headphones.vue'
import SettingsIcon from '@/components/icons/Settings.vue'

export default defineComponent({
  name: 'UserProfileComponent',
  components: {
    MicIcon,
    HeadphonesIcon,
    SettingsIcon
  },
  setup() {
    const authStore = useAuthStore()
    const router = useRouter()
    const { getUserStatusClass, getUserStatusText } = useUserProfile()
    const { playSound } = useAudioEffects()
    const { targetRef, handleClickOutside } = useClickOutside()

    const profile = ref<User | null>(null)
    const showStatusDropdown = ref(false)
    const selectedStatus = ref(UserStatus.Offline)
    const isMicActive = ref(false)
    const isHeadphonesActive = ref(true)

    const toggleMic = () => {
      isMicActive.value = !isMicActive.value
      const soundPath = isMicActive.value ? '/assets/sounds/mic_on.mp3' : '/assets/sounds/mic_off.mp3'
      playSound(soundPath, 0.35)
    }

    const toggleHeadphones = () => {
      isHeadphonesActive.value = !isHeadphonesActive.value
      if (!isHeadphonesActive.value) {
        isMicActive.value = false
      }
      const soundPath = isHeadphonesActive.value ? '/assets/sounds/camera_on.mp3' : '/assets/sounds/camera_off.mp3'
      playSound(soundPath, 0.35)
    }

    const toggleStatusDropdown = () => {
      showStatusDropdown.value = !showStatusDropdown.value
    }

    const updateStatus = async () => {
      if (authStore.session?.user) {
        await updateUserStatus(authStore.session.user.id, selectedStatus.value)
        if (profile.value) {
          profile.value.status = selectedStatus.value
        }
      }
    }

    const goToSettings = () => {
      router.push({ name: 'Profile' })
    }

    // Handle click outside to close dropdown
    handleClickOutside(() => {
      showStatusDropdown.value = false
    })

    onMounted(async () => {
      if (authStore.session?.user) {
        profile.value = await getProfileWithAvatarUrl(authStore.session.user.id)
        selectedStatus.value = profile.value?.status || UserStatus.Offline
      }
    })

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
      targetRef
    }
  },
})
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

.user-status-container .user-status {
  width: 8px;
  height: 8px;
  margin-right: 6px;
  position: relative;
  border: none;
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
