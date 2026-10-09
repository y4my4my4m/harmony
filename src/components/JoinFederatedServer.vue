<template>
  <div class="federated-server-modal" @click.self="close">
    <div
      class="modal-content"
      role="dialog"
      aria-modal="true"
      aria-labelledby="join-remote-server-title"
    >
      <div class="modal-header">
        <div class="header-icon">
          <Icon name="globe" :size="22" />
        </div>
        <div class="header-text">
          <h2 id="join-remote-server-title">{{ $t('federation.joinRemoteServer') }}</h2>
          <p class="subtitle">{{ $t('federation.joinRemoteServerDesc') }}</p>
        </div>
        <button
          type="button"
          class="close-button"
          :aria-label="$t('common.close')"
          :disabled="isJoining"
          @click="close"
        >
          <Icon name="x" :size="20" />
        </button>
      </div>

      <form class="input-section" @submit.prevent="discoverServer">
        <label for="server-url">{{ $t('federation.serverUrl') }}</label>
        <div class="input-wrapper">
          <input
            id="server-url"
            ref="urlInput"
            v-model.trim="serverUrl"
            type="text"
            inputmode="url"
            autocomplete="off"
            autocapitalize="off"
            spellcheck="false"
            :placeholder="$t('federation.serverUrlPlaceholder')"
            :disabled="isLoading || isJoining"
            @keydown.enter.prevent="discoverServer"
          />
          <button
            type="submit"
            class="btn btn-secondary discover-btn"
            :disabled="!serverUrl || isLoading || isJoining"
          >
            <Icon v-if="isLoading" name="spinner" :size="16" class="spin" />
            <span v-else>{{ $t('federation.discover') }}</span>
          </button>
        </div>
        <p class="input-hint">{{ $t('federation.urlFormatHint') }}</p>
      </form>

      <div v-if="error" class="error-message" role="alert">
        <Icon name="alert-circle" :size="16" />
        <span>
          {{ error }}
          <a
            v-if="props.initialUrl"
            :href="safeHref(props.initialUrl)"
            target="_blank"
            rel="noopener noreferrer"
            class="error-fallback-link"
            data-no-intercept
          >{{ $t('federation.openInBrowser', 'Open link in browser instead') }}</a>
        </span>
      </div>

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
            <Icon name="globe" :size="13" />
            {{ discoveredServer.instance }}
          </p>
          <p v-if="discoveredServer.description" class="server-description">
            {{ discoveredServer.description }}
          </p>

          <div class="server-stats">
            <span class="stat">
              <Icon name="users" :size="14" />
              {{ discoveredServer.memberCount }} {{ $t('federation.members') }}
            </span>
            <span class="stat">
              <Icon name="hash" :size="14" />
              {{ previewChannels.length }} {{ $t('federation.channels') }}
            </span>
          </div>

          <div v-if="isInvite && inviteInfo" class="invite-badge">
            <Icon name="link" :size="13" />
            <span>{{ $t('federation.inviteLink') }}</span>
          </div>

          <div v-if="isInvite && inviteInfo && (inviteInfo.createdBy || inviteInfo.expiresAt)" class="invite-details">
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

          <div v-if="isInvite && combinedRules.length > 0 && !joinedServerId" class="invite-rules">
            <div class="invite-rules__title">{{ $t('federation.serverRules', 'Rules') }}</div>
            <ol class="invite-rules__list">
              <li v-for="(rule, index) in combinedRules" :key="index">{{ rule }}</li>
            </ol>
            <p class="invite-rules__note">{{ $t('federation.rulesAgreeNote', 'By joining, you agree to these rules.') }}</p>
          </div>

          <div v-if="previewChannels.length > 0" class="channels-preview">
            <span
              v-for="channel in previewChannels.slice(0, 5)"
              :key="channel.id"
              class="channel-tag"
            >
              <Icon :name="channelKind(channel) === 'voice' ? 'volume' : 'hash'" :size="12" />
              {{ channel.name }}
            </span>
            <span v-if="previewChannels.length > 5" class="more-channels">
              +{{ previewChannels.length - 5 }} {{ $t('federation.more') }}
            </span>
          </div>
        </div>
      </div>

      <p v-if="joinedServerId" class="already-joined">
        <Icon name="check-circle" :size="16" />
        {{ $t('federation.alreadyJoined') }}
      </p>

      <div class="modal-actions">
        <button type="button" class="btn btn-ghost" :disabled="isJoining" @click="close">
          {{ $t('common.cancel') }}
        </button>
        <button
          v-if="joinedServerId"
          type="button"
          class="btn btn-primary"
          :disabled="isJoining"
          @click="openJoinedServer"
        >
          <Icon v-if="isJoining" name="spinner" :size="16" class="spin" />
          <span v-else>{{ $t('federation.openServer') }}</span>
        </button>
        <button
          v-else
          type="button"
          class="btn btn-primary"
          :disabled="!discoveredServer || isJoining"
          @click="joinServer"
        >
          <Icon v-if="isJoining" name="spinner" :size="16" class="spin" />
          <span v-else>{{ $t('federation.joinServer') }}</span>
        </button>
      </div>

      <p v-if="discoveredServer" class="federated-notice">
        <Icon name="info" :size="14" />
        <span>{{ $t('federation.federatedNotice') }}</span>
      </p>
    </div>
  </div>
