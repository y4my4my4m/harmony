<template>
  <div class="ii" data-testid="instance-invites">
    <section class="ii-card" :aria-labelledby="`${uid}-title`">
      <h3 :id="`${uid}-title`" class="ii-title">{{ t('adminInvites.title') }}</h3>
      <p class="ii-hint">{{ t('adminInvites.intro') }}</p>
      <p v-if="overview" class="ii-mode" data-testid="invites-registration">
        <strong>{{ registrationLabel }}</strong>
        <span>{{ registrationExplanation }}</span>
      </p>
      <p v-if="overview && advertisedMismatch" class="ii-hint">{{ advertisedMismatch }}</p>
      <p class="ii-hint">{{ t('adminInvites.everyMode') }}</p>

      <form class="ii-form" novalidate @submit.prevent="create">
        <label class="ii-label" :for="`${uid}-email`">{{ t('adminInvites.email') }}</label>
        <input
          :id="`${uid}-email`"
          ref="emailInput"
          v-model="email"
          type="email"
          class="ii-input"
          autocomplete="off"
          autocapitalize="off"
          spellcheck="false"
          required
          :aria-invalid="formError ? 'true' : undefined"
          :aria-describedby="formError ? `${uid}-error` : `${uid}-email-hint`"
          data-testid="invite-email"
          @input="formError = ''"
        />
        <span :id="`${uid}-email-hint`" class="ii-hint">{{ t('adminInvites.emailHint') }}</span>
        <label class="ii-check">
          <input
            v-model="send"
            type="checkbox"
            :disabled="!emailAvailable"
            :aria-describedby="`${uid}-send-hint`"
            data-testid="invite-send"
          />
          <span>{{ t('adminInvites.send') }}</span>
        </label>
        <span :id="`${uid}-send-hint`" class="ii-hint" data-testid="invite-send-hint">
          {{ emailAvailable ? t('adminInvites.sendHint') : t('adminInvites.sendUnavailable') }}
        </span>
        <p :id="`${uid}-error`" class="ii-error" role="alert" data-testid="invite-error">{{ formError }}</p>
        <div class="ii-actions">
          <button type="submit" class="ii-btn ii-btn-primary" :disabled="busy" data-testid="invite-create">
            {{ t('adminInvites.create') }}
          </button>
        </div>
      </form>

      <div v-if="issued" class="ii-result" data-testid="invite-result">
        <p class="ii-result-line">{{ issuedLine }}</p>
        <div v-if="issued.link" class="ii-link-row">
          <input
            :id="`${uid}-link`"
            class="ii-input ii-link"
            type="text"
            readonly
            :value="issued.link"
            :aria-label="t('adminInvites.linkFor', { email: issued.invite.email })"
            data-testid="invite-link"
            @focus="($event.target as HTMLInputElement).select()"
          />
          <button type="button" class="ii-btn" data-testid="invite-copy" @click="copy(issued.link)">
            {{ t('adminInvites.copy') }}
          </button>
        </div>
        <p v-if="issued.link" class="ii-hint">{{ t('adminInvites.singleUse') }}</p>
      </div>
    </section>

    <section class="ii-card" :aria-labelledby="`${uid}-pending`">
      <div class="ii-head">
        <h3 :id="`${uid}-pending`" class="ii-title">{{ t('adminInvites.pendingTitle', { count: pending.length }) }}</h3>
        <button type="button" class="ii-btn" :disabled="loading" @click="load">{{ t('adminInvites.refresh') }}</button>
      </div>
      <p v-if="overview" class="ii-hint">{{ t('adminInvites.lifetime', { hours: lifetimeHours }, lifetimeHours) }}</p>
      <p v-if="loading && !overview" class="ii-hint">{{ t('adminInvites.loading') }}</p>
      <p v-else-if="loadError" class="ii-error" role="alert">{{ loadError }}</p>
      <p v-else-if="pending.length === 0" class="ii-hint" data-testid="invites-pending-empty">{{ t('adminInvites.pendingEmpty') }}</p>
      <ul v-else class="ii-list" data-testid="invites-pending">
        <li v-for="invite in pending" :key="invite.auth_user_id" class="ii-item" :data-testid="`invite-${invite.email}`">
          <p :id="`${uid}-row-${invite.auth_user_id}`" class="ii-email">{{ invite.email }}</p>
          <dl class="ii-meta">
            <div>
              <dt>{{ t('adminInvites.invitedBy') }}</dt>
              <dd>{{ inviter(invite) }}</dd>
            </div>
            <div>
              <dt>{{ t('adminInvites.invitedAt') }}</dt>
              <dd>{{ when(invite.created_at) }}</dd>
            </div>
            <div>
              <dt>{{ t('adminInvites.delivery') }}</dt>
              <dd>{{ deliveryLabel(invite) }}</dd>
            </div>
            <div>
              <dt>{{ t('adminInvites.expiry') }}</dt>
              <dd :class="{ 'ii-warning': invite.expired }" data-testid="invite-expiry">{{ expiryLabel(invite) }}</dd>
            </div>
          </dl>
          <div class="ii-actions">
            <button
              type="button"
              class="ii-btn"
              :disabled="busy"
              :aria-label="t('adminInvites.reissueFor', { email: invite.email })"
              data-testid="invite-reissue"
              @click="reissue(invite)"
            >
              {{ t('adminInvites.reissue') }}
            </button>
            <button
              type="button"
              class="ii-btn ii-btn-danger"
              :disabled="busy"
              :aria-label="t('adminInvites.revokeFor', { email: invite.email })"
              data-testid="invite-revoke"
              @click="revoke(invite)"
            >
              {{ t('adminInvites.revoke') }}
            </button>
          </div>
        </li>
      </ul>
    </section>

    <section v-if="closed.length > 0" class="ii-card" :aria-labelledby="`${uid}-closed`">
      <h3 :id="`${uid}-closed`" class="ii-title">{{ t('adminInvites.closedTitle') }}</h3>
      <ul class="ii-list" data-testid="invites-closed">
        <li v-for="invite in closed" :key="invite.id ?? invite.auth_user_id" class="ii-item" :data-testid="`invite-closed-${invite.email}`">
          <p class="ii-email">{{ invite.email }}</p>
          <p class="ii-hint" data-testid="invite-outcome">{{ outcome(invite) }}</p>
          <p class="ii-hint">{{ t('adminInvites.invitedLine', { who: inviter(invite), when: when(invite.created_at) }) }}</p>
        </li>
      </ul>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import { useToast } from 'vue-toastification'
