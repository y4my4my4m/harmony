<template>
  <div class="advanced-settings">
    <div class="settings-header">
      <h2 class="settings-title">{{ $t('settings.advanced.title') }}</h2>
      <p class="settings-description">
        {{ $t('settings.advanced.description') }}
      </p>
    </div>

    <div v-if="showInstallSection" class="settings-section">
      <h3 class="section-title">Install app</h3>
      <p v-if="!isInstalledPWA" class="setting-description install-app-help">
        Install Harmony as an app for faster loading and notifications. On desktop, use the install icon in your browser address bar if the button below is unavailable.
      </p>
      <PWAInstallPrompt v-if="!isInstalledPWA" variant="button" :is-in-settings="true" />

      <div v-if="canShowRunOnLogin" class="setting-item run-on-login-item">
        <div class="setting-info">
          <h4 class="setting-label">Start Harmony when you sign in</h4>
          <p class="setting-description">
            <span v-if="runOnLoginEnabled">
              You've enabled this from <code>{{ runOnLoginUrl }}</code>. Tap below for instructions if you ever need to change it.
            </span>
            <span v-else>
              {{ runOnLoginBrowserLabel }} can launch Harmony automatically every time you log into your computer.
            </span>
          </p>
        </div>
        <div class="setting-control">
          <button class="btn btn-secondary" @click="showRunOnLoginModal = true">
            {{ runOnLoginEnabled ? 'Change' : 'Set up' }}
          </button>
        </div>
      </div>
    </div>

    <RunOnLoginInstructionsModal v-model="showRunOnLoginModal" @enabled="onRunOnLoginEnabled" />

    <div class="settings-section">
      <h3 class="section-title">Beta features</h3>

      <div class="setting-item">
        <div class="setting-info">
          <h4 class="setting-label">Today dashboard</h4>
          <p class="setting-description">
            A daily digest of channels with unread activity, threads you're part of,
            and trending posts. Adds a sun icon to the server sidebar.
          </p>
        </div>
        <div class="setting-control">
          <ToggleSwitch
            :model-value="todayDashboardEnabled"
            @update:model-value="setTodayDashboardEnabled"
          />
        </div>
      </div>

      <div class="setting-item" :class="{ 'disabled-option': !todayDashboardEnabled }">
        <div class="setting-info">
          <h4 class="setting-label">On-device AI summaries</h4>
          <p class="setting-description">
            Summarize the Today digest with your browser's built-in AI model
            (Chrome's Gemini Nano). Runs entirely on your device - nothing is sent
            to a server.
            <span v-if="!onDeviceAiSupported"> Not supported by this browser.</span>
          </p>
        </div>
        <div class="setting-control">
          <ToggleSwitch
            :model-value="todayAiSummariesEnabled"
            :disabled="!todayDashboardEnabled || !onDeviceAiSupported"
            @update:model-value="setTodayAiSummariesEnabled"
          />
        </div>
      </div>
    </div>

    <div v-if="isTauriDesktop" class="settings-section">
      <h3 class="section-title">Desktop app</h3>

      <div class="setting-item">
        <div class="setting-info">
          <h4 class="setting-label">Launch at startup</h4>
          <p class="setting-description">Start Harmony automatically when you log into your computer. It launches minimized to the tray.</p>
        </div>
        <div class="setting-control">
          <ToggleSwitch v-model="launchAtLogin" @change="onLaunchAtLoginChange" />
        </div>
      </div>

      <div class="setting-item">
        <div class="setting-info">
          <h4 class="setting-label">Game activity (rich presence)</h4>
          <p class="setting-description">Show the game you're playing as your status. Detection runs locally; only the game name is shared, as your status text.</p>
        </div>
        <div class="setting-control">
          <ToggleSwitch v-model="richPresence" @change="onRichPresenceChange" />
        </div>
      </div>

      <div class="setting-item">
        <div class="setting-info">
          <h4 class="setting-label">In-game voice overlay</h4>
          <p class="setting-description">Floating, click-through voice tiles over your game while in a call. Press Ctrl+Shift+O to toggle interaction.</p>
        </div>
        <div class="setting-control">
          <ToggleSwitch v-model="gameOverlay" @change="onGameOverlayChange" />
        </div>
      </div>
    </div>

    <div v-if="isTauriDesktop" class="settings-section">
      <h3 class="section-title">{{ $t('updater.settings.title') }}</h3>

      <div class="setting-item">
        <div class="setting-info">
          <h4 class="setting-label">
            {{ updaterState.currentVersion
              ? $t('updater.settings.versionLabel', { version: updaterState.currentVersion })
              : $t('updater.settings.versionUnknown') }}
          </h4>
          <p class="setting-description" aria-live="polite">{{ updateStatusText }}</p>
        </div>
        <div class="setting-control">
          <button
            v-if="updaterState.phase === 'ready' || updaterState.phase === 'installing'"
            class="btn btn-success"
            :disabled="updaterState.phase === 'installing'"
            @click="restartToUpdate"
          >
            {{ $t('updater.restartToUpdate') }}
          </button>
          <button
            v-else-if="updaterState.phase === 'available'"
            class="btn btn-primary"
            @click="downloadUpdate()"
          >
            {{ $t('updater.settings.download') }}
          </button>
          <button
            v-else
            class="btn btn-secondary"
            :disabled="!updaterActive || updaterBusy"
            @click="checkForUpdates()"
          >
            {{ $t('updater.settings.check') }}
          </button>
        </div>
      </div>

      <div class="setting-item" :class="{ 'disabled-option': !updaterActive }">
        <div class="setting-info">
          <h4 class="setting-label">{{ $t('updater.settings.autoDownload') }}</h4>
          <p class="setting-description">{{ $t('updater.settings.autoDownloadDescription') }}</p>
        </div>
        <div class="setting-control">
          <ToggleSwitch
            :model-value="updaterState.autoDownload"
            :disabled="!updaterActive"
            @update:model-value="setAutoDownload"
          />
        </div>
      </div>
    </div>

    <div class="settings-section">
      <h3 class="section-title">Developer settings</h3>

      <div class="setting-item">
        <div class="setting-info">
          <h4 class="setting-label">{{ $t('settings.advanced.developerMode') }}</h4>
          <p class="setting-description">{{ $t('settings.advanced.developerModeDescription') }}</p>
        </div>
        <div class="setting-control">
          <ToggleSwitch
            v-model="settings.developerMode"
            @change="onSettingChange"
          />
        </div>
      </div>

    </div>

    <div class="settings-section">
      <h3 class="section-title">Data management</h3>

      <div class="setting-item">
        <div class="setting-info">
          <h4 class="setting-label">{{ $t('common.clear') }} Cache</h4>
          <p class="setting-description">
            Clears the service-worker caches, the in-memory emoji cache, and the locally cached background-image manifest. Your messages, identity keys and settings are preserved.
          </p>
        </div>
        <div class="setting-control">
          <button class="btn btn-secondary" @click="clearCache" :disabled="clearingCache">
            <span v-if="!clearingCache">{{ $t('common.clear') }} Cache</span>
            <span v-else>Clearing...</span>
          </button>
        </div>
      </div>

    </div>

    <div class="settings-section">
      <h3 class="section-title">{{ $t('settings.advanced.reportBugSection') }}</h3>

      <div class="setting-item">
        <div class="setting-info">
          <h4 class="setting-label">{{ $t('settings.advanced.reportBug') }}</h4>
          <p class="setting-description">{{ $t('settings.advanced.reportBugDescription') }}</p>
        </div>
        <div class="setting-control">
          <a
            :href="safeHref(reportBugUrl)"
            target="_blank"
            rel="noopener noreferrer"
            class="btn btn-secondary"
          >
            {{ $t('settings.advanced.reportBug') }}
          </a>
        </div>
      </div>
    </div>

    <AccountMigrationPanel />

    <div class="settings-section danger-zone">
      <h3 class="section-title danger">Danger zone</h3>

      <div class="setting-item">
        <div class="setting-info">
          <h4 class="setting-label danger">{{ $t('common.delete') }} account</h4>
          <p class="setting-description">{{ $t('security.deleteAccount.description') }}</p>
        </div>
        <div class="setting-control">
          <button class="btn btn-danger" @click="openDeleteModal">
            {{ $t('common.delete') }} account
          </button>
        </div>
      </div>
    </div>

    <Teleport to="body">
      <div v-if="showDeleteModal" class="sec-modal-overlay" @click.self="closeDeleteModal">
        <form class="sec-modal" role="dialog" aria-modal="true" aria-labelledby="delete-title" @submit.prevent="confirmDeletion">
          <h3 id="delete-title" class="sec-modal-title danger">Delete your account?</h3>

          <ul class="sec-bullets">
            <li>{{ $t('security.deleteAccount.bullets.permanent') }}</li>
            <li>{{ $t('security.deleteAccount.bullets.messages') }}</li>
            <li>{{ $t('security.deleteAccount.bullets.removed') }}</li>
            <li>{{ $t('security.deleteAccount.bullets.federation') }}</li>
          </ul>

          <button type="button" class="sec-link" @click="goToExport">{{ $t('security.deleteAccount.exportFirst') }}</button>

          <div v-if="blockingServers.length > 0" class="sec-callout sec-callout-danger">
            <i18n-t keypath="security.deleteAccount.ownsServers" tag="span" :plural="blockingServers.length">
              <template #servers><strong>{{ blockingServers.join(', ') }}</strong></template>
            </i18n-t>
          </div>

          <div v-if="hasPassword" class="sec-field">
            <label class="sec-label" for="delete-password">{{ $t('auth.password') }}</label>
            <input
              id="delete-password"
              v-model="deletePassword"
              class="sec-input"
              type="password"
              autocomplete="current-password"
            />
          </div>
          <div v-else class="sec-callout">
            <span>{{ $t('security.deleteAccount.noPassword') }}</span>
          </div>

          <div v-if="deletionMfaRequired" class="sec-field">
            <label class="sec-label" for="delete-mfa-input">Authenticator code</label>
            <input
              id="delete-mfa-input"
              v-model="deleteMfaCode"
              class="sec-input sec-code-input"
              inputmode="numeric"
              maxlength="6"
              autocomplete="one-time-code"
              placeholder="000000"
              @input="deleteMfaCode = deleteMfaCode.replace(/\D/g, '')"
            />
          </div>

          <div class="sec-field">
            <label class="sec-label" for="delete-confirm-input">Type <strong>DELETE</strong> to confirm</label>
            <input
              id="delete-confirm-input"
              v-model="deleteConfirmText"
              class="sec-input"
              type="text"
              autocomplete="off"
              spellcheck="false"
              placeholder="DELETE"
            />
          </div>

          <p v-if="deleteError" class="sec-error" role="alert">{{ deleteError }}</p>
          <button v-if="needsFreshSignIn" type="button" class="sec-btn sec-btn-secondary" @click="signInAgain">
            {{ $t('security.deleteAccount.signInAgain') }}
          </button>

          <div class="sec-actions">
            <button type="button" class="sec-btn sec-btn-secondary" :disabled="isDeleting" @click="closeDeleteModal">
              {{ $t('common.cancel') }}
            </button>
            <button type="submit" class="sec-btn sec-btn-danger" :disabled="!canConfirmDeletion || isDeleting">
              {{ isDeleting ? 'Deleting…' : 'Delete account forever' }}
            </button>
          </div>
        </form>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { safeHref } from '@/utils/sanitize';
import { ref, computed, onMounted, watch } from 'vue'
import { debug } from '@/utils/debug'
import { useToast } from 'vue-toastification'
import ToggleSwitch from '@/components/common/ToggleSwitch.vue'
import PWAInstallPrompt from '@/components/PWAInstallPrompt.vue'
import RunOnLoginInstructionsModal from '@/components/RunOnLoginInstructionsModal.vue'
import AccountMigrationPanel from './AccountMigrationPanel.vue'
import { isTauriDesktop as checkTauriDesktop, canInstallPWA } from '@/utils/platform'
import { isRichPresenceEnabled, setRichPresenceEnabled } from '@/services/nativePresence'
import { isOverlayEnabled, setOverlayEnabled } from '@/services/overlayBridge'
import { useDeveloperTools } from '@/composables/useDeveloperTools'
import { useDesktopUpdater } from '@/composables/useDesktopUpdater'
import { useI18n } from 'vue-i18n'
import { useTodayDashboard } from '@/composables/useTodayDashboard'
import { todayDigestService } from '@/services/TodayDigestService'
import { accountDeletionService } from '@/services/AccountDeletionService'
import { useAuthStore } from '@/stores/auth'
import { useRouter } from 'vue-router'
import './securitySettings.css'
import {
  getChromiumBrowserLabel,
  getRunOnLoginUrl,
  isChromiumDesktop,
  isPWA,
} from '@/utils/pwaUtils'

interface Props {
  loading: boolean
}

// eslint-disable-next-line unused-imports/no-unused-vars
const props = defineProps<Props>()

const emit = defineEmits<{
  'update-advanced': [settings: any]
}>()

const toast = useToast()
const { developerToolsEnabled, setDeveloperToolsEnabled } = useDeveloperTools()
const {
  todayDashboardEnabled,
  todayAiSummariesEnabled,
  setTodayDashboardEnabled,
  setTodayAiSummariesEnabled,
} = useTodayDashboard()
const onDeviceAiSupported = todayDigestService.isOnDeviceAiSupported()

const reportBugUrl = 'https://github.com/y4my4my4m/harmony/issues/'

const settings = ref({
  developerMode: false,
})

const clearingCache = ref(false)
const originalSettings = ref({ ...settings.value })

const isTauriDesktop = checkTauriDesktop()
const richPresence = ref(isRichPresenceEnabled())
const gameOverlay = ref(isOverlayEnabled())
function onRichPresenceChange() { setRichPresenceEnabled(richPresence.value) }
function onGameOverlayChange() { setOverlayEnabled(gameOverlay.value) }

const { t } = useI18n()
const {
  state: updaterState,
  isActive: updaterActive,
  isBusy: updaterBusy,
  downloadPercent,
  checkForUpdates,
  downloadUpdate,
  installAndRestart,
  setAutoDownload,
} = useDesktopUpdater()
const updateStatusText = computed(() => {
  const s = updaterState
  const version = s.availableVersion ?? ''
  switch (s.phase) {
    case 'not-configured':
      return t('updater.settings.notConfigured')
    case 'unsupported':
      return t('updater.settings.unsupported')
    case 'checking':
      return t('updater.settings.checking')
    case 'available':
      return t('updater.settings.available', { version })
    case 'downloading': {
      const percent = downloadPercent.value
      return percent === null
        ? t('updater.settings.downloading', { version })
        : t('updater.settings.downloadingPercent', { version, percent })
    }
    case 'ready':
      return t('updater.settings.ready', { version })
    case 'installing':
      return t('updater.settings.installing')
    case 'error':
      return t('updater.settings.failed', { error: s.error ?? '' })
    default: {
      if (s.lastOutcome !== 'up-to-date' || !s.lastCheckedAt) return t('updater.settings.idle')
      const time = new Date(s.lastCheckedAt).toLocaleString()
      return `${t('updater.settings.upToDate')} ${t('updater.settings.lastChecked', { time })}`
    }
  }
})
async function restartToUpdate() {
  try {
    await installAndRestart()
  } catch (error) {
    toast.error(t('updater.installFailed', { error: error instanceof Error ? error.message : String(error) }))
  }
}

// Native autostart (tauri-plugin-autostart), invoked directly; the JS guest
// package is not needed for three one-line commands.
const launchAtLogin = ref(false)
async function onLaunchAtLoginChange() {
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    await invoke(launchAtLogin.value ? 'plugin:autostart|enable' : 'plugin:autostart|disable')
  } catch (error) {
    debug.error('Failed to toggle launch at startup:', error)
    launchAtLogin.value = !launchAtLogin.value
    toast.error('Failed to update launch at startup')
  }
}

