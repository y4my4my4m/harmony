<!--
  "Servers from other instances": every server hosted elsewhere that this instance holds a copy
  of, with its members from here and this instance's block, media and keep-out state. Manage
  opens the server's "On {instance}" panel. Instance admins and moderators.
-->
<template>
  <div class="admin-module remote-servers-module" data-testid="remote-servers-admin">
    <div class="module-header">
      <Icon name="globe" :size="20" />
      <h2>{{ t('instanceServer.dashboard.title') }}</h2>
      <button type="button" class="action-btn" :disabled="loading" @click="load">
        <Icon v-if="loading" name="loader" :size="16" class="spin" />
        <Icon v-else name="refresh-cw" :size="16" />
        {{ t('instanceServer.dashboard.refresh') }}
      </button>
    </div>
    <p class="module-hint">{{ t('instanceServer.dashboard.description', { instance }) }}</p>

    <div class="filters">
      <label class="sr-only" :for="`${uid}-search`">{{ t('instanceServer.dashboard.search') }}</label>
      <input
        :id="`${uid}-search`"
        v-model="query"
        type="search"
        class="search-input"
        :placeholder="t('instanceServer.dashboard.searchHint')"
        data-testid="remote-servers-search"
      />
      <label class="sr-only" :for="`${uid}-filter`">{{ t('instanceServer.dashboard.filter') }}</label>
      <select :id="`${uid}-filter`" v-model="filter" class="filter-select" data-testid="remote-servers-filter">
        <option value="all">{{ t('instanceServer.dashboard.filterAll') }}</option>
        <option value="blocked">{{ t('instanceServer.state.blocked') }}</option>
        <option value="media">{{ t('instanceServer.state.mediaHidden') }}</option>
      </select>
    </div>

    <div v-if="loading && servers.length === 0" class="loading-state" role="status">
      <LoadingSpinner :size="20" />
    </div>
    <EmptyState
      v-else-if="error"
      tone="error"
      icon="alert-circle"
      :title="error"
      :action-label="t('common.retry')"
      @action="load"
    />
    <EmptyState
      v-else-if="servers.length === 0"
      icon="globe"
      :title="t('instanceServer.dashboard.empty', { instance })"
    />
    <EmptyState
      v-else-if="shown.length === 0"
      icon="search"
      :title="t('instanceServer.dashboard.noMatch')"
    />
    <ul v-else class="server-list">
      <li
        v-for="server in shown"
        :key="server.server_id"
        class="server-row"
        data-testid="remote-server-row"
        :data-server-id="server.server_id"
      >
        <img :src="getServerIconUrl(server.icon, 96, server.name)" alt="" class="server-icon" />
        <div class="server-details">
          <span class="server-name">{{ server.name }}</span>
          <span class="server-meta">
            {{ server.host }} ·
            {{ t('instanceServer.panel.localMembers', { count: server.local_members, instance }, server.local_members) }}
          </span>
          <span class="server-badges">
            <span v-if="server.blocked" class="badge blocked">{{ t('instanceServer.state.blocked') }}</span>
            <span v-if="server.media_hidden" class="badge limited">{{ t('instanceServer.state.mediaHidden') }}</span>
            <span v-if="server.kept_out > 0" class="badge inactive">
              {{ t('instanceServer.state.keptOut', { count: server.kept_out }, server.kept_out) }}
            </span>
          </span>
        </div>
        <button
          type="button"
          class="action-btn"
          :aria-label="t('instanceServer.dashboard.manageLabel', { server: server.name, instance })"
          data-testid="remote-server-manage"
          @click="managing = server.server_id"
        >
          {{ t('instanceServer.dashboard.manage') }}
        </button>
      </li>
    </ul>

    <BaseModal
      :show="managing !== null"
      :aria-label="t('instanceServer.panel.title', { instance })"
      :show-header="false"
      @close="closeManage"
    >
      <InstanceServerPanel v-if="managing" :server-id="managing" @changed="onChanged" />
      <template #footer>
        <div class="modal-actions">
          <UnifiedButton variant="ghost" :text="t('common.close')" @click="closeManage" />
        </div>
      </template>
    </BaseModal>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, useId } from 'vue'
import BaseModal from '@/components/common/BaseModal.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import Icon from '@/components/common/Icon.vue'
import LoadingSpinner from '@/components/common/LoadingSpinner.vue'
import UnifiedButton from '@/components/shared/UnifiedButton.vue'
import InstanceServerPanel from '@/components/settings/server/InstanceServerPanel.vue'
import { useT } from '@/composables/useT'
import { getInstanceDomain } from '@/services/instanceConfig'
import { listRemoteServers, type RemoteServerState } from '@/services/instanceServerTools'
import { getServerIconUrl } from '@/utils/serverUtils'

const { t } = useT()
const instance = getInstanceDomain()
const uid = `rsa-${useId()}`

const servers = ref<RemoteServerState[]>([])
const loading = ref(false)
const error = ref('')
const query = ref('')
const filter = ref<'all' | 'blocked' | 'media'>('all')
const managing = ref<string | null>(null)

const shown = computed(() => {
  const q = query.value.trim().toLowerCase()
  return servers.value.filter((server) => {
    if (filter.value === 'blocked' && !server.blocked) return false
    if (filter.value === 'media' && !server.media_hidden) return false
    if (!q) return true
    return server.name.toLowerCase().includes(q) || (server.host ?? '').toLowerCase().includes(q)
  })
})

async function load() {
  loading.value = true
  error.value = ''
  try {
    servers.value = await listRemoteServers()
  } catch (err: any) {
    error.value = t('instanceServer.dashboard.loadFailed') + (err?.message ? ` ${err.message}` : '')
  } finally {
    loading.value = false
  }
}

function onChanged(state: RemoteServerState) {
  servers.value = servers.value.map((server) => (server.server_id === state.server_id ? state : server))
}

function closeManage() {
  managing.value = null
}

onMounted(load)
</script>

<style scoped src="./adminShared.css"></style>

<style scoped>
.module-hint {
  margin: 0;
  padding: 16px 24px 0;
  color: var(--text-secondary);
  font-size: 13px;
  line-height: 1.5;
}

.filters {
  display: flex;
  gap: 12px;
  padding: 16px 24px;
  flex-wrap: wrap;
}

.search-input,
.filter-select {
  padding: 8px 12px;
  border: 1px solid var(--border-color);
  border-radius: var(--radius-md);
  background: var(--background-tertiary);
  color: var(--text-primary);
  font: inherit;
  font-size: 14px;
}

.search-input {
  flex: 1;
  min-width: 180px;
}

.server-list {
  list-style: none;
  margin: 0;
  padding: 0 24px 24px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

.server-row {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  border-radius: var(--radius-md);
  background: var(--background-tertiary);
}

.server-icon {
  width: 40px;
  height: 40px;
  border-radius: var(--radius-md);
  object-fit: cover;
  flex-shrink: 0;
}

.server-details {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.server-name {
  font-weight: 600;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.server-meta {
  font-size: 12px;
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.server-badges {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.server-badges:empty {
  display: none;
}

.modal-actions {
  display: flex;
  justify-content: flex-end;
}
</style>
