<template>
  <div class="eic" :aria-busy="loading ? 'true' : undefined">
    <div class="eic-head">
      <img
        v-if="glyphImage"
        :src="glyphImage"
        alt=""
        class="eic-glyph"
        draggable="false"
        data-testid="emoji-info-glyph"
      />
      <span v-else class="eic-glyph eic-glyph-char" aria-hidden="true" data-testid="emoji-info-glyph">{{ glyphChar }}</span>
      <div class="eic-head-text">
        <h2 :id="titleId" class="eic-name" data-testid="emoji-info-name">{{ title }}</h2>
        <p :id="descriptionId" class="eic-source" data-testid="emoji-info-source">{{ sourceLine }}</p>
      </div>
    </div>

    <p v-if="reactions" class="eic-reactors" data-testid="emoji-info-reactors">
      <template v-if="!shownReactors.length">{{ t('emojiInfo.reactionCount', { count: reactionCount }, reactionCount) }}</template>
      <i18n-t
        v-else
        :keypath="otherReactors > 0 ? 'emojiInfo.reactedByOthers' : 'emojiInfo.reactedBy'"
        :plural="otherReactors > 0 ? otherReactors : undefined"
        scope="global"
      >
        <template #names>
          <template v-for="(user, index) in shownReactors" :key="user.key">
            <template v-if="index > 0">{{ t('emojiInfo.nameSeparator') }}</template>
            <DisplayName v-if="user.kind === 'user' && user.id" :user-id="user.id" :fallback="user.displayName" />
            <template v-else>{{ user.displayName }}</template>
          </template>
        </template>
        <template #count>{{ otherReactors }}</template>
      </i18n-t>
    </p>

    <div v-if="owner" class="eic-owner" data-testid="emoji-info-owner">
      <Avatar :src="owner.avatarUrl || ''" size="xs" class="eic-owner-avatar" />
      <span class="eic-owner-name">
        <DisplayName :user-id="owner.id" :fallback="ownerName" truncate />
        <span class="eic-handle">{{ ownerHandle }}</span>
      </span>
    </div>

    <section
      v-if="server"
      class="eic-server"
      :aria-label="server.name"
      data-testid="emoji-info-server"
    >
      <div class="eic-server-row">
        <ServerIcon :src="server.icon" :name="server.name" :alt="''" size="sm" :show-title="false" />
        <div class="eic-server-text">
          <span class="eic-server-name" data-testid="emoji-info-server-name">{{ server.name }}</span>
          <span class="eic-server-meta">{{ serverMeta }}</span>
        </div>
        <button
          v-if="server.joinable"
          type="button"
          class="btn btn-primary eic-join"
          :disabled="joining"
          data-testid="emoji-info-join"
          @click="join"
        >
          {{ joining ? t('server.joining') : t('server.join') }}
        </button>
      </div>
      <ul
        v-if="shownEmojis.length"
        ref="moreRef"
        class="eic-more"
        :style="{ '--eic-columns': moreColumns }"
        :aria-label="t('emojiInfo.moreEmoji')"
        data-testid="emoji-info-more"
      >
        <li v-for="emoji in shownEmojis" :key="emoji.id">
          <img
            :src="getEmojiUrl(emoji.url, 48)"
            :alt="`:${emoji.name}:`"
            :title="`:${emoji.name}:`"
            loading="lazy"
            draggable="false"
          />
        </li>
      </ul>
    </section>

    <div class="eic-actions">
      <button
        type="button"
        class="eic-action eic-action--icon"
        :aria-label="t('emojiInfo.copy')"
        :title="t('emojiInfo.copy')"
        data-testid="emoji-info-copy"
        @click="copyEmoji"
      >
        <Icon name="copy" :size="15" aria-hidden="true" />
      </button>
      <button
        v-if="imageLink"
        type="button"
        class="eic-action eic-action--icon"
        :aria-label="t('emojiInfo.copyLink')"
        :title="t('emojiInfo.copyLink')"
        data-testid="emoji-info-copy-link"
        @click="copyLink"
      >
        <Icon name="link" :size="15" aria-hidden="true" />
      </button>
      <button
        v-if="reactions?.onShowAll"
        type="button"
        class="eic-action eic-action--all"
        data-testid="emoji-info-all-reactions"
        @click="reactions.onShowAll()"
      >
        <Icon name="users" :size="14" aria-hidden="true" />
        <span class="eic-action-label">{{ t('emojiInfo.allReactions') }}</span>
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { useToast } from 'vue-toastification'
import Avatar from '@/components/common/Avatar.vue'
import ServerIcon from '@/components/common/ServerIcon.vue'
import Icon from '@/components/common/Icon.vue'
import DisplayName from '@/components/DisplayName.vue'
import { useT } from '@/composables/useT'
import { useServerChannelStore } from '@/stores/useServerChannel'
import { useServerStore } from '@/stores/server'
import { useProfileStore } from '@/stores/useProfile'
import { useAuthStore } from '@/stores/auth'
import { getEmojiUrl } from '@/utils/emojiUtils'
import { emojiInfoCopyText, emojiInfoName, type EmojiInfoTarget } from '@/utils/emojiInfoTarget'
import { fetchEmojiSource, invalidateEmojiSources, type EmojiSource } from '@/services/emojiSourceService'
import type { EmojiInfoReactions } from '@/composables/useEmojiInfo'

