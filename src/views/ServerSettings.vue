<template>
  <div class="server-settings">
    <!-- Mobile Navigation Header -->
    <div class="mobile-nav" v-if="isMobile">
      <button class="mobile-menu-btn" @click="toggleSidebar" aria-label="Toggle navigation">
        <div class="hamburger-icon" :class="{ active: showSidebar }">
          <span></span>
          <span></span>
          <span></span>
        </div>
      </button>
      <h1 class="mobile-title">{{ currentSectionLabel }}</h1>
      <button class="mobile-back-btn" @click="back" aria-label="Back to chat">
        <svg width="20" height="20" viewBox="0 0 24 24">
          <path fill="currentColor" d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.42-1.41L7.83 13H20v-2z"/>
        </svg>
      </button>
    </div>

    <!-- Desktop Header -->
    <div class="server-settings-header" v-if="!isMobile">
      <button class="back-button" @click="back" aria-label="Back to chat">
        <svg width="24" height="24" viewBox="0 0 24 24">
          <path fill="currentColor" d="M20 11H7.83l5.59-5.59L12 4l-8 8 8 8 1.42-1.41L7.83 13H20v-2z"/>
        </svg>
      </button>
      <h1 class="server-settings-title">
        {{ permissions.canEditBasicInfo ? $t('server.serverSettings') : $t('server.serverInformation') }}
      </h1>
      <div class="server-settings-actions" v-if="permissions.canSaveChanges">
        <button 
          class="btn btn-secondary" 
          @click="back"
          :disabled="loading"
        >
          {{ $t('common.cancel') }}
        </button>
        <button 
          class="btn btn-primary" 
          @click="handleSave"
          :disabled="loading || !hasChanges"
        >
          <span v-if="loading" class="loading-spinner"></span>
          {{ $t('server.saveChanges') }}
        </button>
      </div>
      <div v-else class="server-settings-actions">
        <button 
          class="btn btn-secondary" 
          @click="back"
          :disabled="loading"
        >
          {{ $t('server.back') }}
        </button>
      </div>
    </div>

    <div class="server-settings-content">
      <!-- Sidebar Navigation -->
      <div 
        class="server-settings-sidebar" 
        :class="{ 'mobile-hidden': isMobile && !showSidebar }"
        v-touch:swipe.left="handleSidebarSwipe"
      >
        <nav class="settings-nav">
          <button 
            v-for="section in availableSections" 
            :key="section.id"
            class="nav-item"
            :class="{ active: activeSection === section.id }"
            @click="setActiveSection(section.id)"
          >
            {{ section.label }}
          </button>
        </nav>
      </div>

      <!-- Sidebar Overlay (mobile) -->
      <div 
        v-if="isMobile && showSidebar" 
        class="sidebar-overlay"
        @click="closeSidebar"
      ></div>

      <div class="server-settings-main">
        <div class="settings-container">
          <!-- Mobile Save Actions (shown at top on mobile when needed) -->
          <div v-if="isMobile && permissions.canSaveChanges" class="mobile-save-actions">
            <button 
              class="btn btn-primary btn-mobile" 
              @click="handleSave"
              :disabled="loading || !hasChanges"
            >
              <span v-if="loading" class="loading-spinner"></span>
              {{ hasChanges ? $t('server.saveChanges') : $t('server.noChanges') }}
            </button>
          </div>

          <!-- Server Overview Section -->
          <ServerBasicInfo
            v-if="activeSection === 'overview'"
            v-model:server="server"
            v-model:selectedFile="selectedFile"
            :selected-banner-file="selectedBannerFile"
            :owner-name="ownerName"
            :loading="loading"
            :permissions="permissions"
            @file-change="handleFileChange"
            @banner-change="handleBannerChange"
          />

          <!-- Roles Section -->
          <RoleManagement
            v-if="activeSection === 'roles'"
            :server-id="serverId"
          />

          <!-- Bans Section -->
          <ServerBans
            v-if="activeSection === 'bans'"
            :server-id="serverId"
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
            @emojis-bulk-deleted="handleEmojisBulkDeleted"
          />

          <!-- Privacy Settings Section -->
          <template v-if="activeSection === 'privacy'">
            <ServerPrivacySettings
              :serverId="serverId"
              v-model:isPublic="server.public"
              :federationEnabled="server.federation_enabled ?? false"
              @update:federationEnabled="server.federation_enabled = $event"
              :loading="loading"
              :permissions="permissions"
            />
            <ServerEncryptionSettings
              ref="encryptionSettingsRef"
              :server-id="serverId"
              v-if="permissions.canChangePrivacySettings"
            />
          </template>

          <!-- Advanced Settings Section -->
          <template v-if="activeSection === 'advanced'">
            <ServerAdvancedSettings
              :server-id="serverId"
              :server-name="server.name"
              :created-at="server.created_at"
              :loading="loading"
              :permissions="{ canDeleteServer: permissions.canDeleteServer }"
            />
            <ServerBotsSettings
              v-if="permissions.canEditBasicInfo"
              :server-id="serverId"
            />
            <DiscordBridgeSetup
              v-if="permissions.canEditBasicInfo"
              :server-id="serverId"
            />
          </template>
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { onMounted, ref, computed, watch, onUnmounted } from 'vue'
import { debug } from '@/utils/debug'
import { useRouter } from 'vue-router'
import { useToast } from 'vue-toastification'
import { useI18n } from 'vue-i18n'
import { useServerStore } from '@/stores/server'
import { useEmojiCacheStore } from '@/stores/useEmojiCache'
import { useServerPermissions } from '@/composables/useServerPermissions'
import { getProfileWithAvatarUrl } from '@/services/ProfileService'
import { useLayoutState } from '@/composables/useLayoutState'
import type { Server, Emoji } from '@/types'

