<template>
  <BaseModal
    :show="show"
    :show-header="false"
    :compact="false"
    @close="emit('close')"
  >
    <div class="profile-modal-content" data-testid="bot-profile">
      <div class="profile-banner" :style="bannerStyle">
        <div class="banner-gradient"></div>
        <div class="banner-actions">
          <button type="button" class="close-button" :aria-label="t('bots.profile.close')" @click="emit('close')">
            <Icon name="close" :size="16" class="close-icon" />
          </button>
        </div>
      </div>

      <div class="profile-content">
        <div class="profile-header">
          <div class="avatar-container">
            <div class="avatar-wrapper">
              <Avatar :src="view.avatarUrl" :alt="view.displayName" class="profile-avatar" />
              <div class="status-indicator" :class="view.status"></div>
            </div>
          </div>

          <div class="profile-info">
            <div class="name-section">
              <h1 class="display-name" :style="{ color: BOT_NAME_COLOR }">
                <span class="display-name-text">{{ view.displayName }}</span>
                <span class="bot-tag">{{ t('bots.badge.bot') }}</span>
                <span v-if="profile?.isVerified" class="verified-badge" :title="t('bots.badge.verified')">
                  <Icon name="check-circle" class="verified-icon" />
                </span>
              </h1>
              <p class="username">@{{ view.username }}</p>
            </div>
          </div>
        </div>

        <div class="user-stats">
          <div class="stat-item">
            <span class="stat-value">{{ createdLabel }}</span>
            <span class="stat-label">{{ t('bots.profile.created') }}</span>
          </div>
          <div class="stat-item">
            <span class="stat-value">{{ t(`bots.status.${view.status}`) }}</span>
            <span class="stat-label">{{ t('bots.profile.status') }}</span>
          </div>
          <div class="stat-item">
            <span class="stat-value">{{ profile ? profile.commands.length : '-' }}</span>
            <span class="stat-label">{{ t('bots.profile.commands') }}</span>
          </div>
        </div>

        <div v-if="view.statusText" class="custom-status-section">
          <span class="custom-status-label">{{ t('bots.profile.status') }}</span>
          <span class="custom-status-text">
            <ActivityIcon v-if="view.activityType" :type="view.activityType" :size="14" />
            {{ view.statusText }}
          </span>
        </div>

        <p v-if="loadFailed" class="load-failed">{{ t('bots.profile.loadFailed') }}</p>

        <section v-if="profile?.bio" class="profile-section">
          <h3 class="section-title">{{ t('bots.profile.about') }}</h3>
          <div class="about-content">
            <p class="about-text">{{ profile.bio }}</p>
          </div>
        </section>

        <section v-if="profile?.website || profile?.supportServer" class="profile-section link-rows">
          <a
            v-if="profile.website"
            :href="profile.website.href"
            target="_blank"
            rel="noopener noreferrer nofollow"
            class="link-row"
          >
            <Icon name="globe" :size="16" class="link-row-icon" />
            <span class="link-row-label">{{ t('bots.profile.website') }}</span>
            <span class="link-row-value">{{ profile.website.label }}</span>
            <Icon name="external-link" :size="14" class="link-row-trail" />
          </a>
          <div v-if="profile.supportServer" class="link-row">
            <ServerIcon :src="profile.supportServer.icon" size="mini" shape="rounded" :show-title="false" />
            <span class="link-row-label">{{ t('bots.profile.supportServer') }}</span>
            <span class="link-row-value">{{ profile.supportServer.name }}</span>
            <button type="button" class="btn-inline" :disabled="joining" @click="goToSupportServer">
              {{ isSupportMember ? t('bots.profile.openServer') : t('bots.profile.joinServer') }}
            </button>
          </div>
        </section>

        <section v-if="profile && profile.commands.length > 0" class="profile-section">
          <h3 class="section-title">{{ t('bots.profile.commandsTitle', { count: profile.commands.length }) }}</h3>
          <ul class="command-list">
            <li v-for="command in visibleCommands" :key="command.name" class="command-row">
              <span class="command-name">/{{ command.name }}</span>
              <span class="command-description" :class="{ muted: !command.description }">
                {{ command.description || t('bots.noDescription') }}
              </span>
            </li>
          </ul>
          <button
            v-if="profile.commands.length > COMMANDS_COLLAPSED"
            type="button"
            class="toggle-commands"
            :aria-expanded="showAllCommands"
            @click="showAllCommands = !showAllCommands"
          >
            <Icon :name="showAllCommands ? 'chevron-up' : 'chevron-down'" :size="14" />
            {{ showAllCommands
              ? t('bots.profile.showFewerCommands')
              : t('bots.profile.showAllCommands', { count: profile.commands.length }) }}
          </button>
        </section>

        <div v-if="canAdd || canOpenSettings || canRemove" class="profile-actions">
          <div v-if="canAdd" class="invite-btn-wrapper">
            <button type="button" class="primary-action-btn" :aria-expanded="showAddPicker" @click="toggleAddPicker">
              <Icon name="plus" :size="16" />
              {{ t('bots.profile.addToServer') }}
            </button>
            <div v-if="showAddPicker" class="server-picker-dropdown" @click.stop>
              <p class="picker-label">{{ t('bots.profile.yourServers') }}</p>
              <div v-if="installTargets === null" class="picker-empty">
                <LoadingSpinner :size="20" />
              </div>
              <p v-else-if="installTargets.servers.length === 0" class="picker-empty">{{ t('bots.install.noServers') }}</p>
              <template v-else>
                <button
                  v-for="server in installTargets.servers"
                  :key="server.id"
                  type="button"
                  class="server-picker-item"
                  :disabled="installTargets.installed.has(server.id) || addingServerId !== null"
                  @click="addTo(server)"
                >
                  <ServerIcon :src="server.icon" size="mini" shape="rounded" :show-title="false" />
                  <span class="picker-server-name">{{ server.name }}</span>
                  <span v-if="installTargets.installed.has(server.id)" class="picker-server-state">
                    <Icon name="check" :size="14" />
                    {{ t('bots.install.added') }}
                  </span>
                  <span v-else class="picker-server-state add">{{ t('bots.install.add') }}</span>
                </button>
              </template>
            </div>
          </div>
          <button v-if="canOpenSettings" type="button" class="secondary-action-btn" @click="openBotSettings">
            <Icon name="settings" :size="16" />
            {{ t('bots.profile.settings') }}
          </button>
          <button
            v-if="canRemove"
            type="button"
            class="secondary-action-btn danger"
            :disabled="removing"
            @click="removeFromServer"
          >
            <Icon name="trash" :size="16" />
            {{ t('bots.profile.remove') }}
          </button>
        </div>
      </div>
    </div>
  </BaseModal>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { useToast } from 'vue-toastification'
