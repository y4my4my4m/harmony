<template>
  <div class="user-sidebar" :class="{ 'sidebar-hidden': !sidebarVisible }">
    <!-- Header Section -->
    <div class="sidebar-header">
      <div class="search-container">
        <div class="search-input-wrapper">
          <svg class="search-icon" viewBox="0 0 24 24" fill="currentColor">
            <path d="M21.53 20.47l-3.66-3.66C19.195 15.24 20 13.214 20 11c0-4.97-4.03-9-9-9s-9 4.03-9 9 4.03 9 9 9c2.215 0 4.24-.804 5.808-2.13l3.66 3.66c.147.146.34.22.53.22s.385-.073.53-.22c.295-.293.295-.767.002-1.06zM3.5 11c0-4.135 3.365-7.5 7.5-7.5s7.5 3.365 7.5 7.5-3.365 7.5-7.5 7.5-7.5-3.365-7.5-7.5z"/>
          </svg>
          <input
            v-model="searchQuery"
            type="text"
            placeholder="Search members"
            class="search-input"
          />
          <button 
            v-if="searchQuery"
            @click="searchQuery = ''"
            class="clear-search"
          >
            <svg viewBox="0 0 24 24" fill="currentColor">
              <path d="M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z"/>
            </svg>
          </button>
        </div>
      </div>

      <!-- Control Buttons -->
      <!-- <div class="control-buttons">
        <button 
          @click="toggleSidebar"
          class="control-btn"
          title="Toggle member list"
        >
          <svg viewBox="0 0 24 24" fill="currentColor">
            <path d="M16 4v8l-2-2-2 2V4c0-1.1.9-2 2-2s2 .9 2 2zM4 18l4-4v3h8v2H8v3l-4-4z"/>
          </svg>
        </button>
        <button 
          @click="toggleServerSettings"
          class="control-btn"
          title="Server settings"
        >
          <svg viewBox="0 0 24 24" fill="currentColor">
            <path d="M19.14,12.94c0.04-0.3,0.06-0.61,0.06-0.94c0-0.32-0.02-0.64-0.07-0.94l2.03-1.58c0.18-0.14,0.23-0.41,0.12-0.61 l-1.92-3.32c-0.12-0.22-0.37-0.29-0.59-0.22l-2.39,0.96c-0.5-0.38-1.03-0.7-1.62-0.94L14.4,2.81c-0.04-0.24-0.24-0.41-0.48-0.41 h-3.84c-0.24,0-0.43,0.17-0.47,0.41L9.25,5.35C8.66,5.59,8.12,5.92,7.63,6.29L5.24,5.33c-0.22-0.08-0.47,0-0.59,0.22L2.74,8.87 C2.62,9.08,2.66,9.34,2.86,9.48l2.03,1.58C4.84,11.36,4.8,11.69,4.8,12s0.02,0.64,0.07,0.94l-2.03,1.58 c-0.18,0.14-0.23,0.41-0.12,0.61l1.92,3.32c0.12,0.22,0.37,0.29,0.59,0.22l2.39-0.96c0.5,0.38,1.03,0.7,1.62,0.94l0.36,2.54 c0.05,0.24,0.24,0.41,0.48,0.41h3.84c0.24,0,0.44-0.17,0.47-0.41l0.36-2.54c0.59-0.24,1.13-0.56,1.62-0.94l2.39,0.96 c0.22,0.08,0.47,0,0.59-0.22l1.92-3.32c0.12-0.22,0.07-0.47-0.12-0.61L19.14,12.94z M12,15.6c-1.98,0-3.6-1.62-3.6-3.6 s1.62-3.6,3.6-3.6s3.6,1.62,3.6,3.6S13.98,15.6,12,15.6z"/>
          </svg>
        </button>
        <button 
          @click="toggleRolesView"
          class="control-btn"
          title="Manage roles"
        >
          <svg viewBox="0 0 24 24" fill="currentColor">
            <path d="M12,2A3,3 0 0,1 15,5V7A3,3 0 0,1 12,10A3,3 0 0,1 9,7V5A3,3 0 0,1 12,2M12,4A1,1 0 0,0 11,5V7A1,1 0 0,0 12,8A1,1 0 0,0 13,7V5A1,1 0 0,0 12,4M21,14V20A2,2 0 0,1 19,22H5A2,2 0 0,1 3,20V14A2,2 0 0,1 5,12H19A2,2 0 0,1 21,14M19,16H5V20H19V16Z"/>
          </svg>
        </button>
      </div> -->

      <!-- Member Count -->
      <div class="member-count">
        {{ totalMemberCount }} members
      </div>
    </div>

    <!-- User Groups -->
    <div class="user-groups" v-if="sidebarVisible">
      <!-- Online Users -->
      <div v-if="groupedUsers.online.length > 0" class="user-group">
        <button 
          @click="toggleGroup('online')"
          class="group-header"
          :class="{ 'group-collapsed': collapsedGroups.online }"
        >
          <svg class="group-arrow" viewBox="0 0 24 24" fill="currentColor">
            <path d="M7.41,8.58L12,13.17L16.59,8.58L18,10L12,16L6,10L7.41,8.58Z"/>
          </svg>
          <span class="group-title">Online — {{ groupedUsers.online.length }}</span>
        </button>
        <div v-if="!collapsedGroups.online" class="user-list">
          <div 
            v-for="user in groupedUsers.online" 
            :key="user.id" 
            class="user-item"
            @click="showUserProfile(user)"
          >
            <Avatar
              :src="getUserAvatarUrl(user.id).value"
              :alt="getUserDisplayName(user.id).value || 'Unknown User'"
              size="sm"
              :status="getStatusForAvatarValue(user.id)"
              class="user-avatar"
            />
            <div class="user-info">
              <span 
                class="user-name" 
                :style="{ color: getUserColor(user.id).value || undefined }"
              >
                {{ getUserDisplayName(user.id).value || 'Unknown User' }}
              </span>
            </div>
          </div>
        </div>
      </div>

      <!-- Away Users -->
      <div v-if="groupedUsers.away.length > 0" class="user-group">
        <button 
          @click="toggleGroup('away')"
          class="group-header"
          :class="{ 'group-collapsed': collapsedGroups.away }"
        >
          <svg class="group-arrow" viewBox="0 0 24 24" fill="currentColor">
            <path d="M7.41,8.58L12,13.17L16.59,8.58L18,10L12,16L6,10L7.41,8.58Z"/>
          </svg>
          <span class="group-title">Away — {{ groupedUsers.away.length }}</span>
        </button>
        <div v-if="!collapsedGroups.away" class="user-list">
          <div 
            v-for="user in groupedUsers.away" 
            :key="user.id" 
            class="user-item"
            @click="showUserProfile(user)"
          >
            <Avatar
              :src="getUserAvatarUrl(user.id).value"
              :alt="getUserDisplayName(user.id).value || 'Unknown User'"
              size="sm"
              :status="getStatusForAvatarValue(user.id)"
              class="user-avatar"
            />
            <div class="user-info">
              <span 
                class="user-name" 
                :style="{ color: getUserColor(user.id).value || undefined }"
              >
                {{ getUserDisplayName(user.id).value || 'Unknown User' }}
              </span>
            </div>
          </div>
        </div>
      </div>

      <!-- Busy Users -->
      <div v-if="groupedUsers.busy.length > 0" class="user-group">
        <button 
          @click="toggleGroup('busy')"
          class="group-header"
          :class="{ 'group-collapsed': collapsedGroups.busy }"
        >
          <svg class="group-arrow" viewBox="0 0 24 24" fill="currentColor">
            <path d="M7.41,8.58L12,13.17L16.59,8.58L18,10L12,16L6,10L7.41,8.58Z"/>
          </svg>
          <span class="group-title">Busy — {{ groupedUsers.busy.length }}</span>
        </button>
        <div v-if="!collapsedGroups.busy" class="user-list">
          <div 
            v-for="user in groupedUsers.busy" 
            :key="user.id" 
            class="user-item"
            @click="showUserProfile(user)"
          >
            <Avatar
              :src="getUserAvatarUrl(user.id).value"
              :alt="getUserDisplayName(user.id).value || 'Unknown User'"
              size="sm"
              :status="getStatusForAvatarValue(user.id)"
              class="user-avatar"
            />
            <div class="user-info">
              <span 
                class="user-name" 
                :style="{ color: getUserColor(user.id).value || undefined }"
              >
                {{ getUserDisplayName(user.id).value || 'Unknown User' }}
              </span>
            </div>
          </div>
        </div>
      </div>

      <!-- Offline Users -->
      <div v-if="groupedUsers.offline.length > 0" class="user-group">
        <button 
          @click="toggleGroup('offline')"
          class="group-header"
          :class="{ 'group-collapsed': collapsedGroups.offline }"
        >
          <svg class="group-arrow" viewBox="0 0 24 24" fill="currentColor">
            <path d="M7.41,8.58L12,13.17L16.59,8.58L18,10L12,16L6,10L7.41,8.58Z"/>
          </svg>
          <span class="group-title">Offline — {{ groupedUsers.offline.length }}</span>
        </button>
        <div v-if="!collapsedGroups.offline" class="user-list">
          <div 
            v-for="user in groupedUsers.offline" 
            :key="user.id" 
            class="user-item"
            @click="showUserProfile(user)"
          >
            <Avatar
              :src="getUserAvatarUrl(user.id).value"
              :alt="getUserDisplayName(user.id).value || 'Unknown User'"
              size="sm"
              :status="getStatusForAvatarValue(user.id)"
              class="user-avatar"
            />
            <div class="user-info">
              <span 
                class="user-name" 
                :style="{ color: getUserColor(user.id).value || undefined }"
              >
                {{ getUserDisplayName(user.id).value || 'Unknown User' }}
              </span>
            </div>
          </div>
        </div>
      </div>
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
      :server-id="serverChannelStore.currentServerId || undefined"
      :server-data="currentServerData || undefined"
      @close="closeInviteModal"
    />
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue';
import type { User } from '@/types';
import UserProfileModal from '@/components/UserProfileModal.vue';
import InviteModal from './InviteModal.vue';
import Avatar from '@/components/common/Avatar.vue';
import { useServerChannelStore } from '@/stores/useServerChannel';
import { useServerUsersStore } from '@/stores/useServerUsers';
import { getUserIdsForServer} from '@/services/usersService';
import { UserStatus } from '@/types';
import { useProfessionalPresence } from '@/composables/useProfessionalPresence';

