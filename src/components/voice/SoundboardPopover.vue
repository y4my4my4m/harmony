<template>
  <Teleport to="body">
    <div v-if="visible" class="sbp-backdrop" @click="close" @contextmenu.prevent="close" />
    <div
      v-if="visible"
      ref="panelRef"
      class="sbp"
      role="dialog"
      tabindex="-1"
      data-voice-popover
      :aria-label="t('soundboard.title')"
      :style="{ left: `${position.x}px`, top: `${position.y}px` }"
      @click.stop
      @keydown.esc.stop.prevent="close"
    >
      <header class="sbp-header">
        <Icon name="music" :size="18" />
        <h3 class="sbp-title">{{ t('soundboard.title') }}</h3>
        <button type="button" class="sbp-close" :aria-label="t('common.close')" :title="t('common.close')" @click="close">
          <Icon name="x" :size="16" />
        </button>
      </header>

      <p v-if="deafened" class="sbp-note">{{ t('soundboard.deafenedNote') }}</p>
      <p v-else-if="muted" class="sbp-note">{{ t('soundboard.mutedNote') }}</p>

      <label class="sbp-search">
        <Icon name="search" :size="14" />
        <input
          v-model="query"
          type="search"
          class="sbp-search-input"
          :placeholder="t('soundboard.search')"
          :aria-label="t('soundboard.search')"
          data-testid="soundboard-search"
        />
      </label>

      <div class="sbp-body">
        <section
          v-for="section in visibleSections"
          :key="section.key"
          class="sbp-section"
          :data-testid="`soundboard-section-${section.kind}`"
          :data-server-id="section.serverId ?? undefined"
        >
          <h4 class="sbp-section-title">
            <ServerIcon
              v-if="section.kind !== 'defaults'"
              class="sbp-section-icon"
              :src="section.icon"
              :alt="section.title"
              size="mini"
              shape="rounded"
              :show-title="false"
            />
            <span class="sbp-section-name">{{ section.title }}</span>
            <span v-if="section.locked" class="sbp-lock" :title="t('soundboard.externalLocked')" data-testid="soundboard-locked">
              <Icon name="lock" :size="12" />
            </span>
          </h4>
          <div v-if="section.loading" class="sbp-loading"><LoadingSpinner :size="20" /></div>
          <p v-else-if="section.sounds.length === 0" class="sbp-empty">{{ t('soundboard.emptyServer') }}</p>
          <div v-else class="sbp-grid">
            <div
              v-for="sound in section.sounds"
              :key="sound.id"
              class="sbp-tile-wrap"
              :title="section.locked ? t('soundboard.externalLocked') : undefined"
            >
              <button
                type="button"
                class="sbp-tile"
                :disabled="!canPlay || section.locked"
                :title="section.locked ? t('soundboard.externalLocked') : t('soundboard.playFor', { name: label(sound) })"
                data-testid="soundboard-tile"
                @click="play(sound)"
              >
                <span class="sbp-emoji" aria-hidden="true">{{ sound.emoji || '🔊' }}</span>
                <span class="sbp-name">{{ label(sound) }}</span>
              </button>
              <button
                type="button"
                class="sbp-preview"
                :aria-label="t('soundboard.preview', { name: label(sound) })"
                :title="t('soundboard.preview', { name: label(sound) })"
                @click="soundboard.preview(sound)"
              >
                <Icon name="volume-2" :size="12" />
              </button>
            </div>
          </div>
        </section>
        <p v-if="query.trim() && visibleSections.length === 0" class="sbp-empty" data-testid="soundboard-no-match">
          {{ t('soundboard.noMatches') }}
        </p>
      </div>

      <div
        class="sbp-cooldown"
        :class="{ active: cooldown > 0 }"
        role="progressbar"
        :aria-label="t('soundboard.cooldown')"
        :aria-valuenow="Math.round(cooldownFraction * 100)"
        aria-valuemin="0"
        aria-valuemax="100"
      >
        <div class="sbp-cooldown-bar" :style="{ transform: `scaleX(${cooldownFraction})` }" />
      </div>
    </div>
  </Teleport>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import Icon from '@/components/common/Icon.vue';
import LoadingSpinner from '@/components/common/LoadingSpinner.vue';
import ServerIcon from '@/components/common/ServerIcon.vue';
import { useSoundboardStore } from '@/stores/soundboard';
import { useUnifiedVoiceChannelStore } from '@/stores/unifiedVoiceChannel';
import { useServerChannelStore } from '@/stores/useServerChannel';
import { VoiceSettingsService } from '@/services/VoiceSettingsService';
import { DEFAULT_SOUNDS, type SoundboardSound } from '@/services/soundboard/sounds';
import { SOUNDBOARD_COOLDOWN_MS } from '@/services/soundboard/protocol';
import { VOICE_POPOVER_DISMISS, placePopover, type Rect } from './voiceMenuModel';

