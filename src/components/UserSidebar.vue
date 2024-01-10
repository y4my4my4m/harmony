<template>
  <div class="user-sidebar">
    <div v-for="user in users" :key="user.id" class="user-item" @click="showUserProfile(user, $event)">
      <img :src="user.avatarUrl" alt="User avatar" class="user-avatar">
      <span class="user-status" :class="getUserStatusClass(user.status)"></span>
      <span class="user-name">{{ user.display_name }}</span>
    </div>

    <!-- User profile card -->
    <div v-if="selectedUser" class="user-profile-card" :style="profileCardStyle" @click.stop>
      <UserPreviewComponent :user="selectedUser" :closeProfile="closeProfile" />
    </div>
  </div>
</template>

<script lang="ts">
import { defineComponent, ref } from 'vue';
import { Permission } from '../types';
import type { User } from '../types';
import UserPreviewComponent from './UserPreviewComponent.vue';

export default defineComponent({
  name: 'UserSidebar',
  components: { UserPreviewComponent },
  setup() {
    const profileCardStyle = ref({ top: '0px'});
    const users = ref<User[]>([
      { id: 1, username: '@HarmonyUser1@harmony.com', display_name: 'HarmonyUser1', avatarUrl: 'default_avatar.png', status: 'online', roles: [
        {id:1,name:'admin',color:'#DD0000',permissions: [Permission.VIEW_CHANNEL, Permission.SEND_MESSAGE, Permission.MANAGE_MESSAGES, Permission.MANAGE_CHANNEL]},
        {id:1,name:'mod',color:'#00DD00',permissions: [Permission.VIEW_CHANNEL]}
      ]},
      { id: 2, username: '@HarmonyUser2@harmony.com', display_name: 'HarmonyUser2', avatarUrl: 'default_avatar.png', status: 'away', roles: [] },
      { id: 3, username: '@HarmonyUser3@harmony.com', display_name: 'HarmonyUser3', avatarUrl: 'default_avatar.png', status: 'busy', roles: [] },
      { id: 4, username: '@HarmonyUser3@harmony.com', display_name: 'HarmonyUser4', avatarUrl: 'default_avatar.png', status: 'offline', roles: [] },
      // Add more mock users
    ]);
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


    const getUserStatusClass = (status: string) => {
      return `status-${status}`;
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
  background-color: #292b2f;
  padding: 10px;
  position: relative;
}

.user-item {
  display: flex;
  align-items: center;
  cursor: pointer;
  padding: 5px;
  &:hover {
    background-color: #36393f;
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
  background-color: #2f3339; 
  z-index: 1000;
  padding: 10px;
}
</style>
