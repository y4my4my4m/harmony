<!--
  Activities launcher: the one dialog behind every Activities button (stores/playTogether
  launcher). In a call on a local server it offers watching or listening together (a pasted
  link or a Drive file, started in the call or queued to the running one) above the games;
  elsewhere only the games. A game session already running at the target is offered first;
  starting another app there joins that one instead, as start_activity_session answers.
-->
<template>
  <BaseModal
    :show="!!launcher && !pickerOpen"
    :title="t('activities.launcherTitle')"
    :subtitle="watchHere ? t('activities.launcherSubtitleCall') : t('playTogether.launcherSubtitle')"
    icon="popcorn"
    @close="store.closeLauncher()"
  >
    <div class="act-launcher" data-testid="activities-launcher">
      <section v-if="watchHere" class="act-launcher__section" data-testid="activities-watch" :aria-labelledby="watchHeadingId">
        <h3 :id="watchHeadingId" class="act-launcher__heading">
          <Icon name="tv" :size="15" aria-hidden="true" />
          {{ watchRunning ? t('activities.addTitle') : t('activities.title') }}
        </h3>
        <p class="act-launcher__lede">{{ t('activities.lede') }}</p>
        <form class="act-launcher__form" @submit.prevent="submit(watchRunning ? 'queue' : 'start')">
          <input
            v-model="link"
            class="act-launcher__input"
            type="url"
            inputmode="url"
            :placeholder="t('activities.linkHint')"
            :aria-label="t('activities.linkPlaceholder')"
            :aria-invalid="!!error"
            data-testid="activity-link"
          />
          <div class="act-launcher__actions">
            <button type="button" class="act-launcher__btn act-launcher__btn--ghost" data-testid="activity-from-drive" :disabled="busy" @click="pickerOpen = true">
              <Icon name="hard-drive" :size="15" aria-hidden="true" />
              {{ t('activities.fromDrive') }}
            </button>
            <button v-if="watchRunning && canEnd" type="button" class="act-launcher__btn" :disabled="!parsed || busy" data-testid="activity-play-now" @click="submit('start')">
              {{ t('activities.playNow') }}
            </button>
            <button type="submit" class="act-launcher__btn act-launcher__btn--primary" :disabled="!parsed || busy" data-testid="activity-start">
              <Icon :name="watchRunning ? 'list-video' : 'play'" :size="15" aria-hidden="true" />
              {{ watchRunning ? t('activities.addToQueue') : startLabel }}
            </button>
          </div>
        </form>
        <p v-if="parsed?.source === 'spotify'" class="act-launcher__lede">{{ t('activities.spotifyHint') }}</p>
        <p v-if="error" class="act-launcher__error" role="alert">{{ error }}</p>
      </section>

      <section v-if="showPlay" class="act-launcher__section" data-testid="activities-play" :aria-labelledby="watchHere ? playHeadingId : undefined">
        <h3 v-if="watchHere" :id="playHeadingId" class="act-launcher__heading">
          <Icon name="gamepad" :size="15" aria-hidden="true" />
          {{ t('activities.playHeading') }}
        </h3>

        <div v-if="running" class="act-launcher__running">
          <img v-if="runningApp" :src="runningApp.iconUrl" alt="" class="act-launcher__running-icon" />
          <div class="act-launcher__running-text">
            <strong>{{ runningName }}</strong>
            <span>{{ t('playTogether.playing', { n: running.members.length }, running.members.length) }}</span>
          </div>
          <button
            type="button"
            class="act-launcher__join"
            data-testid="play-together-launcher-join"
            @click="joinRunning"
          >{{ store.isJoined(running.id) ? t('playTogether.open') : t('playTogether.join') }}</button>
        </div>

        <p v-if="webviewOutdated" class="act-launcher__empty" role="note" data-testid="play-together-webview-outdated">{{ t('playTogether.errors.WEBVIEW_OUTDATED') }}</p>
        <p v-if="!store.appsLoaded" class="act-launcher__empty">{{ t('playTogether.loadingApps') }}</p>
        <p v-else-if="!apps.length" class="act-launcher__empty" data-testid="play-together-none">{{ t('playTogether.noApps') }}</p>

        <ul v-else class="act-launcher__grid" role="list">
          <li v-for="app in apps" :key="app.id">
            <button
              type="button"
              class="act-launcher__app"
              :style="{ '--app-accent': app.accent }"
              :disabled="gameBusy || !!frameRefusal(app)"
              :data-testid="`play-together-app-${app.id}`"
              @click="startApp(app.id)"
            >
              <span class="act-launcher__art"><img :src="app.iconUrl" alt="" /></span>
              <span class="act-launcher__body">
                <span class="act-launcher__name">{{ store.appLabel(app).name }}</span>
                <span class="act-launcher__desc">{{ store.appLabel(app).description }}</span>
                <span class="act-launcher__meta">
                  <Icon name="users" :size="13" />
                  {{ t('playTogether.players', { min: app.minPlayers, max: app.maxPlayers }) }}
                  <span
                    v-if="app.source === 'package'"
                    class="act-launcher__chip"
                    :title="t('playTogether.thirdPartyNotice')"
                    :data-testid="`play-together-third-party-${app.id}`"
                  >{{ t('playTogether.thirdParty') }}</span>
                  <span
                    v-if="frameRefusal(app) === 'PACKAGE_DESKTOP_ONLY'"
                    class="act-launcher__chip"
                    :title="t('playTogether.errors.PACKAGE_DESKTOP_ONLY')"
                    :data-testid="`play-together-desktop-only-${app.id}`"
                  >{{ t('playTogether.desktopOnly') }}</span>
                </span>
              </span>
            </button>
          </li>
        </ul>

        <p v-if="apps.length" class="act-launcher__note">
          <Icon name="shield" :size="13" />
          {{ t('playTogether.sandboxNote') }}
        </p>
      </section>
    </div>
  </BaseModal>
  <DrivePickerModal
    v-if="pickerOpen"
    :kinds="['video', 'audio']"
    :title="t('activities.pickTitle')"
    :confirm-label="watchRunning ? t('activities.addToQueue') : t('activities.playTogether')"
    @pick="pickFile"
    @close="pickerOpen = false"
  />
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import BaseModal from '@/components/common/BaseModal.vue'
import Icon from '@/components/common/Icon.vue'
import DrivePickerModal from '@/components/drive/DrivePickerModal.vue'
import { useT } from '@/composables/useT'
import { useActivitiesStore } from '@/stores/activities'
import { targetContext, usePlayTogetherStore } from '@/stores/playTogether'
import { useUnifiedVoiceChannelStore } from '@/stores/unifiedVoiceChannel'
import { fetchLinkDetails, parseActivityLink, type ActivityItem, type ActivitySource } from '@/services/activities/activityService'
import type { DriveFile } from '@/services/drive/driveService'
import { uid } from '@/utils/a11y/focus'
import { FRAMES_UNSAFE_MARK, frameRefusal } from '@/services/playTogether/frameSupport'
import { useActivityControl } from './useActivityControl'

