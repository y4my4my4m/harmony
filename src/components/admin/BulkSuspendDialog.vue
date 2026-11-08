<!--
  Bulk suspension or unsuspension. The list comes from the server's preview: who changes, who is
  left out and why, the servers they own, then what happens and one required reason.
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
            {{ t(suspending ? 'adminSignups.dialog.affectedSuspend' : 'adminSignups.dialog.affectedUnsuspend') }}
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

        <section v-if="suspending && ownedServers.length" :aria-labelledby="`${uid}-owned`">
          <h3 :id="`${uid}-owned`" class="bulk-heading">{{ t('adminSignups.dialog.ownedTitle') }}</h3>
          <p class="bulk-note">{{ t('adminSignups.dialog.ownedHint') }}</p>
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
          <template v-if="suspending">
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

        <p v-if="error" class="bulk-error" role="alert">{{ error }}</p>
      </template>
    </div>

    <template #footer>
      <button type="button" class="btn btn-secondary" :disabled="busy" @click="cancel">{{ t('common.cancel') }}</button>
      <button
        type="button"
        class="btn"
        :class="suspending ? 'btn-danger' : 'btn-primary'"
        :disabled="busy || loading || !affected.length || !reason.trim()"
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
  bulkSetSuspended,
  previewBulkSuspend,
  type BulkPreviewRow,
  type BulkResult,
} from '@/services/SignupReviewService'

const props = defineProps<{
  show: boolean
  ids: string[]
  suspending: boolean
}>()

const emit = defineEmits<{
  close: []
  done: [result: BulkResult]
}>()

const { t } = useT()
const uid = `bulk-suspend-${useId()}`

const rows = ref<BulkPreviewRow[]>([])
const loading = ref(false)
const loadError = ref('')
const reason = ref('')
const busy = ref(false)
const error = ref('')

const affected = computed(() => rows.value.filter((row) => !row.skip_reason))
const skipped = computed(() => rows.value.filter((row) => !!row.skip_reason))
const followsLost = computed(() => affected.value.reduce((sum, row) => sum + row.local_follows, 0))
const ownedServers = computed(() => affected.value.flatMap((row) =>
  row.owned_servers.map((server) => ({ ...server, owner: row.username }))))

const count = computed(() => (loading.value ? props.ids.length : affected.value.length))
const title = computed(() => t(
  props.suspending ? 'adminSignups.dialog.suspendTitle' : 'adminSignups.dialog.unsuspendTitle',
  { count: count.value }, count.value))
const confirmLabel = computed(() => t(
  props.suspending ? 'adminSignups.dialog.confirmSuspend' : 'adminSignups.dialog.confirmUnsuspend',
  { count: affected.value.length }, affected.value.length))

let loadSeq = 0
async function load() {
  const seq = ++loadSeq
  loading.value = true
  loadError.value = ''
  error.value = ''
  reason.value = ''
  rows.value = []
  try {
    const result = await previewBulkSuspend(props.ids, props.suspending)
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
  if (busy.value || !text || !affected.value.length) return
  busy.value = true
  error.value = ''
  try {
    const result = await bulkSetSuspended(affected.value.map((row) => row.id), props.suspending, text)
    emit('done', result)
  } catch (e) {
    debug.error('Bulk suspension failed:', e)
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

.bulk-error {
  margin: 0;
  color: var(--text-danger);
  font-size: 14px;
}
</style>
