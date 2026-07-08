<template>
  <div class="federated-server-modal" @click.self="$emit('close')">
    <div class="modal-content">
      <!-- Header -->
      <div class="modal-header">
        <div class="header-icon">
          <svg viewBox="0 0 24 24" class="icon">
            <path d="M17.9,17.39C17.64,16.59 16.89,16 16,16H15V13A1,1 0 0,0 14,12H8V10H10A1,1 0 0,0 11,9V7H13A2,2 0 0,0 15,5V4.59C17.93,5.77 20,8.64 20,12C20,14.08 19.2,15.97 17.9,17.39M11,19.93C7.05,19.44 4,16.08 4,12C4,11.38 4.08,10.79 4.21,10.21L9,15V16A2,2 0 0,0 11,18M12,2A10,10 0 0,0 2,12A10,10 0 0,0 12,22A10,10 0 0,0 22,12A10,10 0 0,0 12,2Z" fill="currentColor"/>
          </svg>
        </div>
        <h2>{{ $t('federation.joinRemoteServer') }}</h2>
        <p class="subtitle">{{ $t('federation.joinRemoteServerDesc') }}</p>
      </div>

      <!-- Search/Input -->
      <div class="input-section">
        <label for="server-url">{{ $t('federation.serverUrl') }}</label>
        <div class="input-wrapper">
          <input
            id="server-url"
            v-model="serverUrl"
            type="text"
            :placeholder="$t('federation.serverUrlPlaceholder')"
            :disabled="isLoading"
            @keyup.enter="discoverServer"
          />
          <button 
            class="discover-btn"
            :disabled="!serverUrl || isLoading"
            @click="discoverServer"
          >
            <span v-if="isLoading" class="loading-spinner"></span>
            <span v-else>{{ $t('federation.discover') }}</span>
          </button>
        </div>
        <p class="input-hint">{{ $t('federation.urlFormatHint') }}</p>
      </div>

      <!-- Error Message -->
      <div v-if="error" class="error-message">
        <svg viewBox="0 0 24 24" class="error-icon">
          <path d="M13,13H11V7H13M13,17H11V15H13M12,2A10,10 0 0,0 2,12A10,10 0 0,0 12,22A10,10 0 0,0 22,12A10,10 0 0,0 12,2Z" fill="currentColor"/>
        </svg>
        <span>
          {{ error }}
          <a
            v-if="props.initialUrl"
            :href="props.initialUrl"
            target="_blank"
            rel="noopener noreferrer"
            class="error-fallback-link"
            data-no-intercept
          >{{ $t('federation.openInBrowser', 'Open link in browser instead') }}</a>
        </span>
      </div>

      <!-- Server Preview -->
      <div v-if="discoveredServer" class="server-preview">
        <div class="server-icon">
          <img 
            v-if="discoveredServer.icon" 
            :src="discoveredServer.icon" 
            :alt="discoveredServer.name"
          />
          <span v-else class="icon-placeholder">
            {{ discoveredServer.name.charAt(0).toUpperCase() }}
          </span>
        </div>
        
        <div class="server-info">
          <h3 class="server-name">{{ discoveredServer.name }}</h3>
          <p class="server-instance">
            <svg viewBox="0 0 24 24" class="instance-icon">
              <path d="M17.9,17.39C17.64,16.59 16.89,16 16,16H15V13A1,1 0 0,0 14,12H8V10H10A1,1 0 0,0 11,9V7H13A2,2 0 0,0 15,5V4.59C17.93,5.77 20,8.64 20,12C20,14.08 19.2,15.97 17.9,17.39M11,19.93C7.05,19.44 4,16.08 4,12C4,11.38 4.08,10.79 4.21,10.21L9,15V16A2,2 0 0,0 11,18M12,2A10,10 0 0,0 2,12A10,10 0 0,0 12,22A10,10 0 0,0 22,12A10,10 0 0,0 12,2Z" fill="currentColor"/>
            </svg>
            {{ discoveredServer.instance }}
          </p>
          <p v-if="discoveredServer.description" class="server-description">
            {{ discoveredServer.description }}
          </p>
          
          <div class="server-stats">
            <span class="stat">
              <svg viewBox="0 0 24 24" class="stat-icon">
                <path d="M12,5.5A3.5,3.5 0 0,1 15.5,9A3.5,3.5 0 0,1 12,12.5A3.5,3.5 0 0,1 8.5,9A3.5,3.5 0 0,1 12,5.5M5,8C5.56,8 6.08,8.15 6.53,8.42C6.38,9.85 6.8,11.27 7.66,12.38C7.16,13.34 6.16,14 5,14A3,3 0 0,1 2,11A3,3 0 0,1 5,8M19,8A3,3 0 0,1 22,11A3,3 0 0,1 19,14C17.84,14 16.84,13.34 16.34,12.38C17.2,11.27 17.62,9.85 17.47,8.42C17.92,8.15 18.44,8 19,8M5.5,18.25C5.5,16.18 8.41,14.5 12,14.5C15.59,14.5 18.5,16.18 18.5,18.25V20H5.5V18.25Z" fill="currentColor"/>
              </svg>
              {{ discoveredServer.memberCount }} {{ $t('federation.members') }}
            </span>
            <span class="stat">
              <svg viewBox="0 0 24 24" class="stat-icon">
                <path d="M5,3H19A2,2 0 0,1 21,5V19A2,2 0 0,1 19,21H5A2,2 0 0,1 3,19V5A2,2 0 0,1 5,3M7,7V9H17V7H7M7,11V13H17V11H7M7,15V17H14V15H7Z" fill="currentColor"/>
              </svg>
              {{ discoveredServer.channels.length }} {{ $t('federation.channels') }}
            </span>
          </div>

          <!-- Invite Info Badge -->
          <div v-if="isInvite && inviteInfo" class="invite-badge">
            <svg width="14" height="14" viewBox="0 0 24 24" class="invite-icon">
              <path d="M10,21V19H6.41L10.91,14.5L9.5,13.09L5,17.59V14H3V21H10M14.5,10.91L19,6.41V10H21V3H14V5H17.59L13.09,9.5L14.5,10.91Z" fill="currentColor"/>
            </svg>
            <span>{{ $t('federation.inviteLink') }}</span>
          </div>

          <!-- Invite Details -->
          <div v-if="isInvite && inviteInfo" class="invite-details">
            <div v-if="inviteInfo.createdBy" class="invite-creator">
              <span class="detail-label">{{ $t('federation.invitedBy') }}:</span>
              <span class="detail-value">
                <DisplayName
                  :parts="inviterDisplayNameParts"
                  :fallback="inviteInfo.createdBy.displayName || inviteInfo.createdBy.username || ''"
                />
              </span>
            </div>
            <div v-if="inviteInfo.expiresAt" class="invite-expiry">
              <span class="detail-label">{{ $t('federation.expires') }}:</span>
              <span class="detail-value">{{ formatExpiry(inviteInfo.expiresAt) }}</span>
            </div>
          </div>

          <!-- Origin rules (instance + server) shown before joining -->
          <div v-if="isInvite && combinedRules.length > 0" class="invite-rules">
            <div class="invite-rules__title">{{ $t('federation.serverRules', 'Rules') }}</div>
            <ol class="invite-rules__list">
              <li v-for="(rule, index) in combinedRules" :key="index">{{ rule }}</li>
            </ol>
            <p class="invite-rules__note">{{ $t('federation.rulesAgreeNote', 'By joining, you agree to these rules.') }}</p>
          </div>

          <!-- Channel Preview -->
          <div v-if="discoveredServer.channels.length > 0" class="channels-preview">
            <span 
              v-for="channel in discoveredServer.channels.slice(0, 5)" 
              :key="channel.id"
              class="channel-tag"
            >
              <span class="channel-icon">{{ channel.type === 'voice' ? '🔊' : '#' }}</span>
              {{ channel.name }}
            </span>
            <span v-if="discoveredServer.channels.length > 5" class="more-channels">
              +{{ discoveredServer.channels.length - 5 }} {{ $t('federation.more') }}
            </span>
          </div>
        </div>
      </div>

      <!-- Actions -->
      <div class="modal-actions">
        <button class="cancel-btn" @click="$emit('close')" :disabled="isJoining">
          {{ $t('common.cancel') }}
        </button>
        <button 
          class="join-btn"
          :disabled="!discoveredServer || isJoining"
          @click="joinServer"
        >
          <span v-if="isJoining" class="loading-spinner"></span>
          <span v-else>{{ $t('federation.joinServer') }}</span>
        </button>
      </div>

      <!-- Federated Notice (only shown after a server is discovered) -->
      <div v-if="discoveredServer" class="federated-notice">
        <svg viewBox="0 0 24 24" class="notice-icon">
          <path d="M11,9H13V7H11M12,20C7.59,20 4,16.41 4,12C4,7.59 7.59,4 12,4C16.41,4 20,7.59 20,12C20,16.41 16.41,20 12,20M12,2A10,10 0 0,0 2,12A10,10 0 0,0 12,22A10,10 0 0,0 22,12A10,10 0 0,0 12,2M11,17H13V11H11V17Z" fill="currentColor"/>
        </svg>
        <span>{{ $t('federation.federatedNotice') }}</span>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { federationServerService, type RemoteServer, type InviteInfo } from '@/services/federation'