import BaseModal from '@/components/common/BaseModal.vue'
import Avatar from '@/components/common/Avatar.vue'
import Icon from '@/components/common/Icon.vue'
import LoadingSpinner from '@/components/common/LoadingSpinner.vue'
import ServerIcon from '@/components/common/ServerIcon.vue'
import ActivityIcon from '@/components/ActivityIcon.vue'
import { useConfirmDialog } from '@/composables/useConfirmDialog'
import { useOpenServer } from '@/composables/useOpenServer'
import { useServerPermissions } from '@/composables/useServerPermissions'
import { useAuthStore } from '@/stores/auth'
import { useServerStore } from '@/stores/server'
import { useServerChannelStore } from '@/stores/useServerChannel'
import {
  addBotToServer,
  fetchBotInstallTargets,
  fetchBotProfile,
  isBotInstalled,
  removeBotFromServer,
  type BotInstallTarget,
  type BotInstallTargets,
  type BotProfile,
} from '@/services/botProfileService'
import type { ServerBot } from '@/services/serverBotsService'
import { BOT_NAME_COLOR } from '@/utils/botUtils'
import { getBannerUrl } from '@/utils/bannerUtils'
import { withRenderFallback } from '@/utils/renderFallback'
import { debug } from '@/utils/debug'

/** Commands listed before the list collapses. */
const COMMANDS_COLLAPSED = 5