</template>

<script setup lang="ts">
import { safeHref } from '@/utils/sanitize';
import { ref, computed, nextTick, onMounted, onBeforeUnmount } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { useToast } from 'vue-toastification'
import {
  federationServerService,
  remoteServerUuid,
  type RemoteServer,
  type InviteInfo,
} from '@/services/federation'
import { useAuthStore } from '@/stores/auth'
import { useServerChannelStore } from '@/stores/useServerChannel'
import { useInstanceSettingsStore } from '@/stores/useInstanceSettings'
import { useOpenServer } from '@/composables/useOpenServer'
import { debug } from '@/utils/debug'
import { toInternalPath } from '@/utils/internalLinks'
import Icon from '@/components/common/Icon.vue'
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

const { t } = useI18n()
const router = useRouter()
const toast = useToast()
const authStore = useAuthStore()
const serverChannelStore = useServerChannelStore()
const instanceSettings = useInstanceSettingsStore()
const openServer = useOpenServer()

const serverUrl = ref('')
const urlInput = ref<HTMLInputElement>()
const isLoading = ref(false)
const isJoining = ref(false)
const error = ref('')
const discoveredServer = ref<RemoteServer | null>(null)
const inviteInfo = ref<InviteInfo | null>(null)
const isInvite = ref(false)

type ChannelKind = 'text' | 'voice' | 'category'

// ActivityPub discovery responses carry `channelType`; invite responses carry `type`.
function channelKind(channel: RemoteServer['channels'][number]): ChannelKind | undefined {
  const raw = (channel as { channelType?: string }).channelType ?? channel.type
  return raw === 'text' || raw === 'voice' || raw === 'category' ? raw : undefined
}

const previewChannels = computed(() =>
  (discoveredServer.value?.channels ?? []).filter(channel => channelKind(channel) !== 'category'),
)