const props = defineProps<{
  visible: boolean;
  anchor: Rect | null;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
}>();

const { t } = useI18n();
const soundboard = useSoundboardStore();
const voiceStore = useUnifiedVoiceChannelStore();
const serverChannelStore = useServerChannelStore();

const panelRef = ref<HTMLElement | null>(null);
const position = ref({ x: -9999, y: -9999 });
const loading = ref(false);
const muted = ref(false);
const now = ref(Date.now());
let ticker: ReturnType<typeof setInterval> | null = null;

const query = ref('');

const serverId = computed(() => soundboard.currentChannel()?.serverId ?? null);
const currentServer = computed(() => {
  const id = serverId.value;
  if (!id) return undefined;
  return serverChannelStore.servers.find((s: { id: string }) => s.id === id) as
    | { name?: string; icon?: string | null }
    | undefined;
});
const serverSounds = computed(() => (serverId.value ? soundboard.soundsByServer[serverId.value] ?? [] : []));
const deafened = computed(() => voiceStore.localState.isDeafened);

interface SoundSection {
  key: string;
  kind: 'server' | 'defaults' | 'external';
  serverId: string | null;
  title: string;
  icon: string | null;
  sounds: SoundboardSound[];
  /** External sounds without USE_EXTERNAL_SOUNDS in this channel. */
  locked: boolean;
  loading: boolean;
}

/** The current server, the built-in clips, then each other server sharing its sounds. */
const sections = computed<SoundSection[]>(() => {
  const list: SoundSection[] = [];
  if (serverId.value) {
    list.push({
      key: `server:${serverId.value}`,
      kind: 'server',
      serverId: serverId.value,
      title: currentServer.value?.name || t('soundboard.serverSounds'),
      icon: currentServer.value?.icon ?? null,
      sounds: serverSounds.value,
      locked: false,
      loading: loading.value && serverSounds.value.length === 0,
    });
  }
  list.push({
    key: 'defaults',
    kind: 'defaults',
    serverId: null,
    title: t('soundboard.defaultSounds'),
    icon: null,
    sounds: [...DEFAULT_SOUNDS],
    locked: false,
    loading: false,
  });
  for (const server of soundboard.library) {
    if (server.id === serverId.value || server.sounds.length === 0) continue;
    list.push({
      key: `external:${server.id}`,
      kind: 'external',
      serverId: server.id,
      title: server.name,
      icon: server.icon,
      sounds: server.sounds,
      locked: !soundboard.externalPermitted,
      loading: false,
    });
  }
  return list;
});

/** Sections filtered by the search; without one, every section, an empty current server included. */
const visibleSections = computed<SoundSection[]>(() => {
  const needle = query.value.trim().toLocaleLowerCase();
  if (!needle) return sections.value;
  return sections.value
    .map((section) => ({
      ...section,
      loading: false,
      sounds: section.sounds.filter((sound) => label(sound).toLocaleLowerCase().includes(needle)),
    }))
    .filter((section) => section.sounds.length > 0);
});

const cooldown = computed(() => Math.max(0, soundboard.cooldownUntil - now.value));
const cooldownFraction = computed(() => Math.min(1, cooldown.value / SOUNDBOARD_COOLDOWN_MS));
const canPlay = computed(() => soundboard.permitted && !deafened.value && cooldown.value === 0);

function label(sound: SoundboardSound): string {
  return sound.builtinKey ? t(`soundboard.defaults.${sound.builtinKey}`) : sound.name;
}

function close(): void {
  emit('close');
}

function startTicker(): void {
  now.value = Date.now();
  if (ticker) return;
  ticker = setInterval(() => {
    now.value = Date.now();
    if (cooldown.value === 0 && ticker) {
      clearInterval(ticker);
      ticker = null;
    }
  }, 100);
}

function play(sound: SoundboardSound): void {
  if (soundboard.play(sound)) startTicker();
}

async function place(): Promise<void> {
  await nextTick();
  const el = panelRef.value;
  if (!el) return;
  const rect = el.getBoundingClientRect();
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  const anchor = props.anchor ?? { left: viewport.width / 2, top: viewport.height / 2, width: 0, height: 0 };
  position.value = placePopover(anchor, { width: rect.width, height: rect.height }, viewport);
  el.focus({ preventScroll: true });
}

async function open(): Promise<void> {
  muted.value = VoiceSettingsService.getAll().soundboardMuted === true;
  query.value = '';
  startTicker();
  void place();
  void soundboard.refreshPermission();
  const library = soundboard.loadLibrary();
  const id = serverId.value;
  if (id) {
    loading.value = true;
    try {
      await soundboard.loadServerSounds(id, true);
    } finally {
      loading.value = false;
    }
  }
  await library;
  void place();
}

watch(() => [props.visible, props.anchor] as const, ([visible]) => {
  if (visible) void open();
}, { immediate: true });