const props = defineProps<{
  show: boolean
  botId: string
  /** Server the card was opened from; management actions apply to it. */
  serverId?: string | null
  /** Shown until the profile loads, and in its place when it does not. */
  preview?: Partial<ServerBot> | null
}>()

const emit = defineEmits<{ close: [] }>()

const { t } = useI18n()
const router = useRouter()
const toast = useToast()
const { confirm } = useConfirmDialog()
const openServer = useOpenServer()
const authStore = useAuthStore()
const serverStore = useServerStore()
const serverChannelStore = useServerChannelStore()
const { canManageServer } = useServerPermissions(() => props.serverId ?? null)

const profile = ref<BotProfile | null>(null)
const loadFailed = ref(false)
const installedHere = ref(false)
const showAllCommands = ref(false)
const showAddPicker = ref(false)
const installTargets = ref<BotInstallTargets | null>(null)
const addingServerId = ref<string | null>(null)
let request = 0

const view = computed(() => {
  const p = profile.value ?? props.preview ?? null
  const username = p?.username || props.preview?.username || ''
  return {
    displayName: p?.displayName || username || t('bots.badge.bot'),
    username,
    avatarUrl: p?.avatarUrl || '/default_avatar.webp',
    status: p?.status ?? 'offline',
    statusText: p?.statusText ?? '',
    activityType: p?.activityType ?? null,
    botType: p?.botType ?? null,
  }
})

const bannerStyle = computed(() => {
  const banner = profile.value?.bannerUrl
  if (!banner) return undefined
  const url = withRenderFallback(getBannerUrl(banner, { width: 640, height: 350, quality: 80 })) || banner
  return {
    backgroundImage: `url(${JSON.stringify(url)})`,
    backgroundSize: 'cover',
    backgroundPosition: 'center',
    backgroundRepeat: 'no-repeat',
  }
})

const createdLabel = computed(() => {
  const created = profile.value?.createdAt
  if (!created) return '-'
  return new Date(created).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
})

const visibleCommands = computed(() => {
  const commands = profile.value?.commands ?? []
  return showAllCommands.value ? commands : commands.slice(0, COMMANDS_COLLAPSED)
})

const canAdd = computed(() => profile.value?.isPublic === true)
const canOpenSettings = computed(() => !!props.serverId && installedHere.value && canManageServer.value)
const canRemove = computed(() => !!props.serverId && installedHere.value && canManageServer.value)

const isSupportMember = computed(() => {
  const id = profile.value?.supportServer?.id
  return !!id && serverChannelStore.servers.some(s => s.id === id)
})

async function load(botId: string) {
  const seq = ++request
  loadFailed.value = false
  try {
    const result = await fetchBotProfile(botId)
    if (seq !== request) return
    profile.value = result
    loadFailed.value = result === null
  } catch (error) {
    if (seq !== request) return
    debug.warn('get_bot_profile failed:', error)
    loadFailed.value = true
  }
}

async function checkInstalled(botId: string, serverId: string) {
  const seq = request
  try {
    const installed = await isBotInstalled(botId, serverId)
    if (seq === request) installedHere.value = installed
  } catch (error) {
    debug.warn('bot installation check failed:', error)
  }
}

watch(
  () => [props.show, props.botId, props.serverId] as const,
  ([show, botId, serverId]) => {
    profile.value = null
    installedHere.value = false
    showAllCommands.value = false
    showAddPicker.value = false
    installTargets.value = null
    if (!show || !botId) {
      request++
      return
    }
    void load(botId)
    if (serverId) void checkInstalled(botId, serverId)
  },
  { immediate: true },
)

// Add to server ----------------------------------------------------------------

