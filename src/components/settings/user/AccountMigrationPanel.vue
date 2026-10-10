<template>
  <div class="settings-section account-migration" data-testid="account-migration">
    <h3 class="am-title">{{ t('accountMigration.title') }}</h3>
    <p class="am-description">{{ t('accountMigration.description') }}</p>

    <p v-if="loading" class="sec-muted">{{ t('common.loading') }}</p>

    <template v-else-if="state">
      <div v-if="state.movedTo" class="sec-callout am-moved" data-testid="am-moved">
        <div class="am-moved-body">
          <strong>{{ t('accountMigration.moved.title') }}</strong>
          <p class="sec-text">{{ t('accountMigration.moved.description', { handle: state.movedTo.handle, date: movedDate }) }}</p>
          <p class="sec-muted">{{ t('accountMigration.moved.cancelHint') }}</p>
        </div>
        <button
          type="button"
          class="sec-btn sec-btn-secondary"
          data-testid="am-cancel"
          :disabled="cancelling"
          @click="cancelRedirect"
        >
          {{ cancelling ? t('accountMigration.moved.cancelling') : t('accountMigration.moved.cancel') }}
        </button>
      </div>

      <section class="am-block" aria-labelledby="am-aliases-title">
        <h4 id="am-aliases-title" class="am-label">{{ t('accountMigration.aliases.title') }}</h4>
        <p class="am-hint">{{ t('accountMigration.aliases.description') }}</p>

        <ul v-if="state.aliases.length" class="am-list" data-testid="am-aliases">
          <li v-for="alias in state.aliases" :key="alias.uri ?? alias.handle" class="am-list-item">
            <Avatar :src="alias.avatarUrl || undefined" size="xs" />
            <div class="am-account">
              <span class="am-account-name">{{ alias.displayName || alias.handle }}</span>
              <span class="sec-muted">{{ alias.handle }}</span>
            </div>
            <button
              type="button"
              class="sec-btn sec-btn-secondary sec-btn-sm"
              :disabled="removingAlias === alias.uri"
              @click="removeAlias(alias)"
            >
              {{ t('accountMigration.aliases.remove') }}
            </button>
          </li>
        </ul>
        <p v-else class="sec-muted">{{ t('accountMigration.aliases.empty') }}</p>

        <form class="am-row" @submit.prevent="addAlias">
          <input
            v-model="aliasHandle"
            class="sec-input"
            type="text"
            autocomplete="off"
            spellcheck="false"
            :aria-label="t('accountMigration.aliases.title')"
            :placeholder="t('accountMigration.aliases.placeholder')"
            data-testid="am-alias-input"
          />
          <button type="submit" class="sec-btn sec-btn-secondary" :disabled="!aliasHandle.trim() || addingAlias">
            {{ addingAlias ? t('accountMigration.aliases.adding') : t('accountMigration.aliases.add') }}
          </button>
        </form>
        <p v-if="aliasError" class="sec-error" role="alert">{{ aliasError }}</p>
        <p class="sec-muted">{{ t('accountMigration.aliases.yourHandle', { handle: state.handle }) }}</p>
      </section>

      <section v-if="!state.movedTo" class="am-block" aria-labelledby="am-move-title" data-testid="am-move">
        <h4 id="am-move-title" class="am-label">{{ t('accountMigration.move.title') }}</h4>
        <p class="am-hint">{{ t('accountMigration.move.description') }}</p>

        <form class="am-row" @submit.prevent="checkTarget">
          <input
            v-model="targetHandle"
            class="sec-input"
            type="text"
            autocomplete="off"
            spellcheck="false"
            :aria-label="t('accountMigration.move.title')"
            :placeholder="t('accountMigration.move.placeholder')"
            data-testid="am-target-input"
            @input="preview = null; targetError = ''"
          />
          <button type="submit" class="sec-btn sec-btn-secondary" :disabled="!targetHandle.trim() || checking" data-testid="am-check">
            {{ checking ? t('accountMigration.move.checking') : t('accountMigration.move.check') }}
          </button>
        </form>
        <p v-if="targetError" class="sec-error" role="alert">{{ targetError }}</p>

        <div v-if="preview" class="am-preview" data-testid="am-preview">
          <div class="am-account-row">
            <Avatar :src="preview.target.avatar_url || undefined" size="sm" />
            <div class="am-account">
              <span class="am-account-name">{{ preview.target.display_name || targetLabel }}</span>
              <span class="sec-muted">{{ targetLabel }}</span>
            </div>
          </div>
          <p v-if="preview.isSelf" class="sec-error">{{ t('accountMigration.move.isSelf') }}</p>
          <p v-else-if="preview.targetMoved" class="sec-error">{{ t('accountMigration.move.targetMoved', { handle: targetLabel }) }}</p>
          <p v-else-if="preview.aliasConfirmed" class="am-ok" data-testid="am-alias-ok">
            <Icon name="check-circle" :size="14" />
            {{ t('accountMigration.move.aliasConfirmed', { handle: targetLabel }) }}
          </p>
          <div v-else class="sec-callout am-stack" data-testid="am-alias-missing">
            <span>{{ t('accountMigration.move.aliasMissing', { handle: targetLabel }) }}</span>
            <code class="am-code">{{ state.handle }}</code>
          </div>
          <p v-if="preview.target.locked && canMove" class="sec-callout am-warn">
            {{ t('accountMigration.move.lockedWarning', { handle: targetLabel }) }}
          </p>
        </div>

        <div class="am-columns">
          <div>
            <h5 class="am-subheading">{{ t('accountMigration.move.whatMoves') }}</h5>
            <ul class="sec-bullets">
              <li>{{ t('accountMigration.move.movesFollowers') }}</li>
              <li>{{ t('accountMigration.move.movesServers') }}</li>
            </ul>
          </div>
          <div>
            <h5 class="am-subheading">{{ t('accountMigration.move.whatStays') }}</h5>
            <ul class="sec-bullets">
              <li>{{ t('accountMigration.move.staysPosts') }}</li>
              <li>{{ t('accountMigration.move.staysKeys') }}</li>
              <li>{{ t('accountMigration.move.staysBots') }}</li>
              <li>{{ t('accountMigration.move.staysServers') }}</li>
              <li>{{ t('accountMigration.move.staysFollowing') }}</li>
            </ul>
          </div>
        </div>

        <div v-if="state.ownedServers.length" class="sec-callout sec-callout-danger" data-testid="am-owned">
          {{ t('accountMigration.move.ownedServersWarning', { servers: state.ownedServers.join(', ') }, state.ownedServers.length) }}
        </div>
        <p class="sec-muted">{{ t('accountMigration.move.cooldown') }}</p>

        <div class="sec-actions sec-actions-start">
          <button type="button" class="sec-link" @click="goToExport">{{ t('accountMigration.move.exportFirst') }}</button>
          <button
            type="button"
            class="sec-btn sec-btn-danger"
            data-testid="am-start"
            :disabled="!canMove"
            @click="openMoveModal"
          >
            {{ t('accountMigration.move.start') }}
          </button>
        </div>
      </section>
    </template>

    <p v-else class="sec-error">{{ t('accountMigration.errors.generic') }}</p>

    <Teleport to="body">
      <div v-if="showMoveModal" class="sec-modal-overlay" @click.self="closeMoveModal">
        <form
          class="sec-modal"
          role="dialog"
          aria-modal="true"
          aria-labelledby="am-confirm-title"
          data-testid="am-confirm"
          @submit.prevent="confirmMove"
        >
          <h3 id="am-confirm-title" class="sec-modal-title danger">
            {{ t('accountMigration.move.confirmTitle', { handle: targetLabel }) }}
          </h3>
          <p class="sec-text">{{ t('accountMigration.move.confirmText') }}</p>

          <div v-if="hasPassword" class="sec-field">
            <label class="sec-label" for="am-password">{{ t('accountMigration.move.password') }}</label>
            <input
              id="am-password"
              v-model="password"
              class="sec-input"
              type="password"
              autocomplete="current-password"
            />
          </div>
          <div v-else class="sec-callout">
            <span>{{ t('accountMigration.move.noPassword') }}</span>
          </div>

          <div v-if="mfaRequired" class="sec-field">
            <label class="sec-label" for="am-mfa">{{ t('accountMigration.move.code') }}</label>
            <input
              id="am-mfa"
              v-model="mfaCode"
              class="sec-input sec-code-input"
              inputmode="numeric"
              maxlength="6"
              autocomplete="one-time-code"
              placeholder="000000"
              @input="mfaCode = mfaCode.replace(/\D/g, '')"
            />
          </div>

          <p v-if="moveError" class="sec-error" role="alert">{{ moveError }}</p>

          <div class="sec-actions">
            <button type="button" class="sec-btn sec-btn-secondary" :disabled="moving" @click="closeMoveModal">
              {{ t('common.cancel') }}
            </button>
            <button type="submit" class="sec-btn sec-btn-danger" :disabled="!canConfirm || moving">
              {{ moving ? t('accountMigration.move.moving') : t('accountMigration.move.confirm') }}
            </button>
          </div>
        </form>
      </div>
    </Teleport>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { useToast } from 'vue-toastification'