const { t } = useT()
const store = usePlayTogetherStore()
const actStore = useActivitiesStore()
const voice = useUnifiedVoiceChannelStore()
const watchHeadingId = uid('act-watch')
const playHeadingId = uid('act-play')

const launcher = computed(() => store.launcher)

// Watching together: a voice channel of a local server, joined here.
const watchHere = computed(() => {
  const target = launcher.value?.target
  return !!target && target.kind === 'channel' && target.voice
    && voice.isConnected && voice.currentChannelId === target.id && !voice.isFederatedChannel
})
const watchRunning = computed(() => !!actStore.current)
const { canEnd } = useActivityControl(() => actStore.current)
const link = ref('')
const error = ref<string | null>(null)
const busy = ref(false)
const pickerOpen = ref(false)
const parsed = computed(() => (link.value.trim() ? parseActivityLink(link.value) : null))
const startLabel = computed(() => (parsed.value && (parsed.value.source === 'spotify' || parsed.value.source === 'soundcloud' || parsed.value.item.mime_type === 'audio/*')
  ? t('activities.listenTogether')
  : t('activities.watchTogether')))

watch(launcher, (open) => {
  if (open) return
  link.value = ''
  error.value = null
  pickerOpen.value = false
})

async function begin(source: ActivitySource, item: ActivityItem, mode: 'start' | 'queue', startMs = 0): Promise<void> {
  busy.value = true
  error.value = null
  try {
    if (mode === 'queue') await actStore.control({ action: 'enqueue', source, item })
    else await actStore.start(source, item, startMs)
    store.closeLauncher()
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e)
  } finally {
    busy.value = false
  }
}

