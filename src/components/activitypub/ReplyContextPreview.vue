<!-- The post a reply answers, above the reply's text: the parent's avatar, name and the start
     of its text in at most two lines, one link to the parent's page with this reply
     highlighted. A parent that is deleted, hidden from the reader or not stored here is one
     muted line; a remote one links to its origin. -->
<template>
  <RouterLink
    v-if="kind === 'post' && parentRoute"
    :to="parentRoute"
    class="reply-context"
    data-testid="post-reply-context"
    data-state="post"
    :title="handleTitle"
    @click.stop
  >
    <Icon name="reply" :size="14" class="reply-context-icon" />
    <Avatar :src="author?.avatar_url" alt="" size="mini" class="reply-context-avatar" />
    <!-- The name is the visible text with "Replying to" before it: a label replacing the text
         fails WCAG 2.5.3 (label in name). The spaces are interpolated: the template compiler
         drops whitespace-only text between elements. -->
    <span class="reply-context-text">
      <span class="sr-only">{{ `${t('activitypub.replyingTo')} ` }}</span>
      <span class="reply-context-name"><DisplayName :userId="author?.id" :fallback="authorName" /></span>{{ ' ' }}
      <span v-if="contentWarning" class="reply-context-snippet reply-context-cw">
        {{ t('activitypub.replyContext.contentWarning', { text: contentWarning }) }}
      </span>
      <span v-else-if="snippet" class="reply-context-snippet">{{ snippet }}</span>
      <span v-else-if="mediaLabel" class="reply-context-snippet reply-context-media">
        <Icon :name="mediaIcon" :size="12" class="reply-context-inline-icon" />{{ mediaLabel }}
      </span>
    </span>
  </RouterLink>
  <a
    v-else-if="kind === 'remote' && remoteUrl"
    :href="safeHref(remoteUrl)"
    target="_blank"
    rel="noopener noreferrer"
    class="reply-context is-placeholder"
    data-testid="post-reply-context"
    data-state="remote"
    @click.stop
  >
    <Icon name="reply" :size="14" class="reply-context-icon" />
    <span class="reply-context-text">{{ placeholderText }}</span>
  </a>
  <div
    v-else-if="kind !== 'none'"
    class="reply-context is-placeholder"
    :class="{ 'is-loading': kind === 'loading' }"
    data-testid="post-reply-context"
    :data-state="kind"
    :role="kind === 'loading' ? 'status' : undefined"
  >
    <Icon name="reply" :size="14" class="reply-context-icon" />
    <span v-if="kind === 'loading'" class="reply-context-skeleton" aria-hidden="true"></span>
    <span :class="kind === 'loading' ? 'sr-only' : 'reply-context-text'">{{ placeholderText }}</span>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { useI18n } from 'vue-i18n'
import Icon from '@/components/common/Icon.vue'
import Avatar from '@/components/common/Avatar.vue'
import DisplayName from '@/components/DisplayName.vue'
import { safeHref } from '@/utils/sanitize'
import { replySnippet } from '@/services/replyContext'
import { runtimeConfig } from '@/services/runtimeConfig'
import type { ReplyContext } from '@/types/activitypub'

const props = defineProps<{
  context: ReplyContext | null
  /** The parent is being read. */
  loading?: boolean
  /** The reply, highlighted on the parent's page. */
  replyId: string
}>()

const { t } = useI18n()

const kind = computed<'post' | 'deleted' | 'hidden' | 'remote' | 'loading' | 'none'>(() => {
  const ctx = props.context
  if (!ctx) return props.loading ? 'loading' : 'none'
  if (ctx.state === 'remote') return ctx.url ? 'remote' : 'none'
  if (ctx.state === 'deleted' || ctx.state === 'hidden') return ctx.state
  // Rows without `state` come from reads that predate it; a parent without an id or author is
  // one those reads could not see.
  return ctx.id && ctx.author?.id ? 'post' : 'hidden'
})