import Icon from '@/components/common/Icon.vue'
import Avatar from '@/components/common/Avatar.vue'
import { useAuthStore } from '@/stores/auth'
import {
  accountMigrationService,
  type MigrationFailure,
  type MigrationState,
  type MovePreview,
} from '@/services/AccountMigrationService'
import type { AccountRef } from '@/utils/movedAccount'
import './securitySettings.css'

const { t } = useI18n()
const toast = useToast()
const router = useRouter()
const authStore = useAuthStore()

const KNOWN_ERRORS = new Set([
  'invalid_handle', 'account_not_found', 'alias_is_self', 'too_many_aliases', 'unknown_account',
  'invalid_alias', 'already_moved', 'target_is_self', 'target_not_found', 'target_suspended',
  'target_moved', 'alias_missing', 'account_suspended', 'mfa_required', 'reauthentication_required',
  'insufficient_aal', 'not_moved',
])

const loading = ref(true)
const state = ref<MigrationState | null>(null)

const aliasHandle = ref('')
const addingAlias = ref(false)
const removingAlias = ref<string | null>(null)
const aliasError = ref('')

const targetHandle = ref('')
const checking = ref(false)
const targetError = ref('')
const preview = ref<MovePreview | null>(null)

const showMoveModal = ref(false)
const password = ref('')
const mfaCode = ref('')
const mfaRequired = ref(false)
const moving = ref(false)
const moveError = ref('')
const cancelling = ref(false)

