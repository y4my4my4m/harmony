<!-- FocalPointPicker - Click or tap the subject; previews how cover thumbnails of other shapes crop around it -->
<template>
  <div class="focal-picker">
    <div class="focal-stage-wrap">
      <div
        ref="stageRef"
        class="focal-stage"
        :style="{ '--focal-aspect': String(stageAspect) }"
        tabindex="0"
        role="application"
        :aria-label="t('imageEditor.focalPoint')"
        :aria-describedby="`${uid}-hint ${uid}-value`"
        data-testid="focal-stage"
        @pointerdown="onPointerDown"
        @pointermove="onPointerMove"
        @pointerup="onPointerUp"
        @pointercancel="onPointerUp"
        @keydown="onKeydown"
      >
        <img class="focal-image" :src="src" alt="" draggable="false" @load="onImageLoad" />
        <span
          class="focal-crosshair"
          :style="{ left: `${point.x * 100}%`, top: `${point.y * 100}%` }"
          aria-hidden="true"
          data-testid="focal-crosshair"
        />
      </div>
    </div>

    <p :id="`${uid}-hint`" class="focal-hint">{{ t('imageEditor.focalHint') }}</p>
    <p :id="`${uid}-value`" class="visually-hidden" aria-live="polite">
      {{ t('imageEditor.focalValue', { x: Math.round(point.x * 100), y: Math.round(point.y * 100) }) }}
    </p>

    <div class="focal-previews" :aria-label="t('imageEditor.focalPreviews')" role="group">
      <figure v-for="shape in PREVIEW_SHAPES" :key="shape.key" class="focal-preview">
        <div class="focal-preview-box" :style="{ aspectRatio: shape.ratio }">
          <img :src="src" alt="" draggable="false" :style="{ objectPosition }" />
        </div>
        <figcaption>{{ t(`imageEditor.previewShape.${shape.key}`) }}</figcaption>
      </figure>
    </div>

    <button
      type="button"
      class="btn btn-ghost btn-sm focal-reset"
      :disabled="isCentredFocus(modelValue)"
      @click="emit('update:modelValue', { x: 0, y: 0 })"
    >
      <Icon name="crosshair" :size="14" />
      {{ t('imageEditor.focalReset') }}
    </button>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import Icon from '@/components/common/Icon.vue'
import {
  focusFromNormalized,
  focusToNormalized,
  focusToObjectPosition,
  isCentredFocus,
  type Focus,
} from '@/utils/focalPoint'

interface Props {
  /** Image as it will be uploaded. */
  src: string
  /** Width over height of `src` until it loads; the loaded image's own aspect wins. */
  aspect?: number
  modelValue: Focus
}

const props = withDefaults(defineProps<Props>(), { aspect: 1 })

const emit = defineEmits<{
  'update:modelValue': [focus: Focus]
}>()

const { t } = useI18n()

/** Cover crops: 16:9 quad gallery cells, 1:1 profile media grid, 3:4 a portrait cell. */
const PREVIEW_SHAPES = [
  { key: 'wide', ratio: '16 / 9' },
  { key: 'square', ratio: '1 / 1' },
  { key: 'tall', ratio: '3 / 4' },
] as const

/** Normalized units per arrow key press; Shift multiplies by 4. */
const KEY_STEP = 0.025

const uid = `focal-${Math.random().toString(36).slice(2, 8)}`
const stageRef = ref<HTMLElement | null>(null)
const pressed = ref(false)

const naturalAspect = ref<number | null>(null)
const stageAspect = computed(() => naturalAspect.value ?? props.aspect)

watch(() => props.src, () => { naturalAspect.value = null })

function onImageLoad(event: Event) {
  const img = event.target as HTMLImageElement
  if (img.naturalWidth > 0 && img.naturalHeight > 0) naturalAspect.value = img.naturalWidth / img.naturalHeight
}

const point = computed(() => focusToNormalized(props.modelValue))
const objectPosition = computed(() => focusToObjectPosition(props.modelValue))

