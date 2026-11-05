<template>
  <div class="remote-directory" data-testid="remote-directory">
    <div class="remote-directory__controls">
      <form class="remote-directory__form" @submit.prevent="browse(domainInput)">
        <label :for="inputId" class="remote-directory__label">{{ $t('federation.directory.domainLabel') }}</label>
        <div class="remote-directory__row">
          <input
            :id="inputId"
            v-model.trim="domainInput"
            class="remote-directory__input"
            type="text"
            inputmode="url"
            autocomplete="off"
            autocapitalize="off"
            spellcheck="false"
            :placeholder="$t('federation.directory.domainPlaceholder')"
            :aria-describedby="`${inputId}-hint`"
            data-testid="remote-directory-domain"
          />
          <button
            type="submit"
            class="btn btn-secondary"
            :disabled="!domainInput || loading"
            data-testid="remote-directory-browse"
          >
            <Icon v-if="loading" name="spinner" :size="16" class="spin" />
            <span>{{ $t('federation.directory.browse') }}</span>
          </button>
        </div>
        <p :id="`${inputId}-hint`" class="remote-directory__hint">{{ $t('federation.directory.domainHint') }}</p>
      </form>

      <div
        v-if="peers.length > 0"
        class="remote-directory__peers"
        role="group"
        :aria-labelledby="`${inputId}-peers`"
      >
        <span :id="`${inputId}-peers`" class="remote-directory__peers-label">{{ $t('federation.directory.knownInstances') }}</span>
        <button
          v-for="peer in peers"
          :key="peer.domain"
          type="button"
          class="peer-chip"
          :class="{ 'peer-chip--active': peer.domain === page?.domain }"
          :aria-pressed="peer.domain === page?.domain"
          data-testid="remote-directory-peer"
          @click="browse(peer.domain)"
        >
          <span class="peer-chip__icon"><InstanceIcon :src="peer.icon" :size="14" /></span>
          {{ peer.domain }}
        </button>
      </div>
    </div>

    <div class="remote-directory__results">
      <EmptyState
        v-if="federationOff"
        icon="lock"
        :title="$t('federation.directory.federationOffTitle')"
        :description="$t('federation.directory.federationOff')"
      />

      <EmptyState
        v-else-if="refusal"
        tone="error"
        icon="alert-triangle"
        role="alert"
        :title="refusalTitle"
        :description="refusalText"
        data-testid="remote-directory-error"
      />

      <div
        v-else-if="loading && !page"
        class="remote-directory__loading"
        role="status"
        aria-busy="true"
      >
        <Icon name="spinner" :size="20" class="spin" />
        <span>{{ $t('federation.directory.loading', { domain: pendingDomain }) }}</span>
      </div>

      <template v-else-if="page">
        <p class="remote-directory__stats" aria-live="polite" data-testid="remote-directory-stats">
          {{ $t('federation.directory.serversOn', { domain: page.domain, count: page.totalItems ?? items.length }, page.totalItems ?? items.length) }}
        </p>

        <EmptyState
          v-if="items.length === 0"
          icon="compass"
          :title="$t('federation.directory.emptyTitle')"
          :description="$t('federation.directory.empty', { domain: page.domain })"
        />

        <ul v-else class="remote-directory__list">
          <li
            v-for="(server, index) in items"
            :key="server.id"
            class="remote-server"
            data-testid="remote-directory-server"
          >
            <div class="remote-server__icon">
              <img v-if="server.icon" :src="server.icon" alt="" loading="lazy" />
              <span v-else aria-hidden="true">{{ server.name.charAt(0).toUpperCase() }}</span>
            </div>
            <div class="remote-server__body">
              <h3 :id="`${inputId}-name-${index}`" class="remote-server__name">{{ server.name }}</h3>
              <p class="remote-server__handle">{{ server.handle ?? server.id }}</p>
              <p v-if="server.summary" class="remote-server__summary">{{ server.summary }}</p>
              <p v-if="server.memberCount !== null" class="remote-server__members">
                <Icon name="users" :size="13" />
                {{ $t('federation.directory.members', { count: server.memberCount }, server.memberCount) }}
              </p>
            </div>
            <!-- Named by its own text, then the server's name: "Join <name>". -->
            <button
              v-if="joinedIds.has(server.id)"
              :id="`${inputId}-action-${index}`"
              type="button"
              class="btn btn-secondary remote-server__action"
              :aria-labelledby="`${inputId}-action-${index} ${inputId}-name-${index}`"
              data-testid="remote-directory-open"
              @click="emit('open', joinedIds.get(server.id)!)"
            >
              {{ $t('federation.openServer') }}
            </button>
            <button
              v-else
              :id="`${inputId}-action-${index}`"
              type="button"
              class="btn btn-primary remote-server__action"
              :aria-labelledby="`${inputId}-action-${index} ${inputId}-name-${index}`"
              data-testid="remote-directory-join"
              @click="emit('join', server.id)"
            >
              {{ $t('federation.directory.join') }}
            </button>
          </li>
        </ul>

        <div v-if="page.next" class="remote-directory__more">
          <button type="button" class="btn btn-secondary" :disabled="loading" @click="loadMore">
            <Icon v-if="loading" name="spinner" :size="16" class="spin" />
            <span>{{ $t('federation.directory.loadMore') }}</span>
          </button>
        </div>
      </template>

      <EmptyState
        v-else
        icon="globe"
        :title="$t('federation.directory.introTitle')"
        :description="$t('federation.directory.intro')"
      />
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, useId } from 'vue'
import { useI18n } from 'vue-i18n'
import Icon from '@/components/common/Icon.vue'
import InstanceIcon from '@/components/common/InstanceIcon.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import {
  federationServerService,
  remoteServerUuid,
  type DirectoryPage,
  type DirectoryPeer,
  type DirectoryRefusal,
  type DirectoryServer,
} from '@/services/federation'
import { useServerChannelStore } from '@/stores/useServerChannel'