const hasPassword = computed(() => {
  const providers = authStore.session?.user?.app_metadata?.providers
  return !Array.isArray(providers) || providers.length === 0 || providers.includes('email')
})

const movedDate = computed(() =>
  state.value?.movedAt ? new Date(state.value.movedAt).toLocaleDateString() : '',
)

const targetLabel = computed(() => {
  const target = preview.value?.target
  if (!target) return ''
  return target.is_local || !target.domain ? `@${target.username}` : `@${target.username}@${target.domain}`
})

const canMove = computed(() => {
  const p = preview.value
  return !!p && !p.isSelf && !p.targetMoved && p.aliasConfirmed
})

const canConfirm = computed(() =>
  canMove.value
  && (!hasPassword.value || password.value.length > 0)
  && (!mfaRequired.value || /^\d{6}$/.test(mfaCode.value)),
)

function errorText(failure: MigrationFailure): string {
  const { error, retryAfter } = failure
  if (error === 'move_cooldown') {
    const days = Math.max(1, Math.ceil((retryAfter ?? 86_400) / 86_400))
    return t('accountMigration.errors.move_cooldown', { count: days }, days)
  }
  if (error === 'too_many_attempts') {
    const minutes = Math.max(1, Math.ceil((retryAfter ?? 60) / 60))
    return t('accountMigration.errors.too_many_attempts', { count: minutes }, minutes)
  }
  if (error === 'password_required' || error === 'invalid_password') return t('accountMigration.errors.wrong_password')
  if (KNOWN_ERRORS.has(error)) return t(`accountMigration.errors.${error}`)
  return t('accountMigration.errors.generic')
}

async function load() {
  loading.value = true
  try {
    state.value = await accountMigrationService.loadState()
  } finally {
    loading.value = false
  }
}

async function addAlias() {
  const handle = aliasHandle.value.trim()
  if (!handle || addingAlias.value) return
  addingAlias.value = true
  aliasError.value = ''
  try {
    const result = await accountMigrationService.addAlias(handle)
    if (!result.ok) {
      aliasError.value = errorText(result)
      return
    }
    aliasHandle.value = ''
    toast.success(t('accountMigration.aliases.added'))
    await load()
  } finally {
    addingAlias.value = false
  }
}

