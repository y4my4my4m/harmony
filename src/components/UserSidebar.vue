<template>
  <div class="user-sidebar">
    <div v-for="user in users" :key="user.id" class="user-item" @click="showUserProfile(user, $event)">
      <div class="user-avatar-container">
        <img :src="user.avatar_url || '/default_avatar.png'" alt="User avatar" class="user-avatar">
        <span :class="getUserStatusClass(user.status)" class="user-status"></span>
      </div>
      <span class="user-name">{{ user.display_name || 'Unknown User' }}</span>
    </div>

    <!-- User profile card (reusable component) -->
    <div v-if="selectedUser" :class="['user-profile-card', { 'selected': selectedUser }]" :style="profileCardStyle" @click.stop>
      <UserPreviewComponent :user="selectedUser" :closeProfile="closeProfile" />
    </div>
  </div>
</template>

<script lang="ts">
import { defineComponent, ref, watch, computed, onMounted } from 'vue';
import type { User } from '@/types';
import UserPreviewComponent from './UserPreviewComponent.vue';
import { useServerChannelStore } from '@/stores/useServerChannel';
import { useServerUsersStore } from '@/stores/useServerUsers';
import { getUserIdsForServer} from '@/services/usersService';
import { UserStatus } from '@/types';

export default defineComponent({
  name: 'UserSidebar',
  components: { UserPreviewComponent },
  setup() {
    const serverChannelStore = useServerChannelStore();
    const serverUsersStore = useServerUsersStore();
    const selectedUser = ref<User | null>(null);
    const profileCardStyle = ref({ top: '0px', left: '-332px' });

    // Make users reactive to store changes
    const users = computed(() => {
      const serverId = serverChannelStore.currentServerId;
      if (!serverId) return [];
      
      return Object.values(serverUsersStore.userProfiles).filter(user => user && user.id);
    });

    const fetchAndSetUsers = async (serverId: string | null) => {
      if (serverId) {
        const userIds = await getUserIdsForServer(serverId);
        await serverUsersStore.fetchUserProfiles(userIds);
      }
    };

    watch(() => serverChannelStore.currentServerId, (newServerId) => {
      fetchAndSetUsers(newServerId);
      selectedUser.value = null; // Close profile when switching servers
    });

    const showUserProfile = (user: User, event: MouseEvent) => {
      const userItemElement = (event.currentTarget as HTMLElement);
      const userSidebar = (event.currentTarget as HTMLElement).closest('.user-sidebar');

      if (userSidebar) {
        const userSidebarRect = userSidebar.getBoundingClientRect();
        const userItemRect = userItemElement.getBoundingClientRect();

        profileCardStyle.value = {
          top: `${userItemRect.top - userSidebarRect.top}px`,
          left: '-332px'
        };
      }

      selectedUser.value = user;
      event.stopPropagation();
    };

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
  
    const closeProfile = () => {
      selectedUser.value = null;
    };

    // Initialize on mount and ensure status subscription is active
    onMounted(() => {
      fetchAndSetUsers(serverChannelStore.currentServerId);
      // Make sure status subscription is active
      serverUsersStore.subscribeToUserStatuses();
    });

    return { users, showUserProfile, selectedUser, profileCardStyle, closeProfile, getUserStatusClass };
  }
});
</script>

<style scoped>
.user-sidebar {
  width: 240px;
  background-color: var(--h-sidebar);
  padding: 10px;
  position: relative;
}

.user-item {
  display: flex;
  align-items: center;
  cursor: pointer;
  padding: 5px;
  position: relative;
}

.user-item:hover {
  background-color: var(--h-sidebar-light);
}

.user-avatar-container {
  position: relative;
}

.user-avatar {
  width: 30px;
  height: 30px;
  border-radius: 50%;
  margin-right: 10px;
}

.user-status {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  position: absolute;
  right: 8px;
  bottom: 4px;
  border: 2px solid var(--h-sidebar);
  z-index: 1;
}

.user-name {
  color: #b3b3b3;
  font-size: 0.9em;
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

.user-profile-card {
  position: absolute;
  left: -332px;
  width: 320px; 
  height: 400px;
  border-radius: 12px;
  background-color: #2f3339; 
  z-index: 1000;
  padding: 10px;
  opacity: 0;
  transition: 0.2s ease-in-out;
  box-shadow: 0 3px 6px rgba(0,0,0,0.16), 0 3px 6px rgba(0,0,0,0.23);
  transition: all 0.3s cubic-bezier(.25,.8,.25,1);
}

.user-profile-card:hover {
  box-shadow: 0 10px 20px rgba(0,0,0,0.19), 0 6px 6px rgba(0,0,0,0.23);
}

.user-profile-card.selected {
  opacity: 1
}
</style>