// Components
import ServerBasicInfo from '@/components/settings/ServerBasicInfo.vue'
import ServerEmojiManagement from '@/components/settings/ServerEmojiManagement.vue'
import ServerPrivacySettings from '@/components/settings/ServerPrivacySettings.vue'
import ServerAdvancedSettings from '@/components/settings/ServerAdvancedSettings.vue'
import ServerEncryptionSettings from '@/components/settings/ServerEncryptionSettings.vue'
import ServerBotsSettings from '@/components/settings/ServerBotsSettings.vue'
import DiscordBridgeSetup from '@/components/settings/DiscordBridgeSetup.vue'
import RoleManagement from '@/components/settings/RoleManagement.vue'
import ServerBans from '@/components/settings/server/ServerBans.vue'

interface Props {
  serverId: string
}

const props = defineProps<Props>()

// I18n
const { t } = useI18n()

// Layout State
const { isMobile } = useLayoutState()

// Composables
const router = useRouter()
const serverStore = useServerStore()
const emojiCacheStore = useEmojiCacheStore()
const toast = useToast()
const { serverSettingsPermissions } = useServerPermissions()

// Reactive state
const loading = ref(false)
const ownerName = ref('')
const selectedFile = ref<File | null>(null)
const selectedBannerFile = ref<File | null>(null)
const emojis = ref<Emoji[]>([])
const activeSection = ref('overview')
// Mobile entry starts with the nav open (matches UserSettings) so users can
// orient themselves before a section fills the screen.
const showSidebar = ref(typeof window !== 'undefined' && window.innerWidth <= 768)
const windowWidth = ref(typeof window !== 'undefined' ? window.innerWidth : 1024)

// Server state
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
const encryptionSettingsRef = ref<InstanceType<typeof ServerEncryptionSettings> | null>(null)

const currentSectionLabel = computed(() => {
  const section = availableSections.value.find(s => s.id === activeSection.value)
  return section?.label || t('server.serverSettings')
})

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
    { id: 'overview', label: t('server.overview') },
    { id: 'roles', label: t('server.roles', 'Roles') },
    { id: 'bans', label: 'Bans' },
    { id: 'emoji', label: t('server.emoji') },
    { id: 'privacy', label: t('server.privacySettings') },
    { id: 'advanced', label: t('server.advancedSettings') }
  ]
  return sections
})

