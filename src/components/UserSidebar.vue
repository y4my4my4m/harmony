<template>
  <div class="user-sidebar" :class="{ 'sidebar-hidden': !props.visible }">
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
            :placeholder="$t('server.searchMembersPlaceholder')"
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
        {{ $t('server.membersCount', { count: totalMemberCount }) }}
      </div>
    </div>

    <!-- User Groups -->
    <div class="user-groups" v-if="props.visible">
      <!-- Loading Indicator -->
      <div v-if="isLoadingUsers" class="loading-indicator">
        <div class="loading-spinner"></div>
        <span>{{ $t('server.loadingUsers') }}</span>
      </div>
      
      <!-- Online Users -->
      <div v-if="!isLoadingUsers && groupedUsers.online.length > 0" class="user-group">
        <button 
          @click="toggleGroup('online')"
          class="group-header"
          :class="{ 'group-collapsed': collapsedGroups.online }"
        >
          <svg class="group-arrow" viewBox="0 0 24 24" fill="currentColor">
            <path d="M7.41,8.58L12,13.17L16.59,8.58L18,10L12,16L6,10L7.41,8.58Z"/>
          </svg>
          <span class="group-title">{{ $t('user.online') }} — {{ groupedUsers.online.length }}</span>
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
              <div class="user-name-row">
                <span 
                  class="user-name" 
                  :style="{ color: getUserColor(user.id).value || undefined }"
                >
                  {{ getUserDisplayName(user.id).value || 'Unknown User' }}
                </span>
                <span 
                  v-if="!isUserLocal(user.id).value" 
                  class="federation-badge"
                  :title="getUserDomain(user.id).value ? `From ${getUserDomain(user.id).value}` : 'Federated user'"
                >
                  <svg viewBox="0 0 24 24" fill="currentColor" class="federation-icon">
                    <path d="M17.9,17.39C17.64,16.59 16.89,16 16,16H15V13A1,1 0 0,0 14,12H8V10H10A1,1 0 0,0 11,9V7H13A2,2 0 0,0 15,5V4.59C17.93,5.77 20,8.64 20,12C20,14.08 19.2,15.97 17.9,17.39M11,19.93C7.05,19.44 4,16.08 4,12C4,11.38 4.08,10.79 4.21,10.21L9,15V16A2,2 0 0,0 11,18M12,2A10,10 0 0,0 2,12A10,10 0 0,0 12,22A10,10 0 0,0 22,12A10,10 0 0,0 12,2Z"/>
                  </svg>
                </span>
              </div>
              <span 
                v-if="!isUserLocal(user.id).value && getUserDomain(user.id).value" 
                class="user-domain"
              >
                {{ getUserDomain(user.id).value }}
              </span>
              <!-- Custom Status -->
              <div 
                v-if="getUserCustomStatus(user.id).value?.text || getUserCustomStatus(user.id).value?.emoji" 
                class="user-custom-status"
              >
                <span v-if="getUserCustomStatus(user.id).value?.emoji" class="status-emoji">
                  {{ getUserCustomStatus(user.id).value.emoji }}
                </span>
                <span v-if="getUserCustomStatus(user.id).value?.text" class="status-text">
                  {{ getUserCustomStatus(user.id).value.text }}
                </span>
              </div>
            </div>
          </div>
        </div>
      </div>

      <!-- Away Users -->
      <div v-if="!isLoadingUsers && groupedUsers.away.length > 0" class="user-group">
        <button 
          @click="toggleGroup('away')"
          class="group-header"
          :class="{ 'group-collapsed': collapsedGroups.away }"
        >
          <svg class="group-arrow" viewBox="0 0 24 24" fill="currentColor">
            <path d="M7.41,8.58L12,13.17L16.59,8.58L18,10L12,16L6,10L7.41,8.58Z"/>
          </svg>
          <span class="group-title">{{ $t('user.away') }} — {{ groupedUsers.away.length }}</span>
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
              <div class="user-name-row">
                <span 
                  class="user-name" 
                  :style="{ color: getUserColor(user.id).value || undefined }"
                >
                  {{ getUserDisplayName(user.id).value || 'Unknown User' }}
                </span>
                <span 
                  v-if="!isUserLocal(user.id).value" 
                  class="federation-badge"
                  :title="getUserDomain(user.id).value ? `From ${getUserDomain(user.id).value}` : 'Federated user'"
                >
                  <svg viewBox="0 0 24 24" fill="currentColor" class="federation-icon">
                    <path d="M17.9,17.39C17.64,16.59 16.89,16 16,16H15V13A1,1 0 0,0 14,12H8V10H10A1,1 0 0,0 11,9V7H13A2,2 0 0,0 15,5V4.59C17.93,5.77 20,8.64 20,12C20,14.08 19.2,15.97 17.9,17.39M11,19.93C7.05,19.44 4,16.08 4,12C4,11.38 4.08,10.79 4.21,10.21L9,15V16A2,2 0 0,0 11,18M12,2A10,10 0 0,0 2,12A10,10 0 0,0 12,22A10,10 0 0,0 22,12A10,10 0 0,0 12,2Z"/>
                  </svg>
                </span>
              </div>
              <span 
                v-if="!isUserLocal(user.id).value && getUserDomain(user.id).value" 
                class="user-domain"
              >
                {{ getUserDomain(user.id).value }}
              </span>
            </div>
          </div>
        </div>
      </div>

      <!-- Busy Users -->
      <div v-if="!isLoadingUsers && groupedUsers.busy.length > 0" class="user-group">
        <button 
          @click="toggleGroup('busy')"
          class="group-header"
          :class="{ 'group-collapsed': collapsedGroups.busy }"
        >
          <svg class="group-arrow" viewBox="0 0 24 24" fill="currentColor">
            <path d="M7.41,8.58L12,13.17L16.59,8.58L18,10L12,16L6,10L7.41,8.58Z"/>
          </svg>
          <span class="group-title">{{ $t('user.busy') }} — {{ groupedUsers.busy.length }}</span>
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
              <div class="user-name-row">
                <span 
                  class="user-name" 
                  :style="{ color: getUserColor(user.id).value || undefined }"
                >
                  {{ getUserDisplayName(user.id).value || 'Unknown User' }}
                </span>
                <span 
                  v-if="!isUserLocal(user.id).value" 
                  class="federation-badge"
                  :title="getUserDomain(user.id).value ? `From ${getUserDomain(user.id).value}` : 'Federated user'"
                >
                  <svg viewBox="0 0 24 24" fill="currentColor" class="federation-icon">
                    <path d="M17.9,17.39C17.64,16.59 16.89,16 16,16H15V13A1,1 0 0,0 14,12H8V10H10A1,1 0 0,0 11,9V7H13A2,2 0 0,0 15,5V4.59C17.93,5.77 20,8.64 20,12C20,14.08 19.2,15.97 17.9,17.39M11,19.93C7.05,19.44 4,16.08 4,12C4,11.38 4.08,10.79 4.21,10.21L9,15V16A2,2 0 0,0 11,18M12,2A10,10 0 0,0 2,12A10,10 0 0,0 12,22A10,10 0 0,0 22,12A10,10 0 0,0 12,2Z"/>
                  </svg>
                </span>
              </div>
              <span 
                v-if="!isUserLocal(user.id).value && getUserDomain(user.id).value" 
                class="user-domain"
              >
                {{ getUserDomain(user.id).value }}
              </span>
            </div>
          </div>
        </div>
      </div>

      <!-- Offline Users -->
      <div v-if="!isLoadingUsers && groupedUsers.offline.length > 0" class="user-group">
        <button 
          @click="toggleGroup('offline')"
          class="group-header"
          :class="{ 'group-collapsed': collapsedGroups.offline }"
        >
          <svg class="group-arrow" viewBox="0 0 24 24" fill="currentColor">
            <path d="M7.41,8.58L12,13.17L16.59,8.58L18,10L12,16L6,10L7.41,8.58Z"/>
          </svg>
          <span class="group-title">{{ $t('user.offline') }} — {{ groupedUsers.offline.length }}</span>
        </button>
        <div v-if="!collapsedGroups.offline" class="user-list">
          <div 
            v-for="user in groupedUsers.offline" 
            :key="user.id" 
            class="user-item offline-user"
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
              <div class="user-name-row">
                <span 
                  class="user-name" 
                  :style="{ color: getUserColor(user.id).value || undefined }"
                >
                  {{ getUserDisplayName(user.id).value || 'Unknown User' }}
                </span>
                <span 
                  v-if="!isUserLocal(user.id).value" 
                  class="federation-badge"
                  :title="getUserDomain(user.id).value ? `From ${getUserDomain(user.id).value}` : 'Federated user'"
                >
                  <svg viewBox="0 0 24 24" fill="currentColor" class="federation-icon">
                    <path d="M17.9,17.39C17.64,16.59 16.89,16 16,16H15V13A1,1 0 0,0 14,12H8V10H10A1,1 0 0,0 11,9V7H13A2,2 0 0,0 15,5V4.59C17.93,5.77 20,8.64 20,12C20,14.08 19.2,15.97 17.9,17.39M11,19.93C7.05,19.44 4,16.08 4,12C4,11.38 4.08,10.79 4.21,10.21L9,15V16A2,2 0 0,0 11,18M12,2A10,10 0 0,0 2,12A10,10 0 0,0 12,22A10,10 0 0,0 22,12A10,10 0 0,0 12,2Z"/>
                  </svg>
                </span>
              </div>
              <span 
                v-if="!isUserLocal(user.id).value && getUserDomain(user.id).value" 
                class="user-domain"
              >
                {{ getUserDomain(user.id).value }}
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
import { ref, computed, watch } from 'vue';
import { debug } from '@/utils/debug'
import type { User } from '@/types';
import UserProfileModal from '@/components/UserProfileModal.vue';
import InviteModal from './InviteModal.vue';
import Avatar from '@/components/common/Avatar.vue';
import { useServerChannelStore } from '@/stores/useServerChannel';
import { getUserIdsForServer} from '@/services/usersService';
import { UserStatus } from '@/types';
import { useUserData } from '@/composables/useUserData';

