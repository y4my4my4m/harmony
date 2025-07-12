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
      <button @click="testDatabaseConnection" class="debug-btn">Test Database</button>
    </div>

    <div v-if="dbTestResult" class="debug-section">
      <h4>Database Test Result</h4>
      <div class="debug-item">
        <pre>{{ dbTestResult }}</pre>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { UserStatus } from '@/types'
import { useProfessionalPresence } from '@/composables/useProfessionalPresence'
import { supabase } from '@/supabase'

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

// Database test result
const dbTestResult = ref<string | null>(null)

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

const testDatabaseConnection = async () => {
  try {
    console.log('🧪 Testing database connection...')
    
    // Test basic connection
    const { data: healthCheck, error: healthError } = await supabase
      .from('profiles')
      .select('count')
      .limit(1)
    
    let results = []
    
    if (healthError) {
      results.push(`❌ Health check failed: ${healthError.message}`)
      results.push(`   Details: ${healthError.details}`)
      results.push(`   Hint: ${healthError.hint}`)
      results.push(`   Code: ${healthError.code}`)
    } else {
      results.push('✅ Database connection successful')
    }
    
    // Test profiles table structure
    const { data: profileColumns, error: columnError } = await supabase
      .from('profiles')
      .select('*')
      .limit(1)
    
    if (columnError) {
      results.push(`❌ Profiles table test failed: ${columnError.message}`)
    } else {
      results.push('✅ Profiles table accessible')
      if (profileColumns && profileColumns.length > 0) {
        results.push(`   Sample columns: ${Object.keys(profileColumns[0]).join(', ')}`)
      }
    }
    
    // Test current user profile
    if (currentUserId.value) {
      const { data: userProfile, error: userError } = await supabase
        .from('profiles')
        .select('id, username, display_name, status')
        .eq('id', currentUserId.value)
        .single()
      
      if (userError) {
        results.push(`❌ Current user profile failed: ${userError.message}`)
      } else {
        results.push('✅ Current user profile found')
        results.push(`   User: ${userProfile.username} (${userProfile.display_name})`)
        results.push(`   Status: ${userProfile.status}`)
      }
    }
    
    // Test user_servers table
    const { data: servers, error: serverError } = await supabase
      .from('user_servers')
      .select('*')
      .limit(1)
    
    if (serverError) {
      results.push(`❌ user_servers table test failed: ${serverError.message}`)
    } else {
      results.push('✅ user_servers table accessible')
    }
    
    // Test conversations table
    const { data: convs, error: convError } = await supabase
      .from('conversations')
      .select('*')
      .limit(1)
    
    if (convError) {
      results.push(`❌ conversations table test failed: ${convError.message}`)
    } else {
      results.push('✅ conversations table accessible')
    }
    
    dbTestResult.value = results.join('\n')
    
  } catch (error) {
    console.error('❌ Database test failed:', error)
    dbTestResult.value = `❌ Database test failed: ${error}`
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