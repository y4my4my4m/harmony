<template>
  <div class="user-sidebar">
    <div v-for="user in users" :key="user.id" class="user-item" @click="showUserProfile(user)">
      <img :src="user.avatarUrl" alt="User avatar" class="user-avatar">
      <span class="user-status" :class="getUserStatusClass(user.status)"></span>
      <span class="user-name">{{ user.username }}</span>
    </div>

    <!-- User profile card -->
    <div v-if="selectedUser" class="user-profile-card" @click.stop>
      <UserProfileComponent :user="selectedUser" :closeProfile="closeProfile" />
    </div>
  </div>
</template>

<script lang="ts">
import { defineComponent, ref } from 'vue';
import type { User } from '../types';
import UserProfileComponent from './UserProfileComponent.vue';

export default defineComponent({
  name: 'UserSidebar',
  components: { UserProfileComponent },
  setup() {
    const users = ref<User[]>([
      { id: 1, username: 'HarmonyUser1', avatarUrl: 'default_avatar.png', status: 'online', roles: [] },
      { id: 2, username: 'HarmonyUser2', avatarUrl: 'default_avatar.png', status: 'away', roles: [] },
      { id: 3, username: 'HarmonyUser3', avatarUrl: 'default_avatar.png', status: 'busy', roles: [] },
      { id: 4, username: 'HarmonyUser3', avatarUrl: 'default_avatar.png', status: 'offline', roles: [] },
      // Add more mock users
    ]);
    const selectedUser = ref<User | null>(null);

    const showUserProfile = (user: User) => {
      console.log("User clicked:", user);
      selectedUser.value = user;
    };

    const getUserStatusClass = (status: string) => {
      return `status-${status}`;
    };
    
    const closeProfile = () => {
      selectedUser.value = null;
    };

    return { users, showUserProfile, selectedUser, closeProfile, getUserStatusClass };
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
  left: 230px;
  top: 0;
  width: 200px;
  z-index: 10000;
  /* additional styling for the card */
}
</style>
