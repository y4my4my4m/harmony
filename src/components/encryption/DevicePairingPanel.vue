<template>
  <div class="pairing-panel" data-testid="pairing-panel">
    <template v-if="phase === 'preparing' || phase === 'showing'">
      <p class="pp-lead">
        On a device where you're already signed in, choose <strong>Scan code</strong> on the
        new-login prompt, or <strong>Link a device</strong> under Privacy &rarr; Your devices,
        and scan this code.
      </p>
      <div class="pp-qr">
        <img v-if="qrUrl" :src="qrUrl" alt="Device pairing QR code" data-testid="pairing-qr" />
        <LoadingSpinner v-else :size="36" />
      </div>
      <p v-if="phase === 'showing'" class="pp-meta">
        <span v-if="secondsLeft > 0">Expires in {{ countdown }}</span>
        <span v-else>This code expired.</span>
        &middot; {{ deviceLabel }}
      </p>
      <div class="pp-actions">
        <button type="button" class="btn btn-secondary btn-sm" :disabled="phase !== 'showing'" @click="begin">
          New code
        </button>
        <button type="button" class="btn btn-secondary btn-sm" :disabled="phase !== 'showing'" @click="copyCode">
          Copy code
        </button>
      </div>
      <button type="button" class="pp-link" @click="toScan">
        Other device can't scan? Scan a code from it instead
      </button>
    </template>

    <template v-else-if="phase === 'scan'">
      <QrScanner
        hint="On your signed-in device choose Link a device, then Show a code, and point this camera at it."
        :auto-start="true"
        paste-label="Or paste the code from your other device"
        @decoded="onApproverCode"
      />
      <button type="button" class="pp-link" @click="begin">Show a code on this device instead</button>
    </template>

    <div v-else-if="phase === 'waiting' || phase === 'importing'" class="pp-status">
      <LoadingSpinner :size="32" />
      <p v-if="phase === 'waiting'">Confirm on your other device to finish linking.</p>
      <p v-else>Unlocking your encrypted messages&hellip;</p>
    </div>

    <div v-else-if="phase === 'done'" class="pp-status pp-done">
      <Icon name="check-circle" :size="32" />
      <p>This device is linked. Your encrypted messages are unlocking.</p>
    </div>

    <div v-if="error" class="pp-error" role="alert" data-testid="pairing-error">
      <p>{{ error }}</p>
      <button type="button" class="btn btn-secondary btn-sm" @click="begin">Start again</button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue'
import Icon from '@/components/common/Icon.vue'
import LoadingSpinner from '@/components/common/LoadingSpinner.vue'
import QrScanner from './QrScanner.vue'
import { renderQrDataUrl } from '@/utils/qrCode'
import { debug } from '@/utils/debug'
import { deviceIdentityService } from '@/services/encryption/DeviceIdentityService'
import { devicePairingService, type NewDevicePairing } from '@/services/encryption/DevicePairingService'
import { PairingError, decodePairingCode, looksLikePairingCode } from '@/services/encryption/devicePairing'

const emit = defineEmits<{ restored: [] }>()

type Phase = 'preparing' | 'showing' | 'scan' | 'waiting' | 'importing' | 'done' | 'failed'

const phase = ref<Phase>('preparing')
const qrUrl = ref('')
const error = ref('')
const now = ref(Date.now())
const deviceLabel = deviceIdentityService.buildLabel()

let pairing: NewDevicePairing | null = null
let controller: AbortController | null = null
let ticker: ReturnType<typeof setInterval> | null = null
let ids: { profileId: string; authUserId: string } | null = null
let alive = true

const secondsLeft = computed(() =>
  pairing ? Math.max(0, Math.round((pairing.expiresAt - now.value) / 1000)) : 0,
)
const countdown = computed(() => {
  const s = secondsLeft.value
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
})

async function identities() {
  if (ids) return ids
  const { authContextService } = await import('@/services/AuthContextService')
  const ctx = await authContextService.getCurrentContext()
  if (!ctx.isAuthenticated) throw new Error('Sign in again to link this device.')
  ids = { profileId: ctx.profileId, authUserId: ctx.authUser.id }
  return ids
}

