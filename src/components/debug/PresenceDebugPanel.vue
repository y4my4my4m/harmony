<template>
  <div class="presence-debug-panel">
    <h3>🔍 Professional Presence Debug Panel</h3>
    
    <div class="debug-section">
      <h4>Current User</h4>
      <div class="debug-item">
        <strong>User ID:</strong> {{ currentUserId || 'Not set' }}
      </div>
      <div class="debug-item">
        <strong>Status:</strong> {{ currentStatus !== null ? UserStatus[currentStatus] : 'Not set' }}
      </div>
      <div class="debug-item">
        <strong>Presence Object:</strong> {{ currentUserPresence ? 'Found' : 'Missing' }}
      </div>
      <div v-if="currentUserPresence" class="debug-item">
        <strong>Presence Details:</strong>
        <pre>{{ JSON.stringify(currentUserPresence, null, 2) }}</pre>
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
        <strong>Active Contexts:</strong> {{ stats.activeContexts }}
      </div>
    </div>

    <div class="debug-section">
      <h4>All Online Users</h4>
      <div v-if="onlineUsers.length === 0" class="debug-item">
        No online users found
      </div>
      <div v-for="user in onlineUsers" :key="user.userId" class="debug-item">
        <strong>{{ user.displayName }}</strong> ({{ user.userId }}) - {{ UserStatus[user.status] }}
      </div>
    </div>

    <div class="debug-section">
      <h4>Quick Actions</h4>
      <button @click="refreshPresence" class="debug-btn">Refresh All Presence</button>
      <button @click="testStatusChange" class="debug-btn">Test Status Change</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { UserStatus } from '@/types'
import { useProfessionalPresence } from '@/composables/useProfessionalPresence'

const presence = useProfessionalPresence()

// Reactive data
const currentUserId = computed(() => presence.getCurrentUserId.value)
const currentStatus = computed(() => presence.getCurrentUserStatus.value)
const currentUserPresence = computed(() => {
  if (currentUserId.value) {
    return presence.getUserPresence(currentUserId.value).value
  }
  return null
})
const onlineUsers = computed(() => presence.getOnlineUsers.value)
const stats = computed(() => presence.getStats.value)

// Test functions
const refreshPresence = async () => {
  try {
    await presence.refreshAllPresence()
    console.log('✅ Refreshed all presence data')
  } catch (error) {
    console.error('❌ Failed to refresh presence:', error)
  }
}

const testStatus = ref(UserStatus.Away)
const testStatusChange = async () => {
  try {
    console.log('🧪 Testing status change to:', UserStatus[testStatus.value])
    await presence.updateCurrentUserStatus(testStatus.value)
    
    // Cycle through statuses for testing
    switch (testStatus.value) {
      case UserStatus.Away:
        testStatus.value = UserStatus.Busy
        break
      case UserStatus.Busy:
        testStatus.value = UserStatus.Online
        break
      case UserStatus.Online:
        testStatus.value = UserStatus.Away
        break
    }
    
    console.log('✅ Status change test completed')
  } catch (error) {
    console.error('❌ Status change test failed:', error)
  }
}
</script>

<style scoped>
.presence-debug-panel {
  position: fixed;
  top: 10px;
  right: 10px;
  width: 400px;
  max-height: 80vh;
  overflow-y: auto;
  background: rgba(0, 0, 0, 0.9);
  border: 2px solid #5865f2;
  border-radius: 8px;
  padding: 16px;
  color: white;
  font-family: 'Courier New', monospace;
  font-size: 12px;
  z-index: 10000;
}

.debug-section {
  margin-bottom: 16px;
  padding: 8px;
  border: 1px solid rgba(255, 255, 255, 0.2);
  border-radius: 4px;
}

.debug-section h4 {
  margin: 0 0 8px 0;
  color: #5865f2;
}

.debug-item {
  margin-bottom: 4px;
  word-break: break-word;
}

.debug-item pre {
  background: rgba(255, 255, 255, 0.1);
  padding: 8px;
  border-radius: 4px;
  overflow-x: auto;
  font-size: 10px;
}

.debug-btn {
  background: #5865f2;
  color: white;
  border: none;
  padding: 8px 12px;
  border-radius: 4px;
  cursor: pointer;
  margin-right: 8px;
  margin-bottom: 8px;
  font-size: 11px;
}

.debug-btn:hover {
  background: #4752c4;
}
</style>