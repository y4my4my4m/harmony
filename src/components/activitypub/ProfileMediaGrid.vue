<!-- ProfileMediaGrid - A profile's images, GIFs and videos as a square-tile grid (X-style: one tile per post) -->
<template>
  <section class="profile-media" :aria-label="t('activitypub.mediaGridLabel', { name: displayName })">
    <!-- First load -->
    <div
      v-if="status === 'loading' && tiles.length === 0"
      class="media-grid"
      role="status"
      aria-busy="true"
      :aria-label="t('activitypub.loadingMedia')"
    >
      <div v-for="n in 9" :key="n" class="media-tile media-tile--skeleton" aria-hidden="true" />
    </div>

    <!-- First load failed -->
    <div v-else-if="status === 'error' && tiles.length === 0" class="media-state" role="alert">
      <Icon name="alert-circle" :size="40" />
      <h3>{{ t('activitypub.loadMediaFailed') }}</h3>
      <p>{{ t('activitypub.loadFailedMessage') }}</p>
      <button type="button" class="media-state-btn" @click="reload">{{ t('common.retry') }}</button>
    </div>

    <template v-else>
      <div v-if="tiles.length === 0 && localExhausted && remoteState !== 'importing'" class="media-state">
        <Icon name="image" :size="40" />
        <h3>{{ t('activitypub.noMediaYet') }}</h3>
        <p>{{ isOwnProfile ? t('activitypub.noMediaOwn') : t('activitypub.noMediaOther', { name: displayName }) }}</p>
      </div>

      <ul v-if="tiles.length > 0" class="media-grid" role="list">
        <li
          v-for="tile in tiles"
          :key="tile.postId"
          class="media-tile"
          :class="{ 'is-hidden': isHidden(tile) }"
        >
          <button
            :ref="(el) => setTileRef(tile.postId, el)"
            type="button"
            class="media-tile-btn"
            :aria-label="tileLabel(tile)"
            @click="onTileClick(tile)"
          >
            <span v-if="failed.has(tile.postId)" class="media-tile-fallback" aria-hidden="true">
              <Icon :name="tile.items[0].isVideoFile ? 'video' : 'image'" :size="28" />
            </span>
            <img
              v-else-if="!tile.items[0].isVideoFile || tile.items[0].previewUrl"
              class="media-tile-img"
              :src="thumbnailFor(tile.items[0])"
              :alt="tile.items[0].alt"
              loading="lazy"
              decoding="async"
              draggable="false"
              @error="markFailed(tile.postId)"
            />
            <video
              v-else
              class="media-tile-img"
              :src="`${tile.items[0].url}#t=0.1`"
              preload="metadata"
              muted
              playsinline
              disablepictureinpicture
              tabindex="-1"
              aria-hidden="true"
              @loadedmetadata="onVideoMetadata(tile.items[0].url, $event)"
              @loadeddata="markVideoFrame(tile.items[0].url)"
              @error="markFailed(tile.postId)"
            />
            <!-- Mobile browsers and data saver often skip preload, leaving no frame to show. -->
            <span
              v-if="awaitingFrame(tile)"
              class="media-tile-fallback media-tile-fallback--video"
              aria-hidden="true"
            >
              <Icon name="play" :size="28" />
            </span>

            <span v-if="isHidden(tile)" class="media-tile-veil" aria-hidden="true">
              <Icon name="eye-off" :size="20" />
              <span class="media-tile-cw">{{ tile.contentWarning || t('activitypub.sensitiveContent') }}</span>
            </span>
            <template v-else>
              <span v-if="tile.items.length > 1" class="media-badge media-badge--stack" aria-hidden="true">
                <Icon name="copy" :size="14" />
              </span>
              <span v-if="tile.items[0].kind === 'gif'" class="media-badge media-badge--kind" aria-hidden="true">
                {{ t('activitypub.gifLabel') }}
              </span>
              <span v-else-if="tile.items[0].kind === 'video' && !awaitingFrame(tile)" class="media-badge media-badge--kind" aria-hidden="true">
                <Icon name="play" :size="12" />
                <span v-if="durationLabel(tile.items[0])">{{ durationLabel(tile.items[0]) }}</span>
              </span>
            </template>
          </button>

          <button
            v-if="tile.sensitive && !isHidden(tile)"
            type="button"
            class="media-tile-rehide"
            :aria-label="t('activitypub.hideMedia')"
            :title="t('activitypub.hideMedia')"
            @click="rehide(tile)"
          >
            <Icon name="eye-off" :size="14" />
          </button>
        </li>
      </ul>

      <div ref="sentinelRef" class="media-sentinel" aria-hidden="true" />

      <div v-if="loadingMore || remoteState === 'importing'" class="media-footer" role="status">
        <LoadingSpinner :size="20" :thickness="2" />
        <span v-if="remoteState === 'importing'" class="media-footer-text">
          {{ t('activitypub.fetchingOlderFromDomain', { domain }) }}
        </span>
        <span v-else class="sr-only">{{ t('activitypub.loadingMedia') }}</span>
      </div>
      <div v-else-if="loadMoreFailed" class="media-footer" role="alert">
        <span class="media-footer-text">{{ t('activitypub.loadMoreMediaFailed') }}</span>
        <button type="button" class="media-footer-btn" @click="loadMore">{{ t('common.retry') }}</button>
      </div>
      <div v-else-if="remoteState === 'error'" class="media-footer" role="alert">
        <span class="media-footer-text">{{ t('activitypub.fetchOlderFailed', { domain }) }}</span>
        <button type="button" class="media-footer-btn" @click="importRemote">{{ t('common.retry') }}</button>
      </div>
      <div v-else-if="canImportRemote" class="media-footer">
        <button type="button" class="media-footer-btn" @click="importRemote">
          <Icon name="federation" :size="16" />
          {{ t('activitypub.fetchOlderFromDomain', { domain }) }}
        </button>
      </div>
    </template>

    <MonyMediaLightbox
      v-model:index="lightboxIndex"
      :visible="lightboxOpen"
      :media="lightboxMedia"
      @hide="closeLightbox"
    >
      <template #actions="{ index }">
        <RouterLink
          v-if="lightbox.entries[index]"
          :to="{ name: 'PostDetail', params: { postId: lightbox.entries[index].postId } }"
          class="lightbox-post-link"
          @click="lightboxOpen = false"
        >
          <Icon name="message-square" :size="16" />
          {{ t('activitypub.viewPost') }}
        </RouterLink>
      </template>
    </MonyMediaLightbox>
  </section>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch, type ComponentPublicInstance } from 'vue';