/** Withdraws an unanswered request so other devices drop their prompt. */
function cancelPending() {
  controller?.abort()
  controller = null
  if (pairing && !pairing.session.spent) void deviceIdentityService.cancelPairingRequest(pairing.requestId)
  pairing?.session.discard()
  pairing = null
}

function describe(err: unknown): string {
  if (err instanceof PairingError) {
    switch (err.code) {
      case 'expired':
        return 'The code expired. Start again for a new one.'
      case 'denied':
        return 'Your other device declined this sign-in.'
      case 'bundle_invalid':
        return 'The keys from the other device did not verify, so nothing was imported. Start again.'
      default:
        return err.message
    }
  }
  return err instanceof Error && err.message ? err.message : 'Linking failed. Start again.'
}

async function waitAndComplete(p: NewDevicePairing) {
  controller = new AbortController()
  const keys = await devicePairingService.waitForKeys(p, controller.signal)
  if (!alive) return
  phase.value = 'importing'
  const { authUserId } = await identities()
  await devicePairingService.completeNewDevice(authUserId, p, keys)
  phase.value = 'done'
  emit('restored')
}

function fail(err: unknown, next: Phase = 'failed') {
  if (!alive || (err as { name?: string })?.name === 'AbortError') return
  debug.warn('Device pairing failed:', err)
  error.value = describe(err)
  phase.value = next
}

async function begin() {
  cancelPending()
  error.value = ''
  qrUrl.value = ''
  phase.value = 'preparing'
  try {
    const { profileId } = await identities()
    const p = await devicePairingService.startNewDevice(profileId)
    if (!alive) return
    pairing = p
    qrUrl.value = await renderQrDataUrl(p.qrText!, 280)
    phase.value = 'showing'
    await waitAndComplete(p)
  } catch (err) {
    fail(err)
  }
}

function toScan() {
  cancelPending()
  error.value = ''
  phase.value = 'scan'
}

async function onApproverCode(text: string) {
  error.value = ''
  if (!looksLikePairingCode(text)) {
    error.value = 'That is not a Harmony pairing code. On your signed-in device choose Link a device, then Show a code.'
    return
  }
  let code
  try {
    code = decodePairingCode(text)
  } catch (err) {
    error.value = describe(err)
    return
  }
  if (code.mode !== 'approver') {
    error.value = 'That code belongs to a new device. Scan the code your signed-in device shows.'
    return
  }
  cancelPending()
  phase.value = 'waiting'
  try {
    const { profileId } = await identities()
    const p = await devicePairingService.answerApproverCode(profileId, code)
    if (!alive) return
    pairing = p
    await waitAndComplete(p)
  } catch (err) {
    fail(err, 'scan')
  }
}

async function copyCode() {
  if (!pairing?.qrText) return
  try {
    await navigator.clipboard.writeText(pairing.qrText)
  } catch { /* clipboard unavailable */ }
}

onMounted(() => {
  ticker = setInterval(() => { now.value = Date.now() }, 1000)
  void begin()
})

onUnmounted(() => {
  alive = false
  if (ticker) clearInterval(ticker)
  cancelPending()
})
</script>

<style scoped>
.pairing-panel {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
  padding-top: 16px;
  text-align: center;
}

.pp-lead {
  margin: 0;
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
  line-height: 1.55;
}

.pp-qr {
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

.pp-qr img {
  width: 100%;
  height: 100%;
  border-radius: var(--radius-lg);
  image-rendering: pixelated;
}

.pp-meta {
  margin: 0;
  font-size: var(--font-size-xs);
  color: var(--text-secondary);
}

.pp-actions {
  display: flex;
  gap: 8px;
}

.pp-link {
  background: none;
  border: none;
  padding: 4px;
  color: var(--text-link, var(--harmony-primary));
  font-size: var(--font-size-sm);
  cursor: pointer;
  text-decoration: underline;
  text-underline-offset: 2px;
}

.pp-status {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 12px;
  padding: 24px 0;
  color: var(--text-secondary);
}

.pp-status p {
  margin: 0;
}

.pp-done {
  color: var(--success);
}

.pp-error {
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
  font-size: var(--font-size-sm);
}

.pp-error p {
  margin: 0;
}
</style>