const serverChannelStore = useServerChannelStore();
const serverUsersStore = useServerUsersStore();

// Use professional presence system - contextual subscriptions, full profile data
const { 
  getStatusForAvatar, 
  getUserPresence, 
  subscribeToServer,
  getUserDisplayName,
  getUserAvatarUrl, 
  getUserColor,
  getUsersInContext,
  getAllUsers
} = useProfessionalPresence();

// Component state
const selectedUser = ref<User | null>(null);
const showProfileModal = ref(false);
const showInviteModal = ref(false);
const searchQuery = ref('');
const sidebarVisible = ref(true);
const showServerSettings = ref(false);
const showRolesView = ref(false);

// Group collapse state
const collapsedGroups = ref({
  online: false,
  away: false,
  busy: false,
  offline: true // Start with offline collapsed
});

// Professional user data from presence system - always accurate and real-time
const users = computed(() => {
  const serverId = serverChannelStore.currentServerId;
  if (!serverId) {
    console.log('🔍 UserSidebar: No current server ID');
    return [];
  }
  
  // Get all users in current server context from professional presence system
  const serverUsers = getUsersInContext(serverId).value;
  console.log(`🔍 UserSidebar: Server ${serverId} users from context:`, serverUsers.length, serverUsers);
  
  // Fallback: if no context users, get all users
  if (serverUsers.length === 0) {
    const allUsers = getAllUsers.value;
    console.log(`🔍 UserSidebar: Fallback to all users:`, allUsers.length, allUsers);
    
    // Convert to User format for compatibility
    return allUsers.map(presence => ({
      id: presence.userId,
      username: presence.username,
      display_name: presence.displayName,
      avatar_url: presence.avatarUrl,
      status: presence.status
    }));
  }
  
  // Convert to User format for compatibility - includes both online and offline users
  return serverUsers.map(presence => ({
    id: presence.userId,
    username: presence.username,
    display_name: presence.displayName,
    avatar_url: presence.avatarUrl,
    status: presence.status
  }));
});