import { useI18n } from 'vue-i18n';
import { RouterLink } from 'vue-router';
import Icon from '@/components/common/Icon.vue';
import LoadingSpinner from '@/components/common/LoadingSpinner.vue';
import MonyMediaLightbox from './MonyMediaLightbox.vue';
import { activityPubService } from '@/services/activityPubService';
import { getAttachmentThumbnailUrl } from '@/utils/storageImageUtils';
import { debug } from '@/utils/debug';
import {
  buildLightboxSequence,
  formatMediaDuration,
  mergeProfileMediaTiles,
  profileMediaCursor,
  toLightboxAttachment,
  toProfileMediaTiles,
  type ProfileMediaCursor,
  type ProfileMediaItem,
  type ProfileMediaTile,
} from '@/utils/profileMedia';

interface Props {
  authorId: string;
  displayName: string;
  isOwnProfile?: boolean;
  /** Remote authors: the outbox the backend may import older posts from. */
  outboxUrl?: string | null;
  domain?: string | null;
  /** Scroll container the grid lives in; the infinite-scroll observer's root. */
  scrollRoot?: HTMLElement | null;
}

const props = withDefaults(defineProps<Props>(), {
  isOwnProfile: false,
  outboxUrl: null,
  domain: null,
  scrollRoot: null,
});

const emit = defineEmits<{
  /** Older remote posts were imported; the tab count may have changed. */
  imported: [];
}>();

const { t } = useI18n();

const PAGE_SIZE = 30;
// Thumbnail box in device pixels: tiles are at most 200 CSS px wide.
const THUMB_BOX = 400;
// CSS px below the visible area at which the next page starts loading.
const PRELOAD_MARGIN_PX = 600;

const tiles = shallowRef<ProfileMediaTile[]>([]);
const status = ref<'idle' | 'loading' | 'error'>('idle');
const loadingMore = ref(false);
const loadMoreFailed = ref(false);
const localExhausted = ref(false);
const remoteState = ref<'idle' | 'importing' | 'error'>('idle');
const remoteHasMore = ref(false);
const revealed = ref(new Set<string>());
const failed = ref(new Set<string>());
const framed = ref(new Set<string>());
const durations = ref<Record<string, number>>({});
let cursor: ProfileMediaCursor | null = null;
let generation = 0;