import { useConfirmDialog } from '@/composables/useConfirmDialog'
import { useAnnouncer } from '@/composables/useAnnouncer'
import {
  instanceInvites,
  InviteError,
  type InstanceInvite,
  type InviteOverview,
  type IssuedInvite,
} from '@/services/InstanceInviteService'
import { debug } from '@/utils/debug'

const { t, locale } = useI18n()
const toast = useToast()
const { confirm } = useConfirmDialog()
const { polite } = useAnnouncer()
const uid = `instance-invites-${useId()}`

const overview = ref<InviteOverview | null>(null)
const loading = ref(false)
const loadError = ref('')
const email = ref('')
const send = ref(false)
const formError = ref('')
const busy = ref(false)
const issued = ref<IssuedInvite | null>(null)
const issuedKind = ref<'created' | 'reissued'>('created')
const emailInput = ref<HTMLInputElement | null>(null)

const emailAvailable = computed(() => overview.value?.email_available === true)
const pending = computed(() => (overview.value?.invites ?? []).filter((i) => i.status === 'pending'))
const closed = computed(() => (overview.value?.invites ?? []).filter((i) => i.status !== 'pending'))
const lifetimeHours = computed(() => Math.round((overview.value?.link_lifetime_seconds ?? 86400) / 3600))

const registrationLabel = computed(() => {
  const signup = overview.value?.registration.signup
  if (signup === 'open') return t('adminInvites.modeOpen')
  if (signup === 'closed') return t('adminInvites.modeClosed')
  return t('adminInvites.modeUnknown')
})

const registrationExplanation = computed(() => {
  const signup = overview.value?.registration.signup
  if (signup === 'open') return t('adminInvites.modeOpenHint')
  if (signup === 'closed') return t('adminInvites.modeClosedHint')
  return t('adminInvites.modeUnknownHint')
})

// NodeInfo announces instance_config.open_registration; GoTrue decides.
const advertisedMismatch = computed(() => {
  const r = overview.value?.registration
  if (!r || r.signup === 'unknown' || r.advertised_open === (r.signup === 'open')) return ''
  return r.advertised_open ? t('adminInvites.advertisedOpen') : t('adminInvites.advertisedClosed')
})

const dateFormat = computed(() => new Intl.DateTimeFormat(locale.value, { dateStyle: 'medium', timeStyle: 'short' }))
const when = (iso: string | null) => (iso ? dateFormat.value.format(new Date(iso)) : '—')