async function submit(mode: 'start' | 'queue'): Promise<void> {
  const p = parsed.value
  if (!p) {
    error.value = t('activities.badLink')
    return
  }
  const details = p.source === 'url' ? {} : await fetchLinkDetails(link.value.trim())
  await begin(p.source, { ...p.item, ...details, ...(p.item.title ? { title: p.item.title } : {}) }, mode, p.startMs)
}

function pickFile(files: DriveFile[]): void {
  pickerOpen.value = false
  const file = files[0]
  if (!file) return
  void begin('file', {
    bucket: file.bucket,
    path: file.path,
    mime_type: file.mime_type ?? undefined,
    title: file.name ?? undefined,
  }, watchRunning.value ? 'queue' : 'start')
}

// Games.
const gameBusy = ref(false)
const webviewOutdated = typeof navigator !== 'undefined' && navigator.userAgent.includes(FRAMES_UNSAFE_MARK)
const apps = computed(() => {
  const l = launcher.value
  return l ? store.appsFor(targetContext(l.target, l.conversationType)) : []
})
const running = computed(() => (launcher.value ? store.sessionIn(launcher.value.target) : null))
const runningApp = computed(() => (running.value ? store.appById(running.value.app_id) : undefined))
const runningName = computed(() => (runningApp.value ? store.appLabel(runningApp.value).name : running.value?.app_name ?? ''))
// In a call with nothing to play, the dialog is the watch section alone.
const showPlay = computed(() => !watchHere.value || !store.appsLoaded || apps.value.length > 0 || !!running.value)

async function startApp(appId: string): Promise<void> {
  const l = launcher.value
  if (!l || gameBusy.value) return
  gameBusy.value = true
  try {
    if (await store.start(appId, l.target)) store.closeLauncher()
  } finally {
    gameBusy.value = false
  }
}

async function joinRunning(): Promise<void> {
  if (!running.value) return
  if (await store.join(running.value)) store.closeLauncher()
}
</script>

<style scoped>
.act-launcher {
  display: flex;
  flex-direction: column;
  gap: 18px;
}

.act-launcher__section {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.act-launcher__section + .act-launcher__section {
  padding-top: 16px;
  border-top: 1px solid var(--border-color);
}

.act-launcher__heading {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  font-size: var(--font-size-sm, 14px);
  font-weight: var(--font-weight-semibold, 600);
  color: var(--text-primary);
}

.act-launcher__lede {
  margin: 0;
  font-size: var(--font-size-xs, 12px);
  line-height: 1.4;
  color: var(--text-secondary);
}

.act-launcher__form {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.act-launcher__input {
  min-height: 38px;
  padding: 0 12px;
  background: var(--surface-inset, var(--background-tertiary));
  border: 1px solid var(--border-color);
  border-radius: 10px;
  font: inherit;
  font-size: var(--font-size-sm);
  color: var(--text-primary);
}

.act-launcher__input:focus {
  border-color: var(--harmony-primary);
  outline: none;
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--harmony-primary) 22%, transparent);
}

.act-launcher__actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 8px;
}