const generalHasChanges = computed(() => {
  if (!originalServer.value) return false
  return (
    server.value.name !== originalServer.value.name ||
    server.value.description !== originalServer.value.description ||
    server.value.icon !== originalServer.value.icon ||
    server.value.allow_cross_server_emojis !== originalServer.value.allow_cross_server_emojis ||
    server.value.public !== originalServer.value.public ||
    server.value.federation_enabled !== originalServer.value.federation_enabled ||
    selectedFile.value !== null ||
    selectedBannerFile.value !== null ||
    server.value.banner !== originalServer.value.banner
  )
})

const hasChanges = computed(() => {
  if (!permissions.value.canSaveChanges) return false
  const encryptionChanged = encryptionSettingsRef.value?.hasChanges ?? false
  return generalHasChanges.value || encryptionChanged
})

// Methods
const handleResize = () => {
  if (typeof window !== 'undefined') {
    windowWidth.value = window.innerWidth
    if (!isMobile.value) {
      showSidebar.value = false
    }
  }
}

const toggleSidebar = () => {
  showSidebar.value = !showSidebar.value
}

const closeSidebar = () => {
  showSidebar.value = false
}

const handleSidebarSwipe = () => {
  if (isMobile.value) {
    closeSidebar()
  }
}

const setActiveSection = (sectionId: string) => {
  activeSection.value = sectionId
  // Close sidebar on mobile after selection
  if (isMobile.value) {
    closeSidebar()
  }
}
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
    debug.error('Error fetching server:', error)
    toast.error(t('server.failedToLoadServerSettings'))
  } finally {
    loading.value = false
  }
}

const fetchEmojis = async () => {
  try {
    const cached = emojiCacheStore.getServerEmojis(props.serverId)
    if (cached.length > 0) {
      emojis.value = cached
      return
    }
    await emojiCacheStore.loadEmojisForServers([props.serverId])
    emojis.value = emojiCacheStore.getServerEmojis(props.serverId)
  } catch (error) {
    debug.error('Error fetching emojis:', error)
    toast.error(t('server.failedToLoadEmojis'))
  }
}

const handleFileChange = (file: File | null) => {
  if (!permissions.value.canChangeServerIcon) return
  selectedFile.value = file
}

const handleBannerChange = (file: File | null) => {
  if (!permissions.value.canChangeServerIcon) return
  selectedBannerFile.value = file
}

const handleEmojiUploaded = (newEmoji: Emoji) => {
  emojis.value.push(newEmoji)
  emojiCacheStore.invalidate({ serverId: props.serverId })
}

const handleEmojiDeleted = (emojiId: string) => {
  const index = emojis.value.findIndex(emoji => emoji.id === emojiId)
  if (index > -1) {
    emojis.value.splice(index, 1)
  }
  emojiCacheStore.invalidate({ serverId: props.serverId })
}

const handleEmojisBulkDeleted = (emojiIds: string[]) => {
  const deletedSet = new Set(emojiIds)
  emojis.value = emojis.value.filter(emoji => !deletedSet.has(emoji.id))
  emojiCacheStore.invalidate({ serverId: props.serverId })
}

const handleSave = async () => {
  if (!permissions.value.canSaveChanges) {
    toast.error(t('server.noPermissionSaveChanges'))
    return
  }

  try {
    loading.value = true

    if (generalHasChanges.value) {
      const success = await serverStore.updateServer(server.value, selectedFile.value || undefined, selectedBannerFile.value || undefined)
      if (success) {
        // Re-fetch so uploaded file paths (banner, icon) are reflected in UI
        const freshData = await serverStore.getServer(props.serverId)
        if (freshData) {
          server.value = { ...freshData }
        }
        originalServer.value = { ...server.value }
        selectedFile.value = null
        selectedBannerFile.value = null
      } else {
        throw new Error('Update failed')
      }
    }

    if (encryptionSettingsRef.value?.hasChanges) {
      await encryptionSettingsRef.value.saveSettings()
    }

    toast.success(t('server.serverUpdatedSuccess'))
    back()
  } catch (error) {
    debug.error('Error updating server:', error)
    toast.error(t('server.failedToUpdateServer'))
  } finally {
    loading.value = false
  }
}

