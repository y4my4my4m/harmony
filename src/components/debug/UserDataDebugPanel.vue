<template>
  <div class="user-data-debug-panel">
    <h3>🔍 User Data System Debug</h3>
    
    <div class="debug-section">
      <h4>Current User</h4>
      <div class="debug-item">
        <strong>User ID:</strong> {{ currentUser?.id || 'Not set' }}
      </div>
      <div class="debug-item">
        <strong>Username:</strong> {{ currentUser?.username || 'Not set' }}
      </div>
      <div class="debug-item">
        <strong>Display Name:</strong> {{ currentUser?.displayName || 'Not set' }}
      </div>
      <div class="debug-item">
        <strong>Status:</strong> {{ currentStatusText }}
      </div>
      <div class="debug-item">
        <strong>Is Online:</strong> {{ currentUser?.isOnline || false }}
      </div>
    </div>

    <div class="debug-section">
      <h4>System Stats</h4>
      <div class="debug-item">
        <strong>Total Users:</strong> {{ stats.totalUsers }}
      </div>
      <div class="debug-item">
        <strong>Online Users:</strong> {{ stats.onlineUsers }}
      </div>
      <div class="debug-item">
        <strong>Active Contexts:</strong> {{ stats.contexts }}
      </div>
      <div class="debug-item">
        <strong>Global Channel:</strong> {{ stats.globalChannelConnected ? 'Connected' : 'Disconnected' }}
      </div>
      <div class="debug-item">
        <strong>Initialized:</strong> {{ stats.initialized ? 'Yes' : 'No' }}
      </div>
    </div>

    <div class="debug-section">
      <h4>Online Users</h4>
      <div class="online-users">
        <div v-for="user in onlineUsers" :key="user.id" class="user-item">
          <span class="status-indicator" :class="getStatusClass(user.status)"></span>
          <span>{{ user.displayName }}</span>
          <small>({{ user.username }})</small>
        </div>
      </div>
    </div>

    <div class="debug-section">
      <h4>Actions</h4>
      <div class="debug-actions">
        <button @click="refreshData" class="debug-button">
          🔄 Refresh Data
        </button>
        <button @click="logStats" class="debug-button">
          📊 Log Stats
        </button>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { debug } from '@/utils/debug'
import { useUserData } from '@/composables/useUserData'
import { UserStatus } from '@/types'

const {
  getCurrentUser,
  getCurrentUserStatus,
  getOnlineUsers,
  getStats,
  refresh
} = useUserData()

const currentUser = getCurrentUser
const stats = getStats
const onlineUsers = getOnlineUsers

const currentStatusText = computed(() => {
  const status = getCurrentUserStatus.value
  switch (status) {
    case UserStatus.Online:
      return 'Online'
    case UserStatus.Away:
      return 'Away'  
    case UserStatus.Busy:
      return 'Do Not Disturb'
    case UserStatus.Offline:
    default:
      return 'Offline'
  }
})

const getStatusClass = (status: UserStatus) => {
  switch (status) {
    case UserStatus.Online:
      return 'status-online'
    case UserStatus.Away:
      return 'status-away'
    case UserStatus.Busy:
      return 'status-busy'
    case UserStatus.Offline:
    default:
      return 'status-offline'
  }
}

const refreshData = async () => {
  debug.log('Refreshing user data...')
  await refresh()
  debug.log('User data refreshed')
}

const logStats = () => {
  const currentStats = stats.value
  debug.log('Current User Data Stats:', currentStats)
}
</script>

<style scoped>
.user-data-debug-panel {
  background: rgba(0, 0, 0, 0.8);
  border: 1px solid #333;
  border-radius: 8px;
  padding: 16px;
  margin: 16px;
  color: var(--text-primary);
  font-family: monospace;
  max-width: 500px;
}

.debug-section {
  margin-bottom: 16px;
  padding: 8px;
  border-left: 3px solid #4CAF50;
  background: rgba(255, 255, 255, 0.05);
}

.debug-section h4 {
  margin: 0 0 8px 0;
  color: #4CAF50;
}

.debug-item {
  margin: 4px 0;
  font-size: 12px;
}

.debug-item strong {
  color: #81C784;
}

.online-users {
  max-height: 200px;
  overflow-y: auto;
}

.user-item {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 4px 0;
  font-size: 12px;
}

.status-indicator {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  flex-shrink: 0;
}

.status-online {
  background-color: #4CAF50;
}

.status-away {
  background-color: #FF9800;
}

.status-busy {
  background-color: #F44336;
}

.status-offline {
  background-color: #757575;
}

.debug-actions {
  display: flex;
  gap: 8px;
}

.debug-button {
  background: #333;
  border: 1px solid #555;
  color: var(--text-primary);
  padding: 4px 8px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 11px;
}

.debug-button:hover {
  background: #444;
}

small {
  color: #aaa;
}
</style>