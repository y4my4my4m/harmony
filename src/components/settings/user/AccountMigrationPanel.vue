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

      <section
        v-if="canImport && copyOrigin"
        class="am-block"
        aria-labelledby="am-copy-title"
        data-testid="am-copy"
      >
        <h4 id="am-copy-title" class="am-label">{{ t('accountMigration.copy.title') }}</h4>
        <p class="am-hint">{{ t('accountMigration.copy.description', { handle: copyOrigin.handle }) }}</p>

        <label v-if="state.movedFrom.length > 1" class="am-copy-origin">
          <span class="sec-label">{{ t('accountMigration.copy.origin') }}</span>
          <select v-model="copyOriginId" class="sec-input" data-testid="am-copy-origin">
            <option v-for="origin in state.movedFrom" :key="origin.id" :value="origin.id">{{ origin.handle }}</option>
          </select>
        </label>

        <ul v-if="copyRows.length" class="am-copy-rows">
          <li v-for="row in copyRows" :key="row.field" class="am-copy-row" :data-testid="`am-copy-row-${row.field}`">
            <label class="am-copy-choice">
              <input
                v-model="copySelection"
                type="checkbox"
                :value="row.field"
                :disabled="row.same"
                :data-testid="`am-copy-${row.field}`"
              />
              <span class="am-account-name">{{ t(`accountMigration.copy.fields.${row.field}`) }}</span>
            </label>
            <Avatar v-if="row.field === 'avatar'" :src="row.value" size="sm" />
            <img v-else-if="row.field === 'banner'" class="am-copy-banner" :src="row.value" alt="" />
            <span v-else class="am-copy-value">{{ row.value }}</span>
            <span class="sec-muted">
              {{ row.same ? t('accountMigration.copy.same') : row.replaces ? t('accountMigration.copy.replaces') : t('accountMigration.copy.adds') }}
            </span>
          </li>
        </ul>
        <p v-else class="sec-muted">{{ t('accountMigration.copy.nothing') }}</p>

        <p v-if="copyError" class="sec-error" role="alert">{{ copyError }}</p>
        <div v-if="copyRows.length" class="sec-actions sec-actions-start">
          <button
            type="button"
            class="sec-btn sec-btn-secondary"
            data-testid="am-copy-open"
            :disabled="copySelection.length === 0"
            @click="showCopyModal = true"
          >
            {{ t('accountMigration.copy.review') }}
          </button>
        </div>
      </section>

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

      <section
        v-if="canImport && !state.movedTo"
        class="am-block"
        aria-labelledby="am-import-title"
        data-testid="am-import"
      >
        <h4 id="am-import-title" class="am-label">{{ t('accountMigration.import.title') }}</h4>
        <p class="am-hint">{{ t('accountMigration.import.description') }}</p>

        <template v-if="!importRunning">
          <div class="am-row am-file-row">
            <label class="sec-btn sec-btn-secondary am-file-button">
              {{ t('accountMigration.import.choose') }}
              <input
                ref="importInput"
                class="am-file-input"
                type="file"
                accept=".csv,.json,.zip"
                data-testid="am-import-file"
                @change="onImportFile"
              />
            </label>
          </div>
          <p v-if="importFileError" class="sec-error" role="alert" data-testid="am-import-error">{{ importFileError }}</p>

          <div v-if="importFile" class="am-preview" data-testid="am-import-preview">
            <p class="sec-text">{{ t('accountMigration.import.found', { count: importFile.handles.length }, importFile.handles.length) }}</p>
            <p class="sec-muted">{{ t('accountMigration.import.foundHint') }}</p>
            <div class="sec-actions sec-actions-start">
              <button type="button" class="sec-btn sec-btn-secondary" :disabled="importStarting" @click="clearImportFile">
                {{ t('common.cancel') }}
              </button>
              <button
                type="button"
                class="sec-btn sec-btn-primary"
                data-testid="am-import-start"
                :disabled="importStarting"
                @click="startImport"
              >
                {{ importStarting ? t('accountMigration.import.starting') : t('accountMigration.import.start') }}
              </button>
            </div>
          </div>
        </template>

        <div v-if="followingImport" class="am-preview" data-testid="am-import-result">
          <p class="sec-text" role="status" data-testid="am-import-status">{{ importStatus }}</p>
          <p v-if="importRunning && followingImport.retry_after" class="sec-muted" data-testid="am-import-waiting">
            {{ t('accountMigration.import.waiting', { count: importWaitMinutes }, importWaitMinutes) }}
          </p>
          <dl class="am-counts" data-testid="am-import-counts">
            <template v-for="row in importCounts" :key="row.key">
              <dt>{{ row.label }}</dt>
              <dd :data-testid="`am-import-count-${row.key}`">{{ row.count }}</dd>
            </template>
          </dl>
          <details v-if="followingImport.failures.length" class="am-failures" data-testid="am-import-failures">
            <summary>{{ t('accountMigration.import.failures', { count: followingImport.counts.failed }, followingImport.counts.failed) }}</summary>
            <ul class="am-failure-list">
              <li v-for="failure in followingImport.failures" :key="failure.handle">
                <code class="am-code">{{ failure.handle }}</code>
                <span class="sec-muted">{{ failureText(failure.reason) }}</span>
              </li>
            </ul>
            <p v-if="followingImport.counts.failed > followingImport.failures.length" class="sec-muted">
              {{ t('accountMigration.import.moreFailures', { count: followingImport.counts.failed - followingImport.failures.length }) }}
            </p>
          </details>
          <div v-if="importRunning" class="sec-actions sec-actions-start">
            <button
              type="button"
              class="sec-btn sec-btn-secondary"
              data-testid="am-import-cancel"
              :disabled="importCancelling"
              @click="cancelImport"
            >
              {{ t('accountMigration.import.cancel') }}
            </button>
          </div>
        </div>
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
              <li>{{ t('accountMigration.move.staysInteractions') }}</li>
              <li>{{ t('accountMigration.move.staysProfile') }}</li>
              <li>{{ t('accountMigration.move.staysFollowing') }}</li>
              <li>{{ t('accountMigration.move.staysBlocks') }}</li>
              <li>{{ t('accountMigration.move.staysKeys') }}</li>
              <li>{{ t('accountMigration.move.staysBots') }}</li>
              <li>{{ t('accountMigration.move.staysServers') }}</li>
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
      <div v-if="showCopyModal && copyOrigin" class="sec-modal-overlay" @click.self="closeCopyModal">
        <form
          class="sec-modal"
          role="dialog"
          aria-modal="true"
          aria-labelledby="am-copy-confirm-title"
          data-testid="am-copy-confirm"
          @submit.prevent="confirmCopy"
        >
          <h3 id="am-copy-confirm-title" class="sec-modal-title">
            {{ t('accountMigration.copy.confirmTitle', { handle: copyOrigin.handle }) }}
          </h3>
          <ul class="sec-bullets">
            <li v-for="row in selectedCopyRows" :key="row.field">
              {{ t(row.replaces ? 'accountMigration.copy.confirmReplaces' : 'accountMigration.copy.confirmAdds', { field: t(`accountMigration.copy.fields.${row.field}`) }) }}
            </li>
          </ul>
          <p v-if="selectedCopyRows.some((row) => row.replaces)" class="sec-text">{{ t('accountMigration.copy.confirmWarning') }}</p>
          <p v-if="copyError" class="sec-error" role="alert">{{ copyError }}</p>
          <div class="sec-actions">
            <button type="button" class="sec-btn sec-btn-secondary" :disabled="copying" @click="closeCopyModal">
              {{ t('common.cancel') }}
            </button>
            <button type="submit" class="sec-btn sec-btn-primary" :disabled="copying" data-testid="am-copy-confirm-button">
              {{ copying ? t('accountMigration.copy.copying') : t('accountMigration.copy.confirm') }}
            </button>
          </div>
        </form>
      </div>
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
import { formatHandle } from '@/utils/handles'
import { computed, onMounted, onUnmounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useRouter } from 'vue-router'
import { useToast } from 'vue-toastification'
import Icon from '@/components/common/Icon.vue'
import Avatar from '@/components/common/Avatar.vue'
import { useAuthStore } from '@/stores/auth'
import { useProfileStore } from '@/stores/useProfile'
import { useUserData } from '@/composables/useUserData'
import { hasCapability } from '@/services/instanceCapabilities'
import {
  accountMigrationService,
  type FollowingImport,
  type MigrationFailure,
  type MigrationState,
  type MovePreview,
  type ProfileCopyField,
  type ProfileValues,
} from '@/services/AccountMigrationService'
import type { AccountRef } from '@/utils/movedAccount'
import { readFollowingFile, type FollowingImportSource } from '@/utils/followingImportFile'
import { getBannerUrl } from '@/utils/bannerUtils'
import './securitySettings.css'

