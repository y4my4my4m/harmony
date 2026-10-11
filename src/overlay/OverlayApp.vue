<template>
  <div ref="root" class="overlay-root" :class="{ interactive, panel }">
    <ul v-if="roster.length > 0" class="overlay-list">
      <li v-for="u in roster" :key="u.userId" class="overlay-tile" :class="{ speaking: u.speaking }">
        <div class="overlay-avatar" :class="{ speaking: u.speaking }">
          <img :src="u.avatar" alt="" />
          <span v-if="u.muted" class="overlay-muted" aria-hidden="true">🔇</span>
        </div>
        <span class="overlay-name">{{ u.name }}</span>
        <!-- Speaking reads by shape as well as colour -->
        <span v-if="u.speaking" class="overlay-speaking" aria-hidden="true"><i></i><i></i><i></i></span>
        <span v-if="u.states" class="overlay-sr">, {{ u.states }}</span>
      </li>
    </ul>
    <div v-else class="overlay-empty">Not in a call</div>
  </div>
</template>

<script setup lang="ts">
import { ref, nextTick, onMounted, onUnmounted, watch } from 'vue';

interface RosterEntry {
  userId: string;
  name: string;
  avatar: string;
  speaking: boolean;
  muted: boolean;
  /** Translated state words for screen readers ("Muted, Speaking"). */
  states?: string;
}

const roster = ref<RosterEntry[]>([]);
const interactive = ref(false);
const root = ref<HTMLElement | null>(null);
// Opaque panel sized to the roster: set where the webview cannot be transparent (Linux/CEF).
const panel = new URLSearchParams(window.location.search).get('panel') === '1';
let cleanups: Array<() => void> = [];

async function fitWindow(): Promise<void> {
  await nextTick();
  const el = root.value;
  if (!el) return;
  const { getCurrentWindow, LogicalSize } = await import('@tauri-apps/api/window');
  const width = Math.min(Math.max(Math.ceil(el.scrollWidth), 160), 360);
  const height = Math.min(Math.ceil(el.scrollHeight), 600);
  await getCurrentWindow().setSize(new LogicalSize(width, height));
}

if (panel) {
  document.documentElement.classList.add('overlay-panel');
  watch(roster, () => { fitWindow().catch(() => {}); }, { deep: true });
}

onMounted(async () => {
  const { listen } = await import('@tauri-apps/api/event');
  cleanups.push(await listen<RosterEntry[]>('overlay://roster', (e) => {
    roster.value = e.payload ?? [];
  }));
  cleanups.push(await listen<boolean>('overlay://interactive', (e) => {
    interactive.value = !!e.payload;
  }));
  if (panel) fitWindow().catch(() => {});
});

onUnmounted(() => {
  cleanups.forEach(fn => fn());
  cleanups = [];
});
</script>

<style>
html, body, #app {
  margin: 0;
  background: transparent !important;
  overflow: hidden;
}
.overlay-root {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px;
  font-family: system-ui, sans-serif;
  -webkit-user-select: none;
  user-select: none;
}
.overlay-root.interactive {
  outline: 2px solid rgba(0, 212, 170, 0.8);
  border-radius: 10px;
}
.overlay-tile {
  display: flex;
  align-items: center;
  gap: 8px;
  background: rgba(0, 0, 0, 0.45);
  border-radius: 20px;
  padding: 4px 10px 4px 4px;
  width: fit-content;
}
.overlay-avatar {
  position: relative;
  width: 34px;
  height: 34px;
  border-radius: 50%;
  border: 2px solid transparent;
}
.overlay-avatar.speaking {
  border-color: #00d4aa;
  border-width: 3px;
}
.overlay-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  list-style: none;
  margin: 0;
  padding: 0;
}
.overlay-speaking {
  display: inline-flex;
  align-items: flex-end;
  gap: 2px;
  height: 12px;
}
.overlay-speaking i {
  display: block;
  width: 3px;
  background: #fff;
  border-radius: 1px;
}
.overlay-speaking i:nth-child(1) { height: 5px; }
.overlay-speaking i:nth-child(2) { height: 12px; }
.overlay-speaking i:nth-child(3) { height: 8px; }
.overlay-sr {
  position: absolute;
  width: 1px;
  height: 1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
}
.overlay-avatar img {
  width: 100%;
  height: 100%;
  border-radius: 50%;
  object-fit: cover;
}
.overlay-muted {
  position: absolute;
  bottom: -2px;
  right: -2px;
  font-size: 11px;
}
.overlay-name {
  color: #fff;
  font-size: 13px;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.8);
  white-space: nowrap;
}
html.overlay-panel,
html.overlay-panel body,
html.overlay-panel #app {
  background: #111214 !important;
}
.overlay-root.panel {
  display: inline-flex;
  min-width: 160px;
  box-sizing: border-box;
}
.overlay-root.panel.interactive {
  outline-offset: -2px;
  border-radius: 0;
}
.overlay-root.panel .overlay-tile,
.overlay-root.panel .overlay-empty {
  background: #1e1f22;
}
.overlay-empty {
  color: rgba(255, 255, 255, 0.6);
  font-size: 12px;
  background: rgba(0, 0, 0, 0.4);
  padding: 6px 10px;
  border-radius: 8px;
  width: fit-content;
}
</style>