const showRunOnLoginModal = ref(false)
const runOnLoginEnabled = ref(localStorage.getItem('harmony-run-on-login-enabled') === 'true')
const runOnLoginUrl = computed(() => getRunOnLoginUrl())
const runOnLoginBrowserLabel = computed(() => getChromiumBrowserLabel())
// Only surfaces on Chromium desktop when the app is installed - the feature
// lives on `about://apps`, which only manages installed PWAs.
const canShowRunOnLogin = computed(() => isPWA() && isChromiumDesktop())
const isInstalledPWA = isPWA()
// Hide install UI in the native app; keep the section when installable or
// when the run-on-login item applies to an installed PWA.
const showInstallSection = computed(() => canInstallPWA() || canShowRunOnLogin.value)

const onRunOnLoginEnabled = () => {
  runOnLoginEnabled.value = true
}

// --- Account deletion ---
const authStore = useAuthStore()
const router = useRouter()
const showDeleteModal = ref(false)
const deleteConfirmText = ref('')
const deletePassword = ref('')
const deleteMfaCode = ref('')
const deletionMfaRequired = ref(false)
const blockingServers = ref<string[]>([])
const deleteError = ref('')
const needsFreshSignIn = ref(false)
const isDeleting = ref(false)

const hasPassword = computed(() => {
  const providers = authStore.session?.user?.app_metadata?.providers
  return !Array.isArray(providers) || providers.length === 0 || providers.includes('email')
})