const { t } = useI18n()
const toast = useToast()
const router = useRouter()
const authStore = useAuthStore()
const profileStore = useProfileStore()
const { updateCurrentUserProfile } = useUserData()

const canImport = hasCapability('following-import')

const KNOWN_ERRORS = new Set([
  'invalid_handle', 'account_not_found', 'alias_is_self', 'too_many_aliases', 'unknown_account',
  'invalid_alias', 'already_moved', 'target_is_self', 'target_not_found', 'target_suspended',
  'target_moved', 'alias_missing', 'account_suspended', 'mfa_required', 'reauthentication_required',
  'insufficient_aal', 'not_moved', 'import_running', 'too_many_accounts', 'no_accounts', 'account_moved',
  'not_verified', 'nothing_to_copy',
])

const IMPORT_FAILURES = new Set([
  'invalid_handle', 'not_found', 'instance_blocked', 'federation_off', 'unreachable', 'unavailable', 'self',
  'moved', 'blocked', 'declined',
])

const IMPORT_POLL_MS = 3000

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

const copyOriginId = ref<string | null>(null)
const copySelection = ref<ProfileCopyField[]>([])
const showCopyModal = ref(false)
const copying = ref(false)
const copyError = ref('')

const importInput = ref<HTMLInputElement | null>(null)
const importFile = ref<{ handles: string[]; source: FollowingImportSource } | null>(null)
const importFileError = ref('')
const importStarting = ref(false)
const importCancelling = ref(false)
const followingImport = ref<FollowingImport | null>(null)
let importPoll: ReturnType<typeof setTimeout> | null = null

