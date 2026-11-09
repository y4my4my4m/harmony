<!--
  Bulk suspension, unsuspension or deletion. The list comes from the server's preview: who changes,
  who is left out and why, the servers they own, then what happens and one required reason.
-->
<template>
  <BaseModal
    :show="show"
    :title="title"
    icon="shield"
    role="alertdialog"
    overlay-class="bulk-suspend-dialog"
    @close="cancel"
  >
    <div class="bulk" data-testid="bulk-suspend-dialog">
      <div v-if="loading" class="bulk-loading"><LoadingSpinner :size="20" /></div>
      <p v-else-if="loadError" class="bulk-error" role="alert">{{ loadError }}</p>
      <template v-else>
        <section v-if="affected.length" :aria-labelledby="`${uid}-affected`">
          <h3 :id="`${uid}-affected`" class="bulk-heading">
            {{ t(COPY[action].affected) }}
          </h3>
          <ul class="bulk-list" data-testid="bulk-affected">
            <li v-for="row in affected" :key="row.id" class="bulk-item">
              <span class="bulk-name">@{{ row.username }}</span>
              <span class="bulk-meta">
                {{ t('adminSignups.dialog.activity', { posts: row.post_count, messages: row.message_count }) }}
              </span>
            </li>
          </ul>
        </section>
        <p v-else class="bulk-note" data-testid="bulk-nothing">{{ t('adminSignups.dialog.nothing') }}</p>

        <section v-if="skipped.length" :aria-labelledby="`${uid}-skipped`">
          <h3 :id="`${uid}-skipped`" class="bulk-heading">{{ t('adminSignups.dialog.skippedTitle') }}</h3>
          <ul class="bulk-list" data-testid="bulk-skipped">
            <li v-for="row in skipped" :key="row.id" class="bulk-item">
              <span class="bulk-name">{{ row.username ? `@${row.username}` : row.id }}</span>
              <span class="bulk-meta">{{ t(`adminSignups.dialog.skip.${row.skip_reason}`) }}</span>
            </li>
          </ul>
        </section>

        <section v-if="action !== 'unsuspend' && ownedServers.length" :aria-labelledby="`${uid}-owned`">
          <h3 :id="`${uid}-owned`" class="bulk-heading">
            {{ t(action === 'delete' ? 'adminSignups.dialog.ownedDeleteTitle' : 'adminSignups.dialog.ownedTitle') }}
          </h3>
          <p v-if="action === 'suspend'" class="bulk-note">{{ t('adminSignups.dialog.ownedHint') }}</p>
          <ul class="bulk-list" data-testid="bulk-owned">
            <li v-for="server in ownedServers" :key="server.id" class="bulk-item">
              <span class="bulk-name">{{ server.name }}</span>
              <span class="bulk-meta">
                @{{ server.owner }} ·
                {{ t('adminSignups.dialog.ownedMembers', { count: server.member_count }, server.member_count) }}
                <template v-if="server.suspended"> · {{ t('adminSignups.rows.suspended') }}</template>
              </span>
            </li>
          </ul>
        </section>

        <ul v-if="affected.length" class="bulk-consequences" data-testid="bulk-consequences">
          <template v-if="action === 'delete'">
            <li>{{ t('adminSignups.dialog.consequences.deleteSignIn') }}</li>
            <li>{{ t('adminSignups.dialog.consequences.deleteNames') }}</li>
            <li>{{ t('adminSignups.dialog.consequences.deleteContent') }}</li>
            <li>{{ t('adminSignups.dialog.consequences.deleteFederation') }}</li>
          </template>
          <template v-else-if="action === 'suspend'">
            <li>{{ t('adminSignups.dialog.consequences.signedOut') }}</li>
            <li>{{ t('adminSignups.dialog.consequences.follows', { count: followsLost }, followsLost) }}</li>
            <li>{{ t('adminSignups.dialog.consequences.timelines') }}</li>
            <li>{{ t('adminSignups.dialog.consequences.federation') }}</li>
          </template>
          <li v-else>{{ t('adminSignups.dialog.consequences.unsuspend') }}</li>
        </ul>

        <label v-if="affected.length" class="bulk-field" :for="`${uid}-reason`">
          <span class="bulk-label">{{ t('adminSignups.dialog.reason') }}</span>
          <textarea
            :id="`${uid}-reason`"
            v-model="reason"
            class="bulk-input"
            rows="2"
            maxlength="512"
            required
            :aria-describedby="`${uid}-reason-hint`"
            data-testid="bulk-reason"
          />
          <span :id="`${uid}-reason-hint`" class="bulk-hint">{{ t('adminSignups.dialog.reasonHint') }}</span>
        </label>

        <label v-if="action === 'delete' && affected.length" class="bulk-understand">
          <input v-model="understood" type="checkbox" data-testid="bulk-understand" />
          <span>{{ t('adminSignups.dialog.deleteUnderstand') }}</span>
        </label>

        <p v-if="error" class="bulk-error" role="alert">{{ error }}</p>
      </template>
    </div>

    <template #footer>
      <button type="button" class="btn btn-secondary" :disabled="busy" @click="cancel">{{ t('common.cancel') }}</button>
      <button
        type="button"
        class="btn"
        :class="action === 'unsuspend' ? 'btn-primary' : 'btn-danger'"
        :disabled="busy || loading || !affected.length || !reason.trim() || (action === 'delete' && !understood)"
        :aria-busy="busy || undefined"
        data-testid="bulk-confirm"
        @click="run"
      >{{ confirmLabel }}</button>
    </template>
  </BaseModal>