const sentinelRef = ref<HTMLElement | null>(null);
const tileRefs = new Map<string, HTMLElement>();
let observer: IntersectionObserver | null = null;

const lightboxOpen = ref(false);
const lightboxIndex = ref(0);

const canImportRemote = computed(() =>
  !!props.outboxUrl && localExhausted.value && remoteHasMore.value && remoteState.value === 'idle'
);

function isHidden(tile: ProfileMediaTile): boolean {
  return tile.sensitive && !revealed.value.has(tile.postId);
}

const lightbox = computed(() => buildLightboxSequence(tiles.value, isHidden));
const lightboxMedia = computed(() => lightbox.value.entries.map(toLightboxAttachment));

function thumbnailFor(item: ProfileMediaItem): string {
  if (item.previewUrl) return item.previewUrl;
  return item.kind === 'image' ? getAttachmentThumbnailUrl(item.url, THUMB_BOX) : item.url;
}

function durationLabel(item: ProfileMediaItem): string | null {
  return formatMediaDuration(item.duration ?? durations.value[item.url]);
}

function onVideoMetadata(url: string, event: Event) {
  const video = event.target as HTMLVideoElement;
  if (Number.isFinite(video.duration) && video.duration > 0) {
    durations.value = { ...durations.value, [url]: video.duration };
  }
}

/** A <video> cover with no poster that has not decoded a frame yet. */
function awaitingFrame(tile: ProfileMediaTile): boolean {
  const cover = tile.items[0];
  return cover.isVideoFile && !cover.previewUrl && !failed.value.has(tile.postId) && !framed.value.has(cover.url);
}

function markVideoFrame(url: string) {
  if (framed.value.has(url)) return;
  framed.value = new Set(framed.value).add(url);
}

function markFailed(postId: string) {
  if (failed.value.has(postId)) return;
  failed.value = new Set(failed.value).add(postId);
}

function tileLabel(tile: ProfileMediaTile): string {
  if (isHidden(tile)) {
    return t('activitypub.revealMediaLabel', { warning: tile.contentWarning || t('activitypub.sensitiveContent') });
  }
  const cover = tile.items[0];
  const kind = cover.kind === 'gif'
    ? t('activitypub.gifLabel')
    : cover.kind === 'video' ? t('activitypub.video') : t('activitypub.image');
  const parts = [cover.alt ? `${kind}: ${cover.alt}` : kind];
  if (tile.items.length > 1) parts.push(t('activitypub.mediaItemsCount', { count: tile.items.length }, tile.items.length));
  return parts.join(', ');
}

function setTileRef(postId: string, el: Element | ComponentPublicInstance | null) {
  if (el instanceof HTMLElement) tileRefs.set(postId, el);
  else tileRefs.delete(postId);
}

function onTileClick(tile: ProfileMediaTile) {
  if (isHidden(tile)) {
    revealed.value = new Set(revealed.value).add(tile.postId);
    return;
  }
  const start = lightbox.value.startByPostId.get(tile.postId);
  if (start === undefined) return;
  lightboxIndex.value = start;
  lightboxOpen.value = true;
}

function rehide(tile: ProfileMediaTile) {
  const next = new Set(revealed.value);
  next.delete(tile.postId);
  revealed.value = next;
  nextTick(() => tileRefs.get(tile.postId)?.focus());
}

function closeLightbox() {
  const entry = lightbox.value.entries[lightboxIndex.value];
  lightboxOpen.value = false;
  if (entry) nextTick(() => tileRefs.get(entry.postId)?.focus());
}

// Arrowing toward the end of the loaded grid pulls the next local page into the sequence.
watch(lightboxIndex, (index) => {
  if (lightboxOpen.value && index >= lightbox.value.entries.length - 3 && !localExhausted.value) {
    void loadPage();
  }
});

