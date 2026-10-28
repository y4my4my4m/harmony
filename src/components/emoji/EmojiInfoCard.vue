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

    <p v-if="reactions" class="eic-reactors" data-testid="emoji-info-reactors">{{ reactorsLine }}</p>

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
      </div>
      <ul
        v-if="server.emojis.length"
        class="eic-more"
        :aria-label="t('emojiInfo.moreEmoji')"
        data-testid="emoji-info-more"
      >
        <li v-for="emoji in server.emojis" :key="emoji.id">
          <img
            :src="getEmojiUrl(emoji.url, 48)"
            :alt="`:${emoji.name}:`"
            :title="`:${emoji.name}:`"
            loading="lazy"
            draggable="false"
          />
        </li>
      </ul>
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
    </section>

    <div class="eic-actions">
      <button type="button" class="eic-action" data-testid="emoji-info-copy" @click="copyEmoji">
        <Icon name="copy" :size="14" aria-hidden="true" />
        <span>{{ t('emojiInfo.copy') }}</span>
      </button>
      <button v-if="imageLink" type="button" class="eic-action" data-testid="emoji-info-copy-link" @click="copyLink">
        <Icon name="link" :size="14" aria-hidden="true" />
        <span>{{ t('emojiInfo.copyLink') }}</span>
      </button>
      <button
        v-if="reactions?.onShowAll"
        type="button"
        class="eic-action"
        data-testid="emoji-info-all-reactions"
        @click="reactions.onShowAll()"
      >
        <Icon name="users" :size="14" aria-hidden="true" />
        <span>{{ t('emojiInfo.allReactions') }}</span>
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
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

const serverMeta = computed(() => {
  const s = server.value
  if (!s) return ''
  const members = t('emojiInfo.members', { count: s.memberCount }, s.memberCount)
  return `${members} · ${s.public ? t('emojiInfo.publicLabel') : t('emojiInfo.privateLabel')}`
})

const reactorsLine = computed(() => {
  const reactions = props.reactions
  if (!reactions) return ''
  const users = reactions.users()
  const names = users.slice(0, REACTOR_NAMES).map((u) => u.displayName).filter(Boolean)
  const shown = names.join(t('emojiInfo.nameSeparator'))
  const count = reactions.count()
  const others = Math.max(0, count - names.length)
  if (!shown) return t('emojiInfo.reactionCount', { count }, count)
  return others > 0
    ? t('emojiInfo.reactedByOthers', { names: shown, count: others }, others)
    : t('emojiInfo.reactedBy', { names: shown })
})

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
  gap: 10px;
  min-width: 0;
}

.eic-head {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}

.eic-glyph {
  width: 48px;
  height: 48px;
  flex-shrink: 0;
  object-fit: contain;
  user-select: none;
  -webkit-user-drag: none;
}

.eic-glyph-char {
  font-size: 40px;
  line-height: 48px;
  text-align: center;
}

.eic-head-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}

.eic-name {
  margin: 0;
  font-size: 0.9375rem;
  font-weight: 700;
  color: var(--text-primary);
  overflow-wrap: anywhere;
}

.eic-source,
.eic-reactors {
  margin: 0;
  font-size: 0.8125rem;
  line-height: 1.35;
  color: var(--text-secondary);
  overflow-wrap: anywhere;
}

.eic-reactors {
  padding-top: 8px;
  border-top: 1px solid var(--border-primary);
}

.eic-owner {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  font-size: 0.8125rem;
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
  gap: 8px;
  padding: 10px;
  border-radius: var(--radius-md);
  background: var(--background-secondary);
}

.eic-server-row {
  display: flex;
  align-items: center;
  gap: 10px;
  min-width: 0;
}

.eic-server-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.eic-server-name {
  font-weight: 700;
  font-size: 0.875rem;
  color: var(--text-primary);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.eic-server-meta {
  font-size: 0.75rem;
  color: var(--text-muted);
}

.eic-more {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(28px, 1fr));
  gap: 4px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.eic-more img {
  width: 28px;
  height: 28px;
  object-fit: contain;
  -webkit-user-drag: none;
}

.eic-join {
  width: 100%;
}

.eic-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.eic-action {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 28px;
  padding: 4px 10px;
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--text-secondary);
  font: inherit;
  font-size: 0.8125rem;
  cursor: pointer;
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
  .eic-action {
    min-height: 40px;
  }
}
</style>
