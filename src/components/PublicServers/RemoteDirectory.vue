<template>
  <div class="remote-directory" data-testid="remote-directory">
    <DiscoveryControls
      ref="controls"
      v-model:expanded="expanded"
      :filters="activeFilters"
      :count="statsText"
      count-test-id="remote-directory-stats"
      @remove="removeFilter"
    >
      <!-- One field: filters the listed servers as typed; a domain typed is offered to browse. -->
      <form class="remote-directory__search" role="search" @submit.prevent="submitSearch">
        <label :for="inputId" class="remote-directory__label">{{ $t('federation.directory.searchLabel') }}</label>
        <div class="remote-directory__field">
          <Icon name="search" :size="18" class="remote-directory__field-icon" />
          <input
            :id="inputId"
            ref="fieldEl"
            v-model="filter"
            class="remote-directory__input"
            type="search"
            autocomplete="off"
            autocapitalize="off"
            spellcheck="false"
            :enterkeyhint="typedDomain ? 'go' : 'search'"
            :placeholder="$t('federation.directory.searchPlaceholder')"
            data-testid="remote-directory-search"
            @keydown.esc="onEscape"
          />
        </div>
        <button
          v-if="typedDomain"
          type="submit"
          class="remote-directory__browse"
          :disabled="loading && pendingDomain === typedDomain"
          data-testid="remote-directory-browse"
        >
          <Icon name="globe" :size="16" />
          <span class="remote-directory__browse-label">{{ $t('federation.directory.browseDomain', { domain: typedDomain }) }}</span>
          <kbd class="remote-directory__kbd" aria-hidden="true">↵</kbd>
        </button>
      </form>

      <div
        v-if="peers.length > 0 || view === 'instance'"
        class="remote-directory__peers"
        role="group"
        :aria-labelledby="`${inputId}-peers`"
      >
        <span :id="`${inputId}-peers`" class="remote-directory__peers-label">{{ $t('federation.directory.knownInstances') }}</span>
        <button
          v-if="advertisedSupported"
          type="button"
          class="peer-chip"
          :class="{ 'peer-chip--active': view === 'all' }"
          :aria-pressed="view === 'all'"
          data-testid="remote-directory-all"
          @click="showAll"
        >
          <Icon name="globe" :size="14" />
          {{ $t('federation.directory.allInstances') }}
        </button>
        <!-- A domain browsed by typing that no known instance matches. -->
        <button
          v-if="unlistedDomain"
          type="button"
          class="peer-chip peer-chip--active"
          aria-pressed="true"
          data-testid="remote-directory-typed"
          @click="browse(unlistedDomain)"
        >
          <Icon name="globe" :size="14" />
          <span class="peer-chip__label" :title="unlistedDomain">{{ unlistedDomain }}</span>
        </button>
        <button
          v-for="peer in peers"
          :key="peer.domain"
          type="button"
          class="peer-chip"
          :class="{ 'peer-chip--active': peer.domain === browsedDomain }"
          :aria-pressed="peer.domain === browsedDomain"
          data-testid="remote-directory-peer"
          @click="browse(peer.domain)"
        >
          <span class="peer-chip__icon"><InstanceIcon :src="peer.icon" :size="14" /></span>
          <span class="peer-chip__label">{{ peer.domain }}</span>
        </button>
      </div>
    </DiscoveryControls>

    <div class="remote-directory__results" @scroll="onResultsScroll">
      <EmptyState
        v-if="federationOff"
        icon="lock"
        :title="$t('federation.directory.federationOffTitle')"
        :description="$t('federation.directory.federationOff')"
      />

      <template v-else>
        <!-- One instance's directory, browsed by domain or known instance. -->
        <template v-if="view === 'instance'">
          <EmptyState
            v-if="refusal"
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
            <EmptyState
              v-if="items.length === 0"
              icon="compass"
              :title="$t('federation.directory.emptyTitle')"
              :description="$t('federation.directory.empty', { domain: page.domain })"
            />
            <EmptyState
              v-else-if="instanceItems.length === 0"
              icon="search"
              :title="$t('federation.directory.noMatchTitle')"
              :description="$t('federation.directory.noMatchOn', { domain: page.domain, query: filter.trim() })"
              :action-label="typedDomain ? $t('federation.directory.browseDomain', { domain: typedDomain }) : undefined"
              data-testid="remote-directory-no-match"
              @action="submitSearch"
            />
          </template>
        </template>

        <!-- Every known instance's listed servers, merged by this instance's backend. -->
        <template v-else-if="advertisedSupported">
          <div
            v-if="(advertisedLoading && !advertised) || (!answered && !advertisedError && mergedItems.length === 0)"
            class="remote-directory__loading"
            role="status"
            aria-busy="true"
          >
            <Icon name="spinner" :size="20" class="spin" />
            <span>{{ $t('federation.directory.loadingAdvertised') }}</span>
          </div>

          <EmptyState
            v-else-if="advertisedError && !advertised"
            tone="error"
            icon="alert-triangle"
            :title="$t('federation.directory.advertisedErrorTitle')"
            :description="$t('federation.directory.failed')"
            :action-label="$t('common.retry')"
            data-testid="remote-directory-advertised-error"
            @action="loadAdvertised()"
          />

          <template v-else-if="advertised">
            <p v-if="advertised.pending > 0" class="remote-directory__note" role="status">
              <Icon name="spinner" :size="13" class="spin" />
              {{ $t('federation.directory.advertisedPending', { count: advertised.pending }, advertised.pending) }}
            </p>
            <p v-else-if="advertised.failed.length > 0" class="remote-directory__note" data-testid="remote-directory-partial">
              {{ $t('federation.directory.advertisedFailed', { count: advertised.failed.length }, advertised.failed.length) }}
            </p>

            <EmptyState
              v-if="answered && advertisedItems.length === 0 && filter"
              icon="search"
              :title="$t('federation.directory.noMatchTitle')"
              :description="$t('federation.directory.noMatch', { query: filter.trim() })"
              :action-label="typedDomain ? $t('federation.directory.browseDomain', { domain: typedDomain }) : undefined"
              data-testid="remote-directory-no-match"
              @action="submitSearch"
            />
            <EmptyState
              v-else-if="answered && advertisedItems.length === 0 && advertised.pending === 0"
              icon="globe"
              :title="$t('federation.directory.advertisedEmptyTitle')"
              :description="$t('federation.directory.advertisedEmpty')"
              :action-label="$t('federation.directory.browseAction')"
              data-testid="remote-directory-nothing"
              @action="controls?.expand()"
            />
          </template>
        </template>

        <EmptyState
          v-else
          icon="globe"
          :title="$t('federation.directory.introTitle')"
          :description="$t('federation.directory.intro')"
          :action-label="$t('federation.directory.browseAction')"
          @action="controls?.expand()"
        />

        <ul v-if="listed.length > 0" ref="listEl" class="remote-directory__list">
          <li
            v-for="(server, index) in listed"
            :key="server.id"
            class="remote-server"
            tabindex="-1"
            data-testid="remote-directory-server"
          >
            <div class="remote-server__icon">
              <img v-if="server.icon" :src="server.icon" alt="" loading="lazy" />
              <span v-else aria-hidden="true">{{ server.name.charAt(0).toUpperCase() }}</span>
            </div>
            <div class="remote-server__head">
              <h3 :id="`${inputId}-name-${index}`" class="remote-server__name">{{ server.name }}</h3>
              <p class="remote-server__handle" :title="server.handle ?? server.id">{{ server.handle ?? server.id }}</p>
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
            <p v-if="server.summary" class="remote-server__summary">{{ server.summary }}</p>
            <p v-if="server.memberCount !== null || 'instance' in server" class="remote-server__meta">
              <span v-if="server.memberCount !== null" class="remote-server__members">
                <Icon name="users" :size="13" />
                {{ $t('federation.directory.members', { count: server.memberCount }, server.memberCount) }}
              </span>
              <span v-if="'instance' in server" class="remote-server__instance" data-testid="remote-directory-instance">
                <span class="remote-server__instance-icon"><InstanceIcon :src="server.instance.icon" :size="14" /></span>
                {{ $t('federation.directory.hostedOn', { instance: server.instance.name || server.instance.domain }) }}
              </span>
            </p>
          </li>
        </ul>

        <div v-if="hasMore" class="remote-directory__more">
          <p v-if="moreFailed" class="remote-directory__more-error" role="alert" data-testid="remote-directory-more-failed">
            {{ $t('federation.directory.loadMoreFailed') }}
          </p>
          <!-- aria-disabled, not disabled: a disabled button drops focus to the page while it reads. -->
          <button
            ref="moreButton"
            type="button"
            class="btn btn-secondary"
            :aria-disabled="busy"
            @click="onLoadMore"
          >
            <Icon v-if="busy" name="spinner" :size="16" class="spin" />
            <span>{{ $t('federation.directory.loadMore') }}</span>
          </button>
        </div>
      </template>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import Icon from '@/components/common/Icon.vue'
