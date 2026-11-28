<!--
  Play together in a conversation, a text channel or the call stage.

  While this client is in the session running here: the panel, its bar and the area the frame lays
  itself over (PlayTogetherHost). Docked, the panel sits above the messages at a height dragged
  from its bottom edge (kept per device); expanded, it covers the view below the header. On the
  stage it fills its container.
  While someone else's session runs here: a banner with Join. Sessions are read on mount and every
  POLL_MS while mounted and visible.
-->
<template>
  <section
    v-if="here"
    ref="panelEl"
    class="pt-panel"
    :class="{ 'is-expanded': expanded, 'is-stage': stage }"
    :style="panelStyle"
    :aria-label="label"
    data-testid="play-together-panel"
  >
    <header class="pt-panel__bar">
      <img :src="store.joined!.app.iconUrl" alt="" class="pt-panel__icon" />
      <div class="pt-panel__title">
        <span class="pt-panel__name">{{ label }}</span>
        <span v-if="statusText" class="pt-panel__status" :class="`is-${store.view.status}`" data-testid="play-together-status">{{ statusText }}</span>
      </div>
      <div class="pt-panel__people" :aria-label="t('playTogether.playing', { n: store.view.members.length }, store.view.members.length)">
        <Avatar
          v-for="member in shownMembers"
          :key="member.id"
          :src="member.avatarUrl ? getAvatarUrl(member.avatarUrl, 64) : undefined"
          :alt="member.name"
          size="xs"
          class="pt-panel__avatar"
          :class="{ 'is-host': member.id === store.view.hostId }"
          :title="member.id === store.view.hostId ? t('playTogether.hostName', { name: member.name }) : member.name"
        />
        <span v-if="store.view.members.length > shownMembers.length" class="pt-panel__more">+{{ store.view.members.length - shownMembers.length }}</span>
      </div>
      <div class="pt-panel__actions">
        <button
          v-if="!stage"
          type="button"
          class="pt-icon-btn"
          :aria-label="expanded ? t('playTogether.collapse') : t('playTogether.expand')"
          :title="expanded ? t('playTogether.collapse') : t('playTogether.expand')"
          data-testid="play-together-expand"
          @click="toggleExpanded"
        ><Icon :name="expanded ? 'minimize-2' : 'maximize-2'" :size="16" /></button>
        <button
          v-if="store.view.canEnd && store.view.status !== 'ended'"
          type="button"
          class="pt-icon-btn pt-icon-btn--danger"
          :aria-label="t('playTogether.endForEveryone')"
          :title="t('playTogether.endForEveryone')"
          data-testid="play-together-end"
          @click="store.endForEveryone()"
        ><Icon name="x-circle" :size="16" /></button>
        <button
          type="button"
          class="pt-leave"
          data-testid="play-together-leave"
          @click="store.leave()"
        >
          <Icon name="log-out" :size="15" />
          <span>{{ store.view.status === 'ended' ? t('playTogether.close') : t('playTogether.leave') }}</span>
        </button>
      </div>
    </header>
    <p v-if="store.joined!.app.source === 'package'" class="pt-panel__notice" data-testid="play-together-third-party">
      <Icon name="shield" :size="13" />
      <span>{{ t('playTogether.thirdPartyNotice') }}</span>
    </p>
    <div ref="frameArea" class="pt-panel__frame" data-testid="play-together-slot" />
    <div
      v-if="!expanded && !stage"
      class="pt-panel__resize"
      role="separator"
      aria-orientation="horizontal"
      :aria-label="t('playTogether.resize')"
      :aria-valuenow="store.panelHeight"
      :aria-valuemin="PANEL_MIN_HEIGHT"
      tabindex="0"
      @pointerdown="startResize"
      @keydown.up.prevent="store.setPanelHeight(store.panelHeight - 32)"
      @keydown.down.prevent="store.setPanelHeight(store.panelHeight + 32)"
    ><span /></div>
  </section>

  <div
    v-else-if="running && !stage && banner"
    class="pt-banner"
    data-testid="play-together-banner"
  >
    <img v-if="runningApp" :src="runningApp.iconUrl" alt="" class="pt-banner__icon" />
    <div class="pt-banner__avatars" aria-hidden="true">
      <Avatar
        v-for="member in running.members.slice(0, 3)"
        :key="member.id"
        :src="member.avatar_url ? getAvatarUrl(member.avatar_url, 64) : undefined"
        :alt="member.display_name || member.username || ''"
        size="xs"
      />
    </div>
    <span class="pt-banner__text" data-testid="play-together-banner-text">
      <i18n-t
        v-if="bannerFirst"
        :keypath="running.members.length === 1 ? 'playTogether.bannerOne' : 'playTogether.bannerMany'"
        :plural="running.members.length - 1"
        scope="global"
        tag="span"
      >
        <template #name>
          <DisplayName :user-id="bannerFirst.id" :fallback="bannerFirst.display_name || bannerFirst.username || ''" />
        </template>
        <template #n>{{ running.members.length - 1 }}</template>
        <template #app>{{ bannerApp }}</template>
      </i18n-t>
      <template v-else>{{ t('playTogether.bannerEmpty', { app: bannerApp }) }}</template>
    </span>
    <span v-if="runningApp?.source === 'package'" class="pt-chip" data-testid="play-together-banner-third-party">{{ t('playTogether.thirdParty') }}</span>
    <span v-if="running.refusal" class="pt-banner__refusal" data-testid="play-together-refusal">{{ store.refusalText(running.refusal) }}</span>
    <button
      v-else
      type="button"
      class="pt-btn"
      :disabled="joining"
      data-testid="play-together-join"
      @click="joinRunning"
    >{{ t('playTogether.join') }}</button>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import Avatar from '@/components/common/Avatar.vue'
