<template>
  <div class="server-settings">
    <div class="server-settings-header">
      <button class="back-button" @click="back" aria-label="Back to chat">
        <svg width="24" height="24" viewBox="0 0 24 24">
          <path fill="currentColor" d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.42-1.41L7.83 13H20v-2z"/>
        </svg>
      </button>
      <h1 class="server-settings-title">Server Settings</h1>
      <div class="server-settings-actions">
        <button 
          class="btn btn-secondary" 
          @click="back"
          :disabled="loading"
        >
          Cancel
        </button>
        <button 
          class="btn btn-primary" 
          @click="handleSave"
          :disabled="loading || !hasChanges"
        >
          <span v-if="loading" class="loading-spinner"></span>
          Save Changes
        </button>
      </div>
    </div>

    <div class="server-settings-content">
      <div class="server-settings-sidebar">
        <nav class="settings-nav">
          <button 
            v-for="section in sections" 
            :key="section.id"
            class="nav-item"
            :class="{ active: activeSection === section.id }"
            @click="activeSection = section.id"
          >
            {{ section.label }}
          </button>
        </nav>
      </div>

      <div class="server-settings-main">
        <div class="settings-container">
          <!-- Server Overview Section -->
          <ServerBasicInfo
            v-if="activeSection === 'overview'"
            v-model:server="server"
            v-model:selectedFile="selectedFile"
            :owner-name="ownerName"
            :loading="loading"
            @file-change="handleFileChange"
          />

          <!-- Emoji Management Section -->
          <ServerEmojiManagement
            v-if="activeSection === 'emoji'"
            v-model:emojis="emojis"
            v-model:allowCrossServer="server.allow_cross_server_emojis"
            :server-id="serverId"
            :owner-id="server.owner"
            :loading="loading"
            @emoji-uploaded="handleEmojiUploaded"
          />

          <!-- Privacy Settings Section -->
          <ServerPrivacySettings
            v-if="activeSection === 'privacy'"
            v-model:isPublic="server.public"
            :loading="loading"
          />
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref, computed, watch } from 'vue'
import { useRouter } from 'vue-router'
import { useToast } from 'vue-toastification'
import { useServerStore } from '@/stores/server'
import { getProfileWithAvatarUrl } from '@/services/profileService'
import type { Server, Emoji } from '@/types'

// Components
import ServerBasicInfo from '@/components/settings/ServerBasicInfo.vue'
import ServerEmojiManagement from '@/components/settings/ServerEmojiManagement.vue'
import ServerPrivacySettings from '@/components/settings/ServerPrivacySettings.vue'

interface Props {
  serverId: string
}

const props = defineProps<Props>()

// Composables
const router = useRouter()
const serverStore = useServerStore()
const toast = useToast()

// State
const loading = ref(false)
const ownerName = ref('')
const selectedFile = ref<File | null>(null)
const emojis = ref<Emoji[]>([])
const activeSection = ref('overview')

const server = ref<Server>({
  id: '',
  name: '',
  description: '',
  icon: '',
  owner: '',
  allow_cross_server_emojis: true,
  public: false,
})

const originalServer = ref<Server | null>(null)

// Computed
const sections = computed(() => [
  { id: 'overview', label: 'Overview' },
  { id: 'emoji', label: 'Emoji' },
  { id: 'privacy', label: 'Privacy Settings' },
])

const hasChanges = computed(() => {
  if (!originalServer.value) return false
  
  return (
    server.value.name !== originalServer.value.name ||
    server.value.description !== originalServer.value.description ||
    server.value.allow_cross_server_emojis !== originalServer.value.allow_cross_server_emojis ||
    server.value.public !== originalServer.value.public ||
    selectedFile.value !== null
  )
})

// Methods
const fetchServer = async () => {
  try {
    loading.value = true
    const data = await serverStore.getServer(props.serverId)
    if (data) {
      server.value = { ...data }
      originalServer.value = { ...data }
      
      const owner = await getProfileWithAvatarUrl(server.value.owner)
      ownerName.value = owner?.username ?? 'Unknown User'
    }
  } catch (error) {
    console.error('Error fetching server:', error)
    toast.error('Failed to load server settings')
  } finally {
    loading.value = false
  }
}

const fetchEmojis = async () => {
  try {
    emojis.value = await serverStore.fetchEmojis(props.serverId)
  } catch (error) {
    console.error('Error fetching emojis:', error)
    toast.error('Failed to load emojis')
  }
}