import InstanceIcon from '@/components/common/InstanceIcon.vue'
import EmptyState from '@/components/common/EmptyState.vue'
import DiscoveryControls, { type DiscoveryFilter } from '@/components/PublicServers/DiscoveryControls.vue'
import {
  federationServerService,
  remoteServerUuid,
  type AdvertisedPage,
  type AdvertisedServer,
  type DirectoryPage,
  type DirectoryPeer,
  type DirectoryRefusal,
  type DirectoryServer,
} from '@/services/federation'
import { useServerChannelStore } from '@/stores/useServerChannel'
import { instanceDomainFromInput, serverMatchesQuery } from '@/utils/directorySearch'

type AdvertisedAnswer = Awaited<ReturnType<typeof federationServerService.listAdvertisedServers>>

const emit = defineEmits<{
  /** A listed Group's id, joined through Join by URL. */
  join: [groupId: string]
  /** The local copy of a listed Group the user is in. */
  open: [serverId: string]
}>()

/** Rereads while instances are still being read, this far apart, at most this often. */
const PENDING_RETRY_MS = 3_000
const PENDING_RETRIES = 3
const FILTER_DEBOUNCE_MS = 300
/** MAX_LIMIT of GET /directory/servers. */
const ADVERTISED_MAX_ROWS = 60

