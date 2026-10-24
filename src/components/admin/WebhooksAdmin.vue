<template>
  <div class="wa" data-testid="webhooks-admin">
    <section class="wa-card" :aria-labelledby="`${uid}-settings`">
      <h3 :id="`${uid}-settings`" class="wa-title">{{ t('adminWebhooks.settingsTitle') }}</h3>
      <p class="wa-hint">{{ isAdmin ? t('adminWebhooks.settingsIntro') : t('adminWebhooks.settingsReadOnly') }}</p>
      <p v-if="settingsError" class="wa-hint" role="alert">{{ settingsError }}</p>
      <form v-else-if="form" class="wa-form" @submit.prevent="save">
        <label class="wa-field">
          <span class="wa-label">{{ t('adminWebhooks.outgoingMode') }}</span>
          <select v-model="form.outgoing_mode" class="wa-input" :disabled="!isAdmin" data-testid="webhooks-outgoing-mode">
            <option value="everyone">{{ t('adminWebhooks.modeEveryone') }}</option>
            <option value="staff">{{ t('adminWebhooks.modeStaff') }}</option>
            <option value="off">{{ t('adminWebhooks.modeOff') }}</option>
          </select>
        </label>
        <label class="wa-check">
          <input v-model="form.incoming_enabled" type="checkbox" :disabled="!isAdmin" data-testid="webhooks-incoming-enabled" />
          <span>{{ t('adminWebhooks.incomingEnabled') }}</span>
        </label>
        <div class="wa-row">
          <label class="wa-field">
            <span class="wa-label">{{ t('adminWebhooks.ratePerMinute') }}</span>
            <input v-model.number="form.rate_per_minute" type="number" min="1" max="10000" class="wa-input" :disabled="!isAdmin" data-testid="webhooks-rate" />
          </label>
          <label class="wa-field">
            <span class="wa-label">{{ t('adminWebhooks.hostRatePerMinute') }}</span>
            <input v-model.number="form.host_rate_per_minute" type="number" min="1" max="100000" class="wa-input" :disabled="!isAdmin" data-testid="webhooks-host-rate" />
          </label>
          <label class="wa-field">
            <span class="wa-label">{{ t('adminWebhooks.perUser') }}</span>
            <input v-model.number="form.per_user" type="number" min="0" max="1000" class="wa-input" :disabled="!isAdmin" data-testid="webhooks-per-user" />
          </label>
        </div>
        <label class="wa-field">
          <span class="wa-label">{{ t('adminWebhooks.blockedDomains') }}</span>
          <textarea
            v-model="form.blocked"
            rows="4"
            class="wa-input"
            :placeholder="t('adminWebhooks.blockedPlaceholder')"
            :disabled="!isAdmin"
            :aria-describedby="`${uid}-blocked-hint`"
            data-testid="webhooks-blocked-domains"
          ></textarea>
          <span :id="`${uid}-blocked-hint`" class="wa-hint">{{ t('adminWebhooks.blockedHint') }}</span>
        </label>
        <div v-if="isAdmin" class="wa-actions">
          <button type="submit" class="wa-btn wa-btn-primary" :disabled="saving" data-testid="webhooks-save">
            {{ t('adminWebhooks.save') }}
          </button>
        </div>
      </form>
      <p v-else class="wa-hint">{{ t('adminWebhooks.loading') }}</p>
    </section>

    <section class="wa-card" :aria-labelledby="`${uid}-list`">
      <div class="wa-head">
        <h3 :id="`${uid}-list`" class="wa-title">{{ t('adminWebhooks.listTitle') }}</h3>
        <button type="button" class="wa-btn" :disabled="listLoading" @click="loadList">{{ t('adminWebhooks.refresh') }}</button>
      </div>
      <p class="wa-hint">{{ t('adminWebhooks.listIntro') }}</p>
      <p v-if="listLoading" class="wa-hint">{{ t('adminWebhooks.loading') }}</p>
      <p v-else-if="listError" class="wa-hint" role="alert">{{ listError }}</p>
      <p v-else-if="webhooks.length === 0" class="wa-hint" data-testid="webhooks-admin-empty">{{ t('adminWebhooks.empty') }}</p>
      <div v-else class="wa-table-wrap">
        <table class="wa-table">
          <thead>
            <tr>
              <th scope="col">{{ t('adminWebhooks.colWebhook') }}</th>
              <th scope="col">{{ t('adminWebhooks.colOwner') }}</th>
              <th scope="col">{{ t('adminWebhooks.colDestination') }}</th>
              <th scope="col">{{ t('adminWebhooks.colState') }}</th>
              <th scope="col">{{ t('adminWebhooks.colDeliveries') }}</th>
              <th scope="col"><span class="sr-only">{{ t('adminWebhooks.colActions') }}</span></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="w in webhooks" :key="w.id" :data-testid="`webhooks-admin-${w.id}`">
              <td :id="`webhooks-admin-name-${w.id}`">{{ w.name }}</td>
              <td>
                {{ w.bot_id ? t('adminWebhooks.ownerBot', { name: w.bot_name ?? '—' }) : t('adminWebhooks.ownerServer', { name: w.server_name ?? '—' }) }}
                <span v-if="w.owner_username" class="wa-muted">@{{ w.owner_username }}</span>
              </td>
              <td><code>{{ w.host }}</code></td>
              <td :class="{ 'wa-warning': stateWarning(w) }">{{ stateLabel(w) }}</td>
              <td>{{ t('adminWebhooks.deliveries24h', { count: w.deliveries_24h, failed: w.failed_24h }) }}</td>
              <td class="wa-row-actions">
                <button
                  v-if="w.is_active || w.disabled_reason === 'staff'"
                  type="button"
                  class="wa-btn"
                  :disabled="busy"
                  :data-testid="`webhooks-admin-toggle-${w.id}`"
                  :aria-describedby="`webhooks-admin-name-${w.id}`"
                  @click="toggle(w)"
                >
                  {{ w.is_active ? t('adminWebhooks.turnOff') : t('adminWebhooks.turnOn') }}
                </button>
                <button
                  v-if="isAdmin"
                  type="button"
                  class="wa-btn wa-btn-danger"
                  :disabled="busy"
                  :aria-label="t('adminWebhooks.deleteFor', { name: w.name })"
                  :data-testid="`webhooks-admin-delete-${w.id}`"
                  @click="remove(w)"
                >
                  {{ t('adminWebhooks.delete') }}
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import { useToast } from 'vue-toastification'
import { useConfirmDialog } from '@/composables/useConfirmDialog'
import { useProfileStore } from '@/stores/useProfile'
import {
  adminDeleteOutgoingWebhook,
  adminGetWebhookSettings,
  adminListOutgoingWebhooks,
  adminSetOutgoingWebhookActive,
  adminUpdateWebhookSettings,
  type AdminOutgoingWebhook,
  type WebhookSettings,
} from '@/services/outgoingWebhookService'
import { debug } from '@/utils/debug'

