<template>
  <article class="fedi-post" :class="{ 'has-cw': fediverse.contentWarning && !showContent }">
    <div class="fedi-post__header">
      <a :href="fediverse.authorUrl" target="_blank" rel="noopener noreferrer" class="fedi-post__author">
        <img
          v-if="fediverse.authorAvatar"
          :src="fediverse.authorAvatar"
          :alt="fediverse.authorName"
          class="fedi-post__avatar"
          loading="lazy"
        />
        <div v-else class="fedi-post__avatar fedi-post__avatar--placeholder">
          {{ fediverse.authorName.charAt(0).toUpperCase() }}
        </div>
        <div class="fedi-post__author-info">
          <span class="fedi-post__display-name">{{ fediverse.authorName }}</span>
          <span class="fedi-post__handle">{{ fediverse.authorHandle }}</span>
        </div>
      </a>
      <div class="fedi-post__meta">
        <span v-if="platformLabel" class="fedi-post__platform" :title="fediverse.platform">
          {{ platformIcon }} {{ platformLabel }}
        </span>
        <time
          v-if="fediverse.published"
          :datetime="fediverse.published"
          :title="fullDate"
          class="fedi-post__time"
        >
          {{ relativeTime }}
        </time>
      </div>
    </div>

    <div v-if="fediverse.contentWarning" class="fedi-post__cw">
      <div class="fedi-post__cw-label">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
          <line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>
        </svg>
        <span>{{ fediverse.contentWarning }}</span>
      </div>
      <button class="fedi-post__cw-toggle" @click="showContent = !showContent">
        {{ showContent ? 'Hide' : 'Show' }} content
      </button>
    </div>

    <div v-show="!fediverse.contentWarning || showContent" class="fedi-post__body">
      <div class="fedi-post__content" v-html="sanitizedContent"></div>

      <div
        v-if="imageAttachments.length > 0"
        class="fedi-post__media"
        :class="{ 'fedi-post__media--single': imageAttachments.length === 1, 'fedi-post__media--grid': imageAttachments.length > 1 }"
      >
        <img
          v-for="(img, idx) in imageAttachments"
          :key="idx"
          :src="img.url"
          :alt="img.alt || ''"
          class="fedi-post__media-image"
          loading="lazy"
        />
      </div>
    </div>

    <div class="fedi-post__footer">
      <div v-if="hasStats" class="fedi-post__stats">
        <span v-if="fediverse.stats?.replies != null" class="fedi-post__stat" title="Replies">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>
          </svg>
          {{ formatCount(fediverse.stats.replies) }}
        </span>
        <span v-if="fediverse.stats?.reblogs != null" class="fedi-post__stat" title="Boosts">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polyline points="17 1 21 5 17 9"/><path d="M3 11V9a4 4 0 0 1 4-4h14"/>
            <polyline points="7 23 3 19 7 15"/><path d="M21 13v2a4 4 0 0 1-4 4H3"/>
          </svg>
          {{ formatCount(fediverse.stats.reblogs) }}
        </span>
        <span v-if="fediverse.stats?.favourites != null" class="fedi-post__stat" title="Favourites">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
          </svg>
          {{ formatCount(fediverse.stats.favourites) }}
        </span>
      </div>
      <a :href="fediverse.postUrl" target="_blank" rel="noopener noreferrer" class="fedi-post__view-link">
        View on {{ sourceDomain }}
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>
          <polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>
        </svg>
      </a>
    </div>
  </article>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue';
import { formatDistanceToNow, format } from 'date-fns';
import DOMPurify from 'dompurify';
import type { FediverseEmbedSummary } from '@/types';

const props = defineProps<{
  fediverse: FediverseEmbedSummary;
}>();

const showContent = ref(false);

const sanitizedContent = computed(() => {
  return DOMPurify.sanitize(props.fediverse.content || '', {
    ALLOWED_TAGS: ['p', 'br', 'a', 'span', 'em', 'strong', 'b', 'i', 'del', 'pre', 'code', 'blockquote', 'ul', 'ol', 'li', 'img', 'video', 'audio', 'source', 'picture', 'figure', 'figcaption', 'sub', 'sup'],
    ALLOWED_ATTR: ['href', 'rel', 'target', 'class', 'title', 'src', 'alt', 'width', 'height', 'loading', 'controls', 'type'],
    ALLOW_DATA_ATTR: false,
  });
});

const imageAttachments = computed(() => {
  return (props.fediverse.attachments || []).filter(a =>
    a.mediaType?.startsWith('image/') || /\.(jpe?g|png|gif|webp|avif)/i.test(a.url || '')
  );
});

const sourceDomain = computed(() => {
  try {
    return new URL(props.fediverse.postUrl).hostname;
  } catch {
    return 'source';
  }
});

const relativeTime = computed(() => {
  if (!props.fediverse.published) return '';
  try {
    return formatDistanceToNow(new Date(props.fediverse.published), { addSuffix: true });
  } catch {
    return '';
  }
});

const fullDate = computed(() => {
  if (!props.fediverse.published) return '';
  try {
    return format(new Date(props.fediverse.published), 'PPP p');
  } catch {
    return props.fediverse.published;
  }
});

