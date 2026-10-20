<!-- Starts an activity in the call, or queues to the running one: a pasted link or a Drive file. -->
<template>
  <Teleport :to="portalTarget">
    <div v-show="!pickerOpen" class="act-launch-backdrop" @click="emit('close')" />
    <div
      v-show="!pickerOpen"
      ref="panel"
      class="act-launch"
      role="dialog"
      tabindex="-1"
      data-voice-popover
      :aria-label="t('activities.title')"
      :style="{ left: `${position.x}px`, top: `${position.y}px` }"
      data-testid="activity-launcher"
      @click.stop
      @keydown.esc.stop.prevent="emit('close')"
    >
      <header class="act-launch__head">
        <Icon name="popcorn" :size="18" />
        <h3>{{ running ? t('activities.addTitle') : t('activities.title') }}</h3>
        <button type="button" class="act-launch__close" :aria-label="t('common.close')" @click="emit('close')">
          <Icon name="x" :size="16" />
        </button>
      </header>
      <p class="act-launch__lede">{{ t('activities.lede') }}</p>

      <form class="act-launch__form" @submit.prevent="submit(running ? 'queue' : 'start')">
        <input
          ref="input"
          v-model="link"
          class="act-launch__input"
          type="url"
          inputmode="url"
          :placeholder="t('activities.linkPlaceholder')"
          :aria-label="t('activities.linkPlaceholder')"
          :aria-invalid="!!error"
          data-testid="activity-link"
        />
        <div class="act-launch__actions">
          <button v-if="running && canEnd" type="button" class="act-launch__btn" :disabled="!parsed || busy" data-testid="activity-play-now" @click="submit('start')">
            {{ t('activities.playNow') }}
          </button>
          <button type="submit" class="act-launch__btn act-launch__btn--primary" :disabled="!parsed || busy" data-testid="activity-start">
            <Icon :name="running ? 'list-video' : 'play'" :size="15" />
            {{ running ? t('activities.addToQueue') : startLabel }}
          </button>
        </div>
      </form>
      <p v-if="parsed?.source === 'spotify'" class="act-launch__hint">{{ t('activities.spotifyHint') }}</p>
      <p v-if="error" class="act-launch__error" role="alert">{{ error }}</p>

      <div class="act-launch__divider"><span>{{ t('activities.or') }}</span></div>
      <button type="button" class="act-launch__drive" data-testid="activity-from-drive" :disabled="busy" @click="pickerOpen = true">
        <Icon name="hard-drive" :size="16" />
        <span>{{ t('activities.fromDrive') }}</span>
      </button>
    </div>
    <DrivePickerModal
      v-if="pickerOpen"
      :kinds="['video', 'audio']"
      :title="t('activities.pickTitle')"
      :confirm-label="running ? t('activities.addToQueue') : t('activities.playTogether')"
      @pick="pickFile"
      @close="pickerOpen = false"
    />
  </Teleport>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, ref } from 'vue'
import Icon from '@/components/common/Icon.vue'
import DrivePickerModal from '@/components/drive/DrivePickerModal.vue'
import { useT } from '@/composables/useT'
import { useActivitiesStore } from '@/stores/activities'
import { fetchLinkDetails, parseActivityLink, type ActivityItem, type ActivitySource } from '@/services/activities/activityService'
import type { DriveFile } from '@/services/drive/driveService'
import { placePopover, type Rect } from '@/components/voice/voiceMenuModel'
import { styleRect, styleViewport } from '@/utils/appZoom'
import { useActivityControl } from './useActivityControl'
import { usePortalTarget } from '@/composables/usePortalTarget'

const portalTarget = usePortalTarget()

const props = defineProps<{ anchor: Rect | null }>()
const emit = defineEmits<{ close: [] }>()

const { t } = useT()
const actStore = useActivitiesStore()
const panel = ref<HTMLElement | null>(null)
const input = ref<HTMLInputElement | null>(null)
const link = ref('')
const error = ref<string | null>(null)
const busy = ref(false)
const pickerOpen = ref(false)
const position = ref({ x: -9999, y: -9999 })