// Props
interface Props {
  visible?: boolean
}

const props = withDefaults(defineProps<Props>(), {
  visible: true
})

const serverChannelStore = useServerChannelStore();

// Debug: Track duplicate calls
let fetchCallCounter = 0;

// Use new clean user data system - ONE source of truth
const { 
  getUserAvatarUrl,
  getUserDisplayName,
  getUserColor,
  getAllUsers,
  getUsersInContext,
  subscribeToContext,
  unsubscribeFromContext,
  isUserOnline,
  getUserStatus,
  isUserLocal,
  getUserDomain,
  getUserCustomStatus,
} = useUserData();

// Component state
const selectedUser = ref<User | null>(null);
const showProfileModal = ref(false);
const showInviteModal = ref(false);
const searchQuery = ref('');
const isLoadingUsers = ref(false);
const lastFetchedServerId = ref<string | null>(null);

// Group collapse state
const collapsedGroups = ref({
  online: false,
  away: false,
  busy: false,
  offline: false // Start with offline collapsed
});

// Smart cached user data - shows cached data immediately, updates in background
const users = computed(() => {
  const serverId = serverChannelStore.currentServerId;
  if (!serverId) {
    return [];
  }
  
  // Get users from context first (this is our cached data)
  const contextUsers = getUsersInContext(serverId).value;
  
  // ✅ SMART CACHING: Only log when context changes significantly (not on every presence update)
  if (contextUsers.length > 0) {
    // Use cached context data immediately - no logging spam during presence updates
    return contextUsers;
  }
  
  // Only show loading state if we're actively loading and have no cached data
  if (isLoadingUsers.value) {
    return []; // Show loading spinner
  }
  
  // Fallback only if we have no context data and aren't loading
  const allUsers = getAllUsers.value;
  if (allUsers.length > 0) {
    debug.log(`🔄 UserSidebar: Using fallback data for server ${serverId}: ${allUsers.length} users`);
    
    // Convert to legacy format for compatibility
    return allUsers.map(userData => ({
      id: userData.id,
      username: userData.username,
      display_name: userData.displayName,
      avatar_url: userData.avatarUrl,
      status: userData.status
    }));
  }
  
  return [];
});