const hasStats = computed(() => {
  const s = props.fediverse.stats;
  return s && (s.replies != null || s.reblogs != null || s.favourites != null);
});

function formatCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

const PLATFORM_MAP: Record<string, { icon: string; label: string }> = {
  mastodon: { icon: '🐘', label: 'Mastodon' },
  misskey: { icon: '🌎', label: 'Misskey' },
  pleroma: { icon: '🔵', label: 'Pleroma' },
  gotosocial: { icon: '🐿️', label: 'GoToSocial' },
  pixelfed: { icon: '📷', label: 'Pixelfed' },
  harmony: { icon: '🎵', label: 'Harmony' },
  lemmy: { icon: '🐭', label: 'Lemmy' },
  fediverse: { icon: '🌐', label: 'Fediverse' },
};

const platformLabel = computed(() => {
  const p = props.fediverse.platform || 'fediverse';
  return PLATFORM_MAP[p]?.label || 'Fediverse';
});

const platformIcon = computed(() => {
  const p = props.fediverse.platform || 'fediverse';
  return PLATFORM_MAP[p]?.icon || '🌐';
});
</script>

<style scoped>
.fedi-post {
  background: var(--background-quinary, #161b22);
  border: 1px solid var(--border-color, #30363d);
  border-radius: 12px;
  overflow: hidden;
}

.fedi-post__header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  padding: 12px 14px 0;
  gap: 8px;
}

.fedi-post__author {
  display: flex;
  align-items: center;
  gap: 10px;
  text-decoration: none;
  color: inherit;
  min-width: 0;
  flex: 1;
}

.fedi-post__author:hover .fedi-post__display-name {
  text-decoration: underline;
}

.fedi-post__avatar {
  width: 40px;
  height: 40px;
  border-radius: 50%;
  object-fit: cover;
  flex-shrink: 0;
  background: var(--background-tertiary, #21262d);
}

.fedi-post__avatar--placeholder {
  display: flex;
  align-items: center;
  justify-content: center;
  font-weight: 700;
  font-size: 16px;
  color: var(--text-secondary, #8b949e);
}

.fedi-post__author-info {
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.fedi-post__display-name {
  font-weight: 600;
  font-size: 14px;
  color: var(--text-primary, #e6edf3);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.fedi-post__handle {
  font-size: 12px;
  color: var(--text-secondary, #8b949e);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.fedi-post__meta {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 2px;
  flex-shrink: 0;
}

.fedi-post__platform {
  font-size: 11px;
  color: var(--text-secondary, #8b949e);
  background: var(--background-secondary, #1c2128);
  padding: 2px 6px;
  border-radius: 4px;
  white-space: nowrap;
}

.fedi-post__time {
  font-size: 12px;
  color: var(--text-secondary, #8b949e);
}

.fedi-post__cw {
  margin: 10px 14px 0;
  padding: 10px;
  background: var(--background-secondary, #1c2128);
  border: 1px solid var(--border-color, #30363d);
  border-radius: 8px;
}

.fedi-post__cw-label {
  display: flex;
  align-items: center;
  gap: 6px;
  color: #f0883e;
  font-weight: 500;
  font-size: 13px;
  margin-bottom: 8px;
}

.fedi-post__cw-toggle {
  background: var(--background-tertiary, #21262d);
  color: var(--text-primary, #e6edf3);
  border: none;
  padding: 4px 10px;
  border-radius: 4px;
  cursor: pointer;
  font-size: 12px;
}

.fedi-post__cw-toggle:hover {
  background: var(--background-quaternary, #30363d);
}

.fedi-post__body {
  padding: 8px 14px;
}

.fedi-post__content {
  font-size: 14px;
  line-height: 1.55;
  color: var(--text-primary, #e6edf3);
  word-wrap: break-word;
  overflow-wrap: break-word;
}

.fedi-post__content :deep(a) {
  color: var(--harmony-primary, #58a6ff);
  text-decoration: none;
}

.fedi-post__content :deep(a:hover) {
  text-decoration: underline;
}

.fedi-post__content :deep(p) {
  margin: 0 0 0.5em;
}

.fedi-post__content :deep(p:last-child) {
  margin-bottom: 0;
}

.fedi-post__content :deep(.invisible) {
  display: none;
}

.fedi-post__content :deep(.ellipsis)::after {
  content: '...';
}

.fedi-post__media {
  margin-top: 8px;
  border-radius: 8px;
  overflow: hidden;
}

.fedi-post__media--grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 2px;
}

.fedi-post__media-image {
  width: 100%;
  max-height: 300px;
  object-fit: cover;
  display: block;
}

.fedi-post__media--single .fedi-post__media-image {
  max-height: 400px;
}

.fedi-post__footer {
  padding: 8px 14px 10px;
  border-top: 1px solid var(--border-color, rgba(48, 54, 61, 0.5));
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
}

.fedi-post__stats {
  display: flex;
  align-items: center;
  gap: 12px;
}

.fedi-post__stat {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--text-secondary, #8b949e);
}

.fedi-post__view-link {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 12px;
  color: var(--text-secondary, #8b949e);
  text-decoration: none;
  margin-left: auto;
}

.fedi-post__view-link:hover {
  color: var(--harmony-primary, #58a6ff);
}
</style>