const props = defineProps<{
  target: EmojiInfoTarget
  titleId: string
  descriptionId: string
  reactions?: EmojiInfoReactions
}>()

const { t } = useT()
const toast = useToast()
const serverChannelStore = useServerChannelStore()
const profileStore = useProfileStore()

/** Names a reaction line lists before "and N others". */
const REACTOR_NAMES = 3
/** Preview columns before the row is measured: a 280 px card at 28 px emoji and 4 px gaps. */
const DEFAULT_MORE_COLUMNS = 7
/** Preview emoji size when --eic-emoji-size is unset, px. */
const DEFAULT_EMOJI_SIZE = 28

const source = ref<EmojiSource | null>(null)
let lookup = 0

async function load(): Promise<void> {
  const target = props.target
  const token = ++lookup
  source.value = null
  if (target.kind !== 'custom') return
  const answer = await fetchEmojiSource({ id: target.id, url: target.url, name: target.name })
  if (token === lookup) source.value = answer
}

watch(() => props.target, load, { immediate: true })

const loading = computed(() => props.target.kind === 'custom' && source.value === null)

const glyphImage = computed(() => {
  const target = props.target
  if (target.kind === 'default') return target.imageUrl
  return getEmojiUrl(target.url, 96)
})
const glyphChar = computed(() => (props.target.kind === 'default' ? props.target.glyph : ''))

const title = computed(() => {
  const name = emojiInfoName(props.target)
  return name ? `:${name}:` : t('emojiInfo.dialog')
})

const server = computed(() => (source.value?.kind === 'server' ? source.value.server : null))
const owner = computed(() => (source.value?.kind === 'personal' ? source.value.owner : null))
const ownerName = computed(() => owner.value?.displayName || owner.value?.username || '')
const ownerHandle = computed(() => {
  const o = owner.value
  if (!o) return ''
  return !o.isLocal && o.domain ? `@${o.username}@${o.domain}` : `@${o.username}`
})

const sourceLine = computed((): string => {
  const target = props.target
  if (target.kind === 'default') return t('emojiInfo.default')
  if (target.kind === 'discord') return t('emojiInfo.discord')
  const answer = source.value
  if (!answer) return t('emojiInfo.loading')
  switch (answer.kind) {
    case 'server': {
      const s = answer.server
      if (s.domain) return t('emojiInfo.remoteServer', { server: s.name, domain: s.domain })
      if (s.isMember && s.id === serverChannelStore.currentServerId) return t('emojiInfo.thisServer')
      if (s.isMember) return t('emojiInfo.yourServer', { server: s.name })
      return t('emojiInfo.publicServer', { server: s.name })
    }
    case 'personal':
      if (answer.owner && answer.owner.id === profileStore.profileId) return t('emojiInfo.personalYours')
      return answer.owner ? t('emojiInfo.personalOf', { name: ownerName.value }) : t('emojiInfo.personalUnknown')
    case 'instance':
      return t('emojiInfo.instance')
    case 'remote':
      return t('emojiInfo.remote', { domain: answer.domain })
    default:
      return target.remoteHost ? t('emojiInfo.remote', { domain: target.remoteHost }) : t('emojiInfo.unavailable')
  }
})

// The preview is one row: its columns are the emoji (--eic-emoji-size, column gap
// --eic-emoji-gap) the row's width holds, and it lists no more emoji than that.
const moreRef = ref<HTMLElement | null>(null)
const moreColumns = ref(DEFAULT_MORE_COLUMNS)
let moreObserver: ResizeObserver | null = null

function measureMore(el: HTMLElement): void {
  const width = el.clientWidth
  if (width <= 0) return
  const style = getComputedStyle(el)
  const size = parseFloat(style.getPropertyValue('--eic-emoji-size')) || DEFAULT_EMOJI_SIZE
  const gap = parseFloat(style.columnGap) || 0
  moreColumns.value = Math.max(1, Math.floor((width + gap) / (size + gap)))
}

watch(moreRef, (el) => {
  moreObserver?.disconnect()
  moreObserver = null
  if (!el) return
  measureMore(el)
  if (typeof ResizeObserver === 'undefined') return
  moreObserver = new ResizeObserver(() => measureMore(el))
  moreObserver.observe(el)
}, { flush: 'post' })

onBeforeUnmount(() => moreObserver?.disconnect())