import DisplayName from '@/components/DisplayName.vue'
import Icon from '@/components/common/Icon.vue'
import { useT } from '@/composables/useT'
import { PANEL_MIN_HEIGHT, usePlayTogetherStore } from '@/stores/playTogether'
import { targetKey, type ActivityTarget } from '@/services/playTogether/sessions'
import { getAvatarUrl } from '@/utils/avatarUtils'

const POLL_MS = 15_000
const MAX_AVATARS = 5

const props = withDefaults(defineProps<{
  target: ActivityTarget
  /** Fill the container: the call stage. */
  stage?: boolean
  /** false: no Join banner for someone else's session; the call shows it as a tile. */
  banner?: boolean
}>(), { stage: false, banner: true })

const { t } = useT()
const store = usePlayTogetherStore()

const panelEl = ref<HTMLElement | null>(null)
const frameArea = ref<HTMLElement | null>(null)
const expandedTop = ref(0)
const joining = ref(false)
let pollTimer: ReturnType<typeof setInterval> | null = null

const here = computed(() => {
  const joined = store.joined
  return !!joined && targetKey(joined.target) === targetKey(props.target)
})
const expanded = computed(() => here.value && !props.stage && store.mode === 'expanded')
const label = computed(() => (store.joined ? store.appLabel(store.joined.app).name : ''))
const running = computed(() => store.sessionIn(props.target))
const runningApp = computed(() => (running.value ? store.appById(running.value.app_id) : undefined))
const shownMembers = computed(() => store.view.members.slice(0, MAX_AVATARS))

const statusText = computed(() => {
  switch (store.view.status) {
    case 'connecting': return t('playTogether.status.connecting')
    case 'reconnecting':
    case 'offline': return t('playTogether.status.reconnecting')
    case 'ended': return t('playTogether.status.ended')
    default: return ''
  }
})

const bannerApp = computed(() => {
  const session = running.value
  if (!session) return ''
  return runningApp.value ? store.appLabel(runningApp.value).name : session.app_name
})
const bannerFirst = computed(() => running.value?.members[0])