async function toggleAddPicker() {
  showAddPicker.value = !showAddPicker.value
  if (!showAddPicker.value || installTargets.value) return
  const botId = props.botId
  try {
    const targets = await fetchBotInstallTargets(botId)
    if (botId === props.botId) installTargets.value = targets
  } catch (error) {
    debug.error('Failed to load install targets:', error)
    toast.error(t('bots.install.loadFailed'))
    showAddPicker.value = false
  }
}

async function addTo(server: BotInstallTarget) {
  const targets = installTargets.value
  if (!targets || addingServerId.value) return
  addingServerId.value = server.id
  try {
    await addBotToServer(props.botId, view.value.botType, server.id)
    targets.installed = new Set([...targets.installed, server.id])
    if (server.id === props.serverId) installedHere.value = true
    toast.success(t('bots.install.success', { bot: view.value.displayName, server: server.name }))
  } catch (error) {
    debug.error('Failed to add bot to server:', error)
    toast.error(t('bots.install.failed'))
  } finally {
    addingServerId.value = null
  }
}

// Server management -------------------------------------------------------------

function openBotSettings() {
  if (!props.serverId) return
  emit('close')
  void router.push({
    name: 'ServerSettings',
    params: { serverId: props.serverId },
    query: { section: 'advanced' },
    hash: '#server-bots',
  })
}

const removing = ref(false)

async function removeFromServer() {
  const serverId = props.serverId
  if (!serverId || removing.value) return
  const name = view.value.displayName
  const confirmed = await confirm({
    title: t('bots.server.removeConfirmTitle', { name }),
    message: t('bots.server.removeConfirmBody'),
    confirmButtonText: t('bots.server.remove'),
    dangerAction: true,
  })
  if (!confirmed) return

  removing.value = true
  try {
    await removeBotFromServer(props.botId, serverId)
    toast.success(t('bots.server.removeSuccess', { name }))
    emit('close')
  } catch (error) {
    debug.error('Failed to remove bot:', error)
    toast.error(t('bots.server.removeFailed'))
  } finally {
    removing.value = false
  }
}

// Support server ----------------------------------------------------------------

const joining = ref(false)

async function goToSupportServer() {
  const server = profile.value?.supportServer
  if (!server || joining.value) return
  joining.value = true
  try {
    if (!isSupportMember.value) {
      // joinServer toasts its own failures.
      if (!(await serverStore.joinServer(server.id))) return
      const authId = authStore.session?.user?.id
      if (authId) await serverChannelStore.fetchServersForUser(authId, true)
    }
    emit('close')
    await openServer(server.id)
  } finally {
    joining.value = false
  }
}
</script>

<style scoped>
/* Layout and tokens follow UserProfileModal. */
.profile-modal-content {
  position: relative;
  margin: -24px -32px;
}

.profile-banner {
  position: relative;
  height: 120px;
  background: var(--harmony-primary);
  overflow: hidden;
}

.banner-gradient {
  position: absolute;
  inset: 0;
  background: linear-gradient(135deg, transparent 0%, rgba(0, 0, 0, 0.3) 100%);
}

.banner-actions {
  position: absolute;
  top: 16px;
  right: 16px;
  display: flex;
  align-items: center;
  gap: 8px;
  z-index: 10;
}

.close-button {
  flex: 0 0 32px;
  width: 32px;
  height: 32px;
  padding: 0;
  background: rgba(0, 0, 0, 0.5);
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: var(--radius-md);
  color: var(--text-primary);
  cursor: pointer;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: all 0.2s ease;
  box-sizing: border-box;
}

.close-button:hover {
  background: rgba(0, 0, 0, 0.7);
  border-color: rgba(255, 255, 255, 0.2);
}

.close-icon {
  width: 16px !important;
  height: 16px !important;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
}

.profile-content {
  padding: 24px 32px 32px;
  background: var(--background-quinary);
}

.profile-header {
  display: flex;
  align-items: flex-start;
  gap: 20px;
  margin-bottom: 24px;
}

.avatar-container {
  flex-shrink: 0;
}

.profile-header > .avatar-container {
  margin-top: -40px;
}

.avatar-wrapper {
  position: relative;
  width: 80px;
  height: 80px;
}

