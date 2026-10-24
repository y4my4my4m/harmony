<template>
  <section class="ow-section" :aria-labelledby="headingId" data-testid="outgoing-webhooks">
    <div class="ow-head">
      <div class="ow-head-text">
        <h3 :id="headingId" class="ow-heading">{{ t('outgoingWebhooks.heading') }}</h3>
        <p class="ow-hint">{{ botId ? t('outgoingWebhooks.introBot') : t('outgoingWebhooks.introServer') }}</p>
      </div>
      <button
        v-if="!form || form.mode !== 'create'"
        type="button"
        class="ow-btn ow-btn-primary"
        data-testid="outgoing-webhook-new"
        :disabled="loading || atLimit || busy"
        @click="startCreate"
      >
        <Icon name="plus" :size="14" />
        {{ t('outgoingWebhooks.create') }}
      </button>
    </div>
    <p v-if="atLimit" class="ow-hint">{{ t('outgoingWebhooks.limitReached', { count: MAX_OUTGOING_WEBHOOKS }) }}</p>

    <form v-if="form" class="ow-form" data-testid="outgoing-webhook-form" @submit.prevent="submitForm">
      <label class="ow-field">
        <span class="ow-field-label">{{ t('outgoingWebhooks.nameLabel') }}</span>
        <input v-model="form.name" type="text" class="ow-input" maxlength="80" required data-testid="outgoing-webhook-name" />
      </label>
      <label class="ow-field">
        <span class="ow-field-label">{{ t('outgoingWebhooks.urlLabel') }}</span>
        <input
          v-model="form.url"
          type="url"
          class="ow-input"
          maxlength="2048"
          required
          placeholder="https://"
          :aria-describedby="`${headingId}-url-hint`"
          data-testid="outgoing-webhook-url"
        />
        <span :id="`${headingId}-url-hint`" class="ow-hint">{{ t('outgoingWebhooks.urlHint') }}</span>
      </label>
      <fieldset v-for="group in OUTGOING_WEBHOOK_EVENT_GROUPS" :key="group.key" class="ow-events">
        <legend class="ow-field-label">{{ t(`outgoingWebhooks.groups.${group.key}`) }}</legend>
        <label v-for="event in group.events" :key="event" class="ow-check">
          <input
            type="checkbox"
            :value="event"
            :checked="form.events.includes(event)"
            :data-testid="`outgoing-webhook-event-${event}`"
            @change="toggleEvent(event, ($event.target as HTMLInputElement).checked)"
          />
          <span>{{ t(`outgoingWebhooks.events.${event}`) }}</span>
        </label>
      </fieldset>
      <div class="ow-actions">
        <button type="button" class="ow-btn" @click="form = null">{{ t('outgoingWebhooks.cancel') }}</button>
        <button
          type="submit"
          class="ow-btn ow-btn-primary"
          data-testid="outgoing-webhook-submit"
          :disabled="busy || !form.name.trim() || !form.url.trim() || form.events.length === 0"
        >
          {{ form.mode === 'create' ? t('outgoingWebhooks.createSubmit') : t('outgoingWebhooks.save') }}
        </button>
      </div>
    </form>

    <div v-if="revealed" class="ow-secret" role="status" data-testid="outgoing-webhook-secret">
      <p class="ow-secret-title">{{ t('outgoingWebhooks.copyOnce', { name: revealed.name }) }}</p>
      <code class="ow-secret-value" data-testid="outgoing-webhook-secret-value">{{ revealed.secret }}</code>
      <p class="ow-hint">{{ t('outgoingWebhooks.secretHint') }}</p>
      <div class="ow-actions">
        <button type="button" class="ow-btn ow-btn-primary" @click="copy(revealed.secret)">
          <Icon name="copy" :size="14" />
          {{ t('outgoingWebhooks.copySecret') }}
        </button>
        <button type="button" class="ow-btn" @click="revealed = null">{{ t('outgoingWebhooks.done') }}</button>
      </div>
    </div>

    <p v-if="loading" class="ow-hint">{{ t('outgoingWebhooks.loading') }}</p>
    <p v-else-if="loadError" class="ow-hint" role="alert">{{ t(loadError) }}</p>
    <p v-else-if="webhooks.length === 0" class="ow-hint" data-testid="outgoing-webhook-empty">{{ t('outgoingWebhooks.empty') }}</p>
    <ul v-else class="ow-list">
      <li v-for="webhook in webhooks" :key="webhook.id" class="ow-row" :data-testid="`outgoing-webhook-${webhook.id}`">
        <div class="ow-row-main">
          <div class="ow-info">
            <span class="ow-name">{{ webhook.name }}</span>
            <span class="ow-meta ow-url" :title="webhook.url">{{ webhook.url }}</span>
            <span class="ow-meta">{{ t('outgoingWebhooks.eventCount', { count: webhook.events.length }) }} · {{ t('outgoingWebhooks.secretEndsWith', { hint: webhook.secret_hint }) }}</span>
            <span class="ow-meta" :class="{ 'ow-warning': stateTone(webhook) === 'warning' }" data-testid="outgoing-webhook-state">{{ stateLine(webhook) }}</span>
          </div>
          <label class="ow-switch" :title="t('outgoingWebhooks.active')">
            <input
              type="checkbox"
              role="switch"
              :checked="webhook.is_active"
              :aria-label="t('outgoingWebhooks.activeFor', { name: webhook.name })"
              :disabled="busy"
              :data-testid="`outgoing-webhook-active-${webhook.id}`"
              @change="setActive(webhook, ($event.target as HTMLInputElement).checked)"
            />
            <span class="ow-switch-slider" aria-hidden="true"></span>
          </label>
        </div>
        <div class="ow-row-actions">
          <button type="button" class="ow-btn" :disabled="busy || !webhook.is_active" :data-testid="`outgoing-webhook-test-${webhook.id}`" @click="sendTest(webhook)">
            <Icon name="send" :size="14" />
            {{ t('outgoingWebhooks.sendTest') }}
          </button>
          <button
            type="button"
            class="ow-btn"
            :aria-expanded="openLog === webhook.id"
            :data-testid="`outgoing-webhook-log-${webhook.id}`"
            @click="toggleLog(webhook)"
          >
            <Icon name="list" :size="14" />
            {{ t('outgoingWebhooks.deliveries') }}
          </button>
          <button type="button" class="ow-icon-btn" :title="t('outgoingWebhooks.edit')" :aria-label="t('outgoingWebhooks.editFor', { name: webhook.name })" :disabled="busy" @click="startEdit(webhook)">
            <Icon name="pencil" :size="16" />
          </button>
          <button
            type="button"
            class="ow-icon-btn"
            :title="t('outgoingWebhooks.rotate')"
            :aria-label="t('outgoingWebhooks.rotateFor', { name: webhook.name })"
            :disabled="busy"
            :data-testid="`outgoing-webhook-rotate-${webhook.id}`"
            @click="rotate(webhook)"
          >
            <Icon name="refresh-cw" :size="16" />
          </button>
          <button
            type="button"
            class="ow-icon-btn danger"
            :title="t('outgoingWebhooks.delete')"
            :aria-label="t('outgoingWebhooks.deleteFor', { name: webhook.name })"
            :disabled="busy"
            :data-testid="`outgoing-webhook-delete-${webhook.id}`"
            @click="remove(webhook)"
          >
            <Icon name="trash-2" :size="16" />
          </button>
        </div>
        <div v-if="openLog === webhook.id" class="ow-log" :data-testid="`outgoing-webhook-deliveries-${webhook.id}`">
          <p v-if="logLoading" class="ow-hint">{{ t('outgoingWebhooks.loading') }}</p>
          <p v-else-if="deliveries.length === 0" class="ow-hint">{{ t('outgoingWebhooks.noDeliveries') }}</p>
          <table v-else class="ow-log-table">
            <caption class="sr-only">{{ t('outgoingWebhooks.deliveriesOf', { name: webhook.name }) }}</caption>
            <thead>
              <tr>
                <th scope="col">{{ t('outgoingWebhooks.logEvent') }}</th>
                <th scope="col">{{ t('outgoingWebhooks.logStatus') }}</th>
                <th scope="col">{{ t('outgoingWebhooks.logAnswer') }}</th>
                <th scope="col">{{ t('outgoingWebhooks.logTime') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="d in deliveries" :key="d.id" data-testid="outgoing-webhook-delivery">
                <td><code>{{ d.event }}</code></td>
                <td :class="`ow-status-${d.status}`">{{ t(`outgoingWebhooks.status.${d.status}`, { attempts: d.attempts }) }}</td>
                <td>{{ d.last_status ?? d.last_error ?? '—' }}</td>
                <td>{{ formatTime(d.created_at) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </li>
    </ul>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useToast } from 'vue-toastification'
import Icon from '@/components/common/Icon.vue'
import { useConfirmDialog } from '@/composables/useConfirmDialog'
import {
  MAX_OUTGOING_WEBHOOKS,
  OUTGOING_WEBHOOK_EVENT_GROUPS,
  createOutgoingWebhook,
  deleteOutgoingWebhook,
  listOutgoingWebhookDeliveries,
  listOutgoingWebhooks,
  outgoingWebhookErrorKey,
  rotateOutgoingWebhookSecret,
  testOutgoingWebhook,
  updateOutgoingWebhook,
  type OutgoingWebhook,
  type OutgoingWebhookDelivery,
  type OutgoingWebhookOwner,
  type OutgoingWebhookWithSecret,
} from '@/services/outgoingWebhookService'
import { debug } from '@/utils/debug'

/** Exactly one of botId and serverId. */
const props = defineProps<{ botId?: string; serverId?: string }>()

const { t, locale } = useI18n()
const toast = useToast()
const { confirm } = useConfirmDialog()

const headingId = `outgoing-webhooks-${Math.random().toString(36).slice(2, 8)}`
const webhooks = ref<OutgoingWebhook[]>([])
const loading = ref(false)
const loadError = ref<string | null>(null)
const busy = ref(false)
/** The secret of a webhook just created or rotated; not readable afterwards. */
const revealed = ref<{ name: string; secret: string } | null>(null)
const form = ref<{ mode: 'create' | 'edit'; id?: string; name: string; url: string; events: string[] } | null>(null)
const openLog = ref<string | null>(null)
const deliveries = ref<OutgoingWebhookDelivery[]>([])
const logLoading = ref(false)

const owner = computed<OutgoingWebhookOwner | null>(() =>
  props.botId ? { botId: props.botId } : props.serverId ? { serverId: props.serverId } : null)
const atLimit = computed(() => webhooks.value.length >= MAX_OUTGOING_WEBHOOKS)

function formatTime(value: string): string {
  return new Date(value).toLocaleString(locale.value, { dateStyle: 'medium', timeStyle: 'short' })
}

function stateTone(webhook: OutgoingWebhook): 'ok' | 'warning' {
  return webhook.disabled_reason === 'failing' || (webhook.is_active && webhook.failing_since) ? 'warning' : 'ok'
}

function stateLine(webhook: OutgoingWebhook): string {
  if (!webhook.is_active) {
    return webhook.disabled_reason === 'failing'
      ? t('outgoingWebhooks.state.disabledFailing', { error: webhook.last_error ?? webhook.last_status ?? '—' })
      : t('outgoingWebhooks.state.off')
  }
  if (webhook.failing_since) {
    return t('outgoingWebhooks.state.failing', { date: formatTime(webhook.failing_since), error: webhook.last_error ?? webhook.last_status ?? '—' })
  }
  if (webhook.last_success_at) return t('outgoingWebhooks.state.delivered', { date: formatTime(webhook.last_success_at) })
  return t('outgoingWebhooks.state.never')
}

function withoutSecret(webhook: OutgoingWebhook): OutgoingWebhook {
  const { secret: _secret, ...row } = webhook as OutgoingWebhookWithSecret
  return row
}

function replace(webhook: OutgoingWebhook) {
  const row = withoutSecret(webhook)
  webhooks.value = webhooks.value.map(w => (w.id === row.id ? row : w))
}

async function load() {
  if (!owner.value) return
  loading.value = true
  loadError.value = null
  try {
    webhooks.value = (await listOutgoingWebhooks(owner.value)).map(withoutSecret)
  } catch (error) {
    debug.error('Failed to load outgoing webhooks:', error)
    const key = outgoingWebhookErrorKey(error)
    loadError.value = key === 'outgoingWebhooks.errors.saveFailed' ? 'outgoingWebhooks.loadFailed' : key
    webhooks.value = []
  } finally {
    loading.value = false
  }
}

function startCreate() {
  revealed.value = null
  form.value = { mode: 'create', name: t('outgoingWebhooks.defaultName'), url: '', events: ['MESSAGE_CREATE'] }
}

function startEdit(webhook: OutgoingWebhook) {
  form.value = { mode: 'edit', id: webhook.id, name: webhook.name, url: webhook.url, events: [...webhook.events] }
}

function toggleEvent(event: string, on: boolean) {
  if (!form.value) return
  form.value.events = on ? [...new Set([...form.value.events, event])] : form.value.events.filter(e => e !== event)
}

async function submitForm() {
  const current = form.value
  if (!current || busy.value || !owner.value) return
  busy.value = true
  try {
    const fields = { name: current.name.trim(), url: current.url.trim(), events: current.events }
    if (current.mode === 'create') {
      const created = await createOutgoingWebhook(owner.value, fields)
      webhooks.value = [...webhooks.value, withoutSecret(created)]
      revealed.value = { name: created.name, secret: created.secret }
      toast.success(t('outgoingWebhooks.created'))
    } else if (current.id) {
      replace(await updateOutgoingWebhook(current.id, fields))
      toast.success(t('outgoingWebhooks.updated'))
    }
    form.value = null
  } catch (error) {
    debug.error('Failed to save an outgoing webhook:', error)
    toast.error(t(outgoingWebhookErrorKey(error)))
  } finally {
    busy.value = false
  }
}

async function setActive(webhook: OutgoingWebhook, active: boolean) {
  busy.value = true
  try {
    replace(await updateOutgoingWebhook(webhook.id, { active }))
  } catch (error) {
    debug.error('Failed to switch an outgoing webhook:', error)
    toast.error(t(outgoingWebhookErrorKey(error)))
    await load()
  } finally {
    busy.value = false
  }
}

async function loadDeliveries(webhookId: string) {
  logLoading.value = true
  try {
    deliveries.value = await listOutgoingWebhookDeliveries(webhookId)
  } catch (error) {
    debug.error('Failed to load webhook deliveries:', error)
    deliveries.value = []
    toast.error(t(outgoingWebhookErrorKey(error)))
  } finally {
    logLoading.value = false
  }
}

async function toggleLog(webhook: OutgoingWebhook) {
  if (openLog.value === webhook.id) {
    openLog.value = null
    return
  }
  openLog.value = webhook.id
  await loadDeliveries(webhook.id)
}

async function sendTest(webhook: OutgoingWebhook) {
  busy.value = true
  try {
    await testOutgoingWebhook(webhook.id)
    toast.success(t('outgoingWebhooks.testQueued'))
    openLog.value = webhook.id
    await loadDeliveries(webhook.id)
  } catch (error) {
    debug.error('Failed to send a test event:', error)
    toast.error(t(outgoingWebhookErrorKey(error)))
  } finally {
    busy.value = false
  }
}

async function rotate(webhook: OutgoingWebhook) {
  const ok = await confirm({
    title: t('outgoingWebhooks.confirmRotate.title'),
    message: t('outgoingWebhooks.confirmRotate.message', { name: webhook.name }),
    confirmButtonText: t('outgoingWebhooks.confirmRotate.confirm'),
    dangerAction: true,
  })
  if (!ok) return
  busy.value = true
  try {
    const next = await rotateOutgoingWebhookSecret(webhook.id)
    replace(next)
    revealed.value = { name: next.name, secret: next.secret }
    toast.success(t('outgoingWebhooks.rotated'))
  } catch (error) {
    debug.error('Failed to rotate a webhook secret:', error)
    toast.error(t(outgoingWebhookErrorKey(error)))
  } finally {
    busy.value = false
  }
}

async function remove(webhook: OutgoingWebhook) {
  const ok = await confirm({
    title: t('outgoingWebhooks.confirmDelete.title'),
    message: t('outgoingWebhooks.confirmDelete.message', { name: webhook.name }),
    confirmButtonText: t('outgoingWebhooks.confirmDelete.confirm'),
    dangerAction: true,
  })
  if (!ok) return
  busy.value = true
  try {
    await deleteOutgoingWebhook(webhook.id)
    webhooks.value = webhooks.value.filter(w => w.id !== webhook.id)
    if (form.value?.id === webhook.id) form.value = null
    if (openLog.value === webhook.id) openLog.value = null
    revealed.value = null
    toast.success(t('outgoingWebhooks.deleted'))
  } catch (error) {
    debug.error('Failed to delete an outgoing webhook:', error)
    toast.error(t(outgoingWebhookErrorKey(error)))
  } finally {
    busy.value = false
  }
}

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    toast.success(t('outgoingWebhooks.copied'))
  } catch (error) {
    debug.error('Failed to copy a webhook secret:', error)
    toast.error(t('outgoingWebhooks.copyFailed'))
  }
}

watch(owner, () => {
  form.value = null
  revealed.value = null
  openLog.value = null
  void load()
}, { immediate: true })
</script>

<style scoped>
.ow-section {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.ow-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-4);
}

.ow-head-text {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  min-width: 0;
}

.ow-heading {
  margin: 0;
  font-size: 0.875rem;
  font-weight: 600;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.02em;
}

.ow-hint {
  margin: 0;
  font-size: var(--font-size-xs);
  color: var(--text-muted);
  line-height: 1.4;
}

.ow-form,
.ow-secret {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-4);
  background: var(--surface-inset);
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-md);
}

.ow-field {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.ow-field-label {
  font-size: var(--font-size-xs);
  font-weight: 600;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.02em;
}

.ow-input {
  width: 100%;
  background: var(--background-quinary);
  border: 1px solid var(--background-quinary);
  border-radius: 4px;
  padding: 8px 10px;
  color: var(--text-primary);
  font-size: var(--font-size-sm);
}

.ow-input:focus {
  outline: none;
  border-color: var(--harmony-primary);
}

.ow-events {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2) var(--space-4);
  margin: 0;
  padding: 0;
  border: none;
}

.ow-events legend {
  width: 100%;
  margin-bottom: var(--space-1);
}

.ow-check {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  font-size: var(--font-size-sm);
  color: var(--text-primary);
}

.ow-actions,
.ow-row-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: var(--space-2);
}

.ow-secret-title {
  margin: 0;
  font-size: var(--font-size-sm);
  font-weight: 600;
  color: var(--warning);
}

.ow-secret-value {
  display: block;
  padding: var(--space-2) var(--space-3);
  font-size: var(--font-size-xs);
  word-break: break-all;
  user-select: all;
  background: var(--background-tertiary);
  border-radius: var(--radius-base);
  color: var(--text-primary);
}

.ow-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin: 0;
  padding: 0;
  list-style: none;
}

.ow-row {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-3);
  background: var(--surface-inset);
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-md);
}

.ow-row-main {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
}

.ow-info {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.ow-name {
  font-size: var(--font-size-sm);
  font-weight: 600;
  color: var(--text-primary);
}

.ow-meta {
  font-size: var(--font-size-xs);
  color: var(--text-muted);
}

.ow-url {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.ow-warning {
  color: var(--warning);
}

.ow-btn {
  display: inline-flex;
  align-items: center;
  gap: var(--space-1);
  padding: 6px 12px;
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-base);
  background: var(--background-secondary);
  color: var(--text-primary);
  font-size: var(--font-size-sm);
  cursor: pointer;
}

.ow-btn-primary {
  background: var(--harmony-primary);
  border-color: var(--harmony-primary);
  color: var(--text-on-primary, #fff);
}

.ow-btn:disabled,
.ow-icon-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.ow-icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border: none;
  border-radius: var(--radius-base);
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
}

.ow-icon-btn:hover:not(:disabled) {
  background: var(--background-modifier-hover);
  color: var(--text-primary);
}

.ow-icon-btn.danger:hover:not(:disabled) {
  color: var(--danger);
}

.ow-switch {
  position: relative;
  flex-shrink: 0;
  width: 40px;
  height: 22px;
}

.ow-switch input {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  margin: 0;
  opacity: 0;
  cursor: pointer;
}

.ow-switch-slider {
  position: absolute;
  inset: 0;
  border-radius: 11px;
  background: var(--background-modifier-accent);
  transition: background 0.15s;
  pointer-events: none;
}

.ow-switch-slider::after {
  content: '';
  position: absolute;
  top: 3px;
  left: 3px;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: #fff;
  transition: transform 0.15s;
}

.ow-switch input:checked + .ow-switch-slider {
  background: var(--harmony-primary);
}

.ow-switch input:checked + .ow-switch-slider::after {
  transform: translateX(18px);
}

.ow-switch input:focus-visible + .ow-switch-slider {
  outline: 2px solid var(--harmony-primary);
  outline-offset: 2px;
}

.ow-log {
  overflow-x: auto;
}

.ow-log-table {
  width: 100%;
  border-collapse: collapse;
  font-size: var(--font-size-xs);
}

.ow-log-table th,
.ow-log-table td {
  padding: 4px 8px;
  text-align: left;
  border-bottom: 1px solid var(--border-primary);
  color: var(--text-secondary);
  white-space: nowrap;
}

.ow-status-delivered {
  color: var(--success);
}

.ow-status-failed {
  color: var(--danger);
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}

@media (max-width: 600px) {
  .ow-head {
    flex-direction: column;
  }
}
</style>
