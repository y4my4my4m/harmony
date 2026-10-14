<!-- /d/<token>: a Drive file shared by link, readable without an account. -->
<template>
  <main class="drive-link" data-testid="drive-link-page">
    <div class="drive-link__card">
      <div v-if="state === 'loading'" class="drive-link__status">
        <span class="drive-link__spinner" aria-hidden="true" />
        <span class="sr-only">{{ t('common.loading') }}</span>
      </div>
      <div v-else-if="state === 'missing'" class="drive-link__status" data-testid="drive-link-missing">
        <span class="drive-link__glyph"><Icon name="link" :size="28" /></span>
        <h1>{{ t('drive.link.missingTitle') }}</h1>
        <p>{{ t('drive.link.missingText') }}</p>
      </div>
      <template v-else-if="info">
        <div class="drive-link__preview" :class="`drive-link__preview--${info.kind}`">
          <img v-if="info.kind === 'image'" :src="rawUrl" :alt="info.name" class="drive-link__media" />
          <div v-else-if="info.kind === 'video'" class="drive-link__video">
            <video :src="rawUrl" class="drive-link__media" preload="metadata" playsinline :controls="nativeControls" />
            <VideoControls v-if="!nativeControls" :label="info.name" />
          </div>
          <div v-else-if="info.kind === 'audio'" class="drive-link__audio">
            <Icon name="music" :size="40" />
            <audio :src="rawUrl" controls preload="metadata" />
          </div>
          <div v-else class="drive-link__file">
            <Icon name="file" :size="44" />
          </div>
        </div>
        <div class="drive-link__body">
          <h1 class="drive-link__name" data-testid="drive-link-name">{{ info.name }}</h1>
          <p class="drive-link__meta">
            {{ formatBytes(info.size_bytes, locale.value) }}
            <span aria-hidden="true">·</span>
            {{ t('drive.link.sharedBy', { name: info.owner.display_name || info.owner.username }) }}
          </p>
          <p v-if="info.expires_at" class="drive-link__expiry">
            <Icon name="clock" :size="13" />{{ t('drive.link.expires', { date: dateFormat.format(new Date(info.expires_at)) }) }}
          </p>
          <a :href="`${rawUrl}?download=1`" class="drive-link__download" data-testid="drive-link-download" rel="noopener">
            <Icon name="download" :size="16" />{{ t('drive.actions.download') }}
          </a>
        </div>
      </template>
    </div>
    <p class="drive-link__footer">{{ t('drive.link.footer', { instance: instance }) }}</p>
  </main>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import Icon from '@/components/common/Icon.vue'
import VideoControls from '@/components/common/VideoControls.vue'
import { useT } from '@/composables/useT'
import { useNativeVideoControls } from '@/composables/useVideoPlayerPreference'
import { apiUrl, getInstanceDomain } from '@/services/instanceConfig'
import { resolveDriveLink, type DriveLinkInfo } from '@/services/drive/driveService'
import { formatBytes } from '@/components/drive/driveFormat'

const { t, locale } = useT()
const route = useRoute()
const nativeControls = useNativeVideoControls()
const info = ref<DriveLinkInfo | null>(null)
const state = ref<'loading' | 'ready' | 'missing'>('loading')

const token = computed(() => String(route.params.token ?? ''))
const rawUrl = computed(() => apiUrl(`/api/federation/drive/link/${encodeURIComponent(token.value)}`))
const instance = computed(() => getInstanceDomain())
const dateFormat = computed(() => new Intl.DateTimeFormat(locale.value, { dateStyle: 'medium', timeStyle: 'short' }))

onMounted(async () => {
  try {
    info.value = /^[A-Za-z0-9_-]{16,64}$/.test(token.value) ? await resolveDriveLink(token.value) : null
  } catch {
    info.value = null
  }
  state.value = info.value ? 'ready' : 'missing'
  if (info.value) document.title = `${info.value.name} · ${instance.value}`
})
</script>

<style scoped>
.drive-link {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--space-4);
  width: 100%;
  height: 100%;
  overflow-y: auto;
  padding: var(--space-5) var(--space-4);
  background:
    radial-gradient(1200px 600px at 20% -10%, color-mix(in srgb, var(--harmony-primary) 22%, transparent), transparent 60%),
    var(--background-tertiary, var(--background-primary));
}

.drive-link__card {
  width: min(560px, 100%);
  overflow: hidden;
  background: var(--background-primary);
  border: 1px solid var(--border-color);
  border-radius: var(--radius-lg);
  box-shadow: 0 24px 60px rgb(0 0 0 / 0.35);
}

.drive-link__preview {
  display: flex;
  align-items: center;
  justify-content: center;
  max-height: calc(60 * var(--app-vh));
  min-height: 200px;
  background: #0b0d12;
}

.drive-link__video {
  position: relative;
  width: 100%;
  aspect-ratio: 16 / 9;
}

.drive-link__media {
  display: block;
  width: 100%;
  max-height: calc(60 * var(--app-vh));
  object-fit: contain;
}

.drive-link__audio,
.drive-link__file {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-4);
  padding: var(--space-6);
  color: rgb(255 255 255 / 0.8);
}

.drive-link__body {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
  padding: var(--space-5);
}

.drive-link__name {
  margin: 0;
  font-size: var(--font-size-lg);
  color: var(--text-primary);
  word-break: break-word;
}

.drive-link__meta,
.drive-link__expiry {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
}

.drive-link__download {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  margin-top: var(--space-3);
  min-height: 40px;
  background: var(--harmony-primary-fill, var(--harmony-primary));
  border-radius: var(--radius-md);
  font-weight: var(--font-weight-semibold);
  color: var(--text-on-primary, #fff);
  text-decoration: none;
}

.drive-link__download:hover {
  background: var(--harmony-primary-fill-hover, var(--harmony-primary-hover));
}

.drive-link__status {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: var(--space-2);
  padding: var(--space-8, 48px) var(--space-5);
  text-align: center;
}

.drive-link__status h1 {
  margin: 0;
  font-size: var(--font-size-lg);
  color: var(--text-primary);
}

.drive-link__status p {
  margin: 0;
  color: var(--text-secondary);
}

.drive-link__glyph {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 60px;
  height: 60px;
  margin-bottom: var(--space-2);
  background: var(--background-secondary);
  border-radius: 18px;
  color: var(--text-muted);
}

.drive-link__spinner {
  width: 28px;
  height: 28px;
  border: 3px solid var(--background-modifier-active);
  border-top-color: var(--harmony-primary);
  border-radius: 50%;
  animation: drive-link-spin 0.8s linear infinite;
}

.drive-link__footer {
  margin: 0;
  font-size: var(--font-size-xs);
  color: var(--text-muted);
}

.sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
}

@keyframes drive-link-spin {
  to { transform: rotate(360deg); }
}

@media (prefers-reduced-motion: reduce) {
  .drive-link__spinner { animation-duration: 2s; }
}
</style>