const handleFileChange = (file: File | null) => {
  selectedFile.value = file
  if (file) {
    server.value.icon = URL.createObjectURL(file)
  }
}

const handleEmojiUploaded = (newEmoji: Emoji) => {
  emojis.value.push(newEmoji)
  toast.success('Emoji uploaded successfully')
}

const handleSave = async () => {
  try {
    loading.value = true
    const success = await serverStore.updateServer(server.value, selectedFile.value || undefined)
    
    if (success) {
      originalServer.value = { ...server.value }
      selectedFile.value = null
      toast.success('Server updated successfully')
      back()
    } else {
      throw new Error('Update failed')
    }
  } catch (error) {
    console.error('Error updating server:', error)
    toast.error('Failed to update server')
  } finally {
    loading.value = false
  }
}

const back = () => {
  router.push('/chat')
}

// Lifecycle
onMounted(async () => {
  await Promise.all([fetchServer(), fetchEmojis()])
})

// Watch for unsaved changes warning
watch(hasChanges, (newValue) => {
  if (newValue) {
    window.addEventListener('beforeunload', handleBeforeUnload)
  } else {
    window.removeEventListener('beforeunload', handleBeforeUnload)
  }
})

const handleBeforeUnload = (e: BeforeUnloadEvent) => {
  if (hasChanges.value) {
    e.preventDefault()
    e.returnValue = ''
  }
}
</script>

<style scoped>
.server-settings {
  display: flex;
  flex-direction: column;
  height: 100vh;
  background-color: var(--h-chat-dark);
  color: #ffffff;
}

.server-settings-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 24px;
  background-color: var(--h-chat);
  border-bottom: 1px solid var(--h-chat-light);
  box-shadow: 0 1px 0 rgba(0, 0, 0, 0.2);
}

.back-button {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  background: none;
  border: none;
  color: #b9bbbe;
  cursor: pointer;
  border-radius: 4px;
  transition: all 0.15s ease;
}

.back-button:hover {
  background-color: var(--h-chat-light);
  color: #ffffff;
}

.server-settings-title {
  font-size: 20px;
  font-weight: 600;
  margin: 0;
  color: #ffffff;
}

.server-settings-actions {
  display: flex;
  gap: 12px;
}

.btn {
  padding: 8px 16px;
  border-radius: 4px;
  border: none;
  font-weight: 500;
  font-size: 14px;
  cursor: pointer;
  transition: all 0.15s ease;
  display: flex;
  align-items: center;
  gap: 8px;
}

.btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.btn-primary {
  background-color: #5865f2;
  color: #ffffff;
}

.btn-primary:hover:not(:disabled) {
  background-color: #4752c4;
}

.btn-secondary {
  background-color: transparent;
  color: #b9bbbe;
  border: 1px solid #4f545c;
}

.btn-secondary:hover:not(:disabled) {
  background-color: var(--h-chat-light);
  color: #ffffff;
}

.loading-spinner {
  width: 16px;
  height: 16px;
  border: 2px solid rgba(255, 255, 255, 0.3);
  border-top: 2px solid #ffffff;
  border-radius: 50%;
  animation: spin 1s linear infinite;
}

.server-settings-content {
  display: flex;
  flex: 1;
  overflow: hidden;
}

.server-settings-sidebar {
  width: 240px;
  background-color: var(--h-chat);
  border-right: 1px solid var(--h-chat-light);
  padding: 24px 0;
}

.settings-nav {
  display: flex;
  flex-direction: column;
}

.nav-item {
  display: flex;
  align-items: center;
  padding: 8px 24px;
  background: none;
  border: none;
  color: #b9bbbe;
  font-size: 14px;
  font-weight: 500;
  text-align: left;
  cursor: pointer;
  transition: all 0.15s ease;
  border-left: 3px solid transparent;
}

.nav-item:hover {
  background-color: var(--h-chat-light);
  color: #ffffff;
}

.nav-item.active {
  background-color: var(--h-chat-light);
  color: #ffffff;
  border-left-color: #5865f2;
}

.server-settings-main {
  flex: 1;
  overflow-y: auto;
  padding: 24px;
}

.settings-container {
  max-width: 740px;
  margin: 0 auto;
}

@keyframes spin {
  0% { transform: rotate(0deg); }
  100% { transform: rotate(360deg); }
}

@media (max-width: 768px) {
  .server-settings-header {
    padding: 12px 16px;
  }
  
  .server-settings-title {
    font-size: 18px;
  }
  
  .server-settings-sidebar {
    display: none;
  }
  
  .server-settings-main {
    padding: 16px;
  }
}
</style>