</template>

<script setup lang="ts">
import { computed, ref, useId, watch } from 'vue'
import BaseModal from '@/components/common/BaseModal.vue'
import LoadingSpinner from '@/components/common/LoadingSpinner.vue'
import { useT } from '@/composables/useT'
import { debug } from '@/utils/debug'
import {
  bulkDeleteAccounts,
  bulkSetSuspended,
  previewBulkDelete,
  previewBulkSuspend,
  type BulkAction,
  type BulkPreviewRow,
} from '@/services/SignupReviewService'

const props = defineProps<{
  show: boolean
  ids: string[]
  action: BulkAction
}>()

const emit = defineEmits<{
  close: []
  done: [result: { action: BulkAction; count: number }]
}>()

const COPY: Record<BulkAction, { title: string; affected: string; confirm: string }> = {
  suspend: {
    title: 'adminSignups.dialog.suspendTitle',
    affected: 'adminSignups.dialog.affectedSuspend',
    confirm: 'adminSignups.dialog.confirmSuspend',
  },
  unsuspend: {
    title: 'adminSignups.dialog.unsuspendTitle',
    affected: 'adminSignups.dialog.affectedUnsuspend',
    confirm: 'adminSignups.dialog.confirmUnsuspend',
  },
  delete: {
    title: 'adminSignups.dialog.deleteTitle',
    affected: 'adminSignups.dialog.affectedDelete',
    confirm: 'adminSignups.dialog.confirmDelete',
  },
}

const { t } = useT()
const uid = `bulk-suspend-${useId()}`

const rows = ref<BulkPreviewRow[]>([])
const loading = ref(false)
const loadError = ref('')
const reason = ref('')
const understood = ref(false)
const busy = ref(false)
const error = ref('')

const affected = computed(() => rows.value.filter((row) => !row.skip_reason))
const skipped = computed(() => rows.value.filter((row) => !!row.skip_reason))
const followsLost = computed(() => affected.value.reduce((sum, row) => sum + row.local_follows, 0))
const ownedServers = computed(() => affected.value.flatMap((row) =>
  row.owned_servers.map((server) => ({ ...server, owner: row.username }))))

const count = computed(() => (loading.value ? props.ids.length : affected.value.length))
const title = computed(() => t(COPY[props.action].title, { count: count.value }, count.value))
const confirmLabel = computed(() => t(COPY[props.action].confirm, { count: affected.value.length }, affected.value.length))

let loadSeq = 0
async function load() {
  const seq = ++loadSeq
  loading.value = true
  loadError.value = ''
  error.value = ''
  reason.value = ''
  understood.value = false
  rows.value = []
  try {
    const result = props.action === 'delete'
      ? await previewBulkDelete(props.ids)
      : await previewBulkSuspend(props.ids, props.action === 'suspend')
    if (seq === loadSeq) rows.value = result
  } catch (e) {
    if (seq !== loadSeq) return
    debug.error('Bulk suspension preview failed:', e)
    loadError.value = t('adminSignups.dialog.failed', { error: e instanceof Error ? e.message : String(e) })
  } finally {
    if (seq === loadSeq) loading.value = false
  }
}

watch(() => props.show, (open) => { if (open) void load() }, { immediate: true })

function cancel() {
  if (!busy.value) emit('close')
}

async function run() {
  const text = reason.value.trim()
  if (busy.value || !text || !affected.value.length || (props.action === 'delete' && !understood.value)) return
  busy.value = true
  error.value = ''
  try {
    const ids = affected.value.map((row) => row.id)
    const count = props.action === 'delete'
      ? (await bulkDeleteAccounts(ids, text)).deleted.length
      : (await bulkSetSuspended(ids, props.action === 'suspend', text)).changed.length
    emit('done', { action: props.action, count })
  } catch (e) {
    debug.error('Bulk action failed:', e)
    error.value = t('adminSignups.dialog.failed', { error: e instanceof Error ? e.message : String(e) })
  } finally {
    busy.value = false
  }
}
</script>

<style scoped>
.bulk {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.bulk-loading {
  display: flex;
  justify-content: center;
  padding: 24px;
}

.bulk-heading {
  margin: 0 0 8px;
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
}

.bulk-list {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 200px;
  overflow-y: auto;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-base);
}

.bulk-item {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  gap: 4px 12px;
  padding: 6px 12px;
  font-size: 13px;
}

.bulk-item + .bulk-item {
  border-top: 1px solid var(--border-color);
}

.bulk-name {
  color: var(--text-primary);
  overflow-wrap: anywhere;
}

.bulk-meta,
.bulk-note,
.bulk-hint {
  color: var(--text-secondary);
  font-size: 13px;
}

.bulk-note {
  margin: 0 0 8px;
}

.bulk-consequences {
  margin: 0;
  padding-left: 20px;
  color: var(--text-primary);
  font-size: 14px;
  line-height: 1.5;
}

.bulk-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.bulk-label {
  font-size: 14px;
  font-weight: 600;
  color: var(--text-primary);
}

.bulk-input {
  width: 100%;
  padding: 8px 12px;
  background: var(--background-tertiary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-base);
  color: var(--text-primary);
  font: inherit;
  resize: vertical;
}

.bulk-understand {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 14px;
  color: var(--text-primary);
}

.bulk-error {
  margin: 0;
  color: var(--text-danger);
  font-size: 14px;
}
</style>
