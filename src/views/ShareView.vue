<template>
  <div class="share-view" data-testid="share-view">
    <header class="share-header">
      <button type="button" class="share-icon-button" :aria-label="t('common.cancel')" @click="cancel">
        <Icon name="arrow-left" :size="20" />
      </button>
      <h1>{{ t('share.title') }}</h1>
    </header>

    <div class="share-scroll">
      <div class="share-inner">
        <div v-if="!sharedText" class="share-nothing">
          <p>{{ t('share.nothing') }}</p>
          <button type="button" class="share-button" @click="cancel">{{ t('share.openHarmony') }}</button>
        </div>

        <template v-else>
          <section class="share-preview" :aria-labelledby="previewHeadingId">
            <h2 :id="previewHeadingId" class="share-label">{{ t('share.preview') }}</h2>
            <p class="share-preview-text" data-testid="share-preview">{{ sharedText }}</p>
          </section>

          <h2 class="share-question">{{ t('share.where') }}</h2>
          <input
            v-model="query"
            type="search"
            class="share-search"
            :placeholder="t('share.search')"
            :aria-label="t('share.search')"
            data-testid="share-search"
          />

          <section v-if="dmRows.length" :aria-labelledby="dmHeadingId">
            <h3 :id="dmHeadingId" class="share-label">{{ t('share.directMessages') }}</h3>
            <ul class="share-list">
              <li v-for="row in dmRows" :key="row.id">
                <button
                  type="button"
                  class="share-row"
                  data-testid="share-dm"
                  :data-conversation-id="row.id"
                  :disabled="busy"
                  @click="choose({ kind: 'dm', conversationId: row.id })"
                >
                  <GroupIcon v-if="row.group" :conversation-id="row.id" :icon-path="row.icon" size="xs" alt="" aria-hidden="true" />
                  <Avatar v-else :src="row.icon" size="xs" aria-hidden="true" />
                  <span class="share-row-name">
                    <DisplayName v-if="row.userId" :user-id="row.userId" :fallback="row.name" :truncate="true" />
                    <template v-else>{{ row.name }}</template>
                  </span>
                </button>
              </li>
            </ul>
          </section>

          <section v-if="serverRows.length" :aria-labelledby="serversHeadingId">
            <h3 :id="serversHeadingId" class="share-label">{{ t('share.servers') }}</h3>
            <ul class="share-list">
              <li v-for="row in serverRows" :key="row.server.id">
                <button
                  type="button"
                  class="share-row"
                  data-testid="share-server"
                  :data-server-id="row.server.id"
                  :aria-expanded="isOpen(row.server.id)"
                  :aria-controls="`share-channels-${row.server.id}`"
                  @click="toggleServer(row.server.id)"
                >
                  <ServerIcon :src="row.server.icon" :name="row.server.name" alt="" size="xs" :show-title="false" aria-hidden="true" />
                  <span class="share-row-name">{{ row.server.name }}</span>
                  <Icon :name="isOpen(row.server.id) ? 'chevron-up' : 'chevron-down'" :size="16" class="share-row-chevron" />
                </button>

                <div v-if="isOpen(row.server.id)" :id="`share-channels-${row.server.id}`" class="share-channels">
                  <p v-if="channelState[row.server.id]?.status === 'loading'" class="share-muted" role="status">
                    {{ t('share.loadingChannels') }}
                  </p>
                  <p v-else-if="channelState[row.server.id]?.status === 'error'" class="share-muted" role="alert">
                    {{ t('share.channelsFailed') }}
                    <button type="button" class="share-text-button" @click="loadChannels(row.server.id)">{{ t('common.retry') }}</button>
                  </p>
                  <p v-else-if="row.channels.length === 0" class="share-muted" role="status">
                    {{ t('share.noChannels') }}
                  </p>
                  <ul v-else class="share-list">
                    <li v-for="channel in row.channels" :key="channel.id">
                      <button
                        type="button"
                        class="share-row share-row--channel"
                        data-testid="share-channel"
                        :data-channel-id="channel.id"
                        :disabled="busy"
                        @click="choose({ kind: 'channel', serverId: row.server.id, channelId: channel.id })"
                      >
                        <Icon name="hash" :size="16" class="share-row-hash" />
                        <span class="share-row-name">{{ channel.name }}</span>
                      </button>
                    </li>
                  </ul>
                </div>
              </li>
            </ul>
          </section>

          <p v-if="!dmRows.length && !serverRows.length" class="share-muted" role="status">
            {{ dmsLoading ? t('common.loading') : t('share.noMatches') }}
          </p>
        </template>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, reactive, ref, useId } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import Icon from '@/components/common/Icon.vue'
