<template>
  <BaseModal
    :show="true"
    title="Link a new device"
    subtitle="Give a device you just signed in on access to your encrypted messages."
    icon="smartphone"
    compact
    :close-on-overlay="phase !== 'sending'"
    :show-close-button="phase !== 'sending'"
    @close="close"
  >
    <div class="device-link" data-testid="device-link-modal">
      <div v-if="phase === 'checking'" class="dl-status">
        <LoadingSpinner :size="32" />
      </div>

      <div v-else-if="phase === 'need-unlock'" class="dl-notice">
        <Icon name="key" :size="22" />
        <p>{{ needUnlockText }}</p>
        <button type="button" class="btn btn-primary btn-sm" @click="showPhraseEntry = true">
          Enter recovery phrase
        </button>
      </div>

      <template v-else-if="phase === 'scan'">
        <QrScanner
          hint="Point the camera at the QR code on the new device."
          :auto-start="true"
          paste-label="Or paste the code copied from the new device"
          @decoded="onScanned"
        />
        <button type="button" class="dl-link" @click="toShow">
          New device has a camera? Show a code for it to scan instead
        </button>
      </template>

      <template v-else-if="phase === 'show'">
        <p class="dl-lead">
          On the new device, choose <strong>Another device</strong>, then
          <strong>Scan a code from it instead</strong>, and point its camera here.
          Anyone signed in to your account who scans this code can receive your keys,
          so keep it to yourself.
        </p>
        <div class="dl-qr">
          <img v-if="qrUrl" :src="qrUrl" alt="Device linking QR code" data-testid="link-qr" />
          <LoadingSpinner v-else :size="36" />
        </div>
        <p class="dl-meta">
          <span v-if="secondsLeft > 0">Expires in {{ countdown }}</span>
          <span v-else>This code expired.</span>
        </p>
        <div class="dl-actions">
          <button type="button" class="btn btn-secondary btn-sm" @click="toShow">New code</button>
        </div>
        <button type="button" class="dl-link" @click="toScan">Scan the new device's code instead</button>
      </template>

      <div v-else-if="phase === 'confirm' && link" class="dl-confirm" data-testid="link-confirm">
        <Icon name="shield-check" :size="26" class="dl-ok" />
        <p class="dl-device">{{ link.request.requesting_label || 'New device' }}</p>
        <p class="dl-meta">
          Signed in {{ requestedAgo }}.
          {{ link.request.pairing_proof ? 'It answered the code this device showed.' : 'Its key matches the code you scanned.' }}
        </p>
        <p class="dl-warning">
          This device will be able to read all your encrypted messages. Continue only if it is
          yours and in front of you.
        </p>
        <label class="dl-keep" data-testid="link-keep-copy">
          <input v-model="keepCopy" type="checkbox" />
          <span>
            <strong>Link devices from here later without the recovery phrase</strong>
            <span class="dl-keep-note">
              This device keeps a readable copy of your encryption keys. Anyone able to run
              code in Harmony on this device could copy them. Remove it any time in
              Settings &rsaquo; Encryption.
            </span>
          </span>
        </label>
        <div class="dl-actions">
          <button type="button" class="btn btn-primary" data-testid="link-confirm-button" @click="send">
            Link this device
          </button>
          <button type="button" class="btn btn-secondary" @click="close">Cancel</button>
        </div>
      </div>

      <div v-else-if="phase === 'sending'" class="dl-status">
        <LoadingSpinner :size="32" />
        <p>Sending your keys&hellip;</p>
      </div>

      <div v-else-if="phase === 'done'" class="dl-status dl-done" data-testid="link-done">
        <Icon name="check-circle" :size="32" />
        <p>{{ link?.request.requesting_label || 'The new device' }} is linked.</p>
        <button type="button" class="btn btn-primary btn-sm" @click="close">Done</button>
      </div>

      <div v-if="error" class="dl-error" role="alert" data-testid="link-error">
        <p>{{ error }}</p>
        <button type="button" class="btn btn-secondary btn-sm" @click="retry">Try again</button>
      </div>
    </div>

    <Teleport to="body">
      <KeyRecoveryModal
        v-if="showPhraseEntry"
        initial-tab="phrase"
        @close="showPhraseEntry = false"
        @restored="onPhraseEntered"
      />
    </Teleport>
  </BaseModal>
</template>