const emit = defineEmits<{
  /** A listed Group's id, joined through Join by URL. */
  join: [groupId: string]
  /** The local copy of a listed Group the user is in. */
  open: [serverId: string]
}>()

const { t } = useI18n()
const serverChannelStore = useServerChannelStore()
const inputId = `remote-directory-${useId()}`

const domainInput = ref('')
const pendingDomain = ref('')
const peers = ref<DirectoryPeer[]>([])
const page = ref<DirectoryPage | null>(null)
const items = ref<DirectoryServer[]>([])
const loading = ref(false)
const refusal = ref<DirectoryRefusal | null>(null)
const federationOff = ref(false)
let generation = 0

/** Group id -> local copy id, for the listed servers the user is already in. */
const joinedIds = computed(() => {
  const local = new Map(serverChannelStore.servers.map((s: { id: string; federation_inbox_url?: string }) => [s.id, s]))
  const joined = new Map<string, string>()
  for (const server of items.value) {
    const uuid = remoteServerUuid(server.id)
    const copy = uuid ? local.get(uuid) : undefined
    if (copy) joined.set(server.id, copy.id)
    else {
      const byInbox = serverChannelStore.servers.find((s: { federation_inbox_url?: string }) => s.federation_inbox_url === `${server.id}/inbox`)
      if (byInbox) joined.set(server.id, byInbox.id)
    }
  }
  return joined
})

const refusalTitle = computed(() =>
  refusal.value === 'no_directory' ? t('federation.directory.noDirectoryTitle') : t('federation.directory.errorTitle'))

const refusalText = computed(() => {
  const domain = pendingDomain.value
  switch (refusal.value) {
    case 'invalid_domain': return t('federation.directory.invalidDomain')
    case 'own_instance': return t('federation.directory.ownInstance')
    case 'instance_blocked': return t('federation.directory.blocked', { domain })
    case 'federation_off': return t('federation.directory.federationOff')
    case 'no_directory': return t('federation.directory.noDirectory', { domain })
    case 'unreachable': return t('federation.directory.unreachable', { domain })
    default: return t('federation.directory.failed')
  }
})

async function browse(input: string) {
  const domain = input.trim()
  if (!domain) return
  const mine = ++generation
  domainInput.value = domain
  pendingDomain.value = domain
  refusal.value = null
  page.value = null
  items.value = []
  loading.value = true
  try {
    const result = await federationServerService.browseDirectory(domain)
    if (mine !== generation) return
    if (!result.ok) {
      if (result.refusal === 'federation_off') federationOff.value = true
      else refusal.value = result.refusal
      return
    }
    page.value = result.page
    items.value = result.page.items
  } finally {
    if (mine === generation) loading.value = false
  }
}

async function loadMore() {
  const current = page.value
  if (!current?.next || loading.value) return
  const mine = ++generation
  loading.value = true
  try {
    const result = await federationServerService.browseDirectory(current.domain, current.next)
    if (mine !== generation) return
    if (!result.ok) {
      refusal.value = result.refusal
      return
    }
    const seen = new Set(items.value.map((s) => s.id))
    items.value = [...items.value, ...result.page.items.filter((s) => !seen.has(s.id))]
    page.value = { ...result.page, totalItems: result.page.totalItems ?? current.totalItems }
  } finally {
    if (mine === generation) loading.value = false
  }
}

onMounted(async () => {
  const result = await federationServerService.listDirectoryPeers()
  peers.value = result.peers
  if (result.federationOff) federationOff.value = true
})
</script>

<style scoped src="./discoveryButtons.css"></style>