const author = computed(() => props.context?.author)
const authorName = computed(() => {
  const a = author.value
  return a ? a.display_name || a.username : ''
})

const handle = computed(() => {
  const a = author.value
  if (!a) return ''
  const domain = a.domain && a.domain !== '.' ? a.domain : (runtimeConfig.domain as string)
  return domain ? `@${a.username}@${domain}` : `@${a.username}`
})

const handleTitle = computed(() => `${t('activitypub.replyingTo')} ${handle.value}`)

const parentRoute = computed(() => {
  const id = props.context?.id
  return id ? { name: 'PostDetail', params: { postId: id }, query: { highlight: props.replyId } } : null
})

const contentWarning = computed(() => props.context?.content_warning?.trim() || '')

const snippet = computed(() => {
  const ctx = props.context
  if (!ctx) return ''
  return ctx.content_preview ?? replySnippet(ctx.content)
})

const media = computed(() => props.context?.media_attachments ?? [])

const mediaLabel = computed(() => {
  const items = media.value
  if (items.length === 0) return ''
  if (items.length > 1) return t('activitypub.replyContext.attachments', { count: items.length }, items.length)
  const type = items[0]?.type
  if (type === 'image' || type === 'gifv') return t('activitypub.image')
  if (type === 'video') return t('activitypub.video')
  if (type === 'audio') return t('activitypub.audio')
  return t('activitypub.file')
})

const mediaIcon = computed(() => {
  const type = media.value[0]?.type
  if (media.value.length === 1 && type === 'video') return 'video'
  if (media.value.length === 1 && type === 'audio') return 'music'
  return 'image'
})

const remoteUrl = computed(() => (props.context?.state === 'remote' ? props.context.url || '' : ''))

const remoteDomain = computed(() => {
  try {
    return new URL(remoteUrl.value).hostname
  } catch {
    return ''
  }
})

const placeholderText = computed(() => {
  switch (kind.value) {
    case 'deleted': return t('activitypub.replyContext.deleted')
    case 'hidden': return t('activitypub.replyContext.hidden')
    case 'remote': return t('activitypub.replyContext.remote', { domain: remoteDomain.value })
    case 'loading': return t('activitypub.replyContext.loading')
    default: return ''
  }
})
</script>

<style scoped>
/* Two lines at most: the name runs into the text, which the clamp cuts. */
.reply-context {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  min-width: 0;
  max-width: 100%;
  margin-bottom: var(--space-2);
  padding: var(--space-1) var(--space-2);
  border-left: 2px solid var(--border-primary);
  border-radius: 0 var(--radius-sm) var(--radius-sm) 0;
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
  line-height: 1.4;
  text-decoration: none;
}

a.reply-context:hover {
  background: var(--background-modifier-hover);
  border-left-color: var(--border-hover);
}

a.reply-context:focus-visible {
  outline: 2px solid var(--harmony-primary);
  outline-offset: 2px;
}

.reply-context-icon,
.reply-context-avatar {
  flex-shrink: 0;
  /* Centred on the first line: 1.4 line-height. */
  margin-top: calc((1.4em - 16px) / 2);
}

.reply-context-icon {
  color: var(--text-muted);
}

.reply-context-text {
  flex: 1 1 auto;
  min-width: 0;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  overflow: hidden;
  overflow-wrap: anywhere;
}

.reply-context-name {
  color: var(--text-primary);
  font-weight: 600;
}

.reply-context-snippet {
  color: var(--text-secondary);
}

.reply-context-inline-icon {
  display: inline-block;
  margin-right: var(--space-1);
  vertical-align: -1px;
}

.reply-context.is-placeholder .reply-context-text {
  -webkit-line-clamp: 1;
  line-clamp: 1;
  font-style: italic;
}

a.reply-context.is-placeholder .reply-context-text {
  color: var(--text-link);
  font-style: normal;
}

.reply-context-skeleton {
  flex: 1 1 auto;
  max-width: 60%;
  height: 1.4em;
  border-radius: var(--radius-sm);
  background: var(--background-modifier-hover);
}
</style>