import Avatar from '@/components/common/Avatar.vue'
import GroupIcon from '@/components/common/GroupIcon.vue'
import ServerIcon from '@/components/common/ServerIcon.vue'
import DisplayName from '@/components/DisplayName.vue'
import { useT } from '@/composables/useT'
import { supabase } from '@/supabase'
import { useAuthStore } from '@/stores/auth'
import { useDMStore, type DMConversation } from '@/stores/useDM'
import { useDraftsStore } from '@/stores/drafts'
import { useServerChannelStore } from '@/stores/useServerChannel'
import { Permission, roleService } from '@/services/RoleService'
import type { MessageTarget } from '@/stores/shared/sendToTarget'
import type { Server } from '@/types'
import { debug } from '@/utils/debug'
import {
  appendToDraft,
  composeSharedText,
  orderTextChannels,
  sharedPayloadFromQuery,
  type ShareChannelRow,
} from '@/utils/shareTarget'

const { t } = useT()
const route = useRoute()
const router = useRouter()
const authStore = useAuthStore()
const dmStore = useDMStore()
const draftsStore = useDraftsStore()
const serverStore = useServerChannelStore()

const previewHeadingId = useId()
const dmHeadingId = useId()
const serversHeadingId = useId()

const sharedText = computed(() => composeSharedText(sharedPayloadFromQuery(route.query)))
const query = ref('')
const busy = ref(false)
const dmsLoading = ref(false)
const openServers = ref(new Set<string>())
const channelState = reactive<Record<string, { status: 'loading' | 'ready' | 'error'; channels: ShareChannelRow[] }>>({})

const userId = computed(() => authStore.session?.user?.id ?? null)
const needle = computed(() => query.value.trim().toLocaleLowerCase())
const matches = (name: string) => !needle.value || name.toLocaleLowerCase().includes(needle.value)

function conversationName(c: DMConversation): string {
  if (c.type === 'group') {
    return c.name || (c.participants ?? []).slice(0, 3).map((p) => p.display_name || p.username).join(', ')
  }
  return c.other_user?.display_name || c.other_user?.username || ''
}

const dmRows = computed(() => dmStore.getSortedConversations
  .map((c) => ({
    id: c.id,
    group: c.type === 'group',
    name: conversationName(c),
    handle: c.type === 'group' ? '' : c.other_user?.username ?? '',
    userId: c.type === 'group' ? undefined : c.other_user?.id,
    icon: c.type === 'group' ? c.icon_url : c.other_user?.avatar_url,
  }))
  .filter((row) => row.name && (matches(row.name) || (!!row.handle && matches(row.handle)))))

// A server shows when its name matches, with all its channels, or when loaded
// channels match, with those channels.
const serverRows = computed(() => serverStore.servers.flatMap((server: Server) => {
  const channels = channelState[server.id]?.channels ?? []
  if (matches(server.name)) return [{ server, channels }]
  const hits = channels.filter((c) => matches(c.name))
  return hits.length ? [{ server, channels: hits }] : []
}))

const isOpen = (serverId: string) => openServers.value.has(serverId)

async function loadChannels(serverId: string): Promise<void> {
  const uid = userId.value
  if (!uid) return
  channelState[serverId] = { status: 'loading', channels: [] }
  try {
    const [categories, channels] = await Promise.all([
      supabase.from('channel_categories').select('id, order').eq('server_id', serverId),
      supabase.from('channels').select('id, name, type, order, category').eq('server_id', serverId).order('order'),
    ])
    if (categories.error) throw categories.error
    if (channels.error) throw channels.error
    const text = orderTextChannels(channels.data ?? [], categories.data ?? [])
    const allowed = await Promise.all(text.map((c) =>
      roleService.hasPermissions(uid, serverId, [Permission.VIEW_CHANNEL, Permission.SEND_MESSAGES], c.id)))
    channelState[serverId] = { status: 'ready', channels: text.filter((_, i) => allowed[i]) }
  } catch (error) {
    debug.warn('Share: channel list failed', error)
    channelState[serverId] = { status: 'error', channels: [] }
  }
}

function toggleServer(serverId: string): void {
  const next = new Set(openServers.value)
  if (next.has(serverId)) {
    next.delete(serverId)
  } else {
    next.add(serverId)
    if (!channelState[serverId] || channelState[serverId].status === 'error') void loadChannels(serverId)
  }
  openServers.value = next
}

