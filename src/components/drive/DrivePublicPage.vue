<!-- /d/<token> of a file whose general access is "Anyone with the link", for a viewer who does not
     read the file: no account needed. The owner shows only when the link's Show my name is on. -->
<template>
  <main :id="MAIN_CONTENT_ID" class="drive-link" data-testid="drive-link-page" tabindex="-1">
    <div class="drive-link__card">
      <div v-if="info === undefined" class="drive-link__status">
        <span class="drive-link__spinner" aria-hidden="true" />
        <span class="sr-only">{{ t('common.loading') }}</span>
      </div>
      <div v-else-if="!info" class="drive-link__status" data-testid="drive-link-missing">
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
          <p class="drive-link__meta">{{ formatBytes(info.size_bytes, locale.value) }}</p>
          <p v-if="info.owner" class="drive-link__owner" data-testid="drive-link-owner">
            <Avatar :src="info.owner.avatar_url" size="sm" class="drive-link__avatar" />
            <i18n-t keypath="drive.link.sharedBy" scope="global" tag="span">
              <template #name>
                <RouterLink :to="profilePath(info.owner)" class="drive-link__profile" data-testid="drive-link-owner-name">
                  <DriveOwnerName :owner="info.owner" />
                </RouterLink>
              </template>
            </i18n-t>
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
    <i18n-t keypath="drive.link.poweredBy" scope="global" tag="p" class="drive-link__footer" data-testid="drive-link-footer">
      <template #harmony>
        <a href="https://mony.lol" target="_blank" rel="noopener" data-testid="drive-link-harmony">Harmony</a>
      </template>
      <template #instance>
        <a :href="origin" target="_blank" rel="noopener" data-testid="drive-link-instance">{{ instance }}</a>
      </template>
    </i18n-t>
  </main>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import Icon from '@/components/common/Icon.vue'
import Avatar from '@/components/common/Avatar.vue'
import VideoControls from '@/components/common/VideoControls.vue'
import DriveOwnerName from '@/components/drive/DriveOwnerName.vue'
import { useT } from '@/composables/useT'
import { useNativeVideoControls } from '@/composables/useVideoPlayerPreference'
import { MAIN_CONTENT_ID, useViewTitle } from '@/composables/useRouteA11y'
import { getInstanceDomain } from '@/services/instanceConfig'
import { resolveHarmonyBaseUrl } from '@/utils/discordBridgeSetup'
import { driveLinkContentUrl, type DriveCardOwner, type DriveLinkInfo } from '@/services/drive/driveService'
import { formatBytes } from '@/components/drive/driveFormat'

/** info: undefined while loading, null for a link that opens nothing. */
const props = defineProps<{ token: string; info?: DriveLinkInfo | null }>()

const { t, locale } = useT()
const nativeControls = useNativeVideoControls()

const rawUrl = computed(() => driveLinkContentUrl(props.token))
const instance = computed(() => getInstanceDomain())
const origin = computed(() => resolveHarmonyBaseUrl())
const dateFormat = computed(() => new Intl.DateTimeFormat(locale.value, { dateStyle: 'medium', timeStyle: 'short' }))

useViewTitle(() => props.info?.name ?? '')

/** Drive files belong to accounts of this instance: the local profile route. */
function profilePath(owner: DriveCardOwner): string {
  return `/social/profile/${encodeURIComponent(owner.username)}`
}
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
.drive-link__owner,
.drive-link__expiry {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  font-size: var(--font-size-sm);
  color: var(--text-secondary);
}

.drive-link__owner .drive-link__avatar {
  width: 22px;
  height: 22px;
}

.drive-link__profile {
  font-weight: var(--font-weight-semibold);
  color: var(--text-primary);
  text-decoration: none;
}

.drive-link__profile:hover {
  text-decoration: underline;
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

.drive-link__footer a {
  font-weight: var(--font-weight-semibold);
  color: var(--text-secondary);
  text-decoration: none;
}

.drive-link__footer a:hover {
  color: var(--text-primary);
  text-decoration: underline;
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
