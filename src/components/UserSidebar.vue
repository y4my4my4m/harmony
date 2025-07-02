<template>
  <div class="user-sidebar">
    <div v-for="user in users" :key="user.id" class="user-item" @click="showUserProfile(user, $event)">
      <div class="user-avatar-container">
        <img :src="getUserAvatar(user.id)" alt="User avatar" class="avatar-md" />
        <span :class="getUserStatusClass(user.status)" class="user-status"></span>
      </div>
      <span class="user-name text-ellipsis">{{ getUserDisplayName(user.id) }}</span>
    </div>

    <div v-if="selectedUser" 
         :class="['user-profile-card', { 'selected': selectedUser }]" 
         :style="profileCardStyle" 
         @click.stop>
      <UserPreviewComponent :user="selectedUser" :closeProfile="closeProfile" />
    </div>
  </div>
</template>

<script lang="ts">
import { defineComponent, ref, watch } from 'vue'
import type { User } from '@/types'
import UserPreviewComponent from './UserPreviewComponent.vue'
import { useServerChannelStore } from '@/stores/useServerChannel'
import { useServerUsersStore } from '@/stores/useServerUsers'
import { useUserProfile } from '@/composables/useUserProfile'
import { getUserIdsForServer } from '@/services/usersService'

export default defineComponent({
  name: 'UserSidebar',
  components: { 
    UserPreviewComponent 
  },
  setup() {
    const serverChannelStore = useServerChannelStore()
    const serverUsersStore = useServerUsersStore()
    const { getUserAvatar, getUserDisplayName, getUserStatusClass } = useUserProfile()
    
    const users = ref<User[]>([])
    const selectedUser = ref<User | null>(null)
    const profileCardStyle = ref({ top: '0px' })

    const fetchAndSetUsers = async (serverId: string | null) => {
      if (serverId) {
        try {
          const userIds = await getUserIdsForServer(serverId)
          await serverUsersStore.fetchUserProfiles(userIds)
          users.value = userIds.map(userId => 
            serverUsersStore.userProfiles[userId] || { 
              id: userId, 
              display_name: 'Loading...',
              avatar_url: '/default_avatar.png',
              status: 0
            }
          ).filter(Boolean)
        } catch (error) {
          console.error('Error fetching users:', error)
          users.value = []
        }
      }
    }

    const showUserProfile = (user: User, event: MouseEvent) => {
      selectedUser.value = user
      const rect = (event.target as HTMLElement).getBoundingClientRect()
      profileCardStyle.value = { 
        top: `${rect.top}px` 
      }
    }

    const closeProfile = () => {
      selectedUser.value = null
    }

    watch(() => serverChannelStore.currentServerId, (newServerId) => {
      fetchAndSetUsers(newServerId)
      selectedUser.value = null // Close any open profile when switching servers
    }, { immediate: true })

    return {
      users,
      selectedUser,
      profileCardStyle,
      showUserProfile,
      closeProfile,
      getUserAvatar,
      getUserDisplayName,
      getUserStatusClass
    }
  }
})
</script>

<style scoped>
.user-sidebar {
  width: 240px;
  background-color: var(--h-sidebar);
  padding: 16px 8px;
  overflow-y: auto;
  position: relative;
}

.user-item {
  display: flex;
  align-items: center;
  padding: 8px 12px;
  margin-bottom: 4px;
  border-radius: 6px;
  cursor: pointer;
  transition: background-color 0.2s;
}

.user-item:hover {
  background-color: rgba(255, 255, 255, 0.1);
}

.user-avatar-container {
  position: relative;
  margin-right: 12px;
  flex-shrink: 0;
}

.user-name {
  color: #b3b3b3;
  font-size: 0.9em;
  font-weight: 500;
  max-width: 140px;
}

.user-profile-card {
  position: fixed;
  right: 8px;
  width: 300px;
  z-index: 1000;
  background-color: var(--h-black);
  border-radius: 8px;
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
}

/* Mobile responsive */
@media screen and (max-width: 768px) {
  .user-sidebar {
    width: 0;
    overflow: hidden;
    padding: 0;
  }
  
  .user-sidebar.open {
    width: calc(100% - 72px);
    padding: 16px 8px;
  }
  
  .user-profile-card {
    position: fixed;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    width: 90vw;
    max-width: 400px;
  }
}
</style>