const joinedServerId = computed(() => {
  const remote = discoveredServer.value
  if (!remote) return null
  const uuid = remoteServerUuid(remote.id)
  const match = serverChannelStore.servers.find(server =>
    (uuid && server.id === uuid) ||
    (!!remote.inbox && server.federation_inbox_url === remote.inbox),
  )
  return match?.id ?? null
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

function close() {
  if (isJoining.value) return
  emit('close')
}

function onKeydown(event: KeyboardEvent) {
  if (event.key === 'Escape') close()
}

onMounted(() => {
  window.addEventListener('keydown', onKeydown)
  if (props.initialUrl) {
    serverUrl.value = props.initialUrl.trim()
    void discoverServer()
  } else {
    void nextTick(() => urlInput.value?.focus())
  }
})

onBeforeUnmount(() => {
  window.removeEventListener('keydown', onKeydown)
})

async function discoverServer() {
  const input = serverUrl.value.trim()
  if (!input || isLoading.value) return

  // An invite on this instance joins through the local invite page; the
  // federated path would send a Join to our own Group and leave the
  // membership pending.
  const internalPath = toInternalPath(input)
  if (internalPath && /^\/invite\/[A-Za-z0-9_-]+\/?(?:[?#].*)?$/.test(internalPath)) {
    emit('close')
    await router.push(internalPath)
    return
  }

  error.value = ''
  discoveredServer.value = null
  inviteInfo.value = null
  isInvite.value = false
  isLoading.value = true

  try {
    const result = await federationServerService.discoverServer(input)

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
  const remote = discoveredServer.value
  if (!remote || !userId || isJoining.value) return

  error.value = ''
  isJoining.value = true

  try {
    const result = await federationServerService.joinServer(
      remote.id,
      userId,
      inviteInfo.value?.code
    )

    if (!result.success || !result.serverId) {
      error.value = result.error || 'Failed to join server'
      return
    }

    await serverChannelStore.fetchServersForUser(userId, true)
    if (result.status === 'pending') {
      toast.info(t('federation.joinPending'))
    }
    await openServer(result.serverId, result.defaultChannelId)
    emit('joined', result.serverId)
  } catch (err: any) {
    debug.error('Error joining remote server:', err)
    error.value = err.message || 'Failed to join server'
  } finally {
    isJoining.value = false
  }
}

async function openJoinedServer() {
  const serverId = joinedServerId.value
  if (!serverId || isJoining.value) return

  isJoining.value = true
  try {
    await openServer(serverId)
    emit('joined', serverId)
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

<style scoped src="./PublicServers/discoveryButtons.css"></style>

<style scoped>
.federated-server-modal {
  position: fixed;
  inset: 0;
  background: color-mix(in srgb, var(--background-tertiary) 70%, transparent);
  backdrop-filter: blur(8px);
  -webkit-backdrop-filter: blur(8px);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  padding: var(--space-4);
}

.modal-content {
  background: var(--background-primary);
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-xl);
  box-shadow: var(--shadow-modal);
  padding: var(--space-6);
  width: 100%;
  max-width: 520px;
  max-height: 90vh;
  overflow-y: auto;
}

/* Overrides the global .modal-header row layout and padding. */
.modal-header {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  margin-bottom: var(--space-5);
  padding: 0;
  border-bottom: none;
}

.header-icon {
  width: 40px;
  height: 40px;
  flex-shrink: 0;
  background: var(--harmony-primary-light);
  color: var(--harmony-primary);
  border-radius: var(--radius-lg);
  display: flex;
  align-items: center;
  justify-content: center;
}

.header-text {
  flex: 1;
  min-width: 0;
}

.modal-header h2 {
  font-size: var(--font-size-xl);
  font-weight: var(--font-weight-bold);
  color: var(--text-primary);
  margin: 0 0 var(--space-1);
}

.subtitle {
  color: var(--text-secondary);
  margin: 0;
  font-size: var(--font-size-sm);
}

.close-button {
  width: 36px;
  height: 36px;
  flex-shrink: 0;
  margin: -6px -6px 0 0;
  background: transparent;
  border: none;
  border-radius: var(--radius-md);
  color: var(--text-secondary);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: background-color var(--transition-fast), color var(--transition-fast);
}

.close-button:hover:not(:disabled) {
  background: var(--background-modifier-hover);
  color: var(--text-primary);
}

.close-button:focus-visible {
  outline: 2px solid var(--harmony-primary);
  outline-offset: 2px;
}

.input-section {
  margin-bottom: var(--space-5);
}

.input-section label {
  display: block;
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-semibold);
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  margin-bottom: var(--space-2);
}

.input-wrapper {
  display: flex;
  gap: var(--space-2);
}

.input-wrapper input {
  flex: 1;
  min-width: 0;
  padding: 0 12px;
  height: 40px;
  background: var(--input-bg);
  border: 1px solid var(--input-border);
  border-radius: var(--radius-md);
  color: var(--text-primary);
  font-size: var(--font-size-sm);
  outline: none;
  transition: border-color var(--transition-fast), box-shadow var(--transition-fast);
}

.input-wrapper input:focus {
  border-color: var(--border-focus);
  box-shadow: 0 0 0 3px var(--harmony-primary-light);
}

.input-wrapper input::placeholder {
  color: var(--text-muted);
}

.discover-btn {
  min-width: 96px;
  min-height: 40px;
}

.input-hint {
  font-size: var(--font-size-xs);
  color: var(--text-muted);
  margin: var(--space-2) 0 0;
}

.error-message {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  padding: 10px 12px;
  background: color-mix(in srgb, var(--error) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--error) 40%, transparent);
  border-radius: var(--radius-md);
  color: var(--error);
  font-size: var(--font-size-sm);
  margin-bottom: var(--space-5);
}

.error-message > .icon-wrap {
  flex-shrink: 0;
  margin-top: 2px;
}

.server-preview {
  display: flex;
  gap: var(--space-4);
  padding: var(--space-4);
  background: var(--background-secondary);
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-lg);
  margin-bottom: var(--space-4);
}

.server-icon {
  width: 64px;
  height: 64px;
  border-radius: var(--radius-xl);
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
  background: var(--harmony-primary);
  color: var(--text-on-primary);
  font-size: 26px;
  font-weight: var(--font-weight-bold);
}

.server-info {
  flex: 1;
  min-width: 0;
}

.server-name {
  font-size: var(--font-size-lg);
  font-weight: var(--font-weight-bold);
  color: var(--text-primary);
  margin: 0 0 var(--space-1);
}

.server-instance {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--text-secondary);
  margin: 0 0 var(--space-3);
}

.server-description {
  font-size: 13px;
  color: var(--text-secondary);
  margin: 0 0 var(--space-3);
  line-height: 1.4;
}

.server-stats {
  display: flex;
  gap: var(--space-4);
  margin-bottom: var(--space-3);
}

.stat {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 13px;
  color: var(--text-secondary);
}

.invite-badge {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 4px 10px;
  background: var(--harmony-primary-light);
  border-radius: var(--radius-full);
  color: var(--harmony-primary);
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-semibold);
  margin-bottom: var(--space-3);
}

.invite-details {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: 10px 12px;
  background: var(--background-modifier-hover);
  border-radius: var(--radius-md);
  margin-bottom: var(--space-3);
  font-size: 13px;
}

.invite-creator,
.invite-expiry {
  display: flex;
  align-items: center;
  gap: var(--space-2);
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
  font-weight: var(--font-weight-medium);
}

.detail-value :deep(.display-name) {
  display: inline;
}

.invite-rules {
  padding: 10px 12px;
  background: var(--background-modifier-hover);
  border-radius: var(--radius-md);
  margin-bottom: var(--space-3);
}

.invite-rules__title {
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-bold);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  color: var(--text-secondary);
  margin-bottom: var(--space-2);
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
  margin: var(--space-2) 0 0;
  font-size: 11px;
  color: var(--text-muted);
}