const canConfirmDeletion = computed(() =>
  deleteConfirmText.value === 'DELETE' &&
  (!hasPassword.value || deletePassword.value.length > 0) &&
  (!deletionMfaRequired.value || /^\d{6}$/.test(deleteMfaCode.value))
)

const openDeleteModal = async () => {
  deleteConfirmText.value = ''
  deletePassword.value = ''
  deleteMfaCode.value = ''
  deleteError.value = ''
  needsFreshSignIn.value = false
  blockingServers.value = []
  deletionMfaRequired.value = await accountDeletionService.isMfaEnabled()
  showDeleteModal.value = true
}

const closeDeleteModal = () => {
  if (isDeleting.value) return
  showDeleteModal.value = false
}

const goToExport = () => {
  showDeleteModal.value = false
  router.push({ name: 'UserSettings', params: { section: 'privacy' } })
}

const signInAgain = async () => {
  showDeleteModal.value = false
  await authStore.logout().catch(() => {})
}

const confirmDeletion = async () => {
  if (!canConfirmDeletion.value || isDeleting.value) return
  isDeleting.value = true
  deleteError.value = ''
  needsFreshSignIn.value = false
  blockingServers.value = []

  try {
    // The RPC needs a TOTP verify within the last ten minutes for 2FA accounts.
    if (deletionMfaRequired.value) {
      const mfaError = await accountDeletionService.verifyMfaCode(deleteMfaCode.value)
      if (mfaError) {
        deleteError.value = mfaError
        deleteMfaCode.value = ''
        return
      }
    }

    const result = await accountDeletionService.deleteAccount(hasPassword.value ? deletePassword.value : undefined)

    switch (result.status) {
      case 'success': {
        toast.success('Your account has been deleted.')
        // The auth user is gone; drop all local state and leave.
        await authStore.logout().catch(() => {})
        window.location.href = '/login'
        break
      }
      case 'transfer_ownership_required':
        blockingServers.value = result.servers
        break
      case 'mfa_required':
        deletionMfaRequired.value = true
        deleteError.value = t('security.deleteAccount.errors.mfaRequired')
        break
      case 'password_required':
      case 'invalid_password':
        deleteError.value = t('security.deleteAccount.errors.wrongPassword')
        deletePassword.value = ''
        break
      case 'reauthentication_required':
        needsFreshSignIn.value = true
        deleteError.value = t('security.deleteAccount.errors.reauthRequired')
        break
      case 'error':
        deleteError.value = result.message
        break
    }
  } finally {
    isDeleting.value = false
  }
}

