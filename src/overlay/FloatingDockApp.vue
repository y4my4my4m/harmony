<template>
  <div
    ref="root"
    class="fd-root"
    :class="{ panel, open: listOpen }"
    role="region"
    :aria-label="state?.channelName || undefined"
    data-testid="floating-dock"
  >
    <template v-if="state">
      <div class="fd-bar">
        <div
          class="fd-info"
          :title="state.labels.dragHint"
          data-testid="floating-dock-drag"
          @mousedown="startDrag"
          @dblclick="send({ type: 'redock' })"
        >
          <Icon name="volume" class="fd-channel-icon" aria-hidden="true" />
          <span class="fd-name">{{ state.channelName }}</span>
          <span class="fd-count" :title="state.labels.inCall">
            <span aria-hidden="true">{{ state.participants.length }}</span>
            <span class="fd-sr">{{ state.labels.inCall }}</span>
          </span>
          <Icon v-if="state.encrypted" name="shield-check" class="fd-lock" aria-hidden="true" />
          <span v-if="state.reconnecting" class="fd-reconnecting">{{ state.labels.reconnecting }}</span>
          <span class="fd-speakers" aria-hidden="true">
            <img v-for="p in speakers" :key="p.userId" :src="p.avatar" alt="" class="fd-speaker" />
          </span>
        </div>

        <div class="fd-controls">
          <button
            type="button"
            class="fd-btn"
            :class="{ off: state.muted || state.deafened, locked: state.speakLocked }"
            :aria-label="state.labels.mute"
            :title="state.muted ? state.labels.unmute : state.labels.mute"
            :aria-pressed="state.muted"
            :aria-disabled="state.speakLocked || undefined"
            data-testid="floating-dock-mute"
            @click="send({ type: 'mute' })"
          >
            <Icon :name="state.muted || state.deafened ? 'mic-off' : 'mic'" />
          </button>
          <button
            type="button"
            class="fd-btn"
            :class="{ off: state.deafened, locked: state.deafenLocked }"
            :aria-label="state.labels.deafen"
            :title="state.deafened ? state.labels.undeafen : state.labels.deafen"
            :aria-pressed="state.deafened"
            :aria-disabled="state.deafenLocked || undefined"
            data-testid="floating-dock-deafen"
            @click="send({ type: 'deafen' })"
          >
            <HeadphonesIcon :is-headphones-active="!state.deafened" aria-hidden="true" />
          </button>
          <button
            type="button"
            class="fd-btn"
            :class="{ active: listOpen }"
            :aria-label="state.labels.participants"
            :title="state.labels.participants"
            :aria-expanded="listOpen"
            aria-controls="fd-list"
            data-testid="floating-dock-participants"
            @click="listOpen = !listOpen"
          >
            <Icon name="users" />
          </button>
          <button
            type="button"
            class="fd-btn"
            :aria-label="state.labels.backToApp"
            :title="state.labels.backToApp"
            data-testid="floating-dock-back"
            @click="send({ type: 'expand' })"
          >
            <Icon name="maximize-2" />
          </button>
          <button
            type="button"
            class="fd-btn leave"
            :aria-label="state.labels.leave"
            :title="state.labels.leave"
            data-testid="floating-dock-leave"
            @click="send({ type: 'leave' })"
          >
            <Icon name="phone-off" />
          </button>
        </div>
      </div>

      <ul v-if="listOpen" id="fd-list" class="fd-list" data-testid="floating-dock-list">
        <li v-for="p in state.participants" :key="p.userId" class="fd-row" :data-testid="`floating-dock-row-${p.userId}`">
          <img :src="p.avatar" alt="" class="fd-avatar" :class="{ speaking: p.speaking }" />
          <span class="fd-row-name">{{ p.name }}</span>
          <Icon v-if="p.deafened" name="headphones-off" class="fd-row-state" aria-hidden="true" />
          <Icon v-else-if="p.muted" name="mic-off" class="fd-row-state" aria-hidden="true" />
        </li>
      </ul>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue';
import Icon from '@/components/common/Icon.vue';
import HeadphonesIcon from '@/components/icons/Headphones.vue';
import {
  DOCK_COMMAND_EVENT,
  DOCK_READY_EVENT,
  DOCK_STATE_EVENT,
  clientPointFor,
  landsOn,
  type DockCommand,
  type DockState,
} from './floatingDockProtocol';

