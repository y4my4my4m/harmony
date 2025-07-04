<template>
  <div class="server-settings">
    <div class="server-settings-header">
      <button class="back-button" @click="back" aria-label="Back to chat">
        <svg width="24" height="24" viewBox="0 0 24 24">
          <path fill="currentColor" d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.42-1.41L7.83 13H20v-2z"/>
        </svg>
      </button>
      <h1 class="server-settings-title">
        {{ permissions.canEditBasicInfo ? 'Server Settings' : 'Server Information' }}
      </h1>
      <div class="server-settings-actions" v-if="permissions.canSaveChanges">
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
      <div v-else class="server-settings-actions">
        <button 
          class="btn btn-secondary" 
          @click="back"
          :disabled="loading"
        >
          Back
        </button>
      </div>
    </div>

    <div class="server-settings-content">
      <div class="server-settings-sidebar">
        <nav class="settings-nav">
          <button 
            v-for="section in availableSections" 
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
          <!-- Permission Warning for Read-Only Users -->
          <div v-if="!permissions.canEditBasicInfo && activeSection === 'overview'" class="permission-notice">
            <div class="notice-content">
              <svg class="notice-icon" width="20" height="20" viewBox="0 0 24 24">
                <path fill="#faa61a" d="M13,14H11V10H13M13,18H11V16H13M1,21H23L12,2L1,21Z"/>
              </svg>
              <div class="notice-text">
                <h4>View Only Access</h4>
                <p>You can view server information but cannot make changes. Only the server owner and administrators can modify settings.</p>
              </div>
            </div>
          </div>

          <!-- Server Overview Section -->
          <ServerBasicInfo
            v-if="activeSection === 'overview'"
            v-model:server="server"
            v-model:selectedFile="selectedFile"
            :owner-name="ownerName"
            :loading="loading"
            :permissions="permissions"
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
            :permissions="emojiPermissions"
            @emoji-uploaded="handleEmojiUploaded"
            @emoji-deleted="handleEmojiDeleted"
          />

          <!-- Privacy Settings Section -->
          <ServerPrivacySettings
            v-if="activeSection === 'privacy'"
            v-model:isPublic="server.public"
            :loading="loading"
            :permissions="permissions"
          />

          <!-- Advanced Settings Section -->
          <ServerAdvancedSettings
            v-if="activeSection === 'advanced'"
            :server-id="serverId"
            :server-name="server.name"
            :created-at="server.created_at"
            :loading="loading"
            :permissions="{ canDeleteServer: permissions.canDeleteServer }"
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
import { useServerPermissions } from '@/composables/useServerPermissions'
import { getProfileWithAvatarUrl } from '@/services/profileService'
import type { Server, Emoji } from '@/types'

// Components
import ServerBasicInfo from '@/components/settings/ServerBasicInfo.vue'
import ServerEmojiManagement from '@/components/settings/ServerEmojiManagement.vue'
import ServerPrivacySettings from '@/components/settings/ServerPrivacySettings.vue'
import ServerAdvancedSettings from '@/components/settings/ServerAdvancedSettings.vue'

interface Props {
  serverId: string
}

const props = defineProps<Props>()

// Composables
const router = useRouter()
const serverStore = useServerStore()
const toast = useToast()
const { serverSettingsPermissions } = useServerPermissions()

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
  created_at: undefined,
})

const originalServer = ref<Server | null>(null)

// Computed permissions
const permissions = computed(() => serverSettingsPermissions.value)

const emojiPermissions = computed(() => ({
  canUpload: permissions.value.canUploadEmojis,
  canDelete: permissions.value.canDeleteEmojis,
  canRename: permissions.value.canDeleteEmojis, // Same permission as delete for now
  canManageCrossServer: permissions.value.canManageCrossServerEmojis
}))

// Available sections based on permissions
const availableSections = computed(() => {
  const sections = [
    { id: 'overview', label: 'Overview' }
  ]
  
  // Always show emoji section but with different permissions
  sections.push({ id: 'emoji', label: 'Emoji' })
  
  // Only show privacy settings if user can manage server
  if (permissions.value.canChangePrivacySettings) {
    sections.push({ id: 'privacy', label: 'Privacy Settings' })
  }
  
  // Only show advanced settings if user has advanced permissions
  if (permissions.value.canDeleteServer) {
    sections.push({ id: 'advanced', label: 'Advanced Settings' })
  }
  
  return sections
})

const hasChanges = computed(() => {
  if (!originalServer.value || !permissions.value.canSaveChanges) return false
  
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
  if (!permissions.value.canChangeServerIcon) return
  selectedFile.value = file
  if (file) {
    server.value.icon = URL.createObjectURL(file)
  }
}

const handleEmojiUploaded = (newEmoji: Emoji) => {
  emojis.value.push(newEmoji)
  toast.success('Emoji uploaded successfully')
}

const handleEmojiDeleted = (emojiId: string) => {
  const index = emojis.value.findIndex(emoji => emoji.id === emojiId)
  if (index > -1) {
    emojis.value.splice(index, 1)
  }
}

const handleSave = async () => {
  if (!permissions.value.canSaveChanges) {
    toast.error('You do not have permission to save changes')
    return
  }

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
  router.push({ name: 'Chat', params: { serverId: props.serverId } })
}

// Lifecycle
onMounted(async () => {
  await Promise.all([fetchServer(), fetchEmojis()])
})

// Watch for unsaved changes warning
watch(hasChanges, (newValue) => {
  if (newValue && permissions.value.canSaveChanges) {
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

.permission-notice {
  margin-bottom: 24px;
  padding: 16px;
  background-color: rgba(250, 166, 26, 0.1);
  border: 1px solid rgba(250, 166, 26, 0.3);
  border-radius: 8px;
}

.notice-content {
  display: flex;
  align-items: flex-start;
  gap: 12px;
}

.notice-icon {
  flex-shrink: 0;
  margin-top: 2px;
  color: #faa61a;
}

.notice-text h4 {
  margin: 0 0 4px 0;
  font-size: 14px;
  font-weight: 600;
  color: #faa61a;
}

.notice-text p {
  margin: 0;
  font-size: 13px;
  color: #b9bbbe;
  line-height: 1.4;
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