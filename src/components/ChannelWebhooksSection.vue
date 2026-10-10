<template>
  <section class="webhooks-section" :aria-labelledby="headingId">
    <div class="webhooks-head">
      <div class="webhooks-head-text">
        <h3 :id="headingId" class="webhooks-heading">{{ t('webhooks.heading') }}</h3>
        <p class="webhooks-hint">{{ t('webhooks.intro') }}</p>
      </div>
      <button
        v-if="!form || form.mode !== 'create'"
        type="button"
        class="wh-btn wh-btn-primary"
        data-testid="webhook-new"
        :disabled="loading || atLimit || busy"
        @click="startCreate"
      >
        <Icon name="plus" :size="14" />
        {{ t('webhooks.create') }}
      </button>
    </div>
    <p v-if="atLimit" class="webhooks-hint">{{ t('webhooks.limitReached', { count: MAX_WEBHOOKS_PER_CHANNEL }) }}</p>

    <form v-if="form" class="webhook-form" data-testid="webhook-form" @submit.prevent="submitForm">
      <label class="webhook-field">
        <span class="webhook-field-label">{{ t('webhooks.nameLabel') }}</span>
        <input v-model="form.name" type="text" class="webhook-input" maxlength="80" data-testid="webhook-name" required />
      </label>
      <label class="webhook-field">
        <span class="webhook-field-label">{{ t('webhooks.avatarLabel') }}</span>
        <input
          v-model="form.avatarUrl"
          type="url"
          class="webhook-input"
          maxlength="2048"
          :placeholder="t('webhooks.avatarPlaceholder')"
          data-testid="webhook-avatar"
        />
      </label>
      <div class="webhook-form-actions">
        <button type="button" class="wh-btn" @click="form = null">{{ t('webhooks.cancel') }}</button>
        <button type="submit" class="wh-btn wh-btn-primary" data-testid="webhook-submit" :disabled="busy || !form.name.trim()">
          {{ form.mode === 'create' ? t('webhooks.createSubmit') : t('webhooks.save') }}
        </button>
      </div>
    </form>

    <div v-if="revealed" class="webhook-secret" role="status" data-testid="webhook-secret">
      <p class="webhook-secret-title">{{ t('webhooks.copyOnce', { name: revealed.name }) }}</p>
      <code class="webhook-secret-url" data-testid="webhook-url">{{ revealed.url }}</code>
      <p class="webhooks-hint">{{ t('webhooks.githubHint') }}</p>
      <div class="webhook-form-actions">
        <button type="button" class="wh-btn" @click="copy(`${revealed.url}/github`)">
          <Icon name="copy" :size="14" />
          {{ t('webhooks.copyGithubUrl') }}
        </button>
        <button type="button" class="wh-btn wh-btn-primary" data-testid="webhook-copy" @click="copy(revealed.url)">
          <Icon name="copy" :size="14" />
          {{ t('webhooks.copyUrl') }}
        </button>
        <button type="button" class="wh-btn" @click="revealed = null">{{ t('webhooks.done') }}</button>
      </div>
    </div>

    <p v-if="loading" class="webhooks-hint">{{ t('webhooks.loading') }}</p>
    <p v-else-if="loadError" class="webhooks-hint" role="alert">{{ t(loadError) }}</p>
    <p v-else-if="webhooks.length === 0" class="webhooks-hint" data-testid="webhook-empty">{{ t('webhooks.empty') }}</p>
    <ul v-else class="webhook-list">
      <li v-for="webhook in webhooks" :key="webhook.id" class="webhook-row" :data-testid="`webhook-${webhook.id}`">
        <Avatar :src="webhook.avatar_url" size="sm" :alt="webhook.name" />
        <div class="webhook-info">
          <span class="webhook-name">{{ webhook.name }}</span>
          <span class="webhook-meta">
            {{ creatorLine(webhook) }} · {{ lastUsedLine(webhook) }}
          </span>
          <span class="webhook-meta webhook-hint-line">{{ t('webhooks.urlHint', { hint: webhook.token_hint }) }}</span>
        </div>
        <div class="webhook-actions">
          <button
            type="button"
            class="wh-icon-btn"
            :title="t('webhooks.edit')"
            :aria-label="t('webhooks.edit')"
            :disabled="busy"
            @click="startEdit(webhook)"
          ><Icon name="pencil" :size="16" /></button>
          <button
            type="button"
            class="wh-icon-btn"
            :title="t('webhooks.regenerate')"
            :aria-label="t('webhooks.regenerate')"
            :data-testid="`webhook-regenerate-${webhook.id}`"
            :disabled="busy"
            @click="regenerate(webhook)"
          ><Icon name="refresh-cw" :size="16" /></button>
          <button
            type="button"
            class="wh-icon-btn danger"
            :title="t('webhooks.delete')"
            :aria-label="t('webhooks.delete')"
            :data-testid="`webhook-delete-${webhook.id}`"
            :disabled="busy"
            @click="remove(webhook)"
          ><Icon name="trash-2" :size="16" /></button>
        </div>
      </li>
    </ul>
  </section>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import { useToast } from 'vue-toastification'
import Avatar from '@/components/common/Avatar.vue'
import Icon from '@/components/common/Icon.vue'
import { useConfirmDialog } from '@/composables/useConfirmDialog'
import {
  MAX_WEBHOOKS_PER_CHANNEL,
  channelWebhookUrl,
  createChannelWebhook,
  deleteChannelWebhook,
  listChannelWebhooks,
  regenerateChannelWebhookToken,
  updateChannelWebhook,
  webhookErrorKey,
  type ChannelWebhook,
  type ChannelWebhookWithToken,
} from '@/services/channelWebhookService'
import { debug } from '@/utils/debug'

const props = defineProps<{ channelId: string }>()

const { t, locale } = useI18n()
const toast = useToast()
const { confirm } = useConfirmDialog()

const headingId = `channel-webhooks-${Math.random().toString(36).slice(2, 8)}`
const webhooks = ref<ChannelWebhook[]>([])
const loading = ref(false)
const loadError = ref<string | null>(null)
const busy = ref(false)
/** The URL of a webhook just created or regenerated; the token is not readable afterwards. */
const revealed = ref<{ name: string; url: string } | null>(null)
const form = ref<{ mode: 'create' | 'edit'; id?: string; name: string; avatarUrl: string } | null>(null)

const atLimit = computed(() => webhooks.value.length >= MAX_WEBHOOKS_PER_CHANNEL)

function creatorLine(webhook: ChannelWebhook): string {
  const name = webhook.created_by_display_name || webhook.created_by_username
  return name ? t('webhooks.createdBy', { name }) : t('webhooks.createdByUnknown')
}

function lastUsedLine(webhook: ChannelWebhook): string {
  if (!webhook.last_used_at) return t('webhooks.neverUsed')
  const date = new Date(webhook.last_used_at).toLocaleString(locale.value, { dateStyle: 'medium', timeStyle: 'short' })
  return t('webhooks.lastUsed', { date })
}

async function load() {
  loading.value = true
  loadError.value = null
  try {
    webhooks.value = await listChannelWebhooks(props.channelId)
  } catch (error) {
    debug.error('Failed to load channel webhooks:', error)
    const key = webhookErrorKey(error)
    loadError.value = key === 'webhooks.errors.saveFailed' ? 'webhooks.loadFailed' : key
    webhooks.value = []
  } finally {
    loading.value = false
  }
}

function reveal(webhook: ChannelWebhookWithToken) {
  revealed.value = { name: webhook.name, url: channelWebhookUrl(webhook.id, webhook.token) }
}

function startCreate() {
  revealed.value = null
  form.value = { mode: 'create', name: t('webhooks.defaultName'), avatarUrl: '' }
}

function startEdit(webhook: ChannelWebhook) {
  form.value = { mode: 'edit', id: webhook.id, name: webhook.name, avatarUrl: webhook.avatar_url ?? '' }
}

function replace(webhook: ChannelWebhook) {
  const { token: _token, ...row } = webhook as ChannelWebhookWithToken
  webhooks.value = webhooks.value.map(w => (w.id === row.id ? row : w))
}

async function submitForm() {
  const current = form.value
  if (!current || busy.value) return
  busy.value = true
  try {
    if (current.mode === 'create') {
      const created = await createChannelWebhook(props.channelId, current.name.trim(), current.avatarUrl.trim() || null)
      const { token: _token, ...row } = created
      webhooks.value = [...webhooks.value, row]
      reveal(created)
      toast.success(t('webhooks.created'))
    } else if (current.id) {
      replace(await updateChannelWebhook(current.id, { name: current.name.trim(), avatarUrl: current.avatarUrl.trim() }))
      toast.success(t('webhooks.updated'))
    }
    form.value = null
  } catch (error) {
    debug.error('Failed to save channel webhook:', error)
    toast.error(t(webhookErrorKey(error)))
  } finally {
    busy.value = false
  }
}

