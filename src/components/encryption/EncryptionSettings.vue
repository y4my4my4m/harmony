<template>
  <div class="encryption-settings">
    <div v-if="!isInitialized" class="loading-state">
      <LoadingSpinner :size="48" />
      <p>{{ $t('encryption.settings.loadingStatus') }}</p>
    </div>
    
    <div v-else>
      <div class="subsection">
        <h4 class="subsection-title">{{ $t('encryption.settings.statusHeading') }}</h4>
        <p class="subsection-description">
          {{ $t('encryption.settings.statusDescription') }}
        </p>
        
        <div class="status-card" :class="statusClass">
          <Icon :name="statusIcon" class="status-icon" :size="24" />
          <div class="status-info">
            <strong>{{ statusTitle }}</strong>
            <p>{{ statusDescription }}</p>
          </div>
          <button 
            v-if="!encryptionStatus.hasRecoveryKey"
            @click="showSetupWizard = true"
            class="btn btn-primary btn-sm"
          >
            {{ $t('encryption.settings.setUp') }}
          </button>
          <button 
            v-else-if="!encryptionStatus.enabled"
            @click="showRecoveryModal = true"
            class="btn btn-primary btn-sm"
          >
            {{ $t('encryption.settings.unlockHistory') }}
          </button>
        </div>
      </div>
      
      <div v-if="encryptionStatus.hasRecoveryKey" class="subsection">
        <h4 class="subsection-title">{{ $t('encryption.settings.recoveryKeyHeading') }}</h4>
        
        <div class="info-card">
          <Icon name="key" class="info-icon" :size="24" />
          <div class="info-content">
            <strong>{{ $t('encryption.settings.recoveryKeyActive') }}</strong>
            <p>{{ $t('encryption.settings.recoveryKeyActiveDescription') }}</p>
          </div>
          <div class="info-actions">
            <button @click="showViewRecoveryInfo = true" class="btn btn-secondary btn-sm">
              {{ $t('encryption.settings.viewInfo') }}
            </button>
          </div>
        </div>

        <div class="backup-status" v-if="encryptionStatus.hasBackup">
          <Icon name="server" class="backup-icon" :size="18" />
          <span>{{ $t('encryption.settings.backupStored') }}</span>
          <span class="backup-time" v-if="lastBackupTime">
            {{ $t('encryption.settings.lastBackup', { time: formatTime(lastBackupTime) }) }}
          </span>
        </div>
      </div>
      
      <div v-if="encryptionStatus.enabled" class="subsection">
        <h4 class="subsection-title">{{ $t('encryption.settings.sessionKeys') }}</h4>
        
        <div class="stats-grid">
          <div class="stat-card">
            <div class="stat-value">{{ sessionStats.outbound }}</div>
            <div class="stat-label">{{ $t('encryption.settings.activeRooms') }}</div>
            <div class="stat-description">{{ $t('encryption.settings.activeRoomsDescription') }}</div>
          </div>
          <div class="stat-card">
            <div class="stat-value">{{ sessionStats.inbound }}</div>
            <div class="stat-label">{{ $t('encryption.settings.receivedKeys') }}</div>
            <div class="stat-description">{{ $t('encryption.settings.receivedKeysDescription') }}</div>
          </div>
        </div>
        
        <button
          @click="syncKeys"
          :disabled="isSyncing"
          class="btn btn-secondary"
        >
          <span v-if="isSyncing">{{ $t('encryption.settings.syncing') }}</span>
          <span v-else class="sync-label"><Icon name="refresh-cw" :size="16" /> {{ $t('encryption.settings.syncKeys') }}</span>
        </button>
      </div>

      <div v-if="encryptionStatus.hasRecoveryKey" class="subsection">
        <h4 class="subsection-title">{{ $t('encryption.settings.diagnostics') }}</h4>
        <p class="subsection-description">
          {{ $t('encryption.settings.diagnosticsDescription') }}
        </p>
        <button @click="runDiagnostics" :disabled="isDiagnosing" class="btn btn-secondary">
          {{ isDiagnosing ? $t('encryption.settings.checking') : $t('encryption.settings.runDiagnosis') }}
        </button>
        <ul v-if="diagnostics.length" class="diagnostic-list">
          <li v-for="d in diagnostics" :key="d.labelKey" class="diagnostic-row">
            <span class="diagnostic-state" :class="d.ok === true ? 'ok' : d.ok === false ? 'fail' : 'na'">
              <Icon :name="d.ok === true ? 'check' : d.ok === false ? 'x' : 'minus'" :size="14" />
            </span>
            <span class="diagnostic-label">{{ t(d.labelKey) }}</span>
            <span class="diagnostic-detail">{{ d.params && 'count' in d.params ? t(d.detailKey, d.params, Number(d.params.count)) : t(d.detailKey, d.params ?? {}) }}</span>
          </li>
        </ul>
      </div>
      
      <div v-if="encryptionStatus.hasRecoveryKey" class="subsection">
        <h4 class="subsection-title">{{ $t('encryption.settings.devicesHeading') }}</h4>
        <p class="subsection-description">
          {{ $t('encryption.settings.devicesDescription') }}
        </p>
        <DeviceManager />
      </div>

      <div v-if="encryptionStatus.hasRecoveryKey" class="subsection">
        <h4 class="subsection-title">{{ $t('encryption.settings.backupHeading') }}</h4>
        
        <div class="backup-options">
          <div class="option-card">
            <Icon name="server" class="option-icon" :size="22" />
            <div class="option-info">
              <strong>{{ $t('encryption.settings.createBackup') }}</strong>
              <p>{{ $t('encryption.settings.createBackupDescription') }}</p>
            </div>
            <button 
              @click="createBackup"
              :disabled="isBackingUp"
              class="btn btn-secondary"
            >
              {{ isBackingUp ? $t('encryption.settings.backingUp') : $t('encryption.settings.backup') }}
            </button>
          </div>
          
          <div class="option-card">
            <Icon name="save" class="option-icon" :size="22" />
            <div class="option-info">
              <strong>{{ $t('encryption.settings.exportFile') }}</strong>
              <p>{{ $t('encryption.settings.exportFileDescription') }}</p>
            </div>
            <button @click="exportBackupFile" class="btn btn-secondary">{{ $t('encryption.settings.export') }}</button>
          </div>
          
          <div class="option-card">
            <Icon name="upload" class="option-icon" :size="22" />
            <div class="option-info">
              <strong>{{ $t('encryption.settings.importFile') }}</strong>
              <p>{{ $t('encryption.settings.importFileDescription') }}</p>
            </div>
            <button @click="showImportModal = true" class="btn btn-secondary">{{ $t('encryption.settings.import') }}</button>
          </div>
          
          <div class="option-card">
            <Icon name="smartphone" class="option-icon" :size="22" />
            <div class="option-info">
              <strong>{{ $t('encryption.linkDevice.title') }}</strong>
              <p>{{ $t('encryption.settings.linkDescription') }}</p>
            </div>
            <button @click="showLinkModal = true" class="btn btn-secondary">{{ $t('encryption.settings.link') }}</button>
          </div>

          <div v-if="hasPairingCopy" class="option-card" data-testid="pairing-copy">
            <Icon name="key" class="option-icon" :size="22" />
            <div class="option-info">
              <strong>{{ $t('encryption.settings.pairingCopyTitle') }}</strong>
              <p>{{ $t('encryption.settings.pairingCopyDescription') }}</p>
            </div>
            <button
              class="btn btn-secondary"
              data-testid="pairing-copy-remove"
              :disabled="isRemovingCopy"
              @click="removePairingCopy"
            >
              {{ $t('common.remove') }}
            </button>
          </div>
        </div>
      </div>

      <div v-if="!encryptionStatus.hasRecoveryKey" class="subsection">
        <h4 class="subsection-title">{{ $t('encryption.settings.recoveryHeading') }}</h4>
        
        <div class="backup-options">
          <div class="option-card">
            <Icon name="key" class="option-icon" :size="22" />
            <div class="option-info">
              <strong>{{ $t('encryption.settings.restoreWithKey') }}</strong>
              <p>{{ $t('encryption.settings.restoreWithKeyDescription') }}</p>
            </div>
            <button @click="showRecoveryModal = true" class="btn btn-secondary">
              {{ $t('encryption.settings.enterRecoveryKey') }}
            </button>
          </div>
          
          <div class="option-card">
            <Icon name="upload" class="option-icon" :size="22" />
            <div class="option-info">
              <strong>{{ $t('encryption.settings.importFile') }}</strong>
              <p>{{ $t('encryption.settings.importFileDescription') }}</p>
            </div>
            <button @click="showImportModal = true" class="btn btn-secondary">{{ $t('encryption.settings.import') }}</button>
          </div>
        </div>
      </div>
      
      <div v-if="encryptionStatus.hasRecoveryKey" class="subsection danger-zone">
        <h4 class="subsection-title">{{ $t('server.dangerZone') }}</h4>
        
        <div class="option-card warning">
          <Icon name="alert-triangle" class="option-icon" :size="22" />
          <div class="option-info">
            <strong>{{ $t('encryption.settings.reset') }}</strong>
            <p>{{ $t('encryption.settings.resetDescription') }}</p>
          </div>
          <button @click="confirmReset = true" class="btn btn-danger">{{ $t('common.reset') }}</button>
        </div>
      </div>
    </div>
    
    <Teleport to="body">
      <RecoveryKeySetupWizard 
        v-if="showSetupWizard"
        @close="showSetupWizard = false"
        @complete="handleSetupComplete"
      />
    </Teleport>
    
    <Teleport to="body">
      <KeyRecoveryModal
        v-if="showRecoveryModal"
        :initial-tab="encryptionStatus.hasRecoveryKey ? 'device' : 'phrase'"
        @close="showRecoveryModal = false"
        @restored="handleRecoveryComplete"
      />
    </Teleport>

    <DeviceLinkModal v-if="showLinkModal" mode="scan" @close="onLinkModalClosed" />
    
    <Teleport to="body">
      <div v-if="showViewRecoveryInfo" class="modal-overlay" @click.self="showViewRecoveryInfo = false">
        <div class="modal">
          <h2 class="modal-title-with-icon"><Icon name="key" :size="24" /> {{ $t('encryption.settings.infoTitle') }}</h2>
          <div class="recovery-info-content">
            <div class="info-item">
              <span class="label">{{ $t('encryption.settings.infoStatus') }}</span>
              <span class="value success">{{ $t('encryption.settings.infoActive') }}</span>
            </div>
            <div class="info-item" v-if="recoveryMetadata">
              <span class="label">{{ $t('encryption.settings.infoWordCount') }}</span>
              <span class="value">{{ $t('encryption.settings.infoWords', { count: recoveryMetadata.word_count }, recoveryMetadata.word_count) }}</span>
            </div>
            <div class="info-item" v-if="recoveryMetadata">
              <span class="label">{{ $t('encryption.settings.infoVerificationCode') }}</span>
              <span class="value code">{{ recoveryMetadata.verification_code }}</span>
            </div>
            <div class="info-item" v-if="recoveryMetadata?.storage_hint">
              <span class="label">{{ $t('encryption.settings.infoStorageHint') }}</span>
              <span class="value">{{ recoveryMetadata.storage_hint }}</span>
            </div>
          </div>
          <div class="warning-note">
            <p><Icon name="alert-triangle" class="inline-warning-icon" :size="16" /> {{ $t('encryption.settings.infoNeverStored') }}</p>
            <p>{{ $t('encryption.settings.infoLost') }}</p>
          </div>
          <div class="modal-actions">
            <button @click="showViewRecoveryInfo = false" class="btn btn-primary">{{ $t('common.close') }}</button>
          </div>
        </div>
      </div>
    </Teleport>
    
    <Teleport to="body">
      <div v-if="confirmReset" class="modal-overlay" @click.self="confirmReset = false">
        <div class="modal">
          <h2 class="modal-title-with-icon"><Icon name="alert-triangle" :size="24" /> {{ $t('encryption.settings.resetConfirmTitle') }}</h2>
          <p>
            {{ $t('encryption.settings.resetConfirmText') }}
            <strong>{{ $t('encryption.settings.resetConfirmWarning') }}</strong>
          </p>
          <p class="warning-text">
            {{ $t('encryption.settings.resetConfirmUndone') }}
          </p>
          <div class="modal-actions">
            <button @click="confirmReset = false" class="btn btn-secondary">{{ $t('common.cancel') }}</button>
            <button @click="resetEncryption" :disabled="isResetting" class="btn btn-danger">
              {{ isResetting ? $t('encryption.settings.resetting') : $t('encryption.settings.reset') }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>
    
    <Teleport to="body">
      <div v-if="showImportModal" class="modal-overlay" @click.self="showImportModal = false">
        <div class="modal">
          <h2 class="modal-title-with-icon"><Icon name="upload" :size="24" /> {{ $t('encryption.settings.importFile') }}</h2>
          <p>{{ $t('encryption.settings.importModalText') }}</p>
          <div class="form-group">
            <label>{{ $t('encryption.settings.backupFileLabel') }}</label>
            <input 
              type="file" 
              accept=".harmony-backup,.txt,.json"
              @change="handleFileSelect"
            />
          </div>
          <p v-if="importError" class="error-text">{{ importError }}</p>
          <div class="modal-actions">
            <button @click="closeImportModal" class="btn btn-secondary">{{ $t('common.cancel') }}</button>
            <button 
              @click="importBackupFile"
              :disabled="!selectedFile || isImporting"
              class="btn btn-primary"
            >
              {{ isImporting ? $t('encryption.settings.importing') : $t('encryption.settings.import') }}
            </button>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'
import { debug } from '@/utils/debug'
import { useToast } from 'vue-toastification'
import { useI18n } from 'vue-i18n'
import RecoveryKeySetupWizard from './RecoveryKeySetupWizard.vue'
import KeyRecoveryModal from './KeyRecoveryModal.vue'
import DeviceManager from './DeviceManager.vue'
import DeviceLinkModal from './DeviceLinkModal.vue'
import Icon from '@/components/common/Icon.vue'
import LoadingSpinner from '@/components/common/LoadingSpinner.vue'
import type { DiagnosticRow } from '@/services/encryption/MegolmMessageEncryptionService'

const toast = useToast()
const { t, locale } = useI18n()

const isInitialized = ref(false)
const encryptionStatus = ref({
  enabled: false,
  hasRecoveryKey: false,
  hasBackup: false,
  needsSetup: true,
  mode: 'optional' as 'disabled' | 'optional' | 'required'
})
const sessionStats = ref({ outbound: 0, inbound: 0 })
const lastBackupTime = ref<string | null>(null)
const recoveryMetadata = ref<any>(null)

const showSetupWizard = ref(false)
const showRecoveryModal = ref(false)
const showLinkModal = ref(false)
const hasPairingCopy = ref(false)
const isRemovingCopy = ref(false)
const showViewRecoveryInfo = ref(false)
const showImportModal = ref(false)
const confirmReset = ref(false)

const isSyncing = ref(false)
const isBackingUp = ref(false)
const isResetting = ref(false)
const isImporting = ref(false)

const selectedFile = ref<File | null>(null)
const importError = ref('')

const statusClass = computed(() => {
  if (!encryptionStatus.value.hasRecoveryKey) return 'not-setup'
  if (!encryptionStatus.value.enabled) return 'locked'
  return 'enabled'
})

const statusIcon = computed(() => {
  if (!encryptionStatus.value.hasRecoveryKey) return 'unlock'
  if (!encryptionStatus.value.enabled) return 'lock'
  return 'shield'
})

const statusTitle = computed(() => {
  if (!encryptionStatus.value.hasRecoveryKey) return t('encryption.settings.statusNotSetUp')
  if (!encryptionStatus.value.enabled) return t('encryption.settings.statusLocked')
  return t('encryption.settings.statusActive')
})

const statusDescription = computed(() => {
  if (!encryptionStatus.value.hasRecoveryKey) {
    return t('encryption.settings.statusNotSetUpDescription')
  }
  if (!encryptionStatus.value.enabled) {
    return t('encryption.settings.statusLockedDescription')
  }
  return t('encryption.settings.statusActiveDescription')
})

async function loadEncryptionStatus() {
  try {
    const { megolmMessageEncryptionService } = await import('@/services/encryption/MegolmMessageEncryptionService')
    const { supabase } = await import('@/supabase')
    
    const { data: { user } } = await supabase.auth.getUser()
    if (!user) {
      isInitialized.value = true
      return
    }

    if (!megolmMessageEncryptionService.isInitialized()) {
      await megolmMessageEncryptionService.initialize(user.id)
    }

    const status = await megolmMessageEncryptionService.getEncryptionStatus()
    encryptionStatus.value = status
    hasPairingCopy.value = megolmMessageEncryptionService.hasPairingCopy()

    // maybeSingle: the metadata row may not exist.
    if (status.hasRecoveryKey) {
      const { data: metadata } = await supabase
        .from('recovery_key_metadata')
        .select('*')
        .eq('user_id', megolmMessageEncryptionService.getCurrentUserId())
        .maybeSingle()
      
      recoveryMetadata.value = metadata
      lastBackupTime.value = metadata?.last_backup_at || null
    } else {
      recoveryMetadata.value = null
      lastBackupTime.value = null
    }

    if (status.enabled) {
      const { megolmService } = await import('@/services/encryption/MegolmService')
      const sessions = await megolmService.exportAllSessions()
      sessionStats.value = {
        outbound: sessions.outbound.length,
        inbound: sessions.inbound.length
      }
    }

    isInitialized.value = true
  } catch (error) {
    debug.error('Failed to load encryption status:', error)
    toast.error(t('encryption.settings.toast.loadFailed'))
    isInitialized.value = true
  }
}

function formatTime(isoString: string): string {
  const date = new Date(isoString)
  const now = new Date()
  const diff = now.getTime() - date.getTime()
  
  if (diff < 60000) return t('time.justNow')
  if (diff < 3600000) return t('time.minutesAgo', { count: Math.floor(diff / 60000) })
  if (diff < 86400000) return t('time.hoursAgo', { count: Math.floor(diff / 3600000) })
  return date.toLocaleDateString(locale.value)
}

const diagnostics = ref<DiagnosticRow[]>([])
const isDiagnosing = ref(false)

async function runDiagnostics() {
  isDiagnosing.value = true
  try {
    const { megolmMessageEncryptionService } = await import('@/services/encryption/MegolmMessageEncryptionService')
    diagnostics.value = await megolmMessageEncryptionService.runDiagnostics()
  } catch (error: any) {
    toast.error(error?.message || t('encryption.settings.toast.diagnosisFailed'))
  } finally {
    isDiagnosing.value = false
  }
}

async function syncKeys() {
  isSyncing.value = true
  try {
    const { megolmMessageEncryptionService } = await import('@/services/encryption/MegolmMessageEncryptionService')

    let restoredCount = 0
    try {
      const { megolmKeyBackupService } = await import('@/services/encryption/MegolmKeyBackupService')
      const restored = await megolmKeyBackupService.restoreFromBackup()
      restoredCount = restored.outboundCount + restored.inboundCount
    } catch (restoreErr: any) {
      const msg = String(restoreErr?.message || restoreErr)
      if (msg.includes('invalid recovery key')) {
        toast.warning(
          t('encryption.settings.toast.backupWrongPhrase'),
          { timeout: 10000 },
        )
      } else {
        toast.error(t('encryption.settings.toast.backupRestoreFailed', { error: msg }), { timeout: 10000 })
      }
    }

    const claimed = await megolmMessageEncryptionService.claimPendingSessionShares()

    if (restoredCount > 0 || claimed > 0) {
      toast.success(t('encryption.settings.toast.synced', { restored: restoredCount, claimed }))
    } else {
      toast.info(t('encryption.settings.toast.nothingToSync'))
    }

    // Re-decrypt visible messages. Runs even when claimed == 0: an unlock may
    // have restored sessions from backup.
    try {
      const { useChatStore } = await import('@/stores/useChat')
      useChatStore().reprocessEncryptedMessages()
    } catch { /* non-fatal */ }
    window.dispatchEvent(new CustomEvent('megolm-key-received', { detail: { roomId: '*', sessionId: '*' } }))

    await loadEncryptionStatus()
  } catch (error: any) {
    toast.error(error.message || t('encryption.settings.toast.syncFailed'))
  } finally {
    isSyncing.value = false
  }
}

async function createBackup() {
  isBackingUp.value = true
  try {
    const { megolmMessageEncryptionService } = await import('@/services/encryption/MegolmMessageEncryptionService')
    await megolmMessageEncryptionService.backupSessions()
    toast.success(t('encryption.settings.toast.backupCreated'))
    await loadEncryptionStatus()
  } catch (error: any) {
    toast.error(error.message || t('encryption.settings.toast.backupFailed'))
  } finally {
    isBackingUp.value = false
  }
}

async function exportBackupFile() {
  try {
    const { megolmKeyBackupService } = await import('@/services/encryption/MegolmKeyBackupService')
    const encryptedData = await megolmKeyBackupService.exportToFile()
    
    const blob = new Blob([encryptedData], { type: 'application/octet-stream' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `harmony-megolm-backup-${new Date().toISOString().split('T')[0]}.harmony-backup`
    a.click()
    URL.revokeObjectURL(url)
    
    toast.success(t('encryption.settings.toast.exported'))
  } catch (error: any) {
    toast.error(error.message || t('encryption.settings.toast.exportFailed'))
  }
}

function handleFileSelect(event: Event) {
  const input = event.target as HTMLInputElement
  selectedFile.value = input.files?.[0] || null
  importError.value = ''
}

async function importBackupFile() {
  if (!selectedFile.value) return

  isImporting.value = true
  importError.value = ''

  try {
    const text = await selectedFile.value.text()
    const { megolmKeyBackupService } = await import('@/services/encryption/MegolmKeyBackupService')
    const result = await megolmKeyBackupService.importFromFile(text)
    
    toast.success(t('encryption.settings.toast.imported', { count: result.outboundCount + result.inboundCount }, result.outboundCount + result.inboundCount))
    closeImportModal()
    await loadEncryptionStatus()
  } catch (error: any) {
    importError.value = error.message || t('encryption.settings.toast.importFailed')
  } finally {
    isImporting.value = false
  }
}

function closeImportModal() {
  showImportModal.value = false
  selectedFile.value = null
  importError.value = ''
}

async function resetEncryption() {
  isResetting.value = true
  try {
    // Leave any end-to-end encrypted voice call before wiping keys. The LiveKit
    // worker holds the voice key independently of the Megolm stores, so the call
    // would keep running with a key that can no longer be rotated - a misleading
    // "encrypted" shield that breaks on the next membership change.
    const { useUnifiedVoiceChannelStore } = await import('@/stores/unifiedVoiceChannel')
    const voiceStore = useUnifiedVoiceChannelStore()
    if (voiceStore.isConnected && voiceStore.isEncrypted) {
      debug.log('Reset encryption: leaving active encrypted voice call first')
      await voiceStore.leaveVoiceChannel()
      toast.info(t('encryption.settings.toast.leftVoice'))
    }

    const { megolmMessageEncryptionService } = await import('@/services/encryption/MegolmMessageEncryptionService')
    await megolmMessageEncryptionService.resetEncryption()
    
    confirmReset.value = false
    toast.success(t('encryption.settings.toast.resetDone'))
    await loadEncryptionStatus()
  } catch (error: any) {
    toast.error(error.message || t('encryption.settings.toast.resetFailed'))
  } finally {
    isResetting.value = false
  }
}

async function handleSetupComplete() {
  showSetupWizard.value = false
  await loadEncryptionStatus()
  toast.success(t('encryption.settings.toast.enabled'))
  await autoSyncAfterEnable()
}

async function handleRecoveryComplete() {
  showRecoveryModal.value = false
  await loadEncryptionStatus()
  toast.success(t('encryption.settings.toast.restored'))
  await autoSyncAfterEnable()
}

async function autoSyncAfterEnable() {
  try {
    const { megolmMessageEncryptionService } = await import('@/services/encryption/MegolmMessageEncryptionService')
    const claimed = await megolmMessageEncryptionService.claimPendingSessionShares()
    if (claimed > 0) {
      toast.info(t('encryption.settings.toast.syncedKeys', { count: claimed }, claimed))
    }

    const { useChatStore } = await import('@/stores/useChat')
    const chatStore = useChatStore()
    await chatStore.reprocessEncryptedMessages()

    // Dispatch event so DM store also reprocesses
    window.dispatchEvent(new CustomEvent('megolm-key-received', { detail: { roomId: '*', sessionId: '*' } }))
  } catch (error) {
    // Non-critical - encryption is already enabled
  }
}

async function onLinkModalClosed() {
  showLinkModal.value = false
  const { megolmMessageEncryptionService } = await import('@/services/encryption/MegolmMessageEncryptionService')
  hasPairingCopy.value = megolmMessageEncryptionService.hasPairingCopy()
}

async function removePairingCopy() {
  isRemovingCopy.value = true
  try {
    const { megolmMessageEncryptionService } = await import('@/services/encryption/MegolmMessageEncryptionService')
    await megolmMessageEncryptionService.removePairingCopy()
    hasPairingCopy.value = false
    toast.success(t('encryption.settings.pairingCopyRemoved'))
  } catch (error) {
    debug.error('Failed to remove the pairing copy:', error)
    toast.error(t('encryption.settings.pairingCopyRemoveFailed'))
  } finally {
    isRemovingCopy.value = false
  }
}

onMounted(() => {
  loadEncryptionStatus()
})
</script>

<style scoped>
.encryption-settings {
  padding: 24px;
}

.loading-state {
  text-align: center;
  padding: 48px 0;
}

.subsection {
  margin-bottom: 32px;
  padding-bottom: 32px;
  border-bottom: 1px solid var(--border-color);
}

.subsection:last-child {
  border-bottom: none;
  margin-bottom: 0;
  padding-bottom: 0;
}

.subsection-title {
  font-size: var(--font-size-base);
  font-weight: var(--font-weight-semibold);
  color: var(--text-primary);
  margin: 0 0 8px 0;
}

.subsection-description {
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
  margin: 0 0 20px 0;
  line-height: 1.5;
}

.status-card {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 20px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-lg);
}

.status-card.enabled {
  border-color: var(--success);
  background: color-mix(in srgb, var(--success) 5%, transparent);
}

.status-card.locked {
  border-color: var(--warning);
  background: color-mix(in srgb, var(--warning) 5%, transparent);
}

.status-card.not-setup {
  border-color: var(--text-secondary);
}

.status-icon {
  flex-shrink: 0;
  color: currentColor;
}

.status-info {
  flex: 1;
}

.status-info strong {
  display: block;
  color: var(--text-primary);
  font-size: var(--font-size-base);
  margin-bottom: 4px;
}

.status-info p {
  color: var(--text-secondary);
  font-size: 13px;
  margin: 0;
}

.info-card {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 16px;
  background: var(--bg-secondary);
  border-radius: var(--radius-md);
  margin-bottom: 16px;
}

.info-icon {
  flex-shrink: 0;
  color: currentColor;
}

.info-content {
  flex: 1;
}

.info-content strong {
  display: block;
  color: var(--text-primary);
  margin-bottom: 4px;
}

.info-content p {
  color: var(--text-secondary);
  font-size: 13px;
  margin: 0;
}

.backup-status {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 12px 16px;
  background: color-mix(in srgb, var(--success) 10%, transparent);
  border-radius: var(--radius-md);
  font-size: var(--font-size-sm);
  color: var(--text-success);
}

.backup-icon {
  flex-shrink: 0;
  color: currentColor;
}

.backup-time {
  margin-left: auto;
  font-size: var(--font-size-xs);
  color: var(--text-secondary);
}

.stats-grid {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 16px;
  margin-bottom: 16px;
}

.stat-card {
  padding: 16px;
  background: var(--bg-secondary);
  border-radius: var(--radius-md);
}

.stat-value {
  font-size: 28px;
  font-weight: var(--font-weight-semibold);
  color: var(--text-primary);
  margin-bottom: 4px;
}

.stat-label {
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
  color: var(--text-primary);
  margin-bottom: 4px;
}

.stat-description {
  font-size: var(--font-size-xs);
  color: var(--text-secondary);
}

.backup-options {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.option-card {
  display: flex;
  align-items: center;
  gap: 16px;
  padding: 16px;
  background: var(--bg-secondary);
  border-radius: var(--radius-md);
}

.option-card.warning {
  border: 1px solid color-mix(in srgb, var(--error) 30%, transparent);
  background: color-mix(in srgb, var(--error) 5%, transparent);
}

.option-icon {
  flex-shrink: 0;
  color: currentColor;
}

.option-info {
  flex: 1;
}

.option-info strong {
  display: block;
  color: var(--text-primary);
  margin-bottom: 4px;
}

.option-info p {
  color: var(--text-secondary);
  font-size: 13px;
  margin: 0;
}

.danger-zone .subsection-title {
  color: var(--text-danger);
}

.modal-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.8);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
  padding: 20px;
}

.modal {
  background: var(--bg-primary);
  padding: 24px;
  border-radius: var(--radius-lg);
  border: 1px solid var(--border-color);
  max-width: 480px;
  width: 100%;
}

.modal h2 {
  font-size: var(--font-size-xl);
  color: var(--text-primary);
  margin: 0 0 16px 0;
}

.modal-title-with-icon {
  display: inline-flex;
  align-items: center;
  gap: 8px;
}

.inline-warning-icon {
  vertical-align: middle;
  margin-right: 4px;
}

.sync-label {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

.modal p {
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
  line-height: 1.5;
  margin-bottom: 12px;
}

.warning-text {
  color: var(--text-danger) !important;
  font-weight: var(--font-weight-medium);
}

.error-text {
  color: var(--text-danger);
  font-size: var(--font-size-sm);
}

.modal-actions {
  display: flex;
  gap: 12px;
  justify-content: flex-end;
  margin-top: 24px;
}

.recovery-info-content {
  margin-bottom: 20px;
}

.info-item {
  display: flex;
  justify-content: space-between;
  padding: 12px 0;
  border-bottom: 1px solid var(--border-color);
}

.info-item:last-child {
  border-bottom: none;
}

.info-item .label {
  color: var(--text-secondary);
}

.info-item .value {
  color: var(--text-primary);
  font-weight: var(--font-weight-medium);
}

.info-item .value.success {
  color: var(--text-success);
}

.info-item .value.code {
  font-family: 'JetBrains Mono', monospace;
  background: var(--bg-secondary);
  padding: 4px 8px;
  border-radius: var(--radius-sm);
}

.warning-note {
  padding: 16px;
  background: color-mix(in srgb, var(--warning) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--warning) 30%, transparent);
  border-radius: var(--radius-md);
}

.warning-note p {
  margin: 0;
  font-size: 13px;
}

.warning-note p + p {
  margin-top: 8px;
}

.form-group {
  margin-bottom: 16px;
}

.form-group label {
  display: block;
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
  color: var(--text-primary);
  margin-bottom: 8px;
}

.form-group input[type="file"] {
  width: 100%;
  padding: 12px;
  background: var(--bg-secondary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  color: var(--text-primary);
  cursor: pointer;
}

.btn {
  padding: 12px 24px;
  border-radius: var(--radius-md);
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
  cursor: pointer;
  transition: all 0.2s;
  border: none;
}

.btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.btn-sm {
  padding: 8px 16px;
}

.btn-primary {
  background: var(--harmony-primary-fill);
  color: var(--text-on-primary);
}

.btn-primary:hover:not(:disabled) {
  background: var(--harmony-primary-fill-hover);
}

.btn-secondary {
  background: var(--bg-secondary);
  color: var(--text-primary);
  border: 1px solid var(--border-color);
}

.btn-secondary:hover:not(:disabled) {
  background: var(--bg-tertiary);
}

.btn-danger {
  background: var(--error-fill);
  color: var(--text-on-primary);
}

.btn-danger:hover:not(:disabled) {
  background: var(--error-fill-hover);
}

.diagnostic-list {
  list-style: none;
  margin: 16px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.diagnostic-row {
  display: flex;
  align-items: baseline;
  gap: 10px;
  padding: 8px 12px;
  border-radius: var(--radius-md);
  background: var(--bg-secondary);
  font-size: 13px;
}

.diagnostic-state {
  display: inline-flex;
  align-self: center;
  width: 14px;
  flex-shrink: 0;
}
.diagnostic-state.ok { color: var(--text-success); }
.diagnostic-state.fail { color: var(--text-danger); }
.diagnostic-state.na { color: var(--text-secondary); }

.diagnostic-label {
  font-weight: var(--font-weight-semibold);
  flex-shrink: 0;
  min-width: 110px;
}

.diagnostic-detail {
  color: var(--text-secondary);
  min-width: 0;
}
</style>