const back = () => {
  router.push({ name: 'Chat', params: { serverId: props.serverId } })
}

// SSR-safe beforeunload handler
const handleBeforeUnload = (e: BeforeUnloadEvent) => {
  if (hasChanges.value) {
    e.preventDefault()
    e.returnValue = ''
  }
}

// Escape closes the server settings view (matches the close-button
// behavior). Skipped if a modal-overlay is currently open above us.
const handleSettingsKeydown = (event: KeyboardEvent) => {
  if (event.key !== 'Escape') return
  const target = event.target as HTMLElement | null
  if (target?.closest('.modal-overlay')) return
  back()
}

// Lifecycle
onMounted(async () => {
  // Setup resize listener with SSR safety
  if (typeof window !== 'undefined') {
    window.addEventListener('resize', handleResize)
    handleResize() // Set initial width
    document.addEventListener('keydown', handleSettingsKeydown)
  }

  await Promise.all([fetchServer(), fetchEmojis()])
})

onUnmounted(() => {
  if (typeof window !== 'undefined') {
    window.removeEventListener('resize', handleResize)
    window.removeEventListener('beforeunload', handleBeforeUnload)
    document.removeEventListener('keydown', handleSettingsKeydown)
  }
})

// Watch for unsaved changes warning
watch(hasChanges, (newValue) => {
  if (typeof window !== 'undefined') {
    if (newValue && permissions.value.canSaveChanges) {
      window.addEventListener('beforeunload', handleBeforeUnload)
    } else {
      window.removeEventListener('beforeunload', handleBeforeUnload)
    }
  }
})
</script>

<style scoped>
.server-settings {
  display: flex;
  flex-direction: column;
  height: 100vh;
  height: 100dvh;
  background-color: var(--background-tertiary);
  color: var(--text-primary);
}

/* Mobile Navigation */
.mobile-nav {
  display: none;
  height: 60px;
  background-color: var(--background-secondary);
  border-bottom: 1px solid var(--background-quaternary);
  padding: 0 16px;
  align-items: center;
  justify-content: space-between;
  box-shadow: 0 1px 0 rgba(0, 0, 0, 0.2);
}

.mobile-menu-btn {
  background: none;
  border: none;
  padding: 8px;
  cursor: pointer;
  border-radius: 4px;
  transition: background-color 0.15s ease;
}

.mobile-menu-btn:hover {
  background-color: var(--background-quaternary);
}

.hamburger-icon {
  width: 24px;
  height: 18px;
  position: relative;
  display: flex;
  flex-direction: column;
  justify-content: space-between;
}

.hamburger-icon span {
  display: block;
  height: 2px;
  width: 100%;
  background-color: var(--text-secondary);
  border-radius: 1px;
  transition: all 0.3s ease;
}

.hamburger-icon.active span:nth-child(1) {
  transform: rotate(45deg) translate(6px, 6px);
}

.hamburger-icon.active span:nth-child(2) {
  opacity: 0;
}

.hamburger-icon.active span:nth-child(3) {
  transform: rotate(-45deg) translate(6px, -6px);
}

.mobile-title {
  font-size: 18px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0;
  text-align: center;
  flex: 1;
}

.mobile-back-btn {
  background: none;
  border: none;
  padding: 8px;
  cursor: pointer;
  border-radius: 4px;
  color: var(--text-secondary);
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.15s ease;
}

.mobile-back-btn:hover {
  background-color: var(--background-quaternary);
  color: var(--text-primary);
}

/* Desktop Header */
.server-settings-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 24px;
  background-color: var(--background-secondary);
  border-bottom: 1px solid var(--background-quaternary);
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
  color: var(--text-secondary);
  cursor: pointer;
  border-radius: 4px;
  transition: all 0.15s ease;
}

.back-button:hover {
  background-color: var(--background-quaternary);
  color: var(--text-primary);
}