import { useAuthStore } from '@/stores/auth'
import { useServerChannelStore } from '@/stores/useServerChannel'
import { useInstanceSettingsStore } from '@/stores/useInstanceSettings'
import { useRouter } from 'vue-router'
import { debug } from '@/utils/debug'
import DisplayName from '@/components/DisplayName.vue'
import { userDataService } from '@/services/userDataService'

const props = defineProps<{
  /** Prefill (e.g. a clicked remote invite URL) and auto-run discovery. */
  initialUrl?: string
}>()

const emit = defineEmits<{
  close: []
  joined: [serverId: string]
}>()

const router = useRouter()
const authStore = useAuthStore()
const serverChannelStore = useServerChannelStore()
const instanceSettings = useInstanceSettingsStore()

const serverUrl = ref('')
const isLoading = ref(false)
const isJoining = ref(false)
const error = ref('')
const discoveredServer = ref<RemoteServer | null>(null)
const inviteInfo = ref<InviteInfo | null>(null)
const isInvite = ref(false)

onMounted(() => {
  if (props.initialUrl) {
    serverUrl.value = props.initialUrl
    void discoverServer()
  }
})

const inviterDisplayNameParts = computed(() => {
  const creator = inviteInfo.value?.createdBy
  if (!creator?.displayName && !creator?.username) return undefined
  if (!instanceSettings.settings.allowCustomEmojisInDisplayNames) return undefined
  const dn = creator.displayName || creator.username || ''
  return userDataService.resolveDisplayNameParts(dn)
})