const panelStyle = computed(() => {
  if (props.stage) return undefined
  if (expanded.value) return { top: `${expandedTop.value}px` }
  return { height: `${store.panelHeight}px` }
})

function toggleExpanded(): void {
  if (store.mode === 'expanded') {
    store.mode = 'docked'
    return
  }
  expandedTop.value = panelEl.value?.offsetTop ?? 0
  store.mode = 'expanded'
}

function startResize(event: PointerEvent): void {
  const el = panelEl.value
  if (!el) return
  event.preventDefault()
  const startY = event.clientY
  const startHeight = el.getBoundingClientRect().height
  const parent = el.parentElement?.getBoundingClientRect()
  const max = parent ? Math.max(PANEL_MIN_HEIGHT, parent.bottom - el.getBoundingClientRect().top - 120) : 900
  const handle = event.currentTarget as HTMLElement
  handle.setPointerCapture(event.pointerId)
  const move = (e: PointerEvent) => store.setPanelHeight(Math.min(max, startHeight + (e.clientY - startY)))
  const up = () => {
    handle.removeEventListener('pointermove', move)
    handle.removeEventListener('pointerup', up)
    handle.removeEventListener('pointercancel', up)
  }
  handle.addEventListener('pointermove', move)
  handle.addEventListener('pointerup', up)
  handle.addEventListener('pointercancel', up)
}

async function joinRunning(): Promise<void> {
  const session = running.value
  if (!session || joining.value) return
  joining.value = true
  try {
    await store.join(session)
  } finally {
    joining.value = false
  }
}

watch(frameArea, (el, old) => {
  if (old) store.unregisterSlot(old)
  if (el) store.registerSlot(el)
})

function poll(): void {
  if (document.visibilityState === 'visible') void store.refresh(props.target)
}

watch(() => targetKey(props.target), async () => {
  store.mode = 'docked'
  await nextTick()
  poll()
})

onMounted(() => {
  void store.loadApps()
  poll()
  pollTimer = setInterval(poll, POLL_MS)
})

onBeforeUnmount(() => {
  if (pollTimer) clearInterval(pollTimer)
  if (frameArea.value) store.unregisterSlot(frameArea.value)
})
</script>

<style scoped>
.pt-panel {
  position: relative;
  display: flex;
  flex-direction: column;
  flex-shrink: 0;
  min-height: 0;
  margin: 8px 12px;
  border: 1px solid var(--border-color);
  border-radius: 12px;
  background: var(--background-secondary);
  overflow: visible;
  z-index: 3;
}

/* Docked, the messages and composer keep at least 160 px. */
.pt-panel:not(.is-expanded):not(.is-stage) {
  max-height: calc(100% - 160px);
}

.pt-panel.is-expanded {
  position: absolute;
  left: 0;
  right: 0;
  bottom: 0;
  margin: 0;
  border-radius: 0;
  border-width: 1px 0 0;
  z-index: 6;
}

.pt-panel.is-stage {
  flex: 1 1 auto;
  height: 100%;
  margin: 0;
}

.pt-panel__bar {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 44px;
  padding: 6px 8px 6px 10px;
  border-bottom: 1px solid var(--border-color);
}

.pt-panel__icon {
  width: 26px;
  height: 26px;
  border-radius: 7px;
  flex-shrink: 0;
}

.pt-panel__title {
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}

