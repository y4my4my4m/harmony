<!--
  Picks an activity to start where the launcher was opened (stores/playTogether launcher). A session
  already running there is offered first; starting another app there joins that one instead, as
  start_activity_session answers.
-->
<template>
  <BaseModal
    :show="!!launcher"
    :title="t('playTogether.launcherTitle')"
    :subtitle="t('playTogether.launcherSubtitle')"
    icon="gamepad"
    @close="store.closeLauncher()"
  >
    <div class="pt-launcher" data-testid="play-together-launcher">
      <div v-if="running" class="pt-launcher__running">
        <img v-if="runningApp" :src="runningApp.iconUrl" alt="" class="pt-launcher__running-icon" />
        <div class="pt-launcher__running-text">
          <strong>{{ runningName }}</strong>
          <span>{{ t('playTogether.playing', { n: running.members.length }, running.members.length) }}</span>
        </div>
        <button
          type="button"
          class="pt-launcher__join"
          data-testid="play-together-launcher-join"
          @click="joinRunning"
        >{{ store.isJoined(running.id) ? t('playTogether.open') : t('playTogether.join') }}</button>
      </div>

      <p v-if="!store.appsLoaded" class="pt-launcher__empty">{{ t('playTogether.loadingApps') }}</p>
      <p v-else-if="!apps.length" class="pt-launcher__empty" data-testid="play-together-none">{{ t('playTogether.noApps') }}</p>

      <ul v-else class="pt-launcher__grid" role="list">
        <li v-for="app in apps" :key="app.id">
          <button
            type="button"
            class="pt-launcher__app"
            :style="{ '--app-accent': app.accent }"
            :disabled="busy"
            :data-testid="`play-together-app-${app.id}`"
            @click="startApp(app.id)"
          >
            <span class="pt-launcher__art"><img :src="app.iconUrl" alt="" /></span>
            <span class="pt-launcher__body">
              <span class="pt-launcher__name">{{ store.appLabel(app).name }}</span>
              <span class="pt-launcher__desc">{{ store.appLabel(app).description }}</span>
              <span class="pt-launcher__meta">
                <Icon name="users" :size="13" />
                {{ t('playTogether.players', { min: app.minPlayers, max: app.maxPlayers }) }}
                <span
                  v-if="app.source === 'package'"
                  class="pt-launcher__chip"
                  :title="t('playTogether.thirdPartyNotice')"
                  :data-testid="`play-together-third-party-${app.id}`"
                >{{ t('playTogether.thirdParty') }}</span>
              </span>
            </span>
          </button>
        </li>
      </ul>

      <p class="pt-launcher__note">
        <Icon name="shield" :size="13" />
        {{ t('playTogether.sandboxNote') }}
      </p>
    </div>
  </BaseModal>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import BaseModal from '@/components/common/BaseModal.vue'
import Icon from '@/components/common/Icon.vue'
import { useT } from '@/composables/useT'
import { targetContext, usePlayTogetherStore } from '@/stores/playTogether'

const { t } = useT()
const store = usePlayTogetherStore()
const busy = ref(false)

const launcher = computed(() => store.launcher)
const apps = computed(() => {
  const l = launcher.value
  return l ? store.appsFor(targetContext(l.target, l.conversationType)) : []
})
const running = computed(() => (launcher.value ? store.sessionIn(launcher.value.target) : null))
const runningApp = computed(() => (running.value ? store.appById(running.value.app_id) : undefined))
const runningName = computed(() => (runningApp.value ? store.appLabel(runningApp.value).name : running.value?.app_name ?? ''))

async function startApp(appId: string): Promise<void> {
  const l = launcher.value
  if (!l || busy.value) return
  busy.value = true
  try {
    if (await store.start(appId, l.target)) store.closeLauncher()
  } finally {
    busy.value = false
  }
}

async function joinRunning(): Promise<void> {
  if (!running.value) return
  if (await store.join(running.value)) store.closeLauncher()
}
</script>

<style scoped>
.pt-launcher {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-width: min(520px, calc(100 * var(--app-vw) - 48px));
}

.pt-launcher__running {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 12px;
  border: 1px solid var(--harmony-primary, #0EA5E9);
  border-radius: 12px;
  background: color-mix(in srgb, var(--harmony-primary, #0EA5E9) 10%, transparent);
}

.pt-launcher__running-icon {
  width: 36px;
  height: 36px;
  border-radius: 9px;
}

.pt-launcher__running-text {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
  color: var(--text-primary);
}

.pt-launcher__running-text span {
  font-size: var(--font-size-xs, 12px);
  color: var(--text-secondary);
}

.pt-launcher__join {
  padding: 7px 16px;
  border: 0;
  border-radius: 8px;
  background: var(--harmony-primary, #0EA5E9);
  color: #fff;
  font-weight: var(--font-weight-semibold, 600);
  cursor: pointer;
}

.pt-launcher__grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
  gap: 10px;
  margin: 0;
  padding: 0;
  list-style: none;
}

.pt-launcher__app {
  display: flex;
  flex-direction: column;
  width: 100%;
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

.pt-launcher__app:hover,
.pt-launcher__app:focus-visible {
  border-color: var(--app-accent);
  box-shadow: 0 8px 24px color-mix(in srgb, var(--app-accent) 25%, transparent);
  transform: translateY(-2px);
}

.pt-launcher__app:disabled {
  opacity: 0.6;
  cursor: progress;
}

.pt-launcher__art {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 96px;
  background:
    radial-gradient(circle at 30% 20%, color-mix(in srgb, var(--app-accent) 55%, transparent), transparent 60%),
    linear-gradient(135deg, color-mix(in srgb, var(--app-accent) 35%, #0b0f14), #0b0f14);
}

.pt-launcher__art img {
  width: 60px;
  height: 60px;
  border-radius: 14px;
  box-shadow: 0 6px 18px rgba(0, 0, 0, 0.35);
}

.pt-launcher__body {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 12px 12px;
}

.pt-launcher__name {
  font-weight: var(--font-weight-semibold, 600);
  color: var(--text-primary);
}

.pt-launcher__desc {
  font-size: var(--font-size-sm, 13px);
  color: var(--text-secondary);
  line-height: 1.35;
}

.pt-launcher__meta {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  margin-top: 2px;
  font-size: var(--font-size-xs, 12px);
  color: var(--text-muted);
}

.pt-launcher__chip {
  margin-left: 4px;
  padding: 0 6px;
  border: 1px solid var(--border-color);
  border-radius: 999px;
  line-height: 1.5;
  white-space: nowrap;
}

.pt-launcher__empty {
  margin: 8px 0;
  color: var(--text-secondary);
}

.pt-launcher__note {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0;
  font-size: var(--font-size-xs, 12px);
  color: var(--text-muted);
}

@media (prefers-reduced-motion: reduce) {
  .pt-launcher__app { transition: none; }
  .pt-launcher__app:hover { transform: none; }
}
</style>
