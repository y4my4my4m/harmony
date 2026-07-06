<template>
  <div class="overlay-root" :class="{ interactive }">
    <div v-for="u in roster" :key="u.userId" class="overlay-tile">
      <div class="overlay-avatar" :class="{ speaking: u.speaking }">
        <img :src="u.avatar" :alt="u.name" />
        <span v-if="u.muted" class="overlay-muted">🔇</span>
      </div>
      <span class="overlay-name">{{ u.name }}</span>
    </div>
    <div v-if="roster.length === 0" class="overlay-empty">Not in a call</div>
  </div>
</template>

<script setup lang="ts">
import { ref, onMounted, onUnmounted } from 'vue';

interface RosterEntry {
  userId: string;
  name: string;
  avatar: string;
  speaking: boolean;
  muted: boolean;
}

const roster = ref<RosterEntry[]>([]);
const interactive = ref(false);
let cleanups: Array<() => void> = [];

onMounted(async () => {
  const { listen } = await import('@tauri-apps/api/event');
  cleanups.push(await listen<RosterEntry[]>('overlay://roster', (e) => {
    roster.value = e.payload ?? [];
  }));
  cleanups.push(await listen<boolean>('overlay://interactive', (e) => {
    interactive.value = !!e.payload;
  }));
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
.overlay-empty {
  color: rgba(255, 255, 255, 0.6);
  font-size: 12px;
  background: rgba(0, 0, 0, 0.4);
  padding: 6px 10px;
  border-radius: 8px;
  width: fit-content;
}
</style>