<script setup lang="ts">
import { computed, defineAsyncComponent, onMounted, onUnmounted, ref } from 'vue'
import BaseModal from '@/components/common/BaseModal.vue'
import Icon from '@/components/common/Icon.vue'
import LoadingSpinner from '@/components/common/LoadingSpinner.vue'
import QrScanner from './QrScanner.vue'
import { renderQrDataUrl } from '@/utils/qrCode'
import { debug } from '@/utils/debug'
import { userEventChannel } from '@/services/UserEventChannel'
import { useDeviceApprovals } from '@/composables/useDeviceApprovals'
import { devicePairingService, type PendingLink } from '@/services/encryption/DevicePairingService'
import {
  PairingError,
  decodePairingCode,
  looksLikePairingCode,
  type ApproverCodeSession,
} from '@/services/encryption/devicePairing'

const KeyRecoveryModal = defineAsyncComponent(() => import('./KeyRecoveryModal.vue'))

const props = withDefaults(defineProps<{ mode?: 'scan' | 'show' }>(), { mode: 'scan' })
const emit = defineEmits<{ close: []; linked: [] }>()

type Phase = 'checking' | 'need-unlock' | 'scan' | 'show' | 'confirm' | 'sending' | 'done' | 'failed'

const { linkInProgress } = useDeviceApprovals()
const phase = ref<Phase>('checking')
const error = ref('')
const link = ref<PendingLink | null>(null)
const qrUrl = ref('')
const now = ref(Date.now())
const needUnlockText = ref('')
const showPhraseEntry = ref(false)
const keepCopy = ref(true)

let session: ApproverCodeSession | null = null
let profileId: string | null = null
let pollTimer: ReturnType<typeof setInterval> | null = null
let ticker: ReturnType<typeof setInterval> | null = null
let offRequest: (() => void) | null = null
let searching = false
let alive = true
let lastMode: 'scan' | 'show' = props.mode

const secondsLeft = computed(() =>
  session ? Math.max(0, Math.round((session.expiresAt - now.value) / 1000)) : 0,
)
const countdown = computed(() => {
  const s = secondsLeft.value
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
})
const requestedAgo = computed(() => {
  if (!link.value) return ''
  const s = Math.max(0, Math.round((now.value - Date.parse(link.value.request.created_at)) / 1000))
  if (s < 60) return 'just now'
  const m = Math.round(s / 60)
  return `${m} minute${m === 1 ? '' : 's'} ago`
})

function describe(err: unknown): string {
  if (err instanceof PairingError) {
    switch (err.code) {
      case 'fingerprint_mismatch':
      case 'code_mismatch':
        return 'Security check failed: the device key the server returned does not match the code you scanned. Nothing was sent. Do not link this device.'
      case 'not_found':
        return 'No sign-in for this code on your account. Check that both devices use the same account.'
      case 'already_used':
        return 'This code was answered by more than one device. Nothing was sent. Show a new code.'
      default:
        return err.message
    }
  }
  return err instanceof Error && err.message ? err.message : 'Linking failed.'
}

function fail(err: unknown) {
  if (!alive) return
  debug.warn('Device linking failed:', err)
  error.value = describe(err)
  phase.value = 'failed'
}

function stopSearching() {
  if (pollTimer) clearInterval(pollTimer)
  pollTimer = null
  offRequest?.()
  offRequest = null
  session = null
}

async function precheck(): Promise<boolean> {
  const { megolmMessageEncryptionService } = await import('@/services/encryption/MegolmMessageEncryptionService')
  if (!megolmMessageEncryptionService.isUnlocked()) {
    needUnlockText.value = 'Encryption is locked on this device, so it has no keys to share. Unlock it with your recovery phrase first.'
    phase.value = 'need-unlock'
    return false
  }
  if (!megolmMessageEncryptionService.canExportPairingKeys()) {
    needUnlockText.value = 'To share your keys, this device needs your recovery phrase. Enter it here, then scan the new device.'
    phase.value = 'need-unlock'
    return false
  }
  return true
}

async function enter(mode: 'scan' | 'show') {
  lastMode = mode
  error.value = ''
  link.value = null
  stopSearching()
  phase.value = 'checking'
  try {
    if (!(await precheck())) return
    if (mode === 'scan') {
      phase.value = 'scan'
      return
    }
    await startShowing()
  } catch (err) {
    fail(err)
  }
}

function toScan() {
  void enter('scan')
}

function toShow() {
  void enter('show')
}

function retry() {
  void enter(lastMode)
}

async function startShowing() {
  if (!profileId) {
    const { authContextService } = await import('@/services/AuthContextService')
    const ctx = await authContextService.getCurrentContext()
    if (!ctx.isAuthenticated) throw new Error('Sign in again to link a device.')
    profileId = ctx.profileId
  }
  qrUrl.value = ''
  session = await devicePairingService.startApproverCode(profileId)
  qrUrl.value = await renderQrDataUrl(session.text(), 280)
  phase.value = 'show'
  pollTimer = setInterval(() => void search(), 2000)
  offRequest = userEventChannel.on('device:approval_request', () => void search())
}