.profile-avatar {
  width: 80px;
  height: 80px;
  border-radius: 50%;
  border: 6px solid var(--background-quinary);
  background: var(--background-secondary);
  object-fit: cover;
}

.status-indicator {
  position: absolute;
  bottom: 6px;
  right: 6px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  border: 3px solid var(--background-quinary);
  background: var(--status-offline);
}

.status-indicator.online { background: var(--status-online); }
.status-indicator.away { background: var(--status-away); }
.status-indicator.busy { background: var(--status-busy); }

.profile-info {
  flex: 1;
  min-width: 0;
  padding-top: 8px;
}

.name-section {
  margin-bottom: 12px;
}

.display-name {
  font-size: 24px;
  font-weight: 700;
  margin: 0 0 4px;
  display: flex;
  align-items: center;
  gap: 8px;
  line-height: 1.2;
  min-width: 0;
}

.display-name-text {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.bot-tag {
  flex-shrink: 0;
  padding: 2px 6px;
  border-radius: 4px;
  background: var(--harmony-primary);
  color: var(--text-on-primary, #ffffff);
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.04em;
  line-height: 1.3;
  text-transform: uppercase;
}

.verified-badge {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  flex-shrink: 0;
}

.verified-icon {
  width: 16px;
  height: 16px;
  color: var(--success);
}

.username {
  font-size: 16px;
  color: var(--text-secondary);
  margin: 0;
  font-weight: 500;
  overflow-wrap: anywhere;
}

.user-stats {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 8px;
  margin-bottom: 24px;
  padding: 16px;
  background: var(--background-quaternary);
  border: 1px solid var(--border-secondary);
  border-radius: var(--radius-lg);
}

.stat-item {
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
  padding: 8px;
  border-radius: 8px;
  min-width: 0;
}

.stat-value {
  font-size: 16px;
  font-weight: 700;
  color: var(--text-primary);
  margin-bottom: 2px;
}

.stat-label {
  font-size: 12px;
  color: var(--text-secondary);
  font-weight: 600;
}

.custom-status-section {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 24px;
  padding: 12px 16px;
  background: var(--background-quaternary);
  border: 1px solid var(--border-secondary);
  border-radius: var(--radius-lg);
}

.custom-status-label {
  font-size: 11px;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.02em;
}

.custom-status-text {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: 14px;
  color: var(--text-primary);
}

.load-failed {
  margin: 0 0 24px;
  font-size: 13px;
  color: var(--text-muted);
}

.profile-section {
  margin-bottom: 24px;
}

.section-title {
  font-size: 14px;
  font-weight: 700;
  color: var(--text-primary);
  text-transform: uppercase;
  letter-spacing: 0.02em;
  margin: 0 0 12px;
}

.about-content {
  background: var(--background-quaternary);
  padding: 12px;
  border-radius: 8px;
  border: 1px solid var(--border-secondary);
}

.about-text {
  color: var(--text-secondary);
  margin: 0;
  line-height: 1.5;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  user-select: text;
}

.link-rows {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.link-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  background: var(--background-quaternary);
  border: 1px solid var(--border-secondary);
  border-radius: 8px;
  color: var(--text-secondary);
  font-size: 14px;
  text-decoration: none;
  min-width: 0;
}

a.link-row:hover {
  border-color: var(--border-primary);
  color: var(--text-primary);
}

.link-row-icon,
.link-row-trail {
  flex-shrink: 0;
  color: var(--text-muted);
}

.link-row-label {
  flex-shrink: 0;
  font-weight: 600;
  color: var(--text-primary);
}

.link-row-value {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.btn-inline {
  flex-shrink: 0;
  padding: 4px 12px;
  border-radius: 6px;
  border: 1px solid var(--border-primary);
  background: var(--background-modifier-hover);
  color: var(--text-primary);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}

.btn-inline:hover:not(:disabled) {
  background: var(--background-modifier-active);
}

.command-list {
  list-style: none;
  margin: 0;
  padding: 0;
  border: 1px solid var(--border-secondary);
  border-radius: 8px;
  background: var(--background-quaternary);
  overflow: hidden;
}

.command-row {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 8px 12px;
}

.command-row + .command-row {
  border-top: 1px solid var(--border-secondary);
}

.command-name {
  font-family: var(--font-mono, monospace);
  font-size: 13px;
  font-weight: 600;
  color: var(--text-primary);
  overflow-wrap: anywhere;
}

.command-description {
  font-size: 13px;
  color: var(--text-secondary);
  overflow-wrap: anywhere;
}

.command-description.muted {
  color: var(--text-muted);
}

.toggle-commands {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-top: 8px;
  padding: 4px 0;
  background: none;
  border: none;
  color: var(--harmony-primary);
  font-size: 13px;
  font-weight: 600;
  cursor: pointer;
}

.toggle-commands:hover {
  text-decoration: underline;
}

.profile-actions {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 12px;
}

/* An odd action out takes the full row. */
.profile-actions > :last-child:nth-child(odd) {
  grid-column: 1 / -1;
}

.primary-action-btn,
.secondary-action-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  width: 100%;
  padding: 12px 20px;
  border-radius: 8px;
  font-size: 14px;
  font-weight: 600;
  cursor: pointer;
  transition: background-color var(--transition-fast), border-color var(--transition-fast), color var(--transition-fast);
  border: none;
  min-width: 0;
}

.primary-action-btn {
  background: var(--harmony-primary);
  color: var(--text-on-primary);
}

.primary-action-btn:hover {
  background: var(--harmony-primary-hover);
}

.secondary-action-btn {
  background: var(--background-modifier-hover);
  border: 1px solid var(--border-primary);
  color: var(--text-secondary);
}

.secondary-action-btn:hover:not(:disabled) {
  background: var(--background-modifier-active);
  border-color: var(--border-hover);
  color: var(--text-primary);
}

.secondary-action-btn.danger {
  color: var(--error);
}

.secondary-action-btn.danger:hover:not(:disabled) {
  background: color-mix(in srgb, var(--error) 10%, transparent);
  border-color: color-mix(in srgb, var(--error) 35%, transparent);
  color: var(--error);
}

.secondary-action-btn:disabled {
  opacity: 0.6;
  cursor: default;
}

.invite-btn-wrapper {
  position: relative;
  display: flex;
}

.server-picker-dropdown {
  position: absolute;
  bottom: calc(100% + 8px);
  left: 0;
  right: 0;
  min-width: 220px;
  background: var(--background-quinary);
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-md);
  box-shadow: var(--shadow-large);
  padding: 8px;
  max-height: 240px;
  overflow-y: auto;
  z-index: 30;
}

.picker-label {
  font-size: 11px;
  font-weight: 600;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.05em;
  padding: 4px 8px 6px;
  margin: 0;
}

.picker-empty {
  display: flex;
  justify-content: center;
  margin: 0;
  padding: 8px;
  font-size: 13px;
  color: var(--text-muted);
}

.server-picker-item {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  padding: 8px;
  border: none;
  background: transparent;
  color: var(--text-primary);
  font-size: 14px;
  cursor: pointer;
  border-radius: 6px;
  text-align: left;
}

.server-picker-item:hover:not(:disabled) {
  background: var(--background-modifier-hover);
}

.server-picker-item:disabled {
  cursor: default;
}

.picker-server-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.picker-server-state {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex-shrink: 0;
  font-size: 12px;
  color: var(--text-muted);
}

.picker-server-state.add {
  color: var(--harmony-primary);
  font-weight: 600;
}

@media (max-width: 768px) {
  .profile-modal-content {
    margin: -20px -24px;
  }

  .profile-content {
    padding: 20px 24px 28px;
  }

  .profile-header {
    flex-direction: column;
    align-items: center;
    text-align: center;
    gap: 16px;
  }

  .display-name {
    justify-content: center;
    font-size: 20px;
  }

  .username {
    font-size: 14px;
  }

  .profile-actions {
    grid-template-columns: 1fr;
  }
}
</style>
