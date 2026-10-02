<template>
  <section class="sec-card" aria-labelledby="sessions-title">
    <header class="sec-card-header">
      <div>
        <h3 id="sessions-title" class="sec-card-title">Devices</h3>
        <p class="sec-card-description">
          Everywhere your account is signed in. Signing a device out also stops its push
          notifications. Locations are shown as the IP address the sign-in came from.
        </p>
      </div>
      <button class="sec-icon-btn" title="Refresh" :disabled="loading" @click="load">
        <Icon name="refresh-cw" :size="16" />
      </button>
    </header>

    <p v-if="error" class="sec-error" role="alert">{{ error }}</p>
    <div v-else-if="loading && sessions.length === 0" class="sec-muted">Loading devices…</div>

    <ul v-else class="sec-list">
      <li v-for="session in sessions" :key="session.id" class="sec-list-item">
        <div class="sec-device-icon" :class="{ current: session.is_current }">
          <Icon :name="deviceIcon(session)" :size="20" />
        </div>
        <div class="sec-device-body">
          <div class="sec-row-title">
            {{ deviceLabel(session) }}
            <span v-if="session.is_current" class="sec-pill sec-pill-current">This device</span>
            <span v-if="session.push_transports.length" class="sec-pill" :title="pushTitle(session)">Push</span>
          </div>
          <div class="sec-muted">
            <span v-if="session.ip">{{ session.ip }} · </span>
            <span :title="absolute(session.last_active_at || session.created_at)">
              Active {{ relative(session.last_active_at || session.created_at) }}
            </span>
            <span> · Signed in {{ absoluteDate(session.created_at) }}</span>
            <span v-if="session.aal === 'aal1' && mfaEnabled" class="sec-warn"> · Two-factor not completed</span>
          </div>
        </div>
        <button
          v-if="!session.is_current"
          class="sec-btn sec-btn-secondary sec-btn-sm"
          :disabled="revoking === session.id"
          @click="revoke(session)"
        >
          {{ revoking === session.id ? 'Signing out…' : 'Sign out' }}
        </button>
      </li>
    </ul>

    <div v-if="otherCount > 0" class="sec-actions sec-actions-start">
      <button class="sec-btn sec-btn-danger" :disabled="revokingAll" @click="revokeOthers">
        {{ revokingAll ? 'Signing out…' : `Sign out all other devices (${otherCount})` }}
      </button>
    </div>

    <div v-if="unlinkedPush.length" class="sec-subsection">
      <div class="sec-row-title">Other push notification targets</div>
      <p class="sec-muted">Registered before devices were linked to sign-ins, or by a device that is no longer signed in.</p>
      <ul class="sec-list">
        <li v-for="sub in unlinkedPush" :key="sub.id" class="sec-list-item">
          <div class="sec-device-icon"><Icon :name="iconForKind(describeUserAgent(sub.user_agent).kind)" :size="20" /></div>
          <div class="sec-device-body">
            <div class="sec-row-title">
              {{ sub.device_name || describeUserAgent(sub.user_agent).label || 'Unknown device' }}
              <span class="sec-pill">{{ transportLabel(sub.transport) }}</span>
            </div>
            <div class="sec-muted">Added {{ absoluteDate(sub.created_at) }}<template v-if="sub.failure_count >= 5"> · Not reachable</template></div>
          </div>
          <button class="sec-btn sec-btn-secondary sec-btn-sm" :disabled="removingPush === sub.id" @click="removePush(sub)">
            Remove
          </button>
        </li>
      </ul>
    </div>
  </section>
</template>

<script setup lang="ts">
import './securitySettings.css'
import { computed, onMounted, ref } from 'vue'
import { useToast } from 'vue-toastification'
import Icon from '@/components/common/Icon.vue'
import { supabase } from '@/supabase'
import { debug } from '@/utils/debug'
import { describeUserAgent, type DeviceKind } from '@/utils/userAgent'
import { formatShortRelativeTime } from '@/utils/shortRelativeTime'
import { useConfirmDialog } from '@/composables/useConfirmDialog'
import { usePushNotifications, type PushSubscriptionInfo } from '@/composables/usePushNotifications'
import {
  accountSecurityService,
  securityErrorMessage,
  type AccountSession,
} from '@/services/AccountSecurityService'