const hasPassword = computed(() => {
  const providers = authStore.session?.user?.app_metadata?.providers
  return !Array.isArray(providers) || providers.length === 0 || providers.includes('email')
})

const movedDate = computed(() =>
  state.value?.movedAt ? new Date(state.value.movedAt).toLocaleDateString() : '',
)

const targetLabel = computed(() => {
  return formatHandle(preview.value?.target, { full: true })
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

const copyOrigin = computed(() => {
  const origins = state.value?.movedFrom ?? []
  return origins.find((origin) => origin.id === copyOriginId.value) ?? origins[0] ?? null
})

interface CopyRow {
  field: ProfileCopyField
  value: string
  same: boolean
  replaces: boolean
}

/** Stored values are HTML (escaped text or an anchor); DOMParser runs no script and loads nothing. */
function fieldsText(fields: ProfileValues['profile_fields']): string {
  const parser = new DOMParser()
  return fields
    .map((field) => `${field.name}: ${parser.parseFromString(String(field.value ?? ''), 'text/html').body.textContent ?? ''}`)
    .join(' · ')
}

/** profiles.avatar_url default: no avatar was chosen. */
const avatarChosen = (url: string | null) => !!url && url !== '/default_avatar.webp'

/** What the old account has for each field; a field it left empty offers nothing. */
const copyRows = computed<CopyRow[]>(() => {
  const origin = copyOrigin.value
  const mine = state.value?.profile
  if (!origin || !mine) return []
  const rows: CopyRow[] = []
  const text = (field: 'display_name' | 'bio') => {
    const value = origin[field]?.trim()
    if (value) rows.push({ field, value, same: mine[field] === origin[field], replaces: !!mine[field] })
  }
  text('display_name')
  text('bio')
  if (avatarChosen(origin.avatar_url)) {
    rows.push({ field: 'avatar', value: origin.avatar_url as string, same: false, replaces: avatarChosen(mine.avatar_url) })
  }
  const banner = getBannerUrl(origin.banner_url)
  if (banner) rows.push({ field: 'banner', value: banner, same: false, replaces: !!mine.banner_url })
  if (origin.profile_fields.length) {
    rows.push({
      field: 'profile_fields',
      value: fieldsText(origin.profile_fields),
      same: fieldsText(origin.profile_fields) === fieldsText(mine.profile_fields),
      replaces: mine.profile_fields.length > 0,
    })
  }
  return rows
})

const selectedCopyRows = computed(() => copyRows.value.filter((row) => copySelection.value.includes(row.field)))

watch(copyOriginId, () => {
  copySelection.value = []
})

const importRunning = computed(() => !!followingImport.value && !followingImport.value.finished_at)

const importDone = computed(() => {
  const counts = followingImport.value?.counts
  if (!counts) return 0
  return counts.followed + counts.requested + counts.already_following + counts.already_requested + counts.failed + counts.cancelled
})

const importStatus = computed(() => {
  const current = followingImport.value
  if (!current) return ''
  if (!current.finished_at) return t('accountMigration.import.running', { done: importDone.value, total: current.total })
  return t(current.cancelled ? 'accountMigration.import.stopped' : 'accountMigration.import.finished')
})

const importWaitMinutes = computed(() => Math.max(1, Math.ceil((followingImport.value?.retry_after ?? 60) / 60)))

const importCounts = computed(() => {
  const counts = followingImport.value?.counts
  if (!counts) return []
  return [
    { key: 'followed', label: t('accountMigration.import.counts.followed'), count: counts.followed },
    { key: 'requested', label: t('accountMigration.import.counts.requested'), count: counts.requested },
    { key: 'already', label: t('accountMigration.import.counts.already'), count: counts.already_following + counts.already_requested },
    { key: 'failed', label: t('accountMigration.import.counts.failed'), count: counts.failed },
    ...(counts.cancelled ? [{ key: 'cancelled', label: t('accountMigration.import.counts.cancelled'), count: counts.cancelled }] : []),
  ]
})

function failureText(reason: string): string {
  return t(IMPORT_FAILURES.has(reason) ? `accountMigration.import.reasons.${reason}` : 'accountMigration.import.reasons.unreachable')
}

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
  if (error === 'import_rate_limited') {
    const hours = Math.max(1, Math.ceil((retryAfter ?? 3600) / 3600))
    return t('accountMigration.errors.import_rate_limited', { count: hours }, hours)
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

function stopImportPoll() {
  if (importPoll) clearTimeout(importPoll)
  importPoll = null
}

async function refreshImport() {
  stopImportPoll()
  if (!canImport) return
  followingImport.value = await accountMigrationService.getFollowingImport()
  if (importRunning.value) importPoll = setTimeout(refreshImport, IMPORT_POLL_MS)
}

function clearImportFile() {
  importFile.value = null
  if (importInput.value) importInput.value.value = ''
}

async function onImportFile(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0]
  importFile.value = null
  importFileError.value = ''
  if (!file) return
  const result = await readFollowingFile(file)
  if (!result.ok) {
    importFileError.value = t(`accountMigration.import.fileErrors.${result.error}`)
    clearImportFile()
    return
  }
  importFile.value = { handles: result.handles, source: result.source }
}

async function startImport() {
  const file = importFile.value
  if (!file || importStarting.value) return
  importStarting.value = true
  importFileError.value = ''
  try {
    const result = await accountMigrationService.startFollowingImport(file.handles, file.source)
    if (!result.ok) {
      importFileError.value = errorText(result)
      return
    }
    clearImportFile()
    await refreshImport()
  } finally {
    importStarting.value = false
  }
}

async function cancelImport() {
  if (importCancelling.value) return
  importCancelling.value = true
  try {
    const result = await accountMigrationService.cancelFollowingImport()
    if (!result.ok && result.error !== 'not_running') toast.error(errorText(result))
    await refreshImport()
  } finally {
    importCancelling.value = false
  }
}

function closeCopyModal() {
  if (copying.value) return
  showCopyModal.value = false
}

async function confirmCopy() {
  const origin = copyOrigin.value
  if (!origin || copying.value || copySelection.value.length === 0) return
  copying.value = true
  copyError.value = ''
  try {
    const result = await accountMigrationService.copyProfile(origin.id, copySelection.value)
    if (!result.ok) {
      copyError.value = errorText(result)
      return
    }
    showCopyModal.value = false
    copySelection.value = []
    if (profileStore.profile) {
      profileStore.profile = { ...profileStore.profile, ...result.update } as typeof profileStore.profile
    }
    await updateCurrentUserProfile({
      displayName: result.update.display_name ?? undefined,
      avatarUrl: result.update.avatar_url ?? undefined,
      bio: result.update.bio ?? undefined,
    })
    if (result.failed.length) {
      copyError.value = t('accountMigration.copy.partial', {
        fields: result.failed.map((field) => t(`accountMigration.copy.fields.${field}`)).join(', '),
      })
    } else {
      toast.success(t('accountMigration.copy.done'))
    }
    await load()
  } finally {
    copying.value = false
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

onMounted(() => {
  void load()
  void refreshImport()
})
onUnmounted(stopImportPoll)
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
  color: var(--text-success);
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

.am-file-row {
  align-items: center;
}

.am-file-button {
  position: relative;
  cursor: pointer;
}

.am-file-input {
  position: absolute;
  inset: 0;
  opacity: 0;
  cursor: pointer;
}

.am-file-button:focus-within {
  outline: 2px solid var(--focus-ring, currentColor);
  outline-offset: 2px;
}

.am-counts {
  display: grid;
  grid-template-columns: max-content max-content;
  gap: 2px 12px;
  margin: 0;
  font-size: 12px;
  color: var(--text-secondary);
}

.am-counts dd {
  margin: 0;
  color: var(--text-primary);
  font-variant-numeric: tabular-nums;
}

.am-failures summary {
  font-size: 12px;
  color: var(--text-primary);
  cursor: pointer;
}

.am-failure-list {
  list-style: none;
  margin: 8px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 6px;
  max-height: 240px;
  overflow-y: auto;
}

.am-failure-list li {
  display: flex;
  flex-wrap: wrap;
  gap: 2px 8px;
  align-items: baseline;
}

.am-copy-origin {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.am-copy-rows {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.am-copy-row {
  display: grid;
  grid-template-columns: minmax(120px, max-content) minmax(0, 1fr) max-content;
  gap: 4px 10px;
  align-items: center;
  font-size: 12px;
}

.am-copy-choice {
  display: flex;
  align-items: center;
  gap: 8px;
}

.am-copy-value {
  color: var(--text-secondary);
  overflow-wrap: anywhere;
}

.am-copy-banner {
  width: 100%;
  max-width: 240px;
  height: 48px;
  object-fit: cover;
  border-radius: var(--radius-sm);
}

@media (max-width: 520px) {
  .am-copy-row {
    grid-template-columns: minmax(0, 1fr);
  }
}

.am-columns {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
  gap: 12px;
}
</style>
