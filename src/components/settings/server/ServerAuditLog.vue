<template>
  <div class="audit-log">
    <div class="settings-header">
      <h2 class="settings-title">{{ t('serverAuditLog.title') }}</h2>
      <p class="settings-description">{{ t('serverAuditLog.description') }}</p>
    </div>

    <div class="audit-filters">
      <select v-model="kind" class="audit-select" :aria-label="t('serverAuditLog.filters.action')" data-test="kind-filter">
        <option value="">{{ t('serverAuditLog.filters.allActions') }}</option>
        <option v-for="k in AUDIT_KINDS" :key="k" :value="k">{{ t(`serverAuditLog.kinds.${k}`) }}</option>
      </select>
      <select v-model="actorId" class="audit-select" :aria-label="t('serverAuditLog.filters.actor')" data-test="actor-filter">
        <option value="">{{ t('serverAuditLog.filters.allActors') }}</option>
        <option v-for="actor in actorChoices" :key="actor.id" :value="actor.id">{{ actor.name }}</option>
      </select>
      <button type="button" class="btn btn-secondary btn-sm" :disabled="loading" @click="load(true)">
        {{ t('serverAuditLog.refresh') }}
      </button>
    </div>

    <div v-if="loading && entries.length === 0" class="loading-state">
      <LoadingSpinner :size="20" />
    </div>

    <EmptyState
      v-else-if="error && entries.length === 0"
      tone="error"
      icon="alert-circle"
      :title="error"
      :action-label="t('common.retry')"
      @action="load(true)"
    />

    <EmptyState
      v-else-if="entries.length === 0"
      icon="shield"
      :title="t('serverAuditLog.empty.title')"
      :description="kind || actorId ? t('serverAuditLog.empty.filtered') : t('serverAuditLog.empty.description')"
    />

    <ul v-else class="audit-list">
      <li v-for="row in rows" :key="row.entry.id" class="audit-entry" data-test="audit-entry">
        <div class="audit-icon" aria-hidden="true">
          <Avatar v-if="row.avatar" :src="row.avatar" size="xs" />
          <Icon v-else :name="row.icon" :size="16" />
        </div>
        <div class="audit-body">
          <p class="audit-line">
            <span
              v-for="(segment, i) in row.segments"
              :key="i"
              :class="segment.role ? `audit-${segment.role}` : undefined"
            >{{ segment.text }}</span>
            <span v-if="row.entry.source === 'bot'" class="audit-badge">{{ t('serverAuditLog.botBadge') }}</span>
          </p>
          <ul v-if="row.changes.length" class="audit-changes">
            <li v-for="(change, i) in row.changes" :key="i" class="audit-change">
              <span class="audit-field">{{ change.field }}</span>
              <template v-if="change.added || change.removed">
                <span v-for="name in change.added" :key="`+${name}`" class="audit-perm added">+{{ name }}</span>
                <span v-for="name in change.removed" :key="`-${name}`" class="audit-perm removed">−{{ name }}</span>
              </template>
              <template v-else>
                <span v-if="change.from !== null" class="audit-old">{{ change.from }}</span>
                <span v-if="change.from !== null && change.to !== null" class="audit-arrow" aria-hidden="true">→</span>
                <span v-if="change.to !== null" class="audit-new">{{ change.to }}</span>
              </template>
            </li>
          </ul>
          <p v-if="row.entry.reason" class="audit-reason">{{ t('serverAuditLog.reason', { reason: row.entry.reason }) }}</p>
        </div>
        <time class="audit-time" :datetime="row.entry.created_at" :title="formatFull(row.entry.created_at)">
          {{ formatRelative(row.entry.created_at) }}
        </time>
      </li>
    </ul>

    <p v-if="error && entries.length > 0" class="audit-error" role="alert">{{ error }}</p>

    <div v-if="hasMore && entries.length > 0" class="load-more">
      <button type="button" class="btn btn-secondary btn-sm" :disabled="loading" data-test="load-more" @click="load(false)">
        {{ t('serverAuditLog.loadMore') }}
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import Avatar from '@/components/common/Avatar.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import Icon from '@/components/common/Icon.vue'
import LoadingSpinner from '@/components/common/LoadingSpinner.vue'
import { debug } from '@/utils/debug'
import { formatFullDateTime, formatShortRelativeTime } from '@/utils/shortRelativeTime'
import {
  AUDIT_KINDS,
  auditActorName,
  auditChangeLines,
  describeAuditEntry,
  type AuditTranslate,
} from '@/utils/serverAuditLog'
import { AUDIT_PAGE_SIZE, getServerAuditLog, type ServerAuditEntry } from '@/services/ServerAuditLogService'

const props = defineProps<{ serverId: string }>()

const i18n = useI18n()
const t = i18n.t as unknown as AuditTranslate
const locale = computed(() => String(i18n.locale?.value ?? 'en'))

const entries = ref<ServerAuditEntry[]>([])
const loading = ref(false)
const error = ref('')
const hasMore = ref(false)
const kind = ref('')
const actorId = ref('')
const actors = ref(new Map<string, string>())
let requestSeq = 0