const toast = useToast()
const push = usePushNotifications()
const { confirm } = useConfirmDialog()

const sessions = ref<AccountSession[]>([])
const loading = ref(false)
const error = ref('')
const revoking = ref<string | null>(null)
const revokingAll = ref(false)
const removingPush = ref<string | null>(null)
const mfaEnabled = ref(false)

const otherCount = computed(() => sessions.value.filter((s) => !s.is_current).length)

const unlinkedPush = computed(() => {
  const live = new Set(sessions.value.map((s) => s.id))
  return push.subscriptions.value.filter((sub) => {
    return !sub.session_id || !live.has(sub.session_id)
  })
})

function iconForKind(kind: DeviceKind): string {
  if (kind === 'phone') return 'smartphone'
  if (kind === 'tablet') return 'tablet'
  if (kind === 'desktop') return 'monitor'
  return 'devices'
}

function deviceIcon(session: AccountSession): string {
  return iconForKind(describeUserAgent(session.user_agent).kind)
}

function deviceLabel(session: AccountSession): string {
  return describeUserAgent(session.user_agent).label ?? 'Unknown device'
}

function transportLabel(transport?: string): string {
  if (transport === 'fcm') return 'Google (FCM)'
  if (transport === 'unifiedpush') return 'UnifiedPush'
  return 'Web Push'
}

function pushTitle(session: AccountSession): string {
  return `Push notifications: ${session.push_transports.map(transportLabel).join(', ')}`
}

function relative(iso: string | null): string {
  if (!iso) return 'unknown'
  const short = formatShortRelativeTime(iso)
  return short === 'now' || !/^\d/.test(short) ? short : `${short} ago`
}

function absolute(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : ''
}

function absoluteDate(iso: string | null): string {
  return iso ? new Date(iso).toLocaleDateString() : 'unknown'
}

async function load() {
  loading.value = true
  error.value = ''
  try {
    const [list, factors] = await Promise.all([
      accountSecurityService.listSessions(),
      supabase.auth.mfa.listFactors(),
      push.fetchSubscriptions().catch(() => {}),
    ])
    sessions.value = list
    mfaEnabled.value = !!factors.data?.totp?.some((f) => f.status === 'verified')
  } catch (err) {
    debug.error('Loading sessions failed:', err)
    error.value = securityErrorMessage(err, 'Could not load your devices.')
  } finally {
    loading.value = false
  }
}

async function revoke(session: AccountSession) {
  const ok = await confirm({
    title: 'Sign out this device?',
    message: `${deviceLabel(session)}${session.ip ? ` (${session.ip})` : ''} will need to sign in again. Its push notifications stop.`,
    confirmButtonText: 'Sign out',
    dangerAction: true,
  })
  if (!ok) return
  revoking.value = session.id
  try {
    await accountSecurityService.revokeSession(session.id)
    toast.success('Device signed out')
    await load()
  } catch (err) {
    toast.error(securityErrorMessage(err, 'Could not sign that device out.'))
  } finally {
    revoking.value = null
  }
}

async function revokeOthers() {
  const ok = await confirm({
    title: 'Sign out all other devices?',
    message: 'Every device except this one will need to sign in again.',
    confirmButtonText: 'Sign out all',
    dangerAction: true,
  })
  if (!ok) return
  revokingAll.value = true
  try {
    await accountSecurityService.signOutOtherSessions()
    toast.success('Signed out of all other devices')
    await load()
  } catch (err) {
    toast.error(securityErrorMessage(err, 'Could not sign out the other devices.'))
  } finally {
    revokingAll.value = false
  }
}

async function removePush(sub: PushSubscriptionInfo) {
  removingPush.value = sub.id
  try {
    const result = await push.removeSubscription(sub)
    if (!result.success) throw new Error(result.error || 'Could not remove that push target.')
    toast.success('Push notifications removed for that device')
  } catch (err) {
    toast.error(securityErrorMessage(err, 'Could not remove that push target.'))
  } finally {
    removingPush.value = null
  }
}

defineExpose({ load })

onMounted(load)
</script>