.channels-preview {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  align-items: center;
}

.channel-tag {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 8px;
  background: var(--background-modifier-hover);
  border-radius: var(--radius-md);
  font-size: var(--font-size-xs);
  color: var(--text-secondary);
}

.more-channels {
  font-size: var(--font-size-xs);
  color: var(--text-muted);
}

.already-joined {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  margin: 0 0 var(--space-4);
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
}

.already-joined > .icon-wrap {
  color: var(--success);
}

.modal-actions {
  display: flex;
  gap: var(--space-2);
  justify-content: flex-end;
}

.modal-actions .btn-primary {
  min-width: 112px;
}

.federated-notice {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  margin: var(--space-4) 0 0;
  font-size: var(--font-size-xs);
  color: var(--text-muted);
  line-height: 1.45;
}

.federated-notice > .icon-wrap {
  flex-shrink: 0;
  margin-top: 1px;
}

.error-fallback-link {
  display: block;
  margin-top: 4px;
  font-size: var(--font-size-xs);
  color: var(--text-secondary);
  text-decoration: underline;
}

.error-fallback-link:hover {
  color: var(--text-primary);
}

.spin {
  animation: spin 1s linear infinite;
}

@keyframes spin {
  to { transform: rotate(360deg); }
}

@media (max-width: 480px) {
  .federated-server-modal {
    padding: 0;
    align-items: stretch;
  }

  .modal-content {
    max-width: none;
    max-height: none;
    height: 100vh;
    height: 100dvh;
    border: none;
    border-radius: 0;
    padding: calc(var(--space-4) + env(safe-area-inset-top, 0px)) var(--space-4)
      calc(var(--space-4) + env(safe-area-inset-bottom, 0px));
  }

  .server-preview {
    flex-direction: column;
  }

  .modal-actions .btn {
    flex: 1;
  }
}
</style>