// eslint-disable-next-line unused-imports/no-unused-vars
const hasChanges = computed(() => {
  return JSON.stringify(settings.value) !== JSON.stringify(originalSettings.value)
})

onMounted(async () => {
  settings.value.developerMode = developerToolsEnabled.value
  originalSettings.value = { ...settings.value }

  if (isTauriDesktop) {
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      launchAtLogin.value = await invoke<boolean>('plugin:autostart|is_enabled')
    } catch (error) {
      debug.error('Failed to read launch-at-startup state:', error)
    }
  }
})

watch(developerToolsEnabled, (v) => {
  settings.value.developerMode = v
})

const onSettingChange = () => {
  setDeveloperToolsEnabled(settings.value.developerMode)
  emit('update-advanced', settings.value)
}

/**
 * Clear ephemeral browser caches without touching identity / encryption
 * material or persisted user settings.
 *
 * Drops:
 *   - Service-worker `CacheStorage` entries (HTTP response cache)
 *   - The cached background-image manifest (will be re-fetched at next build/load)
 *   - The in-memory emoji cache (Pinia store; will refetch on demand)
 *
 * Preserves:
 *   - IndexedDB megolm/recovery key store, prekey bundles, signed prekeys
 *   - Supabase auth session (`localStorage`)
 *   - User-scoped settings (visual theme, voice device prefs, etc.)
 */