<style scoped>
.remote-directory {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}

.remote-directory__controls {
  padding: var(--space-4) var(--space-6) var(--space-3);
  border-bottom: 1px solid var(--border-primary);
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.remote-directory__form {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

.remote-directory__label,
.remote-directory__peers-label {
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-semibold);
  color: var(--text-secondary);
}

.remote-directory__row {
  display: flex;
  gap: var(--space-2);
}

.remote-directory__input {
  flex: 1;
  min-width: 0;
  height: 40px;
  padding: 0 var(--space-3);
  background: var(--input-bg);
  border: 1px solid var(--input-border);
  border-radius: var(--radius-md);
  color: var(--text-primary);
  font-size: var(--font-size-sm);
}

.remote-directory__input::placeholder {
  color: var(--text-muted);
}

.remote-directory__input:hover {
  border-color: var(--border-hover);
}

.remote-directory__input:focus-visible {
  outline: none;
  border-color: var(--border-focus);
  box-shadow: 0 0 0 3px var(--harmony-primary-light);
}

.remote-directory__hint {
  margin: 0;
  font-size: var(--font-size-xs);
  color: var(--text-muted);
}

.remote-directory__peers {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-2);
}

.peer-chip {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-full);
  background: transparent;
  color: var(--text-secondary);
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-medium);
  line-height: 1.2;
  white-space: nowrap;
  cursor: pointer;
  transition:
    background-color var(--transition-fast),
    border-color var(--transition-fast),
    color var(--transition-fast);
}

.peer-chip:hover {
  background: var(--background-modifier-hover);
  color: var(--text-primary);
}

.peer-chip:focus-visible {
  outline: 2px solid var(--harmony-primary);
  outline-offset: 2px;
}

.peer-chip--active,
.peer-chip--active:hover {
  background: var(--harmony-primary-fill);
  border-color: var(--harmony-primary);
  color: var(--text-on-primary);
}

.peer-chip__icon {
  width: 14px;
  height: 14px;
  display: inline-flex;
}

.remote-directory__results {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding: var(--space-6);
  display: flex;
  flex-direction: column;
  gap: var(--space-4);
}

.remote-directory__loading {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  padding: var(--space-8) 0;
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
}

.remote-directory__stats {
  margin: 0;
  font-size: var(--font-size-xs);
  color: var(--text-muted);
}

.remote-directory__list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
  gap: var(--space-3);
}

.remote-server {
  display: flex;
  align-items: flex-start;
  gap: var(--space-3);
  padding: var(--space-4);
  background: var(--background-secondary);
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-lg);
  min-width: 0;
}

.remote-server__icon {
  width: 48px;
  height: 48px;
  flex-shrink: 0;
  border-radius: var(--radius-lg);
  background: var(--background-tertiary);
  color: var(--text-primary);
  font-weight: var(--font-weight-semibold);
  font-size: var(--font-size-lg);
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: hidden;
}

.remote-server__icon img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.remote-server__body {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.remote-server__name {
  margin: 0;
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-semibold);
  color: var(--text-primary);
  overflow-wrap: anywhere;
}

.remote-server__handle {
  margin: 0;
  font-size: var(--font-size-xs);
  color: var(--text-muted);
  overflow-wrap: anywhere;
}

.remote-server__summary {
  margin: var(--space-1) 0 0;
  font-size: var(--font-size-xs);
  color: var(--text-secondary);
  white-space: pre-line;
  display: -webkit-box;
  -webkit-line-clamp: 3;
  line-clamp: 3;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.remote-server__members {
  margin: var(--space-1) 0 0;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: var(--font-size-xs);
  color: var(--text-secondary);
}

.remote-server__action {
  flex-shrink: 0;
  align-self: center;
}

.remote-directory__more {
  display: flex;
  justify-content: center;
}

.spin {
  animation: remote-directory-spin 1s linear infinite;
}

@keyframes remote-directory-spin {
  to { transform: rotate(360deg); }
}

@media (prefers-reduced-motion: reduce) {
  .spin {
    animation: none;
  }
}

@media (max-width: 768px) {
  .remote-directory__controls {
    padding: var(--space-3) var(--space-4);
  }

  .remote-directory__results {
    padding: var(--space-4);
  }

  /* 16px keeps iOS Safari from zooming on focus. */
  .remote-directory__input {
    font-size: 16px;
  }

  .remote-directory__peers {
    flex-wrap: nowrap;
    overflow-x: auto;
    margin: 0 calc(-1 * var(--space-4));
    padding: 0 var(--space-4);
    scrollbar-width: none;
  }

  .remote-directory__peers::-webkit-scrollbar {
    display: none;
  }

  .remote-directory__list {
    grid-template-columns: 1fr;
  }
}
</style>