// origin instance rules first, then server rules
const combinedRules = computed(() => [
  ...(inviteInfo.value?.instanceRules ?? []),
  ...(inviteInfo.value?.serverRules ?? []),
])

async function discoverServer() {
  if (!serverUrl.value) return

  error.value = ''
  discoveredServer.value = null
  inviteInfo.value = null
  isInvite.value = false
  isLoading.value = true

  try {
    const result = await federationServerService.discoverServer(serverUrl.value)

    if (result.success && result.server) {
      discoveredServer.value = result.server
      isInvite.value = result.isInvite || false
      if (result.invite) {
        inviteInfo.value = result.invite
      }
    } else {
      error.value = result.error || 'Could not find server'
    }
  } catch (err: any) {
    error.value = err.message || 'Failed to discover server'
  } finally {
    isLoading.value = false
  }
}

async function joinServer() {
  const userId = authStore.session?.user?.id
  if (!discoveredServer.value || !userId) return

  error.value = ''
  isJoining.value = true

  try {
    const result = await federationServerService.joinServer(
      discoveredServer.value.id,
      userId,
      inviteInfo.value?.code // Pass invite code if present
    )

    if (result.success && result.serverId) {
      emit('joined', result.serverId)
      
      // Force refresh the server list to include the newly joined server
      await serverChannelStore.fetchServersForUser(userId, true)
      
      serverChannelStore.setCurrentServer(result.serverId)
      await serverChannelStore.fetchCategoriesAndChannels(result.serverId)
      
      // Navigate to the server's default channel (or server overview if no channel)
      // NOTE: Use /chat/ route for actual chat, not /server/ (which is for settings)
      if (result.defaultChannelId) {
        serverChannelStore.setCurrentChannel(result.defaultChannelId)
        debug.log('Navigating to default channel:', result.defaultChannelId)
        router.push(`/chat/${result.serverId}/${result.defaultChannelId}`)
      } else {
        // Fallback - try to get the first channel from discovered server
        // channelType is used in ActivityPub responses ('text', 'voice', 'category')
        // type might be used in invite responses (same format)
        const firstChannel = discoveredServer.value?.channels?.find((c: any) => 
          c.channelType === 'text' || c.channelType === 'voice' ||
          c.type === 'text' || c.type === 'voice'
        )
        if (firstChannel) {
          const channelId = (firstChannel as any).localId || firstChannel.id?.split('/').pop()
          if (channelId) {
            debug.log('Navigating to fallback channel:', channelId)
            router.push(`/chat/${result.serverId}/${channelId}`)
            return
          }
        }
        debug.log('No default channel found, navigating to DM page')
        router.push('/dm')
      }
    } else {
      error.value = result.error || 'Failed to join server'
    }
  } catch (err: any) {
    error.value = err.message || 'Failed to join server'
  } finally {
    isJoining.value = false
  }
}