const running = computed(() => !!actStore.current)
const { canEnd } = useActivityControl(() => actStore.current)
const parsed = computed(() => (link.value.trim() ? parseActivityLink(link.value) : null))
const startLabel = computed(() => (parsed.value && (parsed.value.source === 'spotify' || parsed.value.source === 'soundcloud' || parsed.value.item.mime_type === 'audio/*')
  ? t('activities.listenTogether')
  : t('activities.watchTogether')))

async function begin(source: ActivitySource, item: ActivityItem, mode: 'start' | 'queue', startMs = 0): Promise<void> {
  busy.value = true
  error.value = null
  try {
    if (mode === 'queue') await actStore.control({ action: 'enqueue', source, item })
    else await actStore.start(source, item, startMs)
    emit('close')
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
  }, running.value ? 'queue' : 'start')
}

onMounted(async () => {
  await nextTick()
  const el = panel.value
  if (!el) return
  const r = styleRect(el)
  const viewport = styleViewport(el)
  const anchor = props.anchor ?? { left: viewport.width / 2, top: viewport.height / 2, width: 0, height: 0 }
  position.value = placePopover(anchor, { width: r.width, height: r.height }, viewport)
  input.value?.focus()
})
</script>

<style scoped>
.act-launch-backdrop {
  position: fixed;
  inset: 0;
  z-index: 10005;
}

.act-launch {
  position: fixed;
  z-index: 10006;
  display: flex;
  flex-direction: column;
  gap: 10px;
  width: 380px;
  max-width: calc(100 * var(--app-vw) - 16px);
  padding: 14px;
  background: var(--background-floating, var(--background-secondary));
  border: 1px solid var(--border-primary, var(--border-color));
  border-radius: 14px;
  box-shadow: 0 18px 48px rgb(0 0 0 / 0.45);
  outline: none;
  animation: act-launch-in 0.14s ease-out;
}

.act-launch__head {
  display: flex;
  align-items: center;
  gap: 8px;
  color: var(--text-primary);
}

.act-launch__head h3 {
  flex: 1;
  margin: 0;
  font-size: var(--font-size-md, 15px);
}

.act-launch__close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  background: none;
  border: none;
  border-radius: 6px;
  color: var(--text-secondary);
  cursor: pointer;
}

.act-launch__close:hover {
  background: var(--background-modifier-hover);
}

.act-launch__lede,
.act-launch__hint {
  margin: 0;
  font-size: var(--font-size-xs);
  line-height: var(--line-height-normal);
  color: var(--text-secondary);
}

.act-launch__form {
  display: flex;
  flex-direction: column;
  gap: 8px;
}

.act-launch__input {
  min-height: 38px;
  padding: 0 12px;
  background: var(--surface-inset, var(--background-tertiary));
  border: 1px solid var(--border-color);
  border-radius: 10px;
  font: inherit;
  font-size: var(--font-size-sm);
  color: var(--text-primary);
}

.act-launch__input:focus {
  border-color: var(--harmony-primary);
  outline: none;
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--harmony-primary) 22%, transparent);
}

.act-launch__actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

.act-launch__btn {
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

.act-launch__btn--primary {
  background: var(--harmony-primary-fill, var(--harmony-primary));
  border-color: transparent;
  color: var(--text-on-primary, #fff);
}

.act-launch__btn:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.act-launch__error {
  margin: 0;
  font-size: var(--font-size-xs);
  color: var(--danger);
}

.act-launch__divider {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 11px;
  color: var(--text-muted);
  text-transform: uppercase;
  letter-spacing: 0.04em;
}

.act-launch__divider::before,
.act-launch__divider::after {
  content: '';
  flex: 1;
  height: 1px;
  background: var(--border-color);
}

.act-launch__drive {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  min-height: 40px;
  background: none;
  border: 1px dashed var(--border-color);
  border-radius: 10px;
  font: inherit;
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
  color: var(--text-secondary);
  cursor: pointer;
}

.act-launch__drive:hover:not(:disabled) {
  border-color: var(--harmony-primary);
  color: var(--text-primary);
}

@keyframes act-launch-in {
  from { opacity: 0; transform: translateY(6px) scale(0.98); }
  to { opacity: 1; transform: none; }
}

@media (prefers-reduced-motion: reduce) {
  .act-launch { animation: none; }
}
</style>
