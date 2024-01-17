<template>
  <div class="user-sidebar">
    <div v-for="user in users" :key="user.id" class="user-item" @click="showUserProfile(user, $event)">
      <img :src="user.avatar_url" alt="User avatar" class="user-avatar">
      <span :class="getUserStatusClass(user.status)" class="user-status"></span>
      <span class="user-name">{{ user.display_name }}</span>
    </div>

    <!-- User profile card -->
    <div v-if="selectedUser" :class="['user-profile-card', { 'selected': selectedUser }]" :style="profileCardStyle" @click.stop>
      <UserPreviewComponent :user="selectedUser" :closeProfile="closeProfile" />
    </div>
  </div>
</template>

<script lang="ts">
import { defineComponent, ref, watch } from 'vue';
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
    const users = ref<User[]>([]); // Define users as a reactive ref

    const fetchAndSetUsers = async (serverId: string | null) => {
      if (serverId) {
        const userIds = await getUserIdsForServer(serverId);
        await serverUsersStore.fetchUserProfiles(userIds);
        users.value = userIds.map(userId => 
          serverUsersStore.userProfiles[userId] || { id: userId, display_name: 'Loading...' });
      }
    };

    watch(() => serverChannelStore.currentServerId, (newServerId) => {
      fetchAndSetUsers(newServerId);
    });

    const profileCardStyle = ref({ top: '0px'});

    const selectedUser = ref<User | null>(null);
      const showUserProfile = (user: User, event: MouseEvent) => {
      const userItemElement = (event.currentTarget as HTMLElement);
      const userSidebar = (event.currentTarget as HTMLElement).closest('.user-sidebar');

      if (userSidebar) {
        const userSidebarRect = userSidebar.getBoundingClientRect();
        const userItemRect = userItemElement.getBoundingClientRect();

        profileCardStyle.value = {
          top: `${userItemRect.top - userSidebarRect.top}px`,
        };
      }

      selectedUser.value = user;
      event.stopPropagation();
    };

    watch(() => serverChannelStore.currentServerId, async (newServerId) => {
      if (newServerId) {
        const userIds = await getUserIdsForServer(newServerId);
        await serverUsersStore.fetchUserProfiles(userIds);
      }
    });
  
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
  &:hover {
    background-color:var(--h-sidebar-light);
  }
}

.user-avatar {
  width: 30px;
  height: 30px;
  border-radius: 50%;
  margin-right: 10px;
}

.user-status {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background-color: grey; /* Default color */
  margin-right: 5px;
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