function inviter(invite: InstanceInvite): string {
  if (invite.invited_by_username) return `@${invite.invited_by_username}`
  if (invite.source === 'cli') return t('adminInvites.byCli')
  if (invite.source === 'admin') return t('adminInvites.byFormerAdmin')
  return t('adminInvites.byUnknown')
}

function deliveryLabel(invite: InstanceInvite): string {
  const how = invite.delivery === 'email' ? t('adminInvites.byEmail') : invite.delivery === 'link' ? t('adminInvites.byLink') : t('adminInvites.byUnknownDelivery')
  return invite.links_issued > 1 ? t('adminInvites.linksIssued', { how, count: invite.links_issued }) : how
}

function expiryLabel(invite: InstanceInvite): string {
  if (!invite.expires_at) return '—'
  return invite.expired
    ? t('adminInvites.expired', { when: when(invite.expires_at) })
    : t('adminInvites.expires', { when: when(invite.expires_at) })
}

function outcome(invite: InstanceInvite): string {
  if (invite.status === 'accepted') {
    return invite.account_username
      ? t('adminInvites.acceptedAs', { handle: `@${invite.account_username}`, when: when(invite.accepted_at) })
      : t('adminInvites.accepted', { when: when(invite.accepted_at) })
  }
  if (invite.status === 'revoked') {
    return invite.revoked_by_username
      ? t('adminInvites.revokedBy', { handle: `@${invite.revoked_by_username}`, when: when(invite.revoked_at) })
      : t('adminInvites.revoked', { when: when(invite.revoked_at) })
  }
  return t('adminInvites.removed')
}

const issuedLine = computed(() => {
  const i = issued.value
  if (!i) return ''
  const expiry = i.expires_at ? when(i.expires_at) : '—'
  if (!i.link) return t('adminInvites.emailed', { email: i.invite.email, when: expiry })
  return issuedKind.value === 'reissued'
    ? t('adminInvites.reissued', { email: i.invite.email, when: expiry })
    : t('adminInvites.created', { email: i.invite.email, when: expiry })
})

function message(error: unknown): string {
  const code = error instanceof InviteError ? error.code : 'unknown'
  const known: Record<string, string> = {
    invalid_email: 'adminInvites.errors.invalidEmail',
    account_exists: 'adminInvites.errors.accountExists',
    invite_pending: 'adminInvites.errors.invitePending',
    email_unavailable: 'adminInvites.errors.emailUnavailable',
    auth_rate_limited: 'adminInvites.errors.authRateLimited',
    rate_limited: 'adminInvites.errors.rateLimited',
    invite_accepted: 'adminInvites.errors.inviteAccepted',
    invite_not_found: 'adminInvites.errors.inviteGone',
    not_an_invite: 'adminInvites.errors.inviteGone',
    admin_required: 'adminInvites.errors.adminRequired',
  }
  if (code === 'auth_failed' && error instanceof InviteError) {
    return t('adminInvites.errors.authFailed', { detail: error.detail || code })
  }
  return t(known[code] ?? 'adminInvites.errors.unavailable')
}

async function load() {
  loading.value = true
  loadError.value = ''
  try {
    overview.value = await instanceInvites.overview()
    if (!overview.value.email_available) send.value = false
  } catch (error) {
    debug.error('Failed to load invitations:', error)
    loadError.value = message(error)
  } finally {
    loading.value = false
  }
}

async function copy(link: string) {
  try {
    await navigator.clipboard.writeText(link)
    toast.success(t('adminInvites.copied'))
  } catch (error) {
    debug.error('Failed to copy the invitation link:', error)
    toast.error(t('adminInvites.copyFailed'))
  }
}

async function create() {
  if (busy.value) return
  const address = email.value.trim()
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(address)) {
    formError.value = t('adminInvites.errors.invalidEmail')
    emailInput.value?.focus()
    return
  }
  busy.value = true
  formError.value = ''
  try {
    issued.value = await instanceInvites.create(address, send.value && emailAvailable.value)
    issuedKind.value = 'created'
    email.value = ''
    polite(issuedLine.value)
    await load()
  } catch (error) {
    debug.error('Failed to create an invitation:', error)
    formError.value = message(error)
    emailInput.value?.focus()
  } finally {
    busy.value = false
  }
}