const { t } = useI18n()
const toast = useToast()
const { confirm } = useConfirmDialog()
const profileStore = useProfileStore()
const uid = `webhooks-admin-${useId()}`

const isAdmin = computed(() => profileStore.profile?.is_admin === true)
const form = ref<(Omit<WebhookSettings, 'blocked_domains'> & { blocked: string }) | null>(null)
const settingsError = ref<string | null>(null)
const saving = ref(false)
const webhooks = ref<AdminOutgoingWebhook[]>([])
const listLoading = ref(false)
const listError = ref<string | null>(null)
const busy = ref(false)

function fill(settings: WebhookSettings) {
  const { blocked_domains, ...rest } = settings
  form.value = { ...rest, blocked: blocked_domains.join('\n') }
}

async function loadSettings() {
  try {
    fill(await adminGetWebhookSettings())
  } catch (error) {
    debug.error('Failed to load webhook settings:', error)
    settingsError.value = t('adminWebhooks.loadFailed')
  }
}

async function loadList() {
  listLoading.value = true
  listError.value = null
  try {
    webhooks.value = await adminListOutgoingWebhooks()
  } catch (error) {
    debug.error('Failed to list outgoing webhooks:', error)
    listError.value = t('adminWebhooks.loadFailed')
  } finally {
    listLoading.value = false
  }
}

async function save() {
  if (!form.value) return
  saving.value = true
  try {
    const { blocked, ...rest } = form.value
    fill(await adminUpdateWebhookSettings({
      ...rest,
      blocked_domains: blocked.split(/[\s,]+/).map(d => d.trim()).filter(Boolean),
    }))
    toast.success(t('adminWebhooks.saved'))
  } catch (error) {
    debug.error('Failed to save webhook settings:', error)
    toast.error(t('adminWebhooks.saveFailed'))
  } finally {
    saving.value = false
  }
}