function onDismiss(): void {
  if (props.visible) close();
}

onMounted(() => {
  window.addEventListener(VOICE_POPOVER_DISMISS, onDismiss);
  window.addEventListener('resize', onDismiss);
});

onBeforeUnmount(() => {
  window.removeEventListener(VOICE_POPOVER_DISMISS, onDismiss);
  window.removeEventListener('resize', onDismiss);
  if (ticker) clearInterval(ticker);
});
</script>

<style scoped>
.sbp-backdrop {
  position: fixed;
  inset: 0;
  z-index: 10005;
}

.sbp {
  position: fixed;
  z-index: 10006;
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: 360px;
  max-width: calc(100vw - 16px);
  max-height: min(480px, calc(100vh - 16px));
  padding: 14px 14px 0;
  background: var(--background-floating);
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-lg);
  box-shadow: var(--shadow-large);
  outline: none;
  overflow: hidden;
  animation: sbp-in 0.12s ease-out;
}

@keyframes sbp-in {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: none; }
}

@media (prefers-reduced-motion: reduce) {
  .sbp { animation: none; }
}

:root[data-reduce-motion="true"] .sbp {
  animation: none;
}

.sbp-header {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--text-primary);
}

.sbp-title {
  flex: 1;
  margin: 0;
  font-size: var(--font-size-base);
  font-weight: 700;
}

.sbp-close {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  padding: 0;
  border: none;
  border-radius: var(--radius-base);
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
}

.sbp-close:hover,
.sbp-close:focus-visible {
  background: var(--background-modifier-hover);
  color: var(--text-primary);
  outline: none;
}

.sbp-note {
  margin: 0;
  padding: 6px 8px;
  border-radius: var(--radius-md);
  background: var(--background-secondary);
  font-size: var(--font-size-xs);
  color: var(--text-secondary);
}

.sbp-body {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding-bottom: 12px;
}

.sbp-search {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 0 8px;
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-md);
  background: var(--background-secondary);
  color: var(--text-muted);
}

.sbp-search:focus-within {
  border-color: var(--harmony-primary);
}

.sbp-search-input {
  flex: 1;
  min-width: 0;
  height: 30px;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--text-primary);
  font: inherit;
  font-size: var(--font-size-sm);
  outline: none;
}

.sbp-section-title {
  display: flex;
  align-items: center;
  gap: 6px;
  margin: 0 0 6px;
  font-size: var(--font-size-xs);
  font-weight: 700;
  letter-spacing: 0.02em;
  text-transform: uppercase;
  color: var(--text-muted);
}

.sbp-section-icon {
  flex-shrink: 0;
}

.sbp-section-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sbp-lock {
  display: inline-flex;
  flex-shrink: 0;
  color: var(--text-muted);
}

.sbp-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(100px, 1fr));
  gap: 6px;
}

.sbp-tile-wrap {
  position: relative;
}

.sbp-tile {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  min-height: 36px;
  padding: 6px 26px 6px 8px;
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-md);
  background: var(--background-secondary);
  color: var(--text-primary);
  font: inherit;
  font-size: var(--font-size-sm);
  text-align: left;
  cursor: pointer;
  transition: background-color var(--transition-fast), border-color var(--transition-fast);
}

.sbp-tile:hover:not(:disabled),
.sbp-tile:focus-visible {
  background: var(--background-modifier-hover);
  border-color: var(--harmony-primary);
  outline: none;
}

.sbp-tile:disabled {
  opacity: 0.55;
  cursor: default;
}

.sbp-emoji {
  flex-shrink: 0;
  font-size: 18px;
  line-height: 1;
}

.sbp-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sbp-preview {
  position: absolute;
  top: 50%;
  right: 4px;
  transform: translateY(-50%);
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  padding: 0;
  border: none;
  border-radius: var(--radius-sm);
  background: transparent;
  color: var(--text-muted);
  cursor: pointer;
  opacity: 0;
  transition: opacity var(--transition-fast);
}

.sbp-tile-wrap:hover .sbp-preview,
.sbp-preview:focus-visible {
  opacity: 1;
}

.sbp-preview:hover,
.sbp-preview:focus-visible {
  color: var(--text-primary);
  background: var(--background-modifier-hover);
  outline: none;
}

@media (hover: none) {
  .sbp-preview {
    opacity: 1;
  }
}

.sbp-loading {
  display: flex;
  justify-content: center;
  padding: 8px 0;
}

.sbp-empty {
  margin: 0;
  font-size: var(--font-size-xs);
  color: var(--text-muted);
}

.sbp-cooldown {
  height: 3px;
  margin: 0 -14px;
  background: transparent;
}

.sbp-cooldown-bar {
  height: 100%;
  background: var(--harmony-primary);
  transform-origin: left center;
  transform: scaleX(0);
}
</style>