// Filter users based on search query
const filteredUsers = computed(() => {
  if (!searchQuery.value.trim()) {
    return users.value;
  }
  
  const query = searchQuery.value.toLowerCase();
  return users.value.filter(user => {
    const displayName = getUserDisplayName(user.id).value?.toLowerCase() || '';
    const username = user.username?.toLowerCase() || '';
    return displayName.includes(query) || username.includes(query);
  });
});

// Group users by status using professional presence store
const groupedUsers = computed(() => {
  const groups = {
    online: [] as User[],
    away: [] as User[],
    busy: [] as User[],
    offline: [] as User[]
  };
  
  filteredUsers.value.forEach(user => {
    const presence = getUserPresence(user.id).value;
    
    if (!presence) {
      // If no presence available, treat as offline
      groups.offline.push(user);
      return;
    }
    
    switch (presence.status) {
      case UserStatus.Online:
        groups.online.push(user);
        break;
      case UserStatus.Away:
        groups.away.push(user);
        break;
      case UserStatus.Busy:
        groups.busy.push(user);
        break;
      default:
        groups.offline.push(user);
        break;
    }
  });
  
  // Sort users within each group by display name using real-time data
  Object.values(groups).forEach(group => {
    group.sort((a, b) => {
      const nameA = getUserDisplayName(a.id).value || '';
      const nameB = getUserDisplayName(b.id).value || '';
      return nameA.localeCompare(nameB);
    });
  });
  
  return groups;
});