async function loadPage(): Promise<void> {
  if (loadingMore.value || status.value === 'loading' || localExhausted.value) return;
  const gen = generation;
  const first = tiles.value.length === 0 && cursor === null;
  if (first) status.value = 'loading';
  else loadingMore.value = true;
  loadMoreFailed.value = false;

  try {
    const rows = await activityPubService.getProfileMedia(props.authorId, { limit: PAGE_SIZE, before: cursor });
    if (gen !== generation) return;
    tiles.value = mergeProfileMediaTiles(tiles.value, toProfileMediaTiles(rows));
    cursor = profileMediaCursor(rows) ?? cursor;
    if (rows.length < PAGE_SIZE) localExhausted.value = true;
    status.value = 'idle';
  } catch (err) {
    if (gen !== generation) return;
    debug.error('Failed to load profile media:', err);
    if (first) status.value = 'error';
    else loadMoreFailed.value = true;
  } finally {
    if (gen === generation) loadingMore.value = false;
  }

  if (gen === generation) {
    await nextTick();
    continueIfNearEnd();
  }
}

/**
 * The observer fires only when the sentinel crosses its threshold. A page too short to
 * push the sentinel out of range leaves it intersecting, so after each local page the
 * position is checked directly. Remote imports are never chained from here.
 */
function continueIfNearEnd() {
  if (localExhausted.value || loadMoreFailed.value || status.value !== 'idle') return;
  if (sentinelInRange()) void loadPage();
}

function sentinelInRange(): boolean {
  const sentinel = sentinelRef.value;
  if (!sentinel) return false;
  const bottom = props.scrollRoot ? props.scrollRoot.getBoundingClientRect().bottom : window.innerHeight;
  return sentinel.getBoundingClientRect().top <= bottom + PRELOAD_MARGIN_PX;
}

function loadMore() {
  if (!localExhausted.value) void loadPage();
  else if (canImportRemote.value) void importRemote();
}

/**
 * One outbox page (up to 20 posts) through the existing federation import, then the next
 * local page from the current cursor. An imported post newer than the last loaded tile is
 * not inserted in place; it appears when the tab next loads.
 */
async function importRemote(): Promise<void> {
  if (!props.outboxUrl || remoteState.value === 'importing') return;
  const gen = generation;
  remoteState.value = 'importing';
  try {
    // Any max_id continues from the backend's cached next-page URL for this author;
    // omitting it resets the author's walk to the first outbox page.
    const result = await activityPubService.importRemoteOutboxPage(props.authorId, props.outboxUrl, {
      maxId: 'next',
      limit: 20,
    });
    if (gen !== generation) return;
    remoteHasMore.value = result.hasMore;
    remoteState.value = 'idle';
    localExhausted.value = false;
    emit('imported');
    await loadPage();
  } catch (err) {
    if (gen !== generation) return;
    debug.warn('Remote outbox import failed:', err);
    remoteState.value = 'error';
  }
}

function reset() {
  generation++;
  tiles.value = [];
  cursor = null;
  status.value = 'idle';
  loadingMore.value = false;
  loadMoreFailed.value = false;
  localExhausted.value = false;
  remoteState.value = 'idle';
  remoteHasMore.value = !!props.outboxUrl;
  revealed.value = new Set();
  failed.value = new Set();
  framed.value = new Set();
  durations.value = {};
  lightboxOpen.value = false;
  tileRefs.clear();
}

function reload() {
  reset();
  void loadPage();
}

function observe() {
  observer?.disconnect();
  if (typeof IntersectionObserver === 'undefined' || !sentinelRef.value) return;
  observer = new IntersectionObserver(
    (entries) => {
      if (entries.some((e) => e.isIntersecting)) loadMore();
    },
    { root: props.scrollRoot ?? null, rootMargin: `0px 0px ${PRELOAD_MARGIN_PX}px 0px` }
  );
  observer.observe(sentinelRef.value);
}

watch(() => props.authorId, reload);
watch([() => props.scrollRoot, sentinelRef], observe);

onMounted(() => {
  reload();
  observe();
});

onBeforeUnmount(() => {
  generation++;
  observer?.disconnect();
  observer = null;
});
</script>

<style scoped>
.profile-media {
  padding-bottom: 100px;
}

.media-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 2px;
  margin: 0;
  padding: 0;
  list-style: none;
}

@media (max-width: 359px) {
  .media-grid {
    grid-template-columns: repeat(2, minmax(0, 1fr));
  }
}

.media-tile {
  position: relative;
  aspect-ratio: 1 / 1;
  overflow: hidden;
  background: var(--background-tertiary);
}