.server-settings-title {
  font-size: 20px;
  font-weight: 600;
  margin: 0;
  color: var(--text-primary);
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
  min-height: 36px;
}

.btn:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.btn-primary {
  background-color: var(--harmony-primary);
  color: var(--text-on-primary, #ffffff);
}

.btn-primary:hover:not(:disabled) {
  background-color: #0284C7;
}

.btn-secondary {
  background-color: transparent;
  color: var(--text-secondary);
  border: 1px solid var(--border-primary);
}

.btn-secondary:hover:not(:disabled) {
  background-color: var(--background-quaternary);
  color: var(--text-primary);
}

.btn-mobile {
  width: 100%;
  padding: 12px 16px;
  font-size: 15px;
  min-height: 48px;
}

.loading-spinner {
  width: 16px;
  height: 16px;
  border: 2px solid rgba(255, 255, 255, 0.3);
  border-top: 2px solid #ffffff;
  border-radius: 50%;
  animation: spin 1s linear infinite;
}

/* Content Layout */
.server-settings-content {
  display: flex;
  flex: 1;
  overflow: hidden;
}

.server-settings-sidebar {
  width: 240px;
  background-color: var(--background-secondary);
  border-right: 1px solid var(--background-quaternary);
  padding: 24px 0;
  transition: transform 0.3s ease;
}

.settings-nav {
  display: flex;
  flex-direction: column;
}

.nav-item {
  display: flex;
  align-items: center;
  padding: 12px 24px;
  background: none;
  border: none;
  color: var(--text-secondary);
  font-size: 14px;
  font-weight: 500;
  text-align: left;
  cursor: pointer;
  transition: all 0.15s ease;
  border-left: 3px solid transparent;
  min-height: 44px; /* Better touch target */
}

.nav-item:hover {
  background-color: var(--background-quaternary);
  color: var(--text-primary);
}

.nav-item.active {
  background-color: var(--background-quaternary);
  color: var(--text-primary);
  border-left-color: #0EA5E9;
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

/* Mobile Save Actions */
.mobile-save-actions {
  margin-bottom: 24px;
  padding: 16px;
  background-color: var(--background-secondary);
  border-radius: 8px;
  border: 1px solid var(--background-quaternary);
}


/* Sidebar Overlay */
.sidebar-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background-color: rgba(0, 0, 0, 0.5);
  z-index: 999;
}

/* Animations */
@keyframes spin {
  0% { transform: rotate(0deg); }
  100% { transform: rotate(360deg); }
}

/* Mobile Styles */
@media (max-width: 768px) {
  .mobile-nav {
    display: flex;
  }

  .server-settings-header {
    display: none;
  }
  

  .server-settings-sidebar {
    position: fixed;
    top: 60px; /* Below mobile nav */
    left: 0;
    width: 280px;
    height: calc(100vh - 60px);
    z-index: 1000;
    box-shadow: 2px 0 8px rgba(0, 0, 0, 0.3);
  }

  .server-settings-sidebar.mobile-hidden {
    transform: translateX(-100%);
  }
  
  .server-settings-main {
    padding: 16px;
  }

  /* Improve touch targets on mobile */
  .nav-item {
    padding: 16px 24px;
    min-height: 48px;
    font-size: 15px;
  }

  .mobile-title {
    font-size: 16px;
  }

  .settings-container {
    max-width: none;
  }
}

/* Extra small screens */
@media (max-width: 480px) {
  .server-settings-sidebar {
    width: 100vw;
  }
  
  .server-settings-main {
    padding: 12px;
  }

  .mobile-title {
    font-size: 15px;
  }
}

/* Transitions and animations */
@media (prefers-reduced-motion: no-preference) {
  .server-settings-sidebar {
    transition: transform 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  }

  .hamburger-icon span {
    transition: all 0.3s cubic-bezier(0.4, 0, 0.2, 1);
  }

  .sidebar-overlay {
    animation: fadeIn 0.3s ease;
  }
}

@keyframes fadeIn {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}
</style>