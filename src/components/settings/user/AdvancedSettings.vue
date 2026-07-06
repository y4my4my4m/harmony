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
      <h3 class="section-title">Beta Features</h3>

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
      <h3 class="section-title">Desktop App</h3>

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

    <div class="settings-section">
      <h3 class="section-title">Developer Settings</h3>

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

      <div class="setting-item disabled-option">
        <div class="setting-info">
          <h4 class="setting-label">
            {{ $t('settings.advanced.hardwareAcceleration') }}
            <span class="coming-soon-badge">Coming soon</span>
          </h4>
          <p class="setting-description">Toggle GPU-accelerated rendering. Currently controlled by your browser/OS - an in-app override is being wired up for the Tauri desktop builds.</p>
        </div>
        <div class="setting-control">
          <ToggleSwitch
            v-model="settings.hardwareAcceleration"
            disabled
          />
        </div>
      </div>
    </div>

    <div class="settings-section">
      <h3 class="section-title">Data Management</h3>

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

      <div class="setting-item disabled-option">
        <div class="setting-info">
          <h4 class="setting-label">
            {{ $t('common.download') }} Data
            <span class="coming-soon-badge">Coming soon</span>
          </h4>
          <p class="setting-description">Export your user data for backup purposes.</p>
        </div>
        <div class="setting-control">
          <button class="btn btn-secondary" disabled @click="exportData">
            {{ $t('common.download') }} Data
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
            :href="reportBugUrl"
            target="_blank"
            rel="noopener noreferrer"
            class="btn btn-secondary"
          >
            {{ $t('settings.advanced.reportBug') }}
          </a>
        </div>
      </div>
    </div>

    <div class="settings-section danger-zone">
      <h3 class="section-title danger">Danger Zone</h3>

      <div class="setting-item">
        <div class="setting-info">
          <h4 class="setting-label danger">{{ $t('common.delete') }} Account</h4>
          <p class="setting-description">
            Permanently delete your account. Your messages and posts remain
            visible but are attributed to an anonymous "Deleted User"; your
            profile, encryption keys, devices and login are removed and cannot
            be recovered.
          </p>
        </div>
        <div class="setting-control">
          <button class="btn btn-danger" @click="openDeleteModal">
            {{ $t('common.delete') }} Account
          </button>
        </div>
      </div>
    </div>

    <!-- Account deletion confirmation modal -->
    <Teleport to="body">
      <div v-if="showDeleteModal" class="delete-modal-overlay" @click.self="closeDeleteModal">
        <div class="delete-modal">
          <h3 class="delete-modal-title">Delete your account?</h3>

          <p class="delete-modal-text">
            This is permanent. Your login, profile, encryption keys and devices
            are deleted. Messages and posts you wrote stay visible, attributed
            to "Deleted User".
          </p>

          <div v-if="blockingServers.length > 0" class="delete-modal-error">
            You still own {{ blockingServers.length === 1 ? 'a server' : 'servers' }} with other
            members: <strong>{{ blockingServers.join(', ') }}</strong>.
            Transfer ownership or delete {{ blockingServers.length === 1 ? 'it' : 'them' }} first.
          </div>

          <div class="delete-modal-field">
            <label for="delete-confirm-input">Type <strong>DELETE</strong> to confirm</label>
            <input
              id="delete-confirm-input"
              v-model="deleteConfirmText"
              type="text"
              autocomplete="off"
              spellcheck="false"
              placeholder="DELETE"
            />
          </div>

          <div v-if="deletionMfaRequired" class="delete-modal-field">
            <label for="delete-mfa-input">Authenticator code</label>
            <input
              id="delete-mfa-input"
              v-model="deleteMfaCode"
              type="text"
              inputmode="numeric"
              maxlength="6"
              autocomplete="one-time-code"
              placeholder="6-digit code"
            />
          </div>

          <p v-if="deleteError" class="delete-modal-error">{{ deleteError }}</p>

          <div class="delete-modal-actions">
            <button class="btn btn-secondary" @click="closeDeleteModal" :disabled="isDeleting">
              {{ $t('common.cancel') }}
            </button>
            <button
              class="btn btn-danger"
              :disabled="!canConfirmDeletion || isDeleting"
              @click="confirmDeletion"
            >
              {{ isDeleting ? 'Deleting…' : 'Delete Account Forever' }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted, watch } from 'vue'
import { debug } from '@/utils/debug'
import { useToast } from 'vue-toastification'
import ToggleSwitch from '@/components/common/ToggleSwitch.vue'
import PWAInstallPrompt from '@/components/PWAInstallPrompt.vue'
import RunOnLoginInstructionsModal from '@/components/RunOnLoginInstructionsModal.vue'
import { isTauriDesktop as checkTauriDesktop, canInstallPWA } from '@/utils/platform'
import { isRichPresenceEnabled, setRichPresenceEnabled } from '@/services/nativePresence'
import { isOverlayEnabled, setOverlayEnabled } from '@/services/overlayBridge'
import { useDeveloperTools } from '@/composables/useDeveloperTools'
import { useTodayDashboard } from '@/composables/useTodayDashboard'
import { todayDigestService } from '@/services/TodayDigestService'
import { accountDeletionService } from '@/services/AccountDeletionService'
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
  hardwareAcceleration: true,
})

const clearingCache = ref(false)
const originalSettings = ref({ ...settings.value })

const isTauriDesktop = checkTauriDesktop()
const richPresence = ref(isRichPresenceEnabled())
const gameOverlay = ref(isOverlayEnabled())
function onRichPresenceChange() { setRichPresenceEnabled(richPresence.value) }
function onGameOverlayChange() { setOverlayEnabled(gameOverlay.value) }

// Native autostart (tauri-plugin-autostart); invoked directly so we don't
// need the JS guest package for three one-line commands.
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
// Only surface on Chromium desktop when the app is actually installed -
// the feature lives on `about://apps`, which only manages installed PWAs.
const canShowRunOnLogin = computed(() => isPWA() && isChromiumDesktop())
const isInstalledPWA = isPWA()
// Hide install UI in the native app; keep the section when installable or
// when the run-on-login item applies to an installed PWA.
const showInstallSection = computed(() => canInstallPWA() || canShowRunOnLogin.value)

const onRunOnLoginEnabled = () => {
  runOnLoginEnabled.value = true
}

// --- Account deletion ---
const showDeleteModal = ref(false)
const deleteConfirmText = ref('')
const deleteMfaCode = ref('')
const deletionMfaRequired = ref(false)
const blockingServers = ref<string[]>([])
const deleteError = ref('')
const isDeleting = ref(false)

const canConfirmDeletion = computed(() =>
  deleteConfirmText.value === 'DELETE' &&
  (!deletionMfaRequired.value || deleteMfaCode.value.length === 6)
)

const openDeleteModal = async () => {
  deleteConfirmText.value = ''
  deleteMfaCode.value = ''
  deleteError.value = ''
  blockingServers.value = []
  deletionMfaRequired.value = await accountDeletionService.isMfaEnabled()
  showDeleteModal.value = true
}

const closeDeleteModal = () => {
  if (isDeleting.value) return
  showDeleteModal.value = false
}