.pt-panel__name {
  font-weight: var(--font-weight-semibold, 600);
  color: var(--text-primary);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.pt-panel__status {
  font-size: var(--font-size-xs, 12px);
  color: var(--text-secondary);
  white-space: nowrap;
}

.pt-panel__status.is-ended {
  color: var(--text-danger, #f87171);
}

.pt-panel__people {
  display: flex;
  align-items: center;
  margin-left: auto;
  padding-left: 6px;
}

.pt-panel__avatar {
  margin-left: -6px;
  border: 2px solid var(--background-secondary);
  border-radius: 50%;
}

.pt-panel__avatar.is-host {
  box-shadow: 0 0 0 2px var(--harmony-primary, #0EA5E9);
}

.pt-panel__more {
  margin-left: 4px;
  font-size: var(--font-size-xs, 12px);
  color: var(--text-secondary);
}

.pt-panel__actions {
  display: flex;
  align-items: center;
  gap: 4px;
}

.pt-panel__frame {
  flex: 1 1 auto;
  min-height: 0;
}

.pt-panel__notice {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  margin: 0;
  padding: 5px 10px;
  border-bottom: 1px solid var(--border-color);
  background: var(--background-modifier-hover);
  color: var(--text-muted);
  font-size: var(--font-size-xs, 12px);
  line-height: 1.35;
}

.pt-panel__notice :deep(svg) {
  flex: none;
  margin-top: 1px;
}

.pt-chip {
  flex: none;
  padding: 1px 7px;
  border: 1px solid var(--border-color);
  border-radius: 999px;
  color: var(--text-muted);
  font-size: var(--font-size-xs, 12px);
  line-height: 1.5;
  white-space: nowrap;
}

.pt-panel__resize {
  position: absolute;
  left: 0;
  right: 0;
  bottom: -7px;
  height: 14px;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: ns-resize;
  touch-action: none;
  z-index: 25;
}

.pt-panel__resize span {
  width: 44px;
  height: 4px;
  border-radius: 2px;
  background: var(--border-color);
  transition: background 0.15s ease;
}

.pt-panel__resize:hover span,
.pt-panel__resize:focus-visible span {
  background: var(--harmony-primary, #0EA5E9);
}

.pt-leave {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  padding: 0 10px;
  border: 0;
  border-radius: 8px;
  background: var(--background-modifier-hover);
  color: var(--text-primary);
  font-size: var(--font-size-sm, 14px);
  cursor: pointer;
}

.pt-leave:hover,
.pt-leave:focus-visible {
  background: var(--background-modifier-active, rgba(255, 255, 255, 0.12));
}

.pt-icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
}

.pt-icon-btn:hover,
.pt-icon-btn:focus-visible {
  background: var(--background-modifier-hover);
  color: var(--text-primary);
}

.pt-icon-btn--danger:hover,
.pt-icon-btn--danger:focus-visible {
  color: var(--text-danger, #f87171);
}

.pt-banner {
  display: flex;
  align-items: center;
  gap: 10px;
  margin: 8px 12px;
  padding: 8px 10px;
  border: 1px solid var(--border-color);
  border-radius: 12px;
  background: var(--background-secondary);
}

.pt-banner__icon {
  width: 28px;
  height: 28px;
  border-radius: 8px;
}

.pt-banner__avatars {
  display: flex;
}

.pt-banner__avatars > * + * {
  margin-left: -6px;
}

.pt-banner__text {
  flex: 1;
  min-width: 0;
  color: var(--text-primary);
  font-size: var(--font-size-sm, 14px);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.pt-banner__refusal {
  flex-shrink: 0;
  max-width: 50%;
  color: var(--text-secondary);
  font-size: var(--font-size-xs, 12px);
  text-align: right;
}

.pt-btn {
  padding: 6px 14px;
  border: 0;
  border-radius: 8px;
  background: var(--harmony-primary, #0EA5E9);
  color: #fff;
  font-weight: var(--font-weight-semibold, 600);
  font-size: var(--font-size-sm, 14px);
  cursor: pointer;
}

.pt-btn:disabled {
  opacity: 0.6;
  cursor: default;
}

@media (max-width: 768px) {
  .pt-panel {
    margin: 0 0 6px;
    border-radius: 0;
    border-width: 0 0 1px;
  }

  .pt-panel__people {
    display: none;
  }

  .pt-leave span {
    display: none;
  }

  .pt-banner {
    margin: 0 8px 6px;
  }
}
</style>