// Quiet time after the last move before a drop counts, ms. A drag holds the window still for
// shorter pauses than this.
const DROP_SETTLE_MS = 450;
// A native drag reports no end, and winit's Moved does not arrive on every X11 setup: after a
// drag starts, the window's position is sampled at this interval until it settles, ms.
const DRAG_POLL_MS = 150;
// Sampling stops after this long without the window moving at all, ms.
const DRAG_POLL_IDLE_MS = 10_000;
const MAX_SPEAKERS = 4;

const state = ref<DockState | null>(null);
const listOpen = ref(false);
const root = ref<HTMLElement | null>(null);
// Opaque panel: set where the webview cannot be transparent (Linux/CEF).
const panel = new URLSearchParams(window.location.search).get('panel') === '1';

const speakers = computed(() => (state.value?.participants ?? []).filter((p) => p.speaking).slice(0, MAX_SPEAKERS));

let cleanups: Array<() => void> = [];
let resizeObserver: ResizeObserver | null = null;
let settleTimer: ReturnType<typeof setTimeout> | null = null;
let pollTimer: ReturnType<typeof setInterval> | null = null;
let redockSent = false;
const appliedAttributes = new Set<string>();

async function send(command: DockCommand): Promise<void> {
  if (command.type === 'redock' || command.type === 'expand') {
    if (redockSent) return;
    redockSent = true;
  }
  const { emit } = await import('@tauri-apps/api/event');
  await emit(DOCK_COMMAND_EVENT, command);
}

function stopPolling(): void {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
}

/** Samples the window position after a drag starts; a move that settles is a drop. */
async function pollDrag(): Promise<void> {
  stopPolling();
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  const self = getCurrentWindow();
  const start = await self.outerPosition();
  let last = start;
  let moved = false;
  let lastChange = Date.now();
  pollTimer = setInterval(() => {
    self.outerPosition().then((pos) => {
      const now = Date.now();
      if (pos.x !== last.x || pos.y !== last.y) {
        last = pos;
        moved = true;
        lastChange = now;
        return;
      }
      if (moved && now - lastChange >= DROP_SETTLE_MS) {
        stopPolling();
        checkDrop().catch(() => {});
      } else if (!moved && now - lastChange >= DRAG_POLL_IDLE_MS) {
        stopPolling();
      }
    }).catch(() => stopPolling());
  }, DRAG_POLL_MS);
}

async function startDrag(event: MouseEvent): Promise<void> {
  if (event.button !== 0) return;
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  await pollDrag();
  await getCurrentWindow().startDragging().catch(() => {});
}

/** The main document's theme, mirrored onto this one. */
function applyHtml(html: DockState['html']): void {
  const el = document.documentElement;
  el.className = `${html.className} floating-dock-document${panel ? ' floating-dock-panel' : ''}`;
  if (html.style) el.setAttribute('style', html.style);
  else el.removeAttribute('style');
  for (const name of appliedAttributes) {
    if (!(name in html.attributes)) el.removeAttribute(name);
  }
  appliedAttributes.clear();
  for (const [name, value] of Object.entries(html.attributes)) {
    el.setAttribute(name, value);
    appliedAttributes.add(name);
  }
}

async function fitWindow(): Promise<void> {
  await nextTick();
  const el = root.value;
  if (!el) return;
  const { getCurrentWindow, LogicalSize } = await import('@tauri-apps/api/window');
  await getCurrentWindow().setSize(new LogicalSize(Math.ceil(el.offsetWidth), Math.ceil(el.offsetHeight)));
}

/** Dropped on the app window: back into it, where it landed. */
async function checkDrop(): Promise<void> {
  const { getCurrentWindow, Window } = await import('@tauri-apps/api/window');
  const main = await Window.getByLabel('main');
  if (!main || !(await main.isVisible()) || (await main.isMinimized())) return;
  const self = getCurrentWindow();
  const [pos, size, mainPos, mainSize, mainInner, scale] = await Promise.all([
    self.outerPosition(),
    self.outerSize(),
    main.outerPosition(),
    main.outerSize(),
    main.innerPosition(),
    main.scaleFactor(),
  ]);
  const landed = landsOn(
    { x: pos.x, y: pos.y, width: size.width, height: size.height },
    { x: mainPos.x, y: mainPos.y, width: mainSize.width, height: mainSize.height },
  );
  if (landed) await send({ type: 'redock', at: clientPointFor(pos, mainInner, scale) });
}

watch(state, (next) => { if (next) applyHtml(next.html); });
watch([state, listOpen], () => { fitWindow().catch(() => {}); }, { deep: true });