function setFromEvent(event: PointerEvent) {
  const rect = stageRef.value?.getBoundingClientRect()
  if (!rect || rect.width === 0 || rect.height === 0) return
  const x = Math.min(1, Math.max(0, (event.clientX - rect.left) / rect.width))
  const y = Math.min(1, Math.max(0, (event.clientY - rect.top) / rect.height))
  emit('update:modelValue', focusFromNormalized({ x, y }))
}

function onPointerDown(event: PointerEvent) {
  if (event.button !== 0 && event.pointerType === 'mouse') return
  stageRef.value?.focus({ preventScroll: true })
  try {
    stageRef.value?.setPointerCapture(event.pointerId)
  } catch {
    // Synthetic events carry no active pointer.
  }
  pressed.value = true
  setFromEvent(event)
}

function onPointerMove(event: PointerEvent) {
  if (pressed.value) setFromEvent(event)
}

function onPointerUp() {
  pressed.value = false
}

function onKeydown(event: KeyboardEvent) {
  const step = KEY_STEP * (event.shiftKey ? 4 : 1)
  const p = point.value
  let next: { x: number; y: number } | null = null
  if (event.key === 'ArrowLeft') next = { x: p.x - step, y: p.y }
  else if (event.key === 'ArrowRight') next = { x: p.x + step, y: p.y }
  else if (event.key === 'ArrowUp') next = { x: p.x, y: p.y - step }
  else if (event.key === 'ArrowDown') next = { x: p.x, y: p.y + step }
  if (!next) return
  event.preventDefault()
  event.stopPropagation()
  emit('update:modelValue', focusFromNormalized({
    x: Math.min(1, Math.max(0, next.x)),
    y: Math.min(1, Math.max(0, next.y)),
  }))
}

defineExpose({ focus: () => stageRef.value?.focus({ preventScroll: true }) })
</script>

<style scoped>
.focal-picker {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.focal-stage-wrap {
  display: flex;
  justify-content: center;
  padding: var(--space-3);
  border-radius: var(--radius-md);
  background: var(--background-tertiary);
}

/* Fits the image aspect inside the wrap width and a 180-320 px height. */
.focal-stage {
  position: relative;
  width: min(100%, calc(clamp(180px, 38vh, 320px) * var(--focal-aspect)));
  aspect-ratio: var(--focal-aspect);
  cursor: crosshair;
  touch-action: none;
  user-select: none;
  -webkit-user-select: none;
  outline: none;
  border-radius: var(--radius-sm);
}

.focal-stage:focus-visible {
  box-shadow: 0 0 0 2px var(--harmony-primary);
}

.focal-image {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: fill;
  border-radius: inherit;
  pointer-events: none;
}

.focal-crosshair {
  position: absolute;
  width: 28px;
  height: 28px;
  margin: -14px 0 0 -14px;
  border: 2px solid #fff;
  border-radius: var(--radius-full);
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.6), inset 0 0 0 1px rgba(0, 0, 0, 0.6);
  pointer-events: none;
}

.focal-crosshair::before,
.focal-crosshair::after {
  content: '';
  position: absolute;
  background: #fff;
  box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.45);
}

.focal-crosshair::before {
  left: 50%;
  top: -10px;
  bottom: -10px;
  width: 2px;
  margin-left: -1px;
}

.focal-crosshair::after {
  top: 50%;
  left: -10px;
  right: -10px;
  height: 2px;
  margin-top: -1px;
}

.focal-hint {
  margin: 0;
  color: var(--text-muted);
  font-size: var(--font-size-xs);
}

.focal-previews {
  display: grid;
  grid-template-columns: 16fr 9fr 6.75fr;
  align-items: end;
  gap: var(--space-3);
}

.focal-preview {
  display: flex;
  flex-direction: column;
  gap: var(--space-1);
  margin: 0;
  min-width: 0;
}

.focal-preview-box {
  width: 100%;
  overflow: hidden;
  border-radius: var(--radius-sm);
  background: var(--background-tertiary);
  border: 1px solid var(--border-primary);
}

.focal-preview-box img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.focal-preview figcaption {
  color: var(--text-muted);
  font-size: var(--font-size-xs);
  text-align: center;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.focal-reset {
  align-self: flex-start;
}

.visually-hidden {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border: 0;
}
</style>