const { t } = useI18n()
const serverChannelStore = useServerChannelStore()
const inputId = `remote-directory-${useId()}`

const view = ref<'all' | 'instance'>('all')
const pendingDomain = ref('')
const peers = ref<DirectoryPeer[]>([])
const page = ref<DirectoryPage | null>(null)
const items = ref<DirectoryServer[]>([])
const loading = ref(false)
const refusal = ref<DirectoryRefusal | null>(null)
const federationOff = ref(false)
let generation = 0

const advertisedSupported = ref(true)
const advertised = ref<AdvertisedPage | null>(null)
const advertisedItems = ref<AdvertisedServer[]>([])
const advertisedLoading = ref(false)
const advertisedError = ref(false)
const filter = ref('')
/** The filter, trimmed, that `advertised` answers. */
const advertisedQuery = ref('')
let advertisedGeneration = 0
let filterTimer: ReturnType<typeof setTimeout> | undefined
let retryTimer: ReturnType<typeof setTimeout> | undefined
let retries = 0

// Folded on open: the list takes the height; the bar still shows active filters and the count.
const expanded = ref(false)
const controls = ref<InstanceType<typeof DiscoveryControls> | null>(null)
const fieldEl = ref<HTMLInputElement | null>(null)
const listEl = ref<HTMLUListElement | null>(null)
const moreButton = ref<HTMLButtonElement | null>(null)
/** The last Load more failed; the button stays to try again. */
const moreFailed = ref(false)

/** The field's text as an instance domain, when it reads as one. */
const typedDomain = computed(() => instanceDomainFromInput(filter.value))

/** The instance whose directory is shown, while one is. */
const browsedDomain = computed(() => (view.value === 'instance' ? page.value?.domain ?? pendingDomain.value : null))

const unlistedDomain = computed(() => {
  const domain = browsedDomain.value
  return domain && !peers.value.some((p) => p.domain === domain) ? domain : null
})

