<template>
  <div class="user-sidebar">
    <div v-for="user in users" :key="user.id" class="user-item" @click="showUserProfile(user)">
      <div class="user-avatar-container">
        <img :src="user.avatar_url || '/default_avatar.png'" alt="User avatar" class="user-avatar">
        <span :class="getUserStatusClass(user.status)" class="user-status"></span>
      </div>
      <span class="user-name">{{ user.display_name || 'Unknown User' }}</span>
    </div>

    <!-- Modern User Profile Modal -->
    <UserProfileModal 
      :show="showProfileModal" 
      :user="selectedUser" 
      @close="closeProfile"
      @invite="openInviteModal"
    />

    <!-- Invite Modal -->
    <InviteModal 
      :show="showInviteModal" 
      :server-id="serverChannelStore.currentServerId"
      :server-data="currentServerData"
      @close="closeInviteModal"
    />
  </div>
</template>

<script lang="ts">
import { defineComponent, ref, watch, computed, onMounted } from 'vue';
import type { User } from '@/types';
import UserProfileModal from './UserProfileModal.vue';
import InviteModal from './InviteModal.vue';
import { useServerChannelStore } from '@/stores/useServerChannel';
import { useServerUsersStore } from '@/stores/useServerUsers';
import { getUserIdsForServer} from '@/services/usersService';
import { UserStatus } from '@/types';

export default defineComponent({
  name: 'UserSidebar',
  components: { 
    UserProfileModal,
    InviteModal
  },
  setup() {
    const serverChannelStore = useServerChannelStore();
    const serverUsersStore = useServerUsersStore();
    const selectedUser = ref<User | null>(null);
    const showProfileModal = ref(false);
    const showInviteModal = ref(false);

    // Make users reactive to store changes
    const users = computed(() => {
      const serverId = serverChannelStore.currentServerId;
      if (!serverId) return [];
      
      return Object.values(serverUsersStore.userProfiles).filter(user => user && user.id);
    });

    // Current server data for invite modal
    const currentServerData = computed(() => {
      const serverId = serverChannelStore.currentServerId;
      if (!serverId) return null;
      
      // You'll need to get this from your server store
      return {
        id: serverId,
        name: 'Current Server', // Replace with actual server name
        icon_url: undefined, // Replace with actual server icon
        member_count: users.value.length
      };
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

    const showUserProfile = (user: User) => {
      selectedUser.value = user;
      showProfileModal.value = true;
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
      showProfileModal.value = false;
      selectedUser.value = null;
    };

    const openInviteModal = () => {
      showProfileModal.value = false;
      showInviteModal.value = true;
    };

    const closeInviteModal = () => {
      showInviteModal.value = false;
    };

    // Initialize on mount and ensure status subscription is active
    onMounted(() => {
      fetchAndSetUsers(serverChannelStore.currentServerId);
      // Make sure status subscription is active
      serverUsersStore.subscribeToUserStatuses();
    });

    return { 
      users, 
      showUserProfile, 
      selectedUser, 
      showProfileModal,
      showInviteModal,
      currentServerData,
      serverChannelStore,
      closeProfile, 
      openInviteModal,
      closeInviteModal,
      getUserStatusClass 
    };
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

/* Removed old profile card styles - now using modal */
</style>