// Total member count
const totalMemberCount = computed(() => users.value.length);

// Current server data for invite modal
const currentServerData = computed(() => {
  const serverId = serverChannelStore.currentServerId;
  if (!serverId) return null;
  
  const currentServer = serverChannelStore.currentServer;
  return {
    id: serverId,
    name: currentServer?.name || 'Unknown Server',
    icon_url: currentServer?.icon,
    member_count: users.value.length
  };
});

// Methods
const toggleSidebar = () => {
  sidebarVisible.value = !sidebarVisible.value;
};

const toggleServerSettings = () => {
  showServerSettings.value = !showServerSettings.value;
  console.log('Server settings toggled:', showServerSettings.value);
};

const toggleRolesView = () => {
  showRolesView.value = !showRolesView.value;
  console.log('Roles view toggled:', showRolesView.value);
};

const toggleGroup = (groupName: string) => {
  if (groupName in collapsedGroups.value) {
    collapsedGroups.value[groupName as keyof typeof collapsedGroups.value] = 
      !collapsedGroups.value[groupName as keyof typeof collapsedGroups.value];
  }
};

const fetchAndSetUsers = async (serverId: string | null) => {
  if (serverId) {
    const userIds = await getUserIdsForServer(serverId);
    
    // Professional presence system now handles all user loading and presence tracking
    // via the UnifiedView server watcher - no duplicate loading needed here
    console.log(`📋 Server user list ready for server: ${serverId} (${userIds.length} members)`);
    console.log(`🎯 Professional presence system handles all user data loading and real-time updates`);
  }
};