function formatExpiry(expiresAt: string): string {
  const date = new Date(expiresAt)
  const now = new Date()
  const diff = date.getTime() - now.getTime()
  
  if (diff < 0) return 'Expired'
  
  const hours = Math.floor(diff / (1000 * 60 * 60))
  const days = Math.floor(hours / 24)
  
  if (days > 0) return `${days} day${days > 1 ? 's' : ''}`
  if (hours > 0) return `${hours} hour${hours > 1 ? 's' : ''}`
  
  const minutes = Math.floor(diff / (1000 * 60))
  return `${minutes} minute${minutes > 1 ? 's' : ''}`
}
</script>

<style scoped>
.federated-server-modal {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.75);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  padding: 16px;
}

.modal-content {
  background: linear-gradient(
    165deg,
    color-mix(in srgb, var(--bg-secondary, #2b2d31) 95%, transparent) 0%,
    color-mix(in srgb, var(--bg-secondary, #1e1f22) 98%, #0ea5e9 5%) 100%
  );
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 20px;
  padding: 36px;
  width: 100%;
  max-width: 540px;
  max-height: 90vh;
  overflow-y: auto;
  box-shadow:
    0 0 0 1px rgba(14, 165, 233, 0.15),
    0 24px 48px -12px rgba(0, 0, 0, 0.5),
    0 0 80px -20px rgba(14, 165, 233, 0.2);
}

/* Stack vertically - global .modal-header is a row (title + close); we use icon + title + subtitle */
.modal-header {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: flex-start;
  text-align: center;
  margin-bottom: 24px;
  padding: 0;
  border-bottom: none;
  gap: 0;
}

.header-icon {
  width: 56px;
  height: 56px;
  background: linear-gradient(135deg, #0EA5E9, #38BDF8);
  border-radius: 14px;
  display: flex;
  align-items: center;
  justify-content: center;
  margin: 0 auto 16px;
}

.header-icon .icon {
  width: 28px;
  height: 28px;
  color: var(--text-primary);
}

.modal-header h2 {
  font-size: 24px;
  font-weight: 700;
  color: var(--text-primary);
  margin: 0 0 8px;
}

.subtitle {
  color: var(--text-secondary);
  margin: 0;
  font-size: 14px;
}

.input-section {
  margin-bottom: 20px;
}

.input-section label {
  display: block;
  font-size: 12px;
  font-weight: 600;
  color: var(--text-secondary);
  text-transform: uppercase;
  margin-bottom: 8px;
}

.input-wrapper {
  display: flex;
  gap: 8px;
}

.input-wrapper input {
  flex: 1;
  padding: 12px 16px;
  background: #202225;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 8px;
  color: var(--text-primary);
  font-size: 14px;
  outline: none;
  transition: border-color 0.2s;
}

.input-wrapper input:focus {
  border-color: #0EA5E9;
}

.input-wrapper input::placeholder {
  color: var(--text-muted);
}

.discover-btn {
  padding: 12px 20px;
  background: var(--harmony-primary);
  color: var(--text-primary);
  border: none;
  border-radius: 8px;
  font-weight: 600;
  cursor: pointer;
  transition: background 0.2s;
  min-width: 100px;
}

.discover-btn:hover:not(:disabled) {
  background: #0284C7;
}

.discover-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.input-hint {
  font-size: 12px;
  color: var(--text-muted);
  margin-top: 8px;
}

.error-message {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  background: rgba(237, 66, 69, 0.1);
  border: 1px solid rgba(237, 66, 69, 0.3);
  border-radius: 8px;
  color: #ed4245;
  font-size: 14px;
  margin-bottom: 20px;
}

.error-icon {
  width: 20px;
  height: 20px;
  flex-shrink: 0;
}

.server-preview {
  display: flex;
  gap: 20px;
  padding: 24px;
  background: rgba(255, 255, 255, 0.05);
  border-radius: 16px;
  margin-bottom: 24px;
  border: 1px solid rgba(255, 255, 255, 0.08);
}

.server-icon {
  width: 72px;
  height: 72px;
  border-radius: 18px;
  overflow: hidden;
  flex-shrink: 0;
}

.server-icon img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.icon-placeholder {
  width: 100%;
  height: 100%;
  display: flex;
  align-items: center;
  justify-content: center;
  background: linear-gradient(135deg, #0EA5E9, #38BDF8);
  color: var(--text-primary);
  font-size: 28px;
  font-weight: 700;
}

.server-info {
  flex: 1;
  min-width: 0;
}

.server-name {
  font-size: 20px;
  font-weight: 700;
  color: var(--text-primary);
  margin: 0 0 6px;
  letter-spacing: -0.02em;
}

.server-instance {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: #00d4ff;
  margin: 0 0 12px;
}

.instance-icon {
  width: 14px;
  height: 14px;
}

.server-description {
  font-size: 13px;
  color: var(--text-secondary);
  margin: 0 0 12px;
  line-height: 1.4;
}

.server-stats {
  display: flex;
  gap: 16px;
  margin-bottom: 12px;
}

.stat {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--text-secondary);
}

.stat-icon {
  width: 16px;
  height: 16px;
}

.invite-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  background: rgba(87, 242, 135, 0.12);
  border: 1px solid rgba(87, 242, 135, 0.25);
  border-radius: 10px;
  color: #57f287;
  font-size: 12px;
  font-weight: 600;
  margin-bottom: 12px;
}

.invite-icon {
  opacity: 0.9;
}

.invite-details {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 12px 14px;
  background: rgba(255, 255, 255, 0.03);
  border-radius: 8px;
  margin-bottom: 12px;
  font-size: 13px;
}

.invite-creator,
.invite-expiry {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.invite-creator .detail-value {
  flex: 1;
  min-width: 0;
  overflow: hidden;
}

.detail-label {
  color: var(--text-muted);
  flex-shrink: 0;
}

.detail-value {
  color: var(--text-primary);
  font-weight: 500;
}

.detail-value :deep(.display-name) {
  display: inline;
}

.channels-preview {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}

.channel-tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 5px 10px;
  background: rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 8px;
  font-size: 12px;
  color: var(--text-secondary);
}

.channel-icon {
  font-size: 11px;
  opacity: 0.8;
}

.more-channels {
  font-size: 12px;
  color: var(--text-muted);
  padding: 5px 0;
}

.modal-actions {
  display: flex;
  gap: 12px;
  justify-content: flex-end;
  margin-bottom: 20px;
}

.cancel-btn {
  padding: 12px 24px;
  background: transparent;
  color: var(--text-secondary);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 8px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.2s;
}

.cancel-btn:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.1);
  color: var(--text-primary);
}

.join-btn {
  padding: 12px 32px;
  background: linear-gradient(135deg, #57f287, #00d166);
  color: var(--text-primary);
  border: none;
  border-radius: 8px;
  font-weight: 600;
  cursor: pointer;
  transition: all 0.2s;
  min-width: 120px;
}

.join-btn:hover:not(:disabled) {
  transform: translateY(-1px);
  box-shadow: 0 4px 12px rgba(87, 242, 135, 0.3);
}

.join-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
  transform: none;
}

.loading-spinner {
  display: inline-block;
  width: 16px;
  height: 16px;
  border: 2px solid rgba(255, 255, 255, 0.3);
  border-top-color: var(--text-primary);
  border-radius: 50%;
  animation: spin 0.8s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

.federated-notice {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 16px;
  background: rgba(0, 212, 255, 0.1);
  border: 1px solid rgba(0, 212, 255, 0.2);
  border-radius: 8px;
  font-size: 13px;
  color: #00d4ff;
}

.notice-icon {
  width: 18px;
  height: 18px;
  flex-shrink: 0;
}

@media (max-width: 480px) {
  .federated-server-modal {
    padding: 8px;
    align-items: flex-start;
    padding-top: 48px;
  }

  .modal-content {
    padding: 20px;
    max-width: 100%;
    max-height: calc(100vh - 64px);
    border-radius: 10px;
  }

  .modal-header h2 {
    font-size: 18px;
  }

  .header-icon {
    width: 44px;
    height: 44px;
    border-radius: 10px;
    margin-bottom: 12px;
  }

  .server-preview {
    flex-direction: column;
    text-align: center;
  }

  .server-icon {
    margin: 0 auto;
  }

  .server-instance {
    justify-content: center;
  }

  .server-stats {
    justify-content: center;
  }

  .channels-preview {
    justify-content: center;
  }

  .modal-actions {
    flex-direction: column-reverse;
  }

  .cancel-btn,
  .join-btn {
    width: 100%;
    padding: 12px;
  }
}

.invite-rules {
  padding: 12px 14px;
  background: rgba(255, 255, 255, 0.03);
  border-radius: 8px;
  margin-bottom: 12px;
}

.invite-rules__title {
  font-size: 12px;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-secondary);
  margin-bottom: 8px;
}

.invite-rules__list {
  margin: 0;
  padding-left: 18px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  font-size: 13px;
  color: var(--text-primary);
  max-height: 160px;
  overflow-y: auto;
}

.invite-rules__note {
  margin: 8px 0 0;
  font-size: 11px;
  color: var(--text-muted);
}

.error-fallback-link {
  display: block;
  margin-top: 4px;
  font-size: 12px;
  color: var(--text-secondary);
  text-decoration: underline;
}

.error-fallback-link:hover {
  color: var(--text-primary);
}
</style>