// Filter users based on search query
const filteredUsers = computed(() => {
  if (!searchQuery.value.trim()) {
    return users.value;
  }
  
  const query = searchQuery.value.toLowerCase();
  return users.value.filter((user: User) => {
    const displayName = getUserDisplayName(user.id).value.toLowerCase();
    const username = user.username?.toLowerCase() || '';
    return displayName.includes(query) || username.includes(query);
  });
});

// Group users by real-time presence first, then by status for present users
// This ensures:
// 1. Only users who are actually present (connected via Supabase Realtime) appear as Online/Away/Busy
// 2. All non-present users appear as Offline, regardless of their persistent database status
// 3. After page reload, only truly present users are shown as active
// 4. Professional, scalable real-time presence behavior for modern chat apps
const groupedUsers = computed(() => {
  const groups = {
    online: [] as User[],
    away: [] as User[],
    busy: [] as User[],
    offline: [] as User[]
  };

  filteredUsers.value.forEach((user: User) => {
    // Check if user is actually present in real-time
    const isPresent = isUserOnline(user.id).value;
    
    if (isPresent) {
      // User is present - group by their preferred status
      const status = getUserStatus(user.id).value;
      switch (status) {
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
          // Present but status is Offline? Treat as Online
          groups.online.push(user);
          break;
      }
    } else {
      // User is not present - always show as offline
      groups.offline.push(user);
    }
  });

  // Sort users within each group
  Object.values(groups).forEach(group => {
    group.sort((a, b) => {
      const nameA = getUserDisplayName(a.id).value.toLowerCase();
      const nameB = getUserDisplayName(b.id).value.toLowerCase();
      return nameA.localeCompare(nameB);
    });
  });

  return groups;
});