// Clean watcher for server changes - no debouncing hacks
watch(() => serverChannelStore.currentServerId, (newServerId) => {
  fetchAndSetUsers(newServerId);
  selectedUser.value = null; // Close profile when switching servers
});

const showUserProfile = (user: User) => {
  selectedUser.value = user;
  showProfileModal.value = true;
};

// Professional presence status getter for avatars - no side effects
const getStatusForAvatarValue = (userId: string): 'online' | 'away' | 'busy' | 'offline' => {
  const avatarStatus = getStatusForAvatar(userId).value;
  
  // getStatusForAvatar already returns the correct string format
  return avatarStatus as 'online' | 'away' | 'busy' | 'offline';
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

// Initialize on mount
onMounted(() => {
  fetchAndSetUsers(serverChannelStore.currentServerId);
});
</script>

<style scoped>
.user-sidebar {
  width: 240px;
  min-width: 240px;
  background-color: var(--background-quinary);
  display: flex;
  flex-direction: column;
  height: 100%;
  transition: width 0.2s ease, margin-right 0.2s ease;
  border-left: 1px solid rgba(255, 255, 255, 0.04);
}

.sidebar-hidden {
  width: 0;
  min-width: 0;
  margin-right: -240px;
  overflow: hidden;
}

/* Header Section */
.sidebar-header {
  padding: 16px 8px 8px 16px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.04);
  background-color: var(--background-quinary);
}

.search-container {
  margin-bottom: 8px;
}

.search-input-wrapper {
  position: relative;
  background-color: rgba(0, 0, 0, 0.1);
  border-radius: 4px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  transition: border-color 0.15s ease;
}

.search-input-wrapper:focus-within {
  border-color: rgba(88, 101, 242, 0.6);
}

.search-input {
  width: 100%;
  background: transparent;
  border: none;
  padding: 8px 12px 8px 32px;
  color: #dcddde;
  font-size: 14px;
  font-weight: 400;
  outline: none;
}

.search-input::placeholder {
  color: #72767d;
}

.search-icon {
  position: absolute;
  left: 8px;
  top: 50%;
  transform: translateY(-50%);
  width: 16px;
  height: 16px;
  color: #72767d;
  pointer-events: none;
}

.clear-search {
  position: absolute;
  right: 8px;
  top: 50%;
  transform: translateY(-50%);
  background: none;
  border: none;
  color: #72767d;
  cursor: pointer;
  padding: 0;
  width: 16px;
  height: 16px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-radius: 2px;
  transition: color 0.15s ease;
}

.clear-search:hover {
  color: #dcddde;
}

.clear-search svg {
  width: 12px;
  height: 12px;
}

/* Control Buttons */
.control-buttons {
  display: flex;
  gap: 4px;
  margin-bottom: 8px;
}

.control-btn {
  background: transparent;
  border: none;
  color: #b9bbbe;
  cursor: pointer;
  padding: 6px;
  border-radius: 4px;
  transition: all 0.15s ease;
  display: flex;
  align-items: center;
  justify-content: center;
  flex: 1;
}

.control-btn:hover {
  background-color: rgba(255, 255, 255, 0.1);
  color: #dcddde;
}

.control-btn:active {
  background-color: rgba(255, 255, 255, 0.06);
}

.control-btn svg {
  width: 16px;
  height: 16px;
}

/* Member Count */
.member-count {
  color: #72767d;
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.02em;
  margin-top: 4px;
  text-align: center;
}

/* User Groups */
.user-groups {
  flex: 1;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 8px 8px 16px 8px;
}

.user-groups::-webkit-scrollbar {
  width: 8px;
}

.user-groups::-webkit-scrollbar-track {
  background: transparent;
}

.user-groups::-webkit-scrollbar-thumb {
  background-color: rgba(255, 255, 255, 0.1);
  border-radius: 4px;
}