onMounted(async () => {
  const { listen, emit } = await import('@tauri-apps/api/event');
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  cleanups.push(await listen<DockState>(DOCK_STATE_EVENT, (e) => { state.value = e.payload; }));
  cleanups.push(await getCurrentWindow().onMoved(() => {
    if (settleTimer) clearTimeout(settleTimer);
    settleTimer = setTimeout(() => { settleTimer = null; checkDrop().catch(() => {}); }, DROP_SETTLE_MS);
  }));
  resizeObserver = new ResizeObserver(() => { fitWindow().catch(() => {}); });
  if (root.value) resizeObserver.observe(root.value);
  await emit(DOCK_READY_EVENT);
});

onUnmounted(() => {
  cleanups.forEach((fn) => fn());
  cleanups = [];
  resizeObserver?.disconnect();
  if (settleTimer) clearTimeout(settleTimer);
  stopPolling();
});
</script>

<style>
html.floating-dock-document,
html.floating-dock-document body,
html.floating-dock-document #app {
  margin: 0;
  overflow: hidden;
  background: transparent !important;
}
html.floating-dock-panel,
html.floating-dock-panel body,
html.floating-dock-panel #app {
  background: #1e1f22 !important;
}
</style>

<style scoped>
.fd-root {
  display: inline-flex;
  flex-direction: column;
  min-width: 320px;
  max-width: 420px;
  background: var(--background-floating, #1e1f22);
  border: 1px solid var(--border-primary, rgba(255, 255, 255, 0.08));
  border-radius: 12px;
  color: var(--text-primary, #f2f3f5);
  font-family: var(--font-primary, system-ui, sans-serif);
  overflow: hidden;
  -webkit-user-select: none;
  user-select: none;
}
.fd-root.panel {
  border-radius: 0;
  border: none;
}
.fd-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 8px 8px 12px;
}
.fd-info {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: 1;
  min-width: 0;
  cursor: grab;
}
.fd-channel-icon {
  color: var(--harmony-primary, #0ea5e9);
  flex-shrink: 0;
}
.fd-name {
  font-size: 13px;
  font-weight: 600;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.fd-count {
  font-size: 11px;
  padding: 1px 6px;
  border-radius: 999px;
  background: var(--background-tertiary, rgba(255, 255, 255, 0.08));
  color: var(--text-secondary, #b5bac1);
}
.fd-lock {
  color: var(--success, #23a55a);
  flex-shrink: 0;
}
.fd-reconnecting {
  font-size: 11px;
  color: var(--warning, #f0b232);
}
.fd-speakers {
  display: flex;
  margin-left: 2px;
}
.fd-speaker {
  width: 18px;
  height: 18px;
  border-radius: 50%;
  margin-left: -4px;
  box-shadow: 0 0 0 2px var(--success, #23a55a);
}
.fd-controls {
  display: flex;
  gap: 4px;
}
.fd-btn {
  width: 32px;
  height: 32px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 50%;
  background: var(--background-tertiary, rgba(255, 255, 255, 0.08));
  color: var(--text-primary, #f2f3f5);
  cursor: pointer;
  padding: 0;
}
.fd-btn:hover {
  background: color-mix(in srgb, var(--background-tertiary, #2b2d31) 80%, var(--text-primary, #fff));
}
.fd-btn:focus-visible {
  outline: 2px solid var(--border-focus, #0ea5e9);
  outline-offset: 2px;
}
.fd-btn.off {
  background: var(--error, #da373c);
  color: #fff;
}
.fd-btn.active {
  background: color-mix(in srgb, var(--background-tertiary, #2b2d31) 70%, var(--text-primary, #fff));
}
.fd-btn.locked {
  opacity: 0.6;
}
.fd-btn.leave {
  background: var(--error, #da373c);
  color: #fff;
}
.fd-btn :deep(svg) {
  width: 16px;
  height: 16px;
}
.fd-list {
  list-style: none;
  margin: 0;
  padding: 4px 8px 8px;
  max-height: 260px;
  overflow-y: auto;
  border-top: 1px solid var(--border-primary, rgba(255, 255, 255, 0.08));
}
.fd-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 4px;
  font-size: 13px;
}
.fd-avatar {
  width: 22px;
  height: 22px;
  border-radius: 50%;
}
.fd-avatar.speaking {
  box-shadow: 0 0 0 2px var(--success, #23a55a);
}
.fd-row-name {
  flex: 1;
  min-width: 0;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.fd-row-state {
  color: var(--error, #da373c);
}
.fd-sr {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0 0 0 0);
  white-space: nowrap;
}
</style>
