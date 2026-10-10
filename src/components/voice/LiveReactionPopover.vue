<template>
  <Teleport v-if="visible" :to="host">
    <div class="lrp-backdrop" @click="close(false)" @contextmenu.prevent="close(false)" />
    <div
      ref="panelRef"
      class="lrp"
      role="dialog"
      data-voice-popover
      :aria-label="t('voice.reactions')"
      :style="{ left: `${position.x}px`, top: `${position.y}px` }"
      @click.stop
      @keydown.esc.stop.prevent="close(true)"
    >
      <div ref="rowRef" class="lrp-row" @keydown="onRowKeydown">
        <button
          v-for="entry in quick"
          :key="entry.id"
          type="button"
          class="lrp-btn lrp-emoji"
          :title="entry.display.label"
          :aria-label="entry.display.label"
          :data-emoji="entry.id"
          @click="react(entry.emoji, true)"
        >
          <img
            v-if="entry.display.kind === 'image'"
            class="lrp-emoji-img"
            :src="entry.display.src"
            alt=""
            draggable="false"
          />
          <span v-else class="lrp-emoji-glyph">{{ entry.display.text }}</span>
        </button>
        <span class="lrp-divider" aria-hidden="true" />
        <button
          ref="moreRef"
          type="button"
          class="lrp-btn lrp-more"
          :class="{ active: pickerOpen }"
          :title="t('voice.moreReactions')"
          :aria-label="t('voice.moreReactions')"
          aria-haspopup="dialog"
          :aria-expanded="pickerOpen"
          @click="pickerOpen = !pickerOpen"
        >
          <Icon name="plus" :size="18" />
        </button>
      </div>
      <p v-if="slowDown" class="lrp-status" role="status">{{ t('voice.reactionSlowDown') }}</p>
    </div>
    <EmojiPopup
      v-if="pickerOpen && moreRef"
      :trigger-element="moreRef"
      position="above"
      is-reaction
      :teleport-to="host"
      :close-emoji-list="closePicker"
      @send-emoji="onPicked"
    />
  </Teleport>
</template>

<script setup lang="ts">
import { defineAsyncComponent, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue';
import { useI18n } from 'vue-i18n';
import Icon from '@/components/common/Icon.vue';
import { useFrequentEmojis } from '@/composables/useFrequentEmojis';
import {
  isCustomEmojiId,
  isUnicodeEmoji,
  liveReactions,
  type LiveReactionDisplay,
  type LiveReactionEmoji,
  type LiveReactionTarget,
} from '@/services/voice/liveReactions';
import { VOICE_POPOVER_DISMISS, placePopover } from './voiceMenuModel';

const EmojiPopup = defineAsyncComponent(() => import('@/components/EmojiPopup.vue'));

// Quick reaction bar for a call: frequent emoji first, then the defaults.
const props = defineProps<{
  visible: boolean;
  /** The control that opened the bar; placement and focus return. */
  anchor: HTMLElement | null;
  /** Tile the reactions float over; null puts them on the sender's own tile. */
  target: LiveReactionTarget | null;
}>();

const emit = defineEmits<{
  (e: 'close'): void;
}>();

const QUICK_COUNT = 6;
const DEFAULT_REACTIONS = ['👍', '❤️', '😂', '😮', '🎉', '🔥'];
const SLOW_DOWN_MS = 1500;

interface QuickEntry {
  id: string;
  emoji: LiveReactionEmoji;
  display: LiveReactionDisplay;
}

const { t } = useI18n();
const { getTopEmojis, recordEmojiUsage } = useFrequentEmojis();

const panelRef = ref<HTMLElement | null>(null);
const rowRef = ref<HTMLElement | null>(null);
const moreRef = ref<HTMLButtonElement | null>(null);
const position = ref({ x: -9999, y: -9999 });
const host = ref<string | HTMLElement>('body');
const quick = ref<QuickEntry[]>([]);
const pickerOpen = ref(false);
const slowDown = ref(false);
let slowDownTimer: ReturnType<typeof setTimeout> | null = null;

function frequentToEmoji(entry: { id: string; native?: string }): LiveReactionEmoji | null {
  const unicode = entry.native || entry.id;
  if (isUnicodeEmoji(unicode)) return { kind: 'unicode', value: unicode };
  if (isCustomEmojiId(entry.id)) return { kind: 'custom', value: entry.id };
  return null;
}

// Frozen while open: recording a use reorders the frequent list.
function buildQuick(): QuickEntry[] {
  const out: QuickEntry[] = [];
  const add = (emoji: LiveReactionEmoji | null) => {
    if (!emoji || out.length >= QUICK_COUNT) return;
    const id = `${emoji.kind}:${emoji.value}`;
    if (out.some(e => e.id === id)) return;
    const display = liveReactions.preview(emoji);
    if (display) out.push({ id, emoji, display });
  };
  for (const entry of getTopEmojis(QUICK_COUNT * 2)) add(frequentToEmoji(entry));
  for (const value of DEFAULT_REACTIONS) add({ kind: 'unicode', value });
  return out;
}

function close(restoreFocus: boolean): void {
  pickerOpen.value = false;
  emit('close');
  if (restoreFocus) props.anchor?.focus({ preventScroll: true });
}

function closePicker(): void {
  pickerOpen.value = false;
}

function flashSlowDown(): void {
  slowDown.value = true;
  if (slowDownTimer) clearTimeout(slowDownTimer);
  slowDownTimer = setTimeout(() => { slowDown.value = false; }, SLOW_DOWN_MS);
}

function react(emoji: LiveReactionEmoji, record: boolean): void {
  const result = liveReactions.send(emoji, props.target);
  if (result === 'rate_limited') {
    flashSlowDown();
    return;
  }
  if (result !== 'sent' || !record) return;
  if (emoji.kind === 'unicode') {
    recordEmojiUsage({ id: emoji.value, native: emoji.value, name: emoji.value });
  } else {
    const entry = quick.value.find(e => e.emoji.value === emoji.value);
    recordEmojiUsage({ id: emoji.value, name: entry?.display.label ?? emoji.value });
  }
}

/** The picker records its own usage. */
function onPicked(emoji: { id: string; url?: string }): void {
  closePicker();
  react(emoji.url ? { kind: 'custom', value: emoji.id } : { kind: 'unicode', value: emoji.id }, false);
}

function onRowKeydown(event: KeyboardEvent): void {
  const buttons = Array.from(rowRef.value?.querySelectorAll<HTMLButtonElement>('button') ?? []);
  const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
  if (index < 0 || !buttons.length) return;
  let next = index;
  if (event.key === 'ArrowRight') next = (index + 1) % buttons.length;
  else if (event.key === 'ArrowLeft') next = (index - 1 + buttons.length) % buttons.length;
  else if (event.key === 'Home') next = 0;
  else if (event.key === 'End') next = buttons.length - 1;
  else return;
  event.preventDefault();
  buttons[next].focus();
}

async function place(): Promise<void> {
  await nextTick();
  const el = panelRef.value;
  if (!el) return;
  const rect = el.getBoundingClientRect();
  const viewport = { width: window.innerWidth, height: window.innerHeight };
  const a = props.anchor?.getBoundingClientRect();
  const anchor = a
    ? { left: a.left, top: a.top, width: a.width, height: a.height }
    : { left: viewport.width / 2, top: viewport.height / 2, width: 0, height: 0 };
  position.value = placePopover(anchor, { width: rect.width, height: rect.height }, viewport);
  rowRef.value?.querySelector<HTMLButtonElement>('button')?.focus({ preventScroll: true });
}

// Browser full screen shows only the fullscreen element's subtree.
watch(() => props.visible, visible => {
  if (!visible) {
    pickerOpen.value = false;
    return;
  }
  host.value = (document.fullscreenElement as HTMLElement | null) ?? 'body';
  quick.value = buildQuick();
  position.value = { x: -9999, y: -9999 };
  void place();
}, { immediate: true });

function onDismiss(): void {
  if (props.visible) close(false);
}

onMounted(() => {
  window.addEventListener(VOICE_POPOVER_DISMISS, onDismiss);
  window.addEventListener('resize', onDismiss);
  document.addEventListener('fullscreenchange', onDismiss);
});

onBeforeUnmount(() => {
  window.removeEventListener(VOICE_POPOVER_DISMISS, onDismiss);
  window.removeEventListener('resize', onDismiss);
  document.removeEventListener('fullscreenchange', onDismiss);
  if (slowDownTimer) clearTimeout(slowDownTimer);
});
</script>

<style scoped>
.lrp-backdrop {
  position: fixed;
  inset: 0;
  z-index: 10005;
}

.lrp {
  position: fixed;
  z-index: 10006;
  max-width: calc(100vw - 16px);
  padding: 6px;
  background: var(--background-floating);
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-full);
  box-shadow: var(--shadow-large);
  animation: lrp-in 0.12s ease-out;
}