.user-groups::-webkit-scrollbar-thumb:hover {
  background-color: rgba(255, 255, 255, 0.15);
}

.user-group {
  margin-bottom: 16px;
}

.user-group:last-child {
  margin-bottom: 0;
}

/* Group Headers */
.group-header {
  background: none;
  border: none;
  color: #8e9297;
  cursor: pointer;
  padding: 6px 8px;
  font-size: 12px;
  text-transform: uppercase;
  letter-spacing: 0.02em;
  width: 100%;
  display: flex;
  align-items: center;
  gap: 4px;
  border-radius: 4px;
  transition: color 0.15s ease;
  margin-bottom: 2px;
}

.group-header:hover {
  color: #b9bbbe;
}

.group-title {
  flex: 1;
  display: flex;
  align-items: center;
  font-weight: bold;
}

.group-arrow {
  width: 12px;
  height: 12px;
  transition: transform 0.15s ease;
}

.group-collapsed .group-arrow {
  transform: rotate(-90deg);
}

.status-indicator {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  margin-left: 2px;
}

.status-indicator.online {
  background-color: #3ba55c;
}

.status-indicator.away {
  background-color: #faa61a;
}

.status-indicator.busy {
  background-color: #ed4245;
}

.status-indicator.offline {
  background-color: #747f8d;
}

.group-title {
  flex: 1;
}

/* User List */
.user-list {
  padding-left: 8px;
}

.user-item {
  display: flex;
  align-items: center;
  padding: 4px 8px;
  margin: 4px 0;
  border-radius: 4px;
  cursor: pointer;
  transition: background-color 0.15s ease;
  min-height: 42px;
}

.user-item:hover {
  background-color: rgba(255, 255, 255, 0.04);
}

.user-item:active {
  background-color: rgba(255, 255, 255, 0.02);
}

.user-avatar {
  margin-right: 12px;
  flex-shrink: 0;
}

.user-info {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.user-name {
  color: #dcddde;
  font-size: 14px;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  line-height: 1.25;
}

.user-activity {
  color: #b9bbbe;
  font-size: 12px;
  font-weight: 400;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  line-height: 1.2;
}

/* Animation for collapsing groups */
.user-list {
  overflow: hidden;
  transition: max-height 0.2s ease;
}

/* Focus styles for accessibility */
.control-btn:focus-visible,
.group-header:focus-visible,
.user-item:focus-visible {
  outline: 2px solid #5865f2;
  outline-offset: 2px;
}

.search-input:focus {
  outline: none;
}

/* Responsive adjustments */
@media (max-width: 768px) {
  .user-sidebar {
    width: 100%;
    max-width: 320px;
    min-width: 280px;
    background: linear-gradient(135deg, var(--h-sidebar, #2b2d31) 0%, #252830 100%);
    border-left: 1px solid rgba(88, 101, 242, 0.2);
  }
  
  .sidebar-hidden {
    margin-right: -320px;
  }

  /* Enhanced mobile touch targets */
  .control-btn {
    min-height: 48px;
    padding: 12px 16px;
    border-radius: 12px;
    font-size: 16px;
  }

  .group-header {
    min-height: 48px;
    padding: 12px 16px;
    border-radius: 12px;
  }

  .user-item {
    min-height: 52px;
    padding: 8px 16px;
    border-radius: 12px;
    margin: 4px 8px;
    transition: all 0.2s cubic-bezier(0.4, 0, 0.2, 1);
  }

  .user-item:active {
    transform: scale(0.98);
    background: rgba(255, 255, 255, 0.08);
  }

  .search-input {
    font-size: 16px; /* Prevents zoom on iOS */
    padding: 12px 16px;
    border-radius: 12px;
  }

  .member-count {
    font-size: 14px;
    padding: 8px 16px;
  }
}

/* Dark theme specific adjustments */
@media (prefers-color-scheme: dark) {
  .search-input-wrapper {
    background-color: rgba(0, 0, 0, 0.2);
  }
}
</style>