// Total member count
const totalMemberCount = computed(() => {
  return users.value.length;
});

// Current server data
const currentServerData = computed(() => {
  return serverChannelStore.currentServer;
});

// Methods
const toggleGroup = (groupName: string) => {
  if (groupName in collapsedGroups.value) {
    collapsedGroups.value[groupName as keyof typeof collapsedGroups.value] = 
      !collapsedGroups.value[groupName as keyof typeof collapsedGroups.value];
  }
};

const fetchAndSetUsers = async (serverId: string | null) => {
  fetchCallCounter++;
  debug.log(`🔍 UserSidebar fetchAndSetUsers called (${fetchCallCounter} times) for server:`, serverId);
  
  if (serverId) {
    // ✅ DEBOUNCE: Prevent duplicate calls for the same server
    if (lastFetchedServerId.value === serverId && isLoadingUsers.value) {
      debug.log(`⏭️ UserSidebar: Already loading server ${serverId}, skipping duplicate call`);
      return;
    }
    
    lastFetchedServerId.value = serverId;
    
    // ✅ SMART CACHING: Check if we already have users for this server
    let users = getUsersInContext(serverId).value;
    
    if (users.length > 0) {
      debug.log(`💾 UserSidebar: Using cached users for server ${serverId} (${users.length} members)`);
      isLoadingUsers.value = false; // Ensure loading state is cleared
      return; // Use cached data, no loading needed
    }
    
    // Only show loading if we truly have no data for this server
    debug.log(`🔄 UserSidebar: No cached users found, loading for server ${serverId}...`);
    isLoadingUsers.value = true;
    
    try {
      // Wait briefly for BaseLayout to establish context (for initial app load)
      if (users.length === 0) {
        debug.log(`⏳ UserSidebar: Waiting for server context to be established...`);
        
        // Shorter wait time since we're being smarter about caching
        const maxWaitTime = 500; // 500ms max for server switches
        const checkInterval = 50; // Check every 50ms
        let waitTime = 0;
        
        while (users.length === 0 && waitTime < maxWaitTime) {
          await new Promise(resolve => setTimeout(resolve, checkInterval));
          waitTime += checkInterval;
          users = getUsersInContext(serverId).value;
        }
        
        if (users.length > 0) {
          debug.log(`✅ UserSidebar: Server context ready after ${waitTime}ms wait`);
          return; // Found cached data during wait
        }
      }
      
      // No cached data available, create new subscription
      debug.log(`🆕 UserSidebar: Creating new subscription for server ${serverId}...`);
      const userIds = await getUserIdsForServer(serverId);
      await subscribeToContext(serverId, 'server', userIds);
      debug.log(`📋 Server user subscription ready: ${serverId} (${userIds.length} members)`);
    } finally {
      isLoadingUsers.value = false;
    }
  }
};