/** The shared text joins the destination's draft; its composer opens with it. */
async function choose(target: MessageTarget): Promise<void> {
  if (busy.value || !sharedText.value) return
  busy.value = true
  const key = target.kind === 'dm'
    ? draftsStore.makeKey('conversation', target.conversationId)
    : draftsStore.makeKey('channel', target.channelId)
  draftsStore.saveDraft(key, appendToDraft(draftsStore.getDraft(key), sharedText.value))
  try {
    await router.replace(target.kind === 'dm'
      ? `/dm/${target.conversationId}`
      : `/chat/${target.serverId}/${target.channelId}`)
  } finally {
    busy.value = false
  }
}

function cancel(): void {
  void router.replace('/chat')
}

onMounted(async () => {
  const uid = userId.value
  if (!uid || dmStore.conversations.length > 0) return
  dmsLoading.value = true
  try {
    await dmStore.initializeDMEnvironment(uid, false, true, 'immediate')
  } finally {
    dmsLoading.value = false
  }
})
</script>

<style scoped>
.share-view {
  height: calc(100 * var(--app-vh));
  height: calc(100 * var(--app-dvh));
  display: flex;
  flex-direction: column;
  background: var(--background-primary);
  color: var(--text-primary);
}

.share-header {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  min-height: 56px;
  padding: var(--space-2) var(--space-4);
  border-bottom: 1px solid var(--border-primary);
  flex-shrink: 0;
}

.share-header h1 {
  margin: 0;
  font-size: var(--font-size-lg);
  font-weight: var(--font-weight-bold);
  line-height: var(--line-height-tight);
}

.share-icon-button {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  flex-shrink: 0;
  border: none;
  border-radius: var(--radius-base);
  background: none;
  color: var(--text-secondary);
  cursor: pointer;
}

.share-icon-button:hover {
  background: var(--background-modifier-hover);
  color: var(--text-primary);
}

.share-scroll {
  flex: 1;
  overflow-y: auto;
  padding: var(--space-4) var(--space-4) var(--space-8);
}

.share-inner {
  max-width: 560px;
  margin: 0 auto;
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.share-nothing {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: var(--space-3);
  color: var(--text-secondary);
}

.share-preview {
  padding: var(--space-3);
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-md);
  background: var(--background-secondary);
}

.share-preview-text {
  margin: var(--space-1) 0 0;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  max-height: 160px;
  overflow-y: auto;
  color: var(--text-primary);
}

.share-label {
  margin: 0;
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-bold);
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: var(--text-muted);
}

.share-question {
  margin: var(--space-2) 0 0;
  font-size: var(--font-size-base);
  font-weight: var(--font-weight-semibold);
}

.share-search {
  width: 100%;
  box-sizing: border-box;
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-base);
  background: var(--background-secondary);
  color: var(--text-primary);
  font: inherit;
}

.share-list {
  list-style: none;
  margin: var(--space-1) 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}

.share-row {
  display: flex;
  align-items: center;
  gap: var(--space-2);
  width: 100%;
  min-height: 44px;
  padding: var(--space-1) var(--space-2);
  border: none;
  border-radius: var(--radius-base);
  background: none;
  color: var(--text-secondary);
  font: inherit;
  text-align: start;
  cursor: pointer;
}

.share-row:hover:not(:disabled) {
  background: var(--background-modifier-hover);
  color: var(--text-primary);
}

.share-row:disabled {
  cursor: default;
  opacity: 0.6;
}

.share-row-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.share-row-hash,
.share-row-chevron {
  flex-shrink: 0;
  color: var(--text-muted);
}

.share-channels {
  padding-inline-start: var(--space-6);
}

.share-muted {
  margin: var(--space-1) 0;
  color: var(--text-muted);
  font-size: var(--font-size-sm);
}

.share-button {
  padding: var(--space-2) var(--space-4);
  border: none;
  border-radius: var(--radius-base);
  background: var(--harmony-primary-fill);
  color: var(--text-on-primary);
  font: inherit;
  font-weight: var(--font-weight-medium);
  cursor: pointer;
}

.share-text-button {
  border: none;
  background: none;
  padding: 0;
  margin-inline-start: var(--space-1);
  color: var(--text-link);
  font: inherit;
  cursor: pointer;
  text-decoration: underline;
}

.share-icon-button:focus-visible,
.share-row:focus-visible,
.share-button:focus-visible,
.share-text-button:focus-visible,
.share-search:focus-visible {
  outline: 2px solid var(--border-focus);
  outline-offset: 2px;
}
</style>