function stateWarning(w: AdminOutgoingWebhook): boolean {
  return !w.is_active ? w.disabled_reason !== 'owner' : Boolean(w.paused || w.failing_since || !w.verified_at)
}

function stateLabel(w: AdminOutgoingWebhook): string {
  if (!w.is_active) {
    if (w.disabled_reason === 'staff') return t('adminWebhooks.stateStaff')
    if (w.disabled_reason === 'failing') return t('adminWebhooks.stateFailingOff')
    return t('adminWebhooks.stateOff')
  }
  if (!w.verified_at) return t('adminWebhooks.stateUnverified')
  if (w.paused) return t('adminWebhooks.statePaused')
  if (w.failing_since) return t('adminWebhooks.stateFailing')
  return t('adminWebhooks.stateActive')
}

async function toggle(w: AdminOutgoingWebhook) {
  busy.value = true
  try {
    const next = await adminSetOutgoingWebhookActive(w.id, !w.is_active)
    webhooks.value = webhooks.value.map(x => (x.id === w.id ? { ...x, ...next } : x))
  } catch (error) {
    debug.error('Failed to switch an outgoing webhook:', error)
    toast.error(t('adminWebhooks.saveFailed'))
  } finally {
    busy.value = false
  }
}

async function remove(w: AdminOutgoingWebhook) {
  const ok = await confirm({
    title: t('adminWebhooks.confirmDeleteTitle'),
    message: t('adminWebhooks.confirmDeleteMessage', { name: w.name, host: w.host }),
    confirmButtonText: t('adminWebhooks.delete'),
    dangerAction: true,
  })
  if (!ok) return
  busy.value = true
  try {
    await adminDeleteOutgoingWebhook(w.id)
    webhooks.value = webhooks.value.filter(x => x.id !== w.id)
  } catch (error) {
    debug.error('Failed to delete an outgoing webhook:', error)
    toast.error(t('adminWebhooks.saveFailed'))
  } finally {
    busy.value = false
  }
}

onMounted(() => {
  void loadSettings()
  void loadList()
})
</script>

<style scoped>
.wa {
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.wa-card {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-4);
  background: var(--background-secondary);
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-md);
}

.wa-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: var(--space-3);
}

.wa-title {
  margin: 0;
  font-size: var(--font-size-md, 1rem);
  font-weight: 600;
  color: var(--text-primary);
}

.wa-hint {
  margin: 0;
  font-size: var(--font-size-xs);
  color: var(--text-muted);
  line-height: 1.4;
}

.wa-form {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.wa-row {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-3);
}

.wa-row .wa-field {
  flex: 1 1 160px;
}

.wa-field {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.wa-label {
  font-size: var(--font-size-xs);
  font-weight: 600;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.02em;
}

.wa-input {
  width: 100%;
  background: var(--background-quinary);
  border: 1px solid var(--background-quinary);
  border-radius: 4px;
  padding: 8px 10px;
  color: var(--text-primary);
  font-size: var(--font-size-sm);
  font-family: inherit;
}

.wa-input:focus {
  outline: none;
  border-color: var(--harmony-primary);
}

.wa-check {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--font-size-sm);
  color: var(--text-primary);
}

.wa-actions,
.wa-row-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: var(--space-2);
}

.wa-btn {
  padding: 6px 12px;
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-base);
  background: var(--background-tertiary);
  color: var(--text-primary);
  font-size: var(--font-size-sm);
  cursor: pointer;
  white-space: nowrap;
}

.wa-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.wa-btn-primary {
  background: var(--harmony-primary);
  border-color: var(--harmony-primary);
  color: var(--text-on-primary, #fff);
}

.wa-btn-danger {
  color: var(--danger);
}

.wa-table-wrap {
  overflow-x: auto;
}

.wa-table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--font-size-sm);
}

.wa-table th,
.wa-table td {
  padding: 6px 8px;
  text-align: left;
  border-bottom: 1px solid var(--border-primary);
  color: var(--text-secondary);
  vertical-align: middle;
}

.wa-muted {
  display: block;
  font-size: var(--font-size-xs);
  color: var(--text-muted);
}

.wa-warning {
  color: var(--warning);
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}
</style>