// Smart watcher for server changes - only triggers on actual server changes
watch(() => serverChannelStore.currentServerId, async (newServerId, oldServerId) => {
  // ✅ SMART CACHING: Only act on actual server changes
  if (newServerId === oldServerId) {
    return; // No change, skip
  }
  
  debug.log(`🔄 UserSidebar: Server changed from ${oldServerId} to ${newServerId}`);
  
  // ✅ INSTANT FEEDBACK: Clear loading state immediately if new server has cached data
  if (newServerId) {
    const cachedUsers = getUsersInContext(newServerId).value;
    if (cachedUsers.length > 0) {
      isLoadingUsers.value = false;
    }
  }
  
  if (oldServerId) {
    await unsubscribeFromContext(oldServerId);
  }
  if (newServerId) {
    await fetchAndSetUsers(newServerId);
  }
}, { immediate: true });

const showUserProfile = (user: User) => {
  selectedUser.value = user;
  showProfileModal.value = true;
};

// Helper to get status for avatar based on real-time presence
const getStatusForAvatarValue = (userId: string): 'online' | 'away' | 'busy' | 'offline' => {
  // First check if user is actually present
  const isPresent = isUserOnline(userId).value;
  
  if (!isPresent) {
    // User is not present - always show as offline
    return 'offline';
  }
  
  // User is present - return their preferred status
  const status = getUserStatus(userId).value;
  switch (status) {
    case UserStatus.Online:
      return 'online';
    case UserStatus.Away:
      return 'away';
    case UserStatus.Busy:
      return 'busy';
    default:
      // Present but status unknown - show as online
      return 'online';
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

</script>

<style scoped>
/* Header Section */
.sidebar-header {
  padding: 16px 8px 8px 16px;
  border-bottom: 1px solid var(--border-color);
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
  color: var(--text-secondary);
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
  color: var(--text-secondary);
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
  color: var(--text-secondary);
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
  color: var(--text-secondary);
}

.control-btn:active {
  background-color: rgba(255, 255, 255, 0.06);
}

.control-btn svg {
  width: 16px;
  height: 16px;
}

.user-sidebar {
  height: 100%;
}

/* Member Count */
.member-count {
  color: var(--text-muted);
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
  height:100%;
  background-color: var(--background-primary-alpha);
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

.user-custom-status {
  opacity: 0.5;
}

.offline-user {
  opacity: 0.3;
  transition: opacity 0.2s ease;
}

.offline-user:hover {
  opacity: 1.0;
}

/* Loading Indicator */
.loading-indicator {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 24px 16px;
  color: var(--text-secondary);
  font-size: 14px;
}

.loading-spinner {
  width: 24px;
  height: 24px;
  border: 2px solid rgba(255, 255, 255, 0.1);
  border-left: 2px solid var(--accent-primary);
  border-radius: 50%;
  animation: spin 1s linear infinite;
  margin-bottom: 12px;
}

@keyframes spin {
  to { transform: rotate(360deg); }
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
  color: var(--text-muted);
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
  color: var(--text-secondary);
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

.user-name-row {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
}

.user-name {
  color: var(--text-secondary);
  font-size: 14px;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  line-height: 1.25;
}

.federation-badge {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  cursor: help;
}

.federation-icon {
  width: 12px;
  height: 12px;
  color: var(--accent-primary, #5865f2);
  opacity: 0.8;
  transition: opacity 0.15s ease;
}

.user-item:hover .federation-icon {
  opacity: 1;
}

.user-domain {
  color: var(--text-muted, #72767d);
  font-size: 11px;
  font-weight: 400;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  line-height: 1.2;
  opacity: 0.7;
}

.user-activity {
  color: var(--text-secondary);
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