.act-launcher__btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-height: 34px;
  padding: 0 14px;
  background: var(--background-modifier-hover);
  border: 1px solid var(--border-color);
  border-radius: 10px;
  font: inherit;
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-semibold);
  color: var(--text-primary);
  cursor: pointer;
}

.act-launcher__btn--ghost {
  margin-right: auto;
  background: none;
  border-style: dashed;
  color: var(--text-secondary);
}

.act-launcher__btn--ghost:hover:not(:disabled) {
  border-color: var(--harmony-primary);
  color: var(--text-primary);
}

.act-launcher__btn--primary {
  background: var(--harmony-primary-fill, var(--harmony-primary));
  border-color: transparent;
  color: var(--text-on-primary, #fff);
}

.act-launcher__btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.act-launcher__error {
  margin: 0;
  font-size: var(--font-size-xs);
  color: var(--danger);
}

.act-launcher__running {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  border: 1px solid var(--harmony-primary, #0EA5E9);
  border-radius: 12px;
  background: color-mix(in srgb, var(--harmony-primary, #0EA5E9) 10%, transparent);
}

.act-launcher__running-icon {
  width: 36px;
  height: 36px;
  border-radius: 9px;
}

.act-launcher__running-text {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  color: var(--text-primary);
}

.act-launcher__running-text span {
  font-size: var(--font-size-xs, 12px);
  color: var(--text-secondary);
}

.act-launcher__join {
  padding: 7px 16px;
  border: 0;
  border-radius: 8px;
  background: var(--harmony-primary, #0EA5E9);
  color: #fff;
  font-weight: var(--font-weight-semibold, 600);
  cursor: pointer;
}

.act-launcher__grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 10px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.act-launcher__app {
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  padding: 0;
  overflow: hidden;
  border: 1px solid var(--border-color);
  border-radius: 14px;
  background: var(--background-secondary);
  color: inherit;
  text-align: left;
  cursor: pointer;
  transition: transform 0.15s ease, border-color 0.15s ease, box-shadow 0.15s ease;
}

.act-launcher__app:hover,
.act-launcher__app:focus-visible {
  border-color: var(--app-accent);
  box-shadow: 0 8px 24px color-mix(in srgb, var(--app-accent) 25%, transparent);
  transform: translateY(-2px);
}

.act-launcher__app:disabled {
  opacity: 0.6;
  cursor: not-allowed;
}

.act-launcher__art {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 84px;
  background:
    radial-gradient(circle at 30% 20%, color-mix(in srgb, var(--app-accent) 55%, transparent), transparent 60%),
    linear-gradient(135deg, color-mix(in srgb, var(--app-accent) 35%, #0b0f14), #0b0f14);
}

.act-launcher__art img {
  width: 52px;
  height: 52px;
  border-radius: 12px;
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.35);
}

.act-launcher__body {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 12px 12px;
}

.act-launcher__name {
  font-weight: var(--font-weight-semibold, 600);
  color: var(--text-primary);
}

.act-launcher__desc {
  font-size: var(--font-size-sm, 13px);
  color: var(--text-secondary);
  line-height: 1.35;
}

.act-launcher__meta {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-top: 2px;
  font-size: var(--font-size-xs, 12px);
  color: var(--text-muted);
}

.act-launcher__chip {
  margin-left: 4px;
  padding: 0 6px;
  border: 1px solid var(--border-color);
  border-radius: 999px;
  line-height: 1.5;
  white-space: nowrap;
}

.act-launcher__empty {
  margin: 4px 0;
  color: var(--text-secondary);
}

.act-launcher__note {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  margin: 0;
  font-size: var(--font-size-xs, 12px);
  line-height: 1.4;
  color: var(--text-muted);
}

.act-launcher__note :deep(svg) {
  flex-shrink: 0;
  margin-top: 2px;
}

@media (prefers-reduced-motion: reduce) {
  .act-launcher__app { transition: none; }
  .act-launcher__app:hover { transform: none; }
}
</style>