@keyframes lrp-in {
  from { opacity: 0; transform: translateY(4px); }
  to { opacity: 1; transform: none; }
}

@media (prefers-reduced-motion: reduce) {
  .lrp { animation: none; }
}

:root[data-reduce-motion="true"] .lrp {
  animation: none;
}

.lrp-row {
  display: flex;
  align-items: center;
  gap: 2px;
}

.lrp-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 40px;
  height: 40px;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  transition: background-color var(--transition-fast), transform var(--transition-fast);
}

.lrp-btn:hover,
.lrp-btn:focus-visible,
.lrp-btn.active {
  background: var(--background-modifier-hover);
  color: var(--text-primary);
  outline: none;
}

.lrp-btn:focus-visible {
  box-shadow: 0 0 0 2px var(--harmony-primary);
}

.lrp-emoji:hover {
  transform: scale(1.12);
}

.lrp-emoji:active {
  transform: scale(0.94);
}

@media (prefers-reduced-motion: reduce) {
  .lrp-emoji:hover,
  .lrp-emoji:active { transform: none; }
}

:root[data-reduce-motion="true"] .lrp-emoji:hover,
:root[data-reduce-motion="true"] .lrp-emoji:active {
  transform: none;
}

.lrp-emoji-img {
  width: 26px;
  height: 26px;
  object-fit: contain;
}

.lrp-emoji-glyph {
  font-size: 24px;
  line-height: 1;
}

.lrp-divider {
  width: 1px;
  height: 24px;
  margin: 0 4px;
  background: var(--border-primary);
}

/* Above the bar, so the bar keeps its place over the anchor. */
.lrp-status {
  position: absolute;
  bottom: calc(100% + 6px);
  left: 50%;
  margin: 0;
  padding: 4px 10px;
  transform: translateX(-50%);
  white-space: nowrap;
  border-radius: var(--radius-md);
  background: var(--background-floating);
  border: 1px solid var(--border-primary);
  box-shadow: var(--shadow-medium);
  font-size: var(--font-size-xs);
  color: var(--text-primary);
}
</style>
