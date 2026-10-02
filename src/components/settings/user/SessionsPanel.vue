<template>
  <section class="sec-card" aria-labelledby="sessions-title">
    <header class="sec-card-header">
      <div>
        <h3 id="sessions-title" class="sec-card-title">{{ $t('security.sessions.title') }}</h3>
        <p class="sec-card-description">{{ $t('security.sessions.description') }}</p>
      </div>
      <button class="sec-icon-btn" :title="$t('security.sessions.refresh')" :disabled="loading" @click="load">
        <Icon name="refresh-cw" :size="16" />
      </button>
    </header>

    <p v-if="error" class="sec-error" role="alert">{{ error }}</p>
    <div v-else-if="loading && sessions.length === 0" class="sec-muted">{{ $t('security.sessions.loading') }}</div>

    <ul v-else class="sec-list">
      <li v-for="session in sessions" :key="session.id" class="sec-list-item">
        <div class="sec-device-icon" :class="{ current: session.is_current }">
          <Icon :name="deviceIcon(session)" :size="20" />
        </div>
        <div class="sec-device-body">
          <div class="sec-row-title">
            {{ deviceLabel(session) }}
            <span v-if="session.is_current" class="sec-pill sec-pill-current">{{ $t('security.sessions.thisDevice') }}</span>
            <span v-if="session.push_transports.length" class="sec-pill" :title="pushTitle(session)">{{ $t('security.sessions.push') }}</span>
          </div>
          <div class="sec-muted">
            <span v-if="session.ip">{{ session.ip }} · </span>
            <span :title="absolute(session.last_active_at || session.created_at)">
              {{ $t('security.sessions.active', { time: relative(session.last_active_at || session.created_at) }) }}
            </span>
            <span> · {{ $t('security.sessions.signedIn', { date: absoluteDate(session.created_at) }) }}</span>
            <span v-if="session.aal === 'aal1' && mfaEnabled" class="sec-warn"> · {{ $t('security.sessions.mfaIncomplete') }}</span>
          </div>
        </div>
        <button
          v-if="!session.is_current"
          class="sec-btn sec-btn-secondary sec-btn-sm"
          :disabled="revoking === session.id"
          @click="revoke(session)"
        >
          {{ revoking === session.id ? $t('security.sessions.signingOut') : $t('security.sessions.signOut') }}
        </button>
      </li>
    </ul>

    <div v-if="otherCount > 0" class="sec-actions sec-actions-start">
      <button class="sec-btn sec-btn-danger" :disabled="revokingAll" @click="revokeOthers">
        {{ revokingAll ? $t('security.sessions.signingOut') : $t('security.sessions.signOutOthers', { count: otherCount }) }}
      </button>
    </div>

    <div v-if="unlinkedPush.length" class="sec-subsection">
      <div class="sec-row-title">{{ $t('security.sessions.otherPush.title') }}</div>
      <p class="sec-muted">{{ $t('security.sessions.otherPush.description') }}</p>
      <ul class="sec-list">
        <li v-for="sub in unlinkedPush" :key="sub.id" class="sec-list-item">
          <div class="sec-device-icon"><Icon :name="iconForKind(describeUserAgent(sub.user_agent).kind)" :size="20" /></div>
          <div class="sec-device-body">
            <div class="sec-row-title">
              {{ sub.device_name || describeUserAgent(sub.user_agent).label || $t('security.sessions.unknownDevice') }}
              <span class="sec-pill">{{ transportLabel(sub.transport) }}</span>
            </div>
            <div class="sec-muted">{{ $t('security.sessions.otherPush.added', { date: absoluteDate(sub.created_at) }) }}<template v-if="sub.failure_count >= 5"> · {{ $t('security.sessions.otherPush.unreachable') }}</template></div>
          </div>
          <button class="sec-btn sec-btn-secondary sec-btn-sm" :disabled="removingPush === sub.id" @click="removePush(sub)">
            {{ $t('common.remove') }}
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
import { useI18n } from 'vue-i18n'
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
const { t, locale } = useI18n()
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
  return describeUserAgent(session.user_agent).label ?? t('security.sessions.unknownDevice')
}

function transportLabel(transport?: string): string {
  if (transport === 'fcm') return 'Google (FCM)'
  if (transport === 'unifiedpush') return 'UnifiedPush'
  return t('security.sessions.webPush')
}

function pushTitle(session: AccountSession): string {
  return t('security.sessions.pushTitle', { transports: session.push_transports.map(transportLabel).join(', ') })
}

function relative(iso: string | null): string {
  if (!iso) return t('security.sessions.unknown')
  const nowLabel = t('time.now')
  const short = formatShortRelativeTime(iso, { locale: locale.value, nowLabel })
  return short === nowLabel || !/^\d/.test(short) ? short : t('security.sessions.ago', { time: short })
}

function absolute(iso: string | null): string {
  return iso ? new Date(iso).toLocaleString() : ''
}

function absoluteDate(iso: string | null): string {
  return iso ? new Date(iso).toLocaleDateString() : t('security.sessions.unknown')
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
    error.value = securityErrorMessage(err, t('security.sessions.errors.loadFailed'))
  } finally {
    loading.value = false
  }
}

async function revoke(session: AccountSession) {
  const ok = await confirm({
    title: t('security.sessions.revokeConfirm.title'),
    message: t('security.sessions.revokeConfirm.message', {
      device: session.ip ? `${deviceLabel(session)} (${session.ip})` : deviceLabel(session),
    }),
    confirmButtonText: t('security.sessions.signOut'),
    dangerAction: true,
  })
  if (!ok) return
  revoking.value = session.id
  try {
    await accountSecurityService.revokeSession(session.id)
    toast.success(t('security.sessions.revoked'))
    await load()
  } catch (err) {
    toast.error(securityErrorMessage(err, t('security.sessions.errors.revokeFailed')))
  } finally {
    revoking.value = null
  }
}

async function revokeOthers() {
  const ok = await confirm({
    title: t('security.sessions.revokeOthersConfirm.title'),
    message: t('security.sessions.revokeOthersConfirm.message'),
    confirmButtonText: t('security.sessions.revokeOthersConfirm.confirm'),
    dangerAction: true,
  })
  if (!ok) return
  revokingAll.value = true
  try {
    await accountSecurityService.signOutOtherSessions()
    toast.success(t('security.sessions.revokedOthers'))
    await load()
  } catch (err) {
    toast.error(securityErrorMessage(err, t('security.sessions.errors.revokeOthersFailed')))
  } finally {
    revokingAll.value = false
  }
}

async function removePush(sub: PushSubscriptionInfo) {
  removingPush.value = sub.id
  try {
    const result = await push.removeSubscription(sub)
    if (!result.success) throw new Error(result.error || t('security.sessions.errors.removePushFailed'))
    toast.success(t('security.sessions.pushRemoved'))
  } catch (err) {
    toast.error(securityErrorMessage(err, t('security.sessions.errors.removePushFailed')))
  } finally {
    removingPush.value = null
  }
}

defineExpose({ load })

onMounted(load)
</script>