const clearCache = async () => {
  if (clearingCache.value) return
  clearingCache.value = true
  let cleared = 0
  try {
    if (typeof window !== 'undefined' && 'caches' in window) {
      const keys = await caches.keys()
      await Promise.all(keys.map((k) => caches.delete(k)))
      cleared += keys.length
    }
    try {
      localStorage.removeItem('harmony-backgrounds-manifest')
      sessionStorage.removeItem('harmony-backgrounds-manifest')
    } catch (e) {
      debug.warn('Failed to clear backgrounds manifest cache:', e)
    }
    try {
      const { useEmojiCacheStore } = await import('@/stores/useEmojiCache')
      const store = useEmojiCacheStore()
      if (typeof (store as any).clearCache === 'function') {
        ;(store as any).clearCache()
      } else if (typeof (store as any).$reset === 'function') {
        ;(store as any).$reset()
      }
    } catch (e) {
      debug.warn('Failed to clear emoji cache store:', e)
    }
    toast.success(`Cleared ${cleared} cache${cleared === 1 ? '' : 's'} + reset emoji cache`)
  } catch (e) {
    debug.error('Failed to clear cache:', e)
    toast.error('Failed to clear cache')
  } finally {
    clearingCache.value = false
  }
}
</script>

<style scoped>
.advanced-settings {
  max-width: 700px;
}