const shownEmojis = computed(() => server.value?.emojis.slice(0, moreColumns.value) ?? [])

const serverMeta = computed(() => {
  const s = server.value
  if (!s) return ''
  const members = t('emojiInfo.members', { count: s.memberCount }, s.memberCount)
  return `${members} · ${s.public ? t('emojiInfo.publicLabel') : t('emojiInfo.privateLabel')}`
})

const reactionCount = computed(() => props.reactions?.count() ?? 0)
const shownReactors = computed(() =>
  (props.reactions?.users() ?? []).slice(0, REACTOR_NAMES).filter((user) => !!user.displayName))
const otherReactors = computed(() => Math.max(0, reactionCount.value - shownReactors.value.length))

const imageLink = computed(() => (props.target.kind === 'default' ? null : props.target.url || null))

async function writeClipboard(text: string, message: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    toast.success(message, { timeout: 2000 })
  } catch {
    toast.error(t('emojiInfo.copyFailed'))
  }
}

function copyEmoji(): void {
  const text = emojiInfoCopyText(props.target)
  void writeClipboard(text, t('emojiInfo.copied', { text }))
}

function copyLink(): void {
  if (imageLink.value) void writeClipboard(imageLink.value, t('emojiInfo.linkCopied'))
}

const joining = ref(false)

async function join(): Promise<void> {
  const s = server.value
  if (!s || joining.value) return
  joining.value = true
  try {
    // joinServer toasts its own failures.
    if (!(await useServerStore().joinServer(s.id))) return
    invalidateEmojiSources()
    const authId = useAuthStore().session?.user?.id
    if (authId) await serverChannelStore.fetchServersForUser(authId, true)
    toast.success(t('emojiInfo.joined', { server: s.name }), { timeout: 3000 })
    await load()
  } finally {
    joining.value = false
  }
}
</script>

<style scoped>
.eic {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}

.eic-head {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.eic-glyph {
  width: 40px;
  height: 40px;
  flex-shrink: 0;
  object-fit: contain;
  user-select: none;
  -webkit-user-drag: none;
}

.eic-glyph-char {
  font-size: 32px;
  line-height: 40px;
  text-align: center;
}

.eic-head-text {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}

.eic-name {
  margin: 0;
  font-size: 0.875rem;
  font-weight: 700;
  line-height: 1.3;
  color: var(--text-primary);
  overflow-wrap: anywhere;
}

.eic-source,
.eic-reactors {
  margin: 0;
  font-size: 0.75rem;
  line-height: 1.35;
  color: var(--text-secondary);
  overflow-wrap: anywhere;
}

.eic-reactors {
  padding-top: 6px;
  border-top: 1px solid var(--border-primary);
}

.eic-owner {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  font-size: 0.75rem;
}

.eic-owner-name {
  display: flex;
  flex-direction: column;
  min-width: 0;
  color: var(--text-primary);
  font-weight: 600;
}

.eic-handle {
  font-weight: 400;
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.eic-server {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px;
  border-radius: var(--radius-md);
  background: var(--background-secondary);
}

.eic-server-row {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}

.eic-server-text {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-width: 0;
}

.eic-server-name {
  font-weight: 700;
  font-size: 0.8125rem;
  line-height: 1.3;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.eic-server-meta {
  font-size: 0.6875rem;
  line-height: 1.3;
  color: var(--text-muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.eic-join {
  flex-shrink: 0;
  min-height: 28px;
  padding: 4px 12px;
  font-size: 0.75rem;
}

.eic-more {
  display: grid;
  grid-template-columns: repeat(var(--eic-columns, 7), minmax(0, 1fr));
  column-gap: var(--eic-emoji-gap, 4px);
  justify-items: center;
  margin: 0;
  padding: 0;
  list-style: none;
}

.eic-more li {
  display: flex;
}

.eic-more img {
  width: var(--eic-emoji-size, 28px);
  height: var(--eic-emoji-size, 28px);
  object-fit: contain;
  -webkit-user-drag: none;
}

.eic-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
}

.eic-action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  min-width: 28px;
  min-height: 28px;
  padding: 0 8px;
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--text-secondary);
  font: inherit;
  font-size: 0.75rem;
  cursor: pointer;
}

.eic-action--icon {
  width: 28px;
  padding: 0;
}

.eic-action--all {
  min-width: 0;
  margin-left: auto;
}

.eic-action-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.eic-action:hover {
  background: var(--background-modifier-hover, var(--background-secondary));
  color: var(--text-primary);
}

.eic-action:focus-visible,
.eic-join:focus-visible {
  outline: 2px solid var(--focus-ring, var(--harmony-primary));
  outline-offset: 2px;
}

@media (pointer: coarse) {
  .eic-action,
  .eic-join {
    min-height: 40px;
  }

  .eic-action--icon {
    width: 40px;
  }
}
</style>
