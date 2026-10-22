<!--
  SocialPostEmbed - the preview of a post on X, Instagram or Bluesky: author, text, every
  photo and video (EmbedMediaGallery), the quoted post, and the date.

  Rendered by LinkEmbedCard for a payload carrying `social` or `media`. Without `social`, the
  card's title and description stand in for the author and text.
-->
<template>
  <article
    class="social-embed"
    :class="`social-embed--${platform}`"
    :data-platform="platform"
    data-testid="social-embed"
  >
    <header class="social-embed__head">
      <img
        v-if="avatar"
        :src="avatar"
        alt=""
        class="social-embed__avatar"
        loading="lazy"
        @error="avatarFailed = true"
      />
      <span v-else class="social-embed__avatar social-embed__avatar--blank" aria-hidden="true">{{ initial }}</span>
      <div class="social-embed__who">
        <a
          v-if="authorLink"
          :href="authorLink"
          target="_blank"
          rel="noopener noreferrer"
          class="social-embed__name"
        >{{ displayName }}</a>
        <span v-else class="social-embed__name">{{ displayName }}</span>
        <span v-if="handle" class="social-embed__handle">{{ handle }}</span>
      </div>
    </header>

    <p
      v-if="text"
      class="social-embed__text"
      :class="{ 'social-embed__text--clamped': long && !expanded }"
      data-testid="social-embed-text"
    >{{ text }}</p>
    <button
      v-if="long"
      type="button"
      class="social-embed__more"
      :aria-expanded="expanded"
      @click="expanded = !expanded"
    >{{ expanded ? t('embeds.showLess') : t('embeds.showMore') }}</button>

    <EmbedMediaGallery
      v-if="media.length"
      :items="media"
      :post-url="postUrl"
      :site-name="siteLabel"
      :label="displayName"
      :platform="platform"
      class="social-embed__media"
      @load="emit('load')"
    />

    <section
      v-if="quote"
      class="social-embed__quote"
      :aria-label="t('embeds.quotedPost')"
      data-testid="social-embed-quote"
    >
      <div class="social-embed__quote-head">
        <img v-if="quoteAvatar" :src="quoteAvatar" alt="" class="social-embed__quote-avatar" loading="lazy" @error="quoteAvatarFailed = true" />
        <a
          :href="safeHref(quote.url)"
          target="_blank"
          rel="noopener noreferrer"
          class="social-embed__name"
        >{{ quote.author.name || quote.author.handle }}</a>
        <span v-if="quote.author.name && quote.author.handle" class="social-embed__handle">{{ quote.author.handle }}</span>
        <time v-if="quoteDate" class="social-embed__quote-date" :datetime="quote.publishedAt">{{ quoteDate }}</time>
      </div>
      <p v-if="quote.text" class="social-embed__quote-text">{{ quote.text }}</p>
      <EmbedMediaGallery
        v-if="quote.media?.length"
        :items="quote.media"
        :post-url="quote.url"
        :site-name="siteLabel"
        :label="quote.author.name || quote.author.handle"
        :platform="platform"
        compact
      />
    </section>

    <footer class="social-embed__foot">
      <span class="social-embed__site">{{ siteLabel }}</span>
      <template v-if="date">
        <span aria-hidden="true">·</span>
        <a :href="safeHref(postUrl)" target="_blank" rel="noopener noreferrer" class="social-embed__date">
          <time :datetime="payload.social?.publishedAt">{{ date }}</time>
        </a>
      </template>
    </footer>
  </article>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue';
import type { EmbedPayload } from '@/types';
import EmbedMediaGallery from './EmbedMediaGallery.vue';
import { useT } from '@/composables/useT';
import { safeHref } from '@/utils/sanitize';

const props = defineProps<{ payload: EmbedPayload }>();
const emit = defineEmits<{ load: [] }>();

const { t, locale } = useT();

const SITE_LABELS: Record<string, string> = { x: 'X', instagram: 'Instagram', bluesky: 'Bluesky' };
/** Text past this many characters starts folded. */
const LONG_TEXT = 420;

const social = computed(() => props.payload.social);
const platform = computed(() => social.value?.platform ?? 'link');
const media = computed(() => (Array.isArray(props.payload.media) ? props.payload.media.filter((m) => m && typeof m.url === 'string' && m.url) : []));
const postUrl = computed(() => social.value?.url || props.payload.canonicalUrl || props.payload.url);
const siteLabel = computed(() => SITE_LABELS[platform.value] ?? props.payload.siteName ?? '');