.settings-header {
  margin-bottom: 32px;
}

.settings-title {
  font-size: var(--font-size-2xl);
  font-weight: var(--font-weight-semibold);
  color: var(--text-primary);
  margin: 0 0 8px 0;
}

.settings-description {
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
  margin: 0;
}

.setting-label.disabled {
  color: var(--text-muted);
}

.setting-description.disabled {
  color: var(--text-muted);
}

.settings-section {
  margin-bottom: 32px;
  padding: 24px;
  background-color: var(--background-secondary);
  border-radius: var(--radius-md);
  border: 1px solid var(--background-quaternary);
}

.settings-section.danger-zone {
  border-color: var(--error);
  background-color: color-mix(in srgb, var(--error) 5%, transparent);
}

.section-title {
  font-size: var(--font-size-base);
  font-weight: var(--font-weight-semibold);
  color: var(--text-primary);
  margin: 0 0 20px 0;
}

.section-title.danger {
  color: var(--error);
}

.setting-item {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 20px;
  padding-bottom: 20px;
  border-bottom: 1px solid var(--background-quaternary);
}

.setting-item:last-child {
  margin-bottom: 0;
  padding-bottom: 0;
  border-bottom: none;
}

.setting-info {
  flex: 1;
  margin-right: 16px;
}

.setting-label {
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
  color: var(--text-primary);
  margin: 0 0 4px 0;
}

.setting-label.danger {
  color: var(--error);
}



.setting-description a {
  color: var(--harmony-primary);
}

.setting-description {
  font-size: var(--font-size-xs);
  color: var(--text-secondary);
  margin: 0;
  line-height: 1.4;
}

.setting-description code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px;
  background: var(--background-modifier-hover);
  padding: 1px 5px;
  border-radius: var(--radius-sm);
  color: var(--text-secondary);
}

.run-on-login-item {
  margin-top: 16px;
  padding-top: 16px;
  padding-bottom: 0;
  border-top: 1px solid var(--background-quaternary);
  border-bottom: none;
}

.setting-control {
  flex-shrink: 0;
}

.btn {
  padding: 8px 16px;
  border-radius: var(--radius-sm);
  border: none;
  font-weight: var(--font-weight-medium);
  font-size: var(--font-size-sm);
  cursor: pointer;
  transition: all 0.15s ease;
}

.btn-secondary {
  background-color: transparent;
  color: var(--text-secondary);
  border: 1px solid var(--border-hover);
}

.btn-secondary:hover {
  background-color: var(--background-quaternary);
  color: var(--text-primary);
}

.btn-danger {
  background-color: var(--error);
  color: var(--text-on-primary);
}

.btn-danger:hover {
  background-color: var(--error-hover);
}

.modal-overlay {
  position: fixed;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  background-color: rgba(0, 0, 0, 0.6);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 2000;
}

.modal-content {
  background-color: var(--background-secondary);
  border-radius: var(--radius-md);
  padding: 24px;
  max-width: 400px;
  width: 90%;
  border: 1px solid var(--background-quaternary);
}

.modal-title {
  font-size: var(--font-size-lg);
  font-weight: var(--font-weight-semibold);
  color: var(--text-primary);
  margin: 0 0 12px 0;
}

.modal-text {
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
  margin: 0 0 20px 0;
  line-height: 1.4;
}

.modal-actions {
  display: flex;
  gap: 12px;
  justify-content: flex-end;
}
</style>