async function removeAlias(alias: AccountRef) {
  if (!alias.uri || removingAlias.value) return
  removingAlias.value = alias.uri
  aliasError.value = ''
  try {
    const result = await accountMigrationService.removeAlias(alias.uri)
    if (!result.ok) {
      aliasError.value = errorText(result)
      return
    }
    toast.success(t('accountMigration.aliases.removed'))
    await load()
  } finally {
    removingAlias.value = null
  }
}

async function checkTarget() {
  const handle = targetHandle.value.trim()
  if (!handle || checking.value) return
  checking.value = true
  targetError.value = ''
  preview.value = null
  try {
    const result = await accountMigrationService.previewMove(handle)
    if (!result.ok) {
      targetError.value = errorText(result)
      return
    }
    preview.value = result.preview
  } finally {
    checking.value = false
  }
}

async function openMoveModal() {
  if (!canMove.value) return
  password.value = ''
  mfaCode.value = ''
  moveError.value = ''
  mfaRequired.value = await accountMigrationService.isMfaEnabled()
  showMoveModal.value = true
}

function closeMoveModal() {
  if (moving.value) return
  showMoveModal.value = false
}

async function confirmMove() {
  if (!canConfirm.value || moving.value) return
  moving.value = true
  moveError.value = ''
  try {
    // begin_account_move needs a TOTP verify within the last ten minutes for 2FA accounts.
    if (mfaRequired.value) {
      const mfaError = await accountMigrationService.verifyMfaCode(mfaCode.value)
      if (mfaError) {
        moveError.value = mfaError
        mfaCode.value = ''
        return
      }
    }
    const result = await accountMigrationService.moveAccount(
      targetHandle.value.trim(),
      hasPassword.value ? password.value : undefined,
    )
    if (!result.ok) {
      if (result.error === 'mfa_required') mfaRequired.value = true
      if (result.error === 'invalid_password' || result.error === 'password_required') password.value = ''
      moveError.value = errorText(result)
      return
    }
    showMoveModal.value = false
    toast.success(t('accountMigration.move.success', { handle: targetLabel.value }))
    targetHandle.value = ''
    preview.value = null
    await load()
  } finally {
    moving.value = false
  }
}

async function cancelRedirect() {
  if (cancelling.value) return
  cancelling.value = true
  try {
    const result = await accountMigrationService.cancelRedirect()
    if (!result.ok) {
      toast.error(errorText(result))
      return
    }
    toast.success(t('accountMigration.moved.cancelled'))
    await load()
  } finally {
    cancelling.value = false
  }
}

function goToExport() {
  router.push({ name: 'UserSettings', params: { section: 'privacy' } })
}

onMounted(load)
</script>

<style scoped>
.am-title {
  font-size: var(--font-size-base);
  font-weight: var(--font-weight-semibold);
  color: var(--text-primary);
  margin: 0 0 6px;
}

.am-description,
.am-hint {
  font-size: var(--font-size-xs);
  color: var(--text-secondary);
  line-height: 1.4;
  margin: 0;
}

.am-description {
  margin-bottom: 16px;
}

.am-label {
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
  color: var(--text-primary);
  margin: 0 0 4px;
}

.am-subheading {
  font-size: 12px;
  font-weight: var(--font-weight-semibold);
  color: var(--text-primary);
  margin: 0 0 6px;
}

.am-block {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding-top: 16px;
  margin-top: 16px;
  border-top: 1px solid var(--background-quaternary);
}

.am-moved {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 16px;
}

.am-moved-body {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.am-row {
  display: flex;
  gap: 8px;
}

.am-row .sec-input {
  flex: 1;
  min-width: 0;
}

.am-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.am-list-item,
.am-account-row {
  display: flex;
  align-items: center;
  gap: 10px;
}

.am-account {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
}

.am-account-name {
  font-size: var(--font-size-sm);
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.am-preview {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 12px;
  border-radius: var(--radius-md);
  background: var(--background-tertiary);
}

.am-ok {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  font-size: 12px;
  color: var(--success);
}

.am-warn {
  color: var(--warning);
}

.am-stack {
  flex-direction: column;
  gap: 4px;
}

.am-code {
  display: inline-block;
  margin-top: 4px;
  font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
  font-size: 12px;
  overflow-wrap: anywhere;
}

.am-columns {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 12px;
}
</style>