async function regenerate(webhook: ChannelWebhook) {
  const ok = await confirm({
    title: t('webhooks.confirmRegenerate.title'),
    message: t('webhooks.confirmRegenerate.message', { name: webhook.name }),
    confirmButtonText: t('webhooks.confirmRegenerate.confirm'),
    dangerAction: true,
  })
  if (!ok) return
  busy.value = true
  try {
    const next = await regenerateChannelWebhookToken(webhook.id)
    replace(next)
    reveal(next)
    toast.success(t('webhooks.regenerated'))
  } catch (error) {
    debug.error('Failed to regenerate a webhook token:', error)
    toast.error(t(webhookErrorKey(error)))
  } finally {
    busy.value = false
  }
}

async function remove(webhook: ChannelWebhook) {
  const ok = await confirm({
    title: t('webhooks.confirmDelete.title'),
    message: t('webhooks.confirmDelete.message', { name: webhook.name }),
    confirmButtonText: t('webhooks.confirmDelete.confirm'),
    dangerAction: true,
  })
  if (!ok) return
  busy.value = true
  try {
    await deleteChannelWebhook(webhook.id)
    webhooks.value = webhooks.value.filter(w => w.id !== webhook.id)
    if (form.value?.id === webhook.id) form.value = null
    revealed.value = null
    toast.success(t('webhooks.deleted'))
  } catch (error) {
    debug.error('Failed to delete a webhook:', error)
    toast.error(t(webhookErrorKey(error)))
  } finally {
    busy.value = false
  }
}

async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text)
    toast.success(t('webhooks.copied'))
  } catch (error) {
    debug.error('Failed to copy a webhook URL:', error)
    toast.error(t('webhooks.copyFailed'))
  }
}

watch(() => props.channelId, () => {
  form.value = null
  revealed.value = null
  void load()
}, { immediate: true })
</script>

<style scoped>
.webhooks-section {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.webhooks-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: var(--space-4);
}

.webhooks-head-text {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  min-width: 0;
}

.webhooks-heading {
  margin: 0;
  font-size: 0.875rem;
  font-weight: 600;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.02em;
}

.webhooks-hint {
  margin: 0;
  font-size: var(--font-size-xs);
  color: var(--text-muted);
  line-height: 1.4;
}

.webhook-form,
.webhook-secret {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
  padding: var(--space-4);
  background: var(--surface-inset);
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-md);
}

.webhook-field {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
}

.webhook-field-label {
  font-size: var(--font-size-xs);
  font-weight: 600;
  color: var(--text-secondary);
  text-transform: uppercase;
  letter-spacing: 0.02em;
}

.webhook-input {
  width: 100%;
  background: var(--background-quinary);
  border: 1px solid var(--background-quinary);
  border-radius: 4px;
  padding: 8px 10px;
  color: var(--text-primary);
  font-size: var(--font-size-sm);
}

.webhook-input:focus {
  outline: none;
  border-color: var(--harmony-primary);
}

.webhook-form-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: var(--space-2);
}

.webhook-secret-title {
  margin: 0;
  font-size: var(--font-size-sm);
  font-weight: 600;
  color: var(--warning);
}

.webhook-secret-url {
  display: block;
  padding: var(--space-2) var(--space-3);
  font-size: var(--font-size-xs);
  word-break: break-all;
  user-select: all;
  background: var(--background-tertiary);
  border-radius: var(--radius-base);
  color: var(--text-primary);
}

.webhook-list {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  margin: 0;
  padding: 0;
  list-style: none;
}

.webhook-row {
  display: flex;
  align-items: center;
  gap: var(--space-3);
  padding: var(--space-3);
  background: var(--surface-inset);
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-md);
}

.webhook-info {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.webhook-name {
  font-size: var(--font-size-sm);
  font-weight: 600;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.webhook-meta {
  font-size: var(--font-size-xs);
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.webhook-hint-line {
  font-family: var(--font-mono, ui-monospace, monospace);
}

.webhook-actions {
  display: flex;
  gap: var(--space-1);
  flex-shrink: 0;
}

.wh-btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border: none;
  border-radius: 4px;
  font-size: var(--font-size-sm);
  font-weight: 500;
  cursor: pointer;
  background: var(--background-quinary);
  color: var(--text-primary);
  white-space: nowrap;
}

.wh-btn-primary {
  background: var(--harmony-primary);
  color: var(--text-on-primary);
}

.wh-btn-primary:hover:not(:disabled) {
  background: var(--harmony-primary-hover);
}

.wh-btn:disabled,
.wh-icon-btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.wh-icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 32px;
  height: 32px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
}

.wh-icon-btn:hover:not(:disabled) {
  background: var(--background-quinary);
  color: var(--text-primary);
}

.wh-icon-btn.danger:hover:not(:disabled) {
  color: var(--error);
}
</style>