.media-tile--skeleton {
  animation: media-pulse 1.4s ease-in-out infinite;
}

@keyframes media-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.55; }
}

@media (prefers-reduced-motion: reduce) {
  .media-tile--skeleton { animation: none; }
}

.media-tile-btn {
  position: absolute;
  inset: 0;
  display: block;
  width: 100%;
  height: 100%;
  padding: 0;
  border: none;
  background: none;
  cursor: pointer;
  overflow: hidden;
}

/* Inset so the 2px gutter never clips it; 3px to stay visible on photographs. */
.media-tile-btn:focus-visible {
  outline: 3px solid var(--harmony-primary);
  outline-offset: -3px;
}

.media-tile-img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
  transition: transform var(--transition-fast), filter var(--transition-fast);
}

@media (hover: hover) {
  .media-tile:not(.is-hidden) .media-tile-btn:hover .media-tile-img {
    filter: brightness(0.88);
  }
}

.media-tile.is-hidden .media-tile-img {
  filter: blur(24px);
  transform: scale(1.15);
}

.media-tile-fallback {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  color: var(--text-tertiary);
}

.media-tile-fallback--video {
  position: absolute;
  inset: 0;
  background: var(--background-tertiary);
  color: var(--text-secondary);
}

/* Veil and badges sit on photographs, not on the theme background: fixed dark scrims with
   white text in both themes. */
.media-tile-veil {
  position: absolute;
  inset: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-1);
  padding: var(--space-2);
  background: rgba(0, 0, 0, 0.45);
  color: #fff;
  text-align: center;
}

.media-tile-cw {
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-semibold);
  line-height: 1.3;
  overflow-wrap: anywhere;
}

.media-badge {
  position: absolute;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  padding: 2px 6px;
  border-radius: var(--radius-sm);
  background: rgba(0, 0, 0, 0.7);
  color: #fff;
  font-size: 11px;
  font-weight: var(--font-weight-bold);
  line-height: 16px;
  letter-spacing: 0.02em;
  pointer-events: none;
}

.media-badge--kind {
  left: 6px;
  bottom: 6px;
}

.media-badge--stack {
  top: 6px;
  right: 6px;
  padding: 3px;
}

.media-tile-rehide {
  position: absolute;
  top: 6px;
  left: 6px;
  z-index: 2;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: none;
  border-radius: var(--radius-md);
  background: rgba(0, 0, 0, 0.6);
  color: #fff;
  cursor: pointer;
}

.media-tile-rehide:focus-visible {
  outline: 2px solid var(--harmony-primary);
  outline-offset: 2px;
}

.media-sentinel {
  height: 1px;
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}

.media-state {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  padding: 3rem 2rem;
  color: var(--text-tertiary);
  text-align: center;
}

.media-state h3 {
  margin: 1rem 0 0.5rem;
  color: var(--text-primary);
  font-size: 1.25rem;
}

.media-state p {
  margin: 0;
  max-width: 320px;
}

.media-state-btn,
.media-footer-btn {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  margin-top: var(--space-4);
  padding: var(--space-2) var(--space-4);
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-full);
  background: transparent;
  color: var(--text-primary);
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-semibold);
  cursor: pointer;
  transition: background-color var(--transition-fast);
}

.media-state-btn:hover,
.media-footer-btn:hover {
  background: var(--background-modifier-hover);
}

.media-state-btn:focus-visible,
.media-footer-btn:focus-visible {
  outline: 2px solid var(--harmony-primary);
  outline-offset: 2px;
}

.media-footer {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: center;
  gap: var(--space-3);
  padding: var(--space-4) var(--space-3);
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
  text-align: center;
}

.media-footer .media-footer-btn {
  margin-top: 0;
}

.lightbox-post-link {
  display: inline-flex;
  align-items: center;
  gap: var(--space-2);
  height: 40px;
  padding: 0 var(--space-4);
  border-radius: var(--radius-full);
  background: rgba(45, 45, 45, 0.92);
  color: #fff;
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-semibold);
  text-decoration: none;
  box-shadow: 0 2px 12px rgba(0, 0, 0, 0.45);
}

.lightbox-post-link:hover {
  background: rgba(61, 61, 61, 0.95);
}

.lightbox-post-link:focus-visible {
  outline: 2px solid #fff;
  outline-offset: 2px;
}
</style>