async function search() {
  const s = session
  if (!s || !profileId || searching || phase.value !== 'show') return
  if (s.expired()) {
    stopSearching()
    return
  }
  searching = true
  try {
    const found = await devicePairingService.findAnswer(profileId, s)
    if (found && session === s && phase.value === 'show') {
      stopSearching()
      link.value = found
      phase.value = 'confirm'
    }
  } catch (err) {
    stopSearching()
    fail(err)
  } finally {
    searching = false
  }
}

async function onScanned(text: string) {
  error.value = ''
  if (!looksLikePairingCode(text)) {
    error.value = 'That is not a Harmony pairing code. Scan the code on the new device.'
    return
  }
  try {
    const code = decodePairingCode(text)
    if (code.mode !== 'new-device') {
      error.value = 'That code is shown by a signed-in device. Scan the code on the new device.'
      return
    }
    phase.value = 'checking'
    link.value = await devicePairingService.inspectScannedCode(code)
    phase.value = 'confirm'
  } catch (err) {
    fail(err)
  }
}

async function send() {
  if (!link.value) return
  phase.value = 'sending'
  try {
    await devicePairingService.approveLink(link.value)
    await applyKeepCopy()
    if (!alive) return
    phase.value = 'done'
    emit('linked')
  } catch (err) {
    fail(err)
  }
}

/** Keeps or removes this device's pairing copy as the checkbox says. The link stands either way. */
async function applyKeepCopy() {
  const { megolmMessageEncryptionService } = await import('@/services/encryption/MegolmMessageEncryptionService')
  try {
    if (keepCopy.value && !megolmMessageEncryptionService.hasPairingCopy()) {
      await megolmMessageEncryptionService.keepPairingCopy()
    } else if (!keepCopy.value && megolmMessageEncryptionService.hasPairingCopy()) {
      await megolmMessageEncryptionService.removePairingCopy()
    }
  } catch (err) {
    debug.warn('Updating the pairing copy failed:', err)
  }
}

function onPhraseEntered() {
  showPhraseEntry.value = false
  void enter(lastMode)
}

function close() {
  emit('close')
}

onMounted(() => {
  linkInProgress.value = true
  ticker = setInterval(() => { now.value = Date.now() }, 1000)
  void enter(props.mode)
})

onUnmounted(() => {
  alive = false
  linkInProgress.value = false
  if (ticker) clearInterval(ticker)
  stopSearching()
})
</script>

<style scoped>
.device-link {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
  min-width: min(420px, 80vw);
  text-align: center;
}

.dl-lead,
.dl-meta,
.dl-warning,
.dl-notice p,
.dl-status p,
.dl-error p {
  margin: 0;
  font-size: var(--font-size-sm);
  line-height: 1.5;
}

.dl-lead,
.dl-meta {
  color: var(--text-secondary);
}

.dl-meta {
  font-size: var(--font-size-xs);
}

.dl-qr {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 280px;
  max-width: 100%;
  aspect-ratio: 1;
  background: #fff;
  border-radius: var(--radius-lg);
  border: 1px solid var(--border-color);
}

.dl-qr img {
  width: 100%;
  height: 100%;
  border-radius: var(--radius-lg);
  image-rendering: pixelated;
}

.dl-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 8px;
}

.dl-link {
  background: none;
  border: none;
  padding: 4px;
  color: var(--text-link, var(--harmony-primary));
  font-size: var(--font-size-sm);
  cursor: pointer;
  text-decoration: underline;
  text-underline-offset: 2px;
}

.dl-status,
.dl-notice,
.dl-confirm {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  padding: 8px 0;
}

.dl-notice {
  color: var(--text-secondary);
}

.dl-ok,
.dl-done {
  color: var(--success);
}

.dl-device {
  margin: 0;
  font-size: var(--font-size-lg);
  font-weight: var(--font-weight-semibold);
  color: var(--text-primary);
}

.dl-warning {
  padding: 10px 12px;
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--warning) 10%, transparent);
  border: 1px solid color-mix(in srgb, var(--warning) 30%, transparent);
  color: var(--text-primary);
}

.dl-keep {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  max-width: 420px;
  text-align: left;
  font-size: var(--font-size-sm);
  line-height: 1.45;
  color: var(--text-primary);
  cursor: pointer;
}

.dl-keep input {
  margin-top: 3px;
  flex-shrink: 0;
}

.dl-keep-note {
  display: block;
  margin-top: 2px;
  font-size: var(--font-size-xs);
  color: var(--text-secondary);
}

.dl-error {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 10px 14px;
  border-radius: var(--radius-md);
  background: color-mix(in srgb, var(--error) 8%, transparent);
  border: 1px solid color-mix(in srgb, var(--error) 25%, transparent);
  color: var(--error);
}
</style>