/** The browsed instance's servers the field's text matches; that directory is not searched remotely. */
const instanceItems = computed(() => items.value.filter((s) => serverMatchesQuery(s, filter.value)))

/** The merged list answers the text now in the field. */
const answered = computed(() => advertisedQuery.value === filter.value.trim())

/**
 * The merged list's rows for the text now in the field: the answer's, or until it arrives, the
 * earlier answer's rows that match it, as the backend matches them.
 */
const mergedItems = computed(() => (answered.value
  ? advertisedItems.value
  : advertisedItems.value.filter((s) => serverMatchesQuery(s, filter.value))))

const listed = computed<Array<DirectoryServer | AdvertisedServer>>(() =>
  view.value === 'all' ? (advertisedSupported.value ? mergedItems.value : []) : instanceItems.value)

const busy = computed(() => (view.value === 'all' ? advertisedLoading.value : loading.value))

const hasMore = computed(() => view.value === 'all'
  ? advertisedSupported.value && answered.value && advertised.value?.nextOffset != null
  : !!page.value?.next)

/** Group id -> local copy id, for the listed servers the user is already in. */
const joinedIds = computed(() => {
  const local = new Map(serverChannelStore.servers.map((s: { id: string; federation_inbox_url?: string }) => [s.id, s]))
  const joined = new Map<string, string>()
  for (const server of listed.value) {
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

const statsText = computed(() => {
  if (federationOff.value) return ''
  const query = filter.value.trim()
  if (view.value === 'instance') {
    const current = page.value
    if (!current || refusal.value) return ''
    if (query) return t('federation.directory.advertisedMatches', { count: instanceItems.value.length }, instanceItems.value.length)
    const count = current.totalItems ?? items.value.length
    return t('federation.directory.serversOn', { domain: current.domain, count }, count)
  }
  const current = advertised.value
  if (!advertisedSupported.value || !answered.value || !current || current.total === 0) return ''
  if (query) return t('federation.directory.advertisedMatches', { count: current.total }, current.total)
  const instances = t('federation.directory.instanceCount', { count: current.instances }, current.instances)
  return t('federation.directory.advertisedStats', { count: current.total, instances }, current.total)
})

const activeFilters = computed<DiscoveryFilter[]>(() => {
  const filters: DiscoveryFilter[] = []
  if (browsedDomain.value) filters.push({ key: 'instance', label: browsedDomain.value, icon: 'globe' })
  const query = filter.value.trim()
  if (query) filters.push({ key: 'query', label: t('server.queryChip', { query }), icon: 'search' })
  return filters
})

function removeFilter(key: string) {
  if (key === 'instance') showAll()
  else if (key === 'query') filter.value = ''
}

/** Enter in the field: browses a typed domain, which leaves the field; filters at once otherwise. */
async function submitSearch() {
  const domain = typedDomain.value
  if (domain) {
    filter.value = ''
    void browse(domain)
    // The Browse button and the empty state's action leave with the text; focus returns to the field.
    await nextTick()
    if (!document.activeElement || document.activeElement === document.body) fieldEl.value?.focus()
    return
  }
  clearTimeout(filterTimer)
  if (view.value === 'all') void loadAdvertised()
}

/**
 * Escape empties a filled field and goes no further; the dialog closes on the next. Vue renders
 * the empty field before the dialog's window listener runs, which would then close it.
 */
function onEscape(event: KeyboardEvent) {
  if (!filter.value) return
  filter.value = ''
  event.stopPropagation()
}

function onResultsScroll(event: Event) {
  controls.value?.listScrolled((event.target as HTMLElement).scrollTop)
}

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
  clearTimeout(filterTimer)
  const mine = ++generation
  moreFailed.value = false
  view.value = 'instance'
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
    moreFailed.value = !result.ok
    if (!result.ok) return
    const seen = new Set(items.value.map((s) => s.id))
    items.value = [...items.value, ...result.page.items.filter((s) => !seen.has(s.id))]
    page.value = { ...result.page, totalItems: result.page.totalItems ?? current.totalItems }
  } finally {
    if (mine === generation) loading.value = false
  }
}

function showAll() {
  ++generation
  loading.value = false
  moreFailed.value = false
  view.value = 'all'
  // The merged list answers the text typed before an instance was browsed.
  if (advertisedSupported.value && !answered.value) {
    clearTimeout(filterTimer)
    retries = 0
    void loadAdvertised()
  }
}

/**
 * The first `rows` servers of the merged list for `query`, the backend's first page for 0, read
 * ADVERTISED_MAX_ROWS at a time. A later page that counts other instances than the first starts
 * the read over once: the first page's offsets no longer hold. Null once `stale()`.
 */
async function readMerged(query: string, rows: number, stale: () => boolean, again = true): Promise<AdvertisedAnswer | null> {
  const first = await federationServerService.listAdvertisedServers(query, 0, rows > 0 ? Math.min(rows, ADVERTISED_MAX_ROWS) : undefined)
  if (stale()) return null
  if (!first.ok) return first
  const merged = [...first.page.items]
  let last = first.page
  while (merged.length < rows && last.nextOffset != null) {
    const next = await federationServerService.listAdvertisedServers(query, last.nextOffset, Math.min(rows - merged.length, ADVERTISED_MAX_ROWS))
    if (stale()) return null
    if (!next.ok) return next
    if (again && next.page.instances !== first.page.instances) return readMerged(query, rows, stale, false)
    const seen = new Set(merged.map((s) => s.id))
    merged.push(...next.page.items.filter((s) => !seen.has(s.id)))
    last = next.page
  }
  return { ok: true, page: { ...last, items: merged } }
}

/**
 * The first `rows` servers of the merged list for the current filter, the first page for 0. The
 * answer replaces the list: servers of an instance read since an earlier answer sort anywhere in
 * it, so that answer's offsets no longer hold.
 */
async function loadAdvertised(rows = 0) {
  clearTimeout(retryTimer)
  const mine = ++advertisedGeneration
  const query = filter.value.trim()
  advertisedLoading.value = true
  try {
    const answer = await readMerged(query, rows, () => mine !== advertisedGeneration)
    if (!answer) return
    if (!answer.ok) {
      if (answer.unsupported) advertisedSupported.value = false
      else {
        advertisedError.value = true
        if (query !== advertisedQuery.value) {
          advertised.value = null
          advertisedItems.value = []
        }
      }
      return
    }
    const result = answer.page
    advertisedError.value = false
    moreFailed.value = false
    if (result.federationOff) federationOff.value = true
    advertised.value = result
    advertisedQuery.value = query
    advertisedItems.value = result.items
    retryWhilePending(result)
  } finally {
    if (mine === advertisedGeneration) advertisedLoading.value = false
  }
}

/** Reads the rows on screen again while `result` counts instances still being read. */
function retryWhilePending(result: AdvertisedPage) {
  if (result.pending === 0 || retries >= PENDING_RETRIES) return
  retries++
  retryTimer = setTimeout(() => { void loadAdvertised(advertisedItems.value.length) }, PENDING_RETRY_MS)
}

async function loadMoreAdvertised() {
  const current = advertised.value
  const offset = current?.nextOffset
  if (!current || offset == null || advertisedLoading.value) return
  clearTimeout(retryTimer)
  const mine = ++advertisedGeneration
  advertisedLoading.value = true
  try {
    const answer = await federationServerService.listAdvertisedServers(advertisedQuery.value, offset)
    if (mine !== advertisedGeneration) return
    moreFailed.value = !answer.ok
    if (!answer.ok) {
      retryWhilePending(current)
      return
    }
    const result = answer.page
    if (result.instances !== current.instances) {
      await loadAdvertised(offset + result.items.length)
      return
    }
    const seen = new Set(advertisedItems.value.map((s) => s.id))
    advertisedItems.value = [...advertisedItems.value, ...result.items.filter((s) => !seen.has(s.id))]
    advertised.value = result
    retryWhilePending(result)
  } finally {
    if (mine === advertisedGeneration) advertisedLoading.value = false
  }
}

/** The last page leaves with the button; focus it held goes to the first row added, not to the page. */
async function onLoadMore() {
  if (busy.value) return
  const before = listed.value.length
  const hadFocus = document.activeElement === moreButton.value
  await (view.value === 'all' ? loadMoreAdvertised() : loadMore())
  if (!hadFocus || hasMore.value) return
  await nextTick()
  const active = document.activeElement
  if (active && active !== document.body && active !== moreButton.value) return
  const rows = listEl.value?.children
  if (rows && rows.length > 0) (rows[Math.min(before, rows.length - 1)] as HTMLElement).focus()
}

// A browsed instance's directory filters on this side; showAll() reads the merged list for the text.
watch(filter, () => {
  clearTimeout(filterTimer)
  retries = 0
  if (view.value !== 'all') return
  filterTimer = setTimeout(() => { void loadAdvertised() }, FILTER_DEBOUNCE_MS)
})

onMounted(async () => {
  void loadAdvertised()
  const result = await federationServerService.listDirectoryPeers()
  peers.value = result.peers
  if (result.federationOff) federationOff.value = true
})

onBeforeUnmount(() => {
  clearTimeout(filterTimer)
  clearTimeout(retryTimer)
  advertisedGeneration++
  generation++
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

.remote-directory__search {
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

.remote-directory__field {
  position: relative;
  display: flex;
  align-items: center;
}

.remote-directory__field-icon {
  position: absolute;
  left: 12px;
  color: var(--text-muted);
  pointer-events: none;
}

.remote-directory__input {
  flex: 1;
  min-width: 0;
  height: 40px;
  padding: 0 var(--space-3) 0 40px;
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

.remote-directory__browse {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-height: 36px;
  padding: 0 var(--space-3);
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-md);
  background: var(--background-modifier-hover);
  color: var(--text-primary);
  font-size: var(--font-size-sm);
  text-align: left;
  cursor: pointer;
  transition: background-color var(--transition-fast), border-color var(--transition-fast);
}

.remote-directory__browse:hover:not(:disabled) {
  background: var(--background-modifier-active);
  border-color: var(--border-hover);
}

.remote-directory__browse:focus-visible {
  outline: 2px solid var(--harmony-primary);
  outline-offset: 2px;
}

.remote-directory__browse:disabled {
  opacity: 0.6;
  cursor: progress;
}

.remote-directory__browse-label {
  flex: 1;
  min-width: 0;
  overflow-wrap: anywhere;
}

.remote-directory__kbd {
  padding: 1px 6px;
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-sm);
  color: var(--text-muted);
  font-family: inherit;
  font-size: var(--font-size-xs);
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
  max-width: 100%;
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
  flex-shrink: 0;
  display: inline-flex;
}

.peer-chip__label {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
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

.remote-directory__note {
  margin: 0;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  font-size: var(--font-size-xs);
  color: var(--text-secondary);
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
  display: grid;
  grid-template-columns: 48px minmax(0, 1fr) auto;
  align-items: center;
  column-gap: var(--space-3);
  row-gap: var(--space-2);
  padding: var(--space-3) var(--space-4);
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

.remote-server__head {
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
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.remote-server__handle {
  margin: 0;
  font-size: var(--font-size-xs);
  color: var(--text-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.remote-server__summary,
.remote-server__meta {
  grid-column: 1 / -1;
  margin: 0;
  font-size: var(--font-size-xs);
}

.remote-server__summary {
  color: var(--text-secondary);
  white-space: pre-line;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}

.remote-server__meta {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--space-1) var(--space-3);
  color: var(--text-secondary);
}

.remote-server__members,
.remote-server__instance {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  overflow-wrap: anywhere;
}

.remote-server__instance-icon {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
  display: inline-flex;
}

.remote-server__action {
  flex-shrink: 0;
}

.remote-server:focus-visible {
  outline: 2px solid var(--harmony-primary);
  outline-offset: 2px;
}

.remote-directory__more {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-2);
}

.remote-directory__more-error {
  margin: 0;
  font-size: var(--font-size-xs);
  color: var(--text-danger);
}

.remote-directory__more .btn[aria-disabled='true'] {
  opacity: 0.5;
  cursor: progress;
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
  .remote-directory__kbd {
    display: none;
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
    margin: -4px calc(-1 * var(--space-4));
    padding: 4px var(--space-4);
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