const confirmDeletion = async () => {
  if (!canConfirmDeletion.value || isDeleting.value) return
  isDeleting.value = true
  deleteError.value = ''
  blockingServers.value = []

  try {
    // Step-up first: the RPC rejects aal1 sessions for MFA-enrolled accounts.
    if (deletionMfaRequired.value) {
      const mfaError = await accountDeletionService.verifyMfaCode(deleteMfaCode.value)
      if (mfaError) {
        deleteError.value = mfaError
        return
      }
    }

    const result = await accountDeletionService.deleteAccount()

    switch (result.status) {
      case 'success': {
        toast.success('Your account has been deleted.')
        // The auth user is gone; drop all local state and leave.
        const { useAuthStore } = await import('@/stores/auth')
        await useAuthStore().logout().catch(() => {})
        window.location.href = '/login'
        break
      }
      case 'transfer_ownership_required':
        blockingServers.value = result.servers
        break
      case 'mfa_required':
        deletionMfaRequired.value = true
        deleteError.value = 'Enter your authenticator code to continue.'
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

const exportData = () => {
  // Placeholder - data export is on the roadmap.
  debug.log('Exporting data... (not yet implemented)')
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
  font-size: 24px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0 0 8px 0;
}

.settings-description {
  font-size: 14px;
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
  border-radius: 8px;
  border: 1px solid var(--background-quaternary);
}

.settings-section.danger-zone {
  border-color: #ed4245;
  background-color: rgba(237, 66, 69, 0.05);
}

.section-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0 0 20px 0;
}

.section-title.danger {
  color: #ed4245;
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
  font-size: 14px;
  font-weight: 500;
  color: var(--text-primary);
  margin: 0 0 4px 0;
}

.setting-label.danger {
  color: #ed4245;
}

.coming-soon-badge {
  display: inline-block;
  font-size: 10px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
  padding: 2px 6px;
  border-radius: 4px;
  background: rgba(245, 158, 11, 0.15);
  color: #f59e0b;
  vertical-align: middle;
  margin-left: 6px;
}

.setting-item.disabled-option .setting-label,
.setting-item.disabled-option .setting-description {
  opacity: 0.65;
}

.setting-description a {
  color: var(--harmony-primary, #0EA5E9);
}

.setting-description {
  font-size: 12px;
  color: var(--text-secondary);
  margin: 0;
  line-height: 1.4;
}

.setting-description code {
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 11px;
  background: rgba(255, 255, 255, 0.06);
  padding: 1px 5px;
  border-radius: 4px;
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
  border-radius: 4px;
  border: none;
  font-weight: 500;
  font-size: 14px;
  cursor: pointer;
  transition: all 0.15s ease;
}

.btn-secondary {
  background-color: transparent;
  color: var(--text-secondary);
  border: 1px solid #4f545c;
}

.btn-secondary:hover {
  background-color: var(--background-quaternary);
  color: var(--text-primary);
}

.btn-danger {
  background-color: #ed4245;
  color: var(--text-primary);
}

.btn-danger:hover {
  background-color: #c73e41;
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
  border-radius: 8px;
  padding: 24px;
  max-width: 400px;
  width: 90%;
  border: 1px solid var(--background-quaternary);
}

.modal-title {
  font-size: 18px;
  font-weight: 600;
  color: var(--text-primary);
  margin: 0 0 12px 0;
}

.modal-text {
  font-size: 14px;
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
<style scoped>
/* Account deletion modal */
.delete-modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.75);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1100;
  padding: 16px;
}

.delete-modal {
  background: var(--background-secondary);
  border: 1px solid var(--border-color);
  border-radius: 12px;
  padding: 24px;
  max-width: 440px;
  width: 100%;
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.delete-modal-title {
  margin: 0;
  font-size: 18px;
  font-weight: 700;
  color: #ed4245;
}

.delete-modal-text {
  margin: 0;
  font-size: 14px;
  line-height: 1.5;
  color: var(--text-secondary);
}

.delete-modal-field {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.delete-modal-field label {
  font-size: 13px;
  color: var(--text-secondary);
}

.delete-modal-field input {
  padding: 10px 12px;
  border-radius: 6px;
  border: 1px solid var(--border-color);
  background: var(--background-tertiary);
  color: var(--text-primary);
  font-size: 14px;
}

.delete-modal-field input:focus {
  outline: none;
  border-color: #ed4245;
}

.delete-modal-error {
  margin: 0;
  font-size: 13px;
  color: #ed4245;
  background: rgba(237, 66, 69, 0.08);
  border: 1px solid rgba(237, 66, 69, 0.3);
  border-radius: 6px;
  padding: 10px 12px;
}

.delete-modal-actions {
  display: flex;
  gap: 12px;
  justify-content: flex-end;
}
</style>