async function reissue(invite: InstanceInvite) {
  if (busy.value) return
  busy.value = true
  try {
    issued.value = await instanceInvites.reissue(invite.auth_user_id)
    issuedKind.value = 'reissued'
    polite(issuedLine.value)
    if (issued.value.link) await copy(issued.value.link)
    await load()
  } catch (error) {
    debug.error('Failed to re-issue an invitation link:', error)
    toast.error(message(error))
    await load()
  } finally {
    busy.value = false
  }
}

async function revoke(invite: InstanceInvite) {
  const ok = await confirm({
    title: t('adminInvites.revokeTitle'),
    message: t('adminInvites.revokeMessage', { email: invite.email }),
    confirmButtonText: t('adminInvites.revoke'),
    dangerAction: true,
  })
  if (!ok) return
  busy.value = true
  try {
    await instanceInvites.revoke(invite.auth_user_id)
    if (issued.value?.invite.auth_user_id === invite.auth_user_id) issued.value = null
    toast.success(t('adminInvites.revokedToast', { email: invite.email }))
    await load()
  } catch (error) {
    debug.error('Failed to revoke an invitation:', error)
    toast.error(message(error))
    await load()
  } finally {
    busy.value = false
  }
}

onMounted(load)
</script>

<style scoped>
.ii {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
  min-width: 0;
}

.ii-card {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-4);
  background: var(--background-secondary);
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-md);
  min-width: 0;
}

.ii-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  flex-wrap: wrap;
  gap: var(--space-3);
}

.ii-title {
  margin: 0;
  font-size: var(--font-size-md, 1rem);
  font-weight: 600;
  color: var(--text-primary);
}

.ii-hint {
  margin: 0;
  font-size: var(--font-size-xs);
  color: var(--text-muted);
  line-height: 1.4;
}

.ii-mode {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-1) var(--space-2);
  margin: 0;
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
}

.ii-mode strong {
  color: var(--text-primary);
}

.ii-form {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  max-width: 480px;
}

.ii-label {
  font-size: var(--font-size-xs);
  font-weight: 600;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.02em;
}

.ii-input {
  width: 100%;
  min-width: 0;
  background: var(--background-quinary);
  border: 1px solid var(--background-quinary);
  border-radius: 4px;
  padding: 8px 10px;
  color: var(--text-primary);
  font-size: var(--font-size-sm);
  font-family: inherit;
}

.ii-input:focus {
  outline: none;
  border-color: var(--harmony-primary);
}

.ii-input[aria-invalid='true'] {
  border-color: var(--danger);
}

.ii-check {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--font-size-sm);
  color: var(--text-primary);
}

.ii-check:has(input:disabled) {
  color: var(--text-muted);
}

.ii-error {
  margin: 0;
  min-height: 1em;
  font-size: var(--font-size-xs);
  color: var(--danger);
}

.ii-error:empty {
  display: none;
}

.ii-actions {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
}

.ii-btn {
  padding: 6px 12px;
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-base);
  background: var(--background-tertiary);
  color: var(--text-primary);
  font-size: var(--font-size-sm);
  cursor: pointer;
  white-space: nowrap;
}

.ii-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.ii-btn-primary {
  background: var(--harmony-primary);
  border-color: var(--harmony-primary);
  color: var(--text-on-primary, #fff);
}

.ii-btn-danger {
  color: var(--danger);
}

.ii-result {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-3);
  border: 1px solid var(--harmony-primary);
  border-radius: var(--radius-md);
  background: var(--background-tertiary);
}

.ii-result-line {
  margin: 0;
  font-size: var(--font-size-sm);
  color: var(--text-primary);
  overflow-wrap: anywhere;
}

.ii-link-row {
  display: flex;
  gap: var(--space-2);
  min-width: 0;
}

.ii-link {
  flex: 1 1 auto;
  font-family: var(--font-mono, monospace);
  font-size: var(--font-size-xs);
}

.ii-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin: 0;
  padding: 0;
  list-style: none;
}

.ii-item {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-3);
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-md);
  min-width: 0;
}

.ii-email {
  margin: 0;
  font-weight: 600;
  color: var(--text-primary);
  overflow-wrap: anywhere;
}

.ii-meta {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: var(--space-2) var(--space-3);
  margin: 0;
}

.ii-meta dt {
  font-size: var(--font-size-xs);
  font-weight: 600;
  color: var(--text-muted);
}

.ii-meta dd {
  margin: 0;
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
  overflow-wrap: anywhere;
}

.ii-warning {
  color: var(--warning);
}
</style>