const KIND_ICONS: Record<string, string> = {
  channel: 'hash',
  category: 'layers',
  override: 'lock',
  role: 'tag',
  member: 'users',
  message: 'trash',
  server: 'server',
  settings: 'settings',
  invite: 'link',
  emoji: 'smile',
  bot: 'bot-message-square',
}

function formatRelative(iso: string): string {
  return formatShortRelativeTime(iso, { locale: locale.value, nowLabel: t('time.now') })
}

function formatFull(iso: string): string {
  return formatFullDateTime(iso, locale.value)
}

const rows = computed(() =>
  entries.value.map(entry => ({
    entry,
    avatar: entry.actor_id ? entry.actor_avatar_url : entry.actor_bot_id ? entry.actor_bot_avatar_url : null,
    icon: KIND_ICONS[entry.action.split('.')[0]] ?? 'activity',
    segments: describeAuditEntry(entry, t, formatFull),
    changes: auditChangeLines(entry, t, formatFull),
  })),
)

const actorChoices = computed(() =>
  [...actors.value.entries()]
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name)),
)

function rememberActors(page: ServerAuditEntry[]) {
  let added = false
  const next = new Map(actors.value)
  for (const entry of page) {
    if (entry.actor_id && !next.has(entry.actor_id)) {
      next.set(entry.actor_id, auditActorName(entry, t))
      added = true
    }
  }
  if (added) actors.value = next
}

async function load(reset: boolean) {
  const seq = ++requestSeq
  loading.value = true
  error.value = ''
  try {
    const before = reset ? null : entries.value[entries.value.length - 1]?.created_at ?? null
    const page = await getServerAuditLog(props.serverId, {
      before,
      limit: AUDIT_PAGE_SIZE,
      action: kind.value || null,
      actorId: actorId.value || null,
    })
    if (seq !== requestSeq) return
    entries.value = reset ? page : [...entries.value, ...page]
    hasMore.value = page.length === AUDIT_PAGE_SIZE
    rememberActors(page)
  } catch (err) {
    if (seq !== requestSeq) return
    debug.warn('Audit log unavailable:', err)
    error.value = t('serverAuditLog.loadError')
  } finally {
    if (seq === requestSeq) loading.value = false
  }
}

watch([kind, actorId], () => {
  entries.value = []
  void load(true)
})

watch(
  () => props.serverId,
  () => {
    actors.value = new Map()
    kind.value = ''
    actorId.value = ''
    entries.value = []
    void load(true)
  },
)

onMounted(() => load(true))
</script>

<style scoped>
.audit-log {
  padding: 0;
}

.settings-header {
  margin-bottom: 16px;
}

.settings-title {
  font-size: var(--font-size-2xl);
  font-weight: var(--font-weight-semibold);
  color: var(--text-primary);
  margin: 0 0 8px;
}

.settings-description {
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
  margin: 0;
}

.audit-filters {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  margin-bottom: 16px;
}

.audit-select {
  min-width: 160px;
  padding: 6px 10px;
  background: var(--bg-tertiary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-sm);
  color: var(--text-primary);
  font-size: var(--font-size-sm);
}

.loading-state {
  display: flex;
  justify-content: center;
  padding: 48px 16px;
}

.audit-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.audit-entry {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  padding: 10px 12px;
  background: var(--bg-tertiary);
  border-radius: var(--radius-base);
}

.audit-icon {
  flex-shrink: 0;
  width: 20px;
  height: 20px;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-muted);
  margin-top: 1px;
}

.audit-body {
  flex: 1;
  min-width: 0;
}

.audit-line {
  margin: 0;
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
  overflow-wrap: anywhere;
}

.audit-actor,
.audit-target,
.audit-subject {
  color: var(--text-primary);
  font-weight: var(--font-weight-semibold);
}

.audit-badge {
  margin-left: 6px;
  padding: 0 4px;
  border-radius: 4px;
  background: var(--background-tertiary);
  color: var(--text-secondary);
  font-size: 0.65rem;
  font-weight: 700;
  text-transform: uppercase;
  vertical-align: middle;
}

.audit-changes {
  list-style: none;
  margin: 4px 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.audit-change {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 6px;
  font-size: 0.78rem;
  color: var(--text-muted);
}

.audit-field {
  color: var(--text-secondary);
}

.audit-field::after {
  content: ':';
}

.audit-old {
  text-decoration: line-through;
  overflow-wrap: anywhere;
}

.audit-new {
  color: var(--text-primary);
  overflow-wrap: anywhere;
}

.audit-perm.added {
  color: var(--success);
}

.audit-perm.removed {
  color: var(--error);
}

.audit-reason {
  margin: 4px 0 0;
  font-size: 0.78rem;
  color: var(--text-muted);
  font-style: italic;
  overflow-wrap: anywhere;
}

.audit-time {
  flex-shrink: 0;
  font-size: 0.75rem;
  color: var(--text-muted);
  white-space: nowrap;
}

.audit-error {
  margin: 8px 0 0;
  font-size: var(--font-size-sm);
  color: var(--error);
}

.load-more {
  display: flex;
  justify-content: center;
  margin-top: 12px;
}

@media (max-width: 768px) {
  .audit-select {
    flex: 1;
    min-width: 0;
  }
}
</style>