const avatarFailed = ref(false);
const quoteAvatarFailed = ref(false);
const avatar = computed(() => (avatarFailed.value ? undefined : social.value?.author.avatar || props.payload.icon));
const displayName = computed(() => social.value?.author.name || social.value?.author.handle || props.payload.title || props.payload.url);
const handle = computed(() => (social.value?.author.name ? social.value.author.handle : undefined));
const initial = computed(() => (displayName.value || '?').replace(/^@/, '').charAt(0).toUpperCase());
const authorLink = computed(() => safeHref(social.value?.author.url));

const text = computed(() => social.value ? social.value.text : props.payload.description);
const long = computed(() => (text.value?.length ?? 0) > LONG_TEXT);
const expanded = ref(false);

const quote = computed(() => social.value?.quote);
const quoteAvatar = computed(() => (quoteAvatarFailed.value ? undefined : quote.value?.author.avatar));

function formatDate(iso: string | undefined, withTime: boolean): string | undefined {
  if (!iso) return undefined;
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return undefined;
  try {
    return new Intl.DateTimeFormat(locale.value || undefined, withTime
      ? { dateStyle: 'medium', timeStyle: 'short' }
      : { dateStyle: 'medium' }).format(at);
  } catch {
    return at.toISOString().slice(0, 10);
  }
}

const date = computed(() => formatDate(social.value?.publishedAt, true));
const quoteDate = computed(() => formatDate(quote.value?.publishedAt, false));

onMounted(() => {
  if (!media.value.length) emit('load');
});
</script>

<style scoped>
.social-embed {
  display: flex;
  flex-direction: column;
  gap: 0.55rem;
  padding: 0.75rem 0.85rem 0.65rem;
  min-width: 0;
  color: var(--text-primary, #e5e7eb);
}

.social-embed__head {
  display: flex;
  align-items: center;
  gap: 0.55rem;
  min-width: 0;
}

.social-embed__avatar {
  flex-shrink: 0;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  object-fit: cover;
  background: var(--background-secondary, #1a1d24);
}

.social-embed__avatar--blank {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-weight: 700;
  color: var(--text-secondary, #9ca3af);
}

.social-embed__who {
  display: flex;
  flex-direction: column;
  min-width: 0;
  flex: 1;
  line-height: 1.2;
}

.social-embed__name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-weight: 600;
  color: var(--text-primary, #e5e7eb);
  text-decoration: none;
}

a.social-embed__name:hover {
  text-decoration: underline;
}

.social-embed__handle {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 0.8rem;
  color: var(--text-secondary, #9ca3af);
}

.social-embed__site {
  font-weight: 600;
}

.social-embed__text,
.social-embed__quote-text {
  margin: 0;
  white-space: pre-line;
  overflow-wrap: anywhere;
  font-size: 0.9rem;
  line-height: 1.4;
}

.social-embed__text--clamped {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 8;
  line-clamp: 8;
  overflow: hidden;
}

.social-embed__more {
  align-self: flex-start;
  margin-top: -0.3rem;
  padding: 0;
  border: 0;
  background: none;
  color: var(--text-link, #0ea5e9);
  font-size: 0.8rem;
  cursor: pointer;
}

.social-embed__more:hover {
  text-decoration: underline;
}

.social-embed__quote {
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
  padding: 0.55rem 0.65rem;
  border: 1px solid var(--border-color, rgba(255, 255, 255, 0.08));
  border-radius: 10px;
  min-width: 0;
}

.social-embed__quote-head {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  min-width: 0;
  font-size: 0.85rem;
}

.social-embed__quote-avatar {
  flex-shrink: 0;
  width: 20px;
  height: 20px;
  border-radius: 50%;
  object-fit: cover;
}

.social-embed__quote-date {
  flex-shrink: 0;
  margin-left: auto;
  font-size: 0.75rem;
  color: var(--text-secondary, #9ca3af);
}

.social-embed__quote-text {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 4;
  line-clamp: 4;
  overflow: hidden;
  font-size: 0.85rem;
}

.social-embed__foot {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0.35rem;
  font-size: 0.75rem;
  color: var(--text-secondary, #9ca3af);
}

.social-embed__date {
  color: var(--text-secondary, #9ca3af);
  text-decoration: none;
}

.social-embed__date:hover {
  text-decoration: underline;
}
</style>
