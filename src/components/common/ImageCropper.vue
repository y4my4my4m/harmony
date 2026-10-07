<!-- ImageCropper - Fixed frame over a movable, zoomable, rotatable image; v-model is the CropState -->
<template>
  <div class="image-cropper">
    <div
      ref="stageRef"
      class="cropper-stage"
      :class="{ 'is-dragging': dragging }"
      tabindex="0"
      role="application"
      :aria-label="label"
      :aria-describedby="hintId"
      data-testid="cropper-stage"
      @pointerdown="onPointerDown"
      @pointermove="onPointerMove"
      @pointerup="onPointerUp"
      @pointercancel="onPointerUp"
      @lostpointercapture="onPointerUp"
      @wheel.prevent="onWheel"
      @keydown="onKeydown"
    >
      <canvas ref="canvasRef" class="cropper-canvas" aria-hidden="true" />
      <svg
        v-if="stage.width > 0"
        class="cropper-mask"
        :viewBox="`0 0 ${stage.width} ${stage.height}`"
        aria-hidden="true"
      >
        <path class="mask-outside" fill-rule="evenodd" :d="`${rectPath(fullStage)} ${rectPath(frame)}`" />
        <path v-if="shape !== 'rect'" class="mask-corners" fill-rule="evenodd" :d="`${rectPath(frame)} ${shapePath}`" />
        <g v-if="dragging" class="mask-grid">
          <line :x1="frame.x + frame.width / 3" :y1="frame.y" :x2="frame.x + frame.width / 3" :y2="frame.y + frame.height" />
          <line :x1="frame.x + (frame.width * 2) / 3" :y1="frame.y" :x2="frame.x + (frame.width * 2) / 3" :y2="frame.y + frame.height" />
          <line :x1="frame.x" :y1="frame.y + frame.height / 3" :x2="frame.x + frame.width" :y2="frame.y + frame.height / 3" />
          <line :x1="frame.x" :y1="frame.y + (frame.height * 2) / 3" :x2="frame.x + frame.width" :y2="frame.y + (frame.height * 2) / 3" />
        </g>
        <path class="mask-outline" :d="shape === 'rect' ? rectPath(frame) : shapePath" />
      </svg>
    </div>

    <p :id="hintId" class="cropper-hint">{{ t('imageEditor.cropHint') }}</p>

    <div class="cropper-controls">
      <button
        type="button"
        class="cropper-btn"
        :aria-label="t('imageEditor.zoomOut')"
        :title="t('imageEditor.zoomOut')"
        :disabled="modelValue.zoom <= 1"
        @click="zoomBy(1 / BUTTON_ZOOM_STEP)"
      >
        <Icon name="zoom-out" :size="18" />
      </button>
      <input
        class="cropper-zoom"
        type="range"
        min="0"
        :max="SLIDER_STEPS"
        step="1"
        :value="sliderValue"
        :disabled="maxZoom <= 1"
        :aria-label="t('imageEditor.zoom')"
        :aria-valuetext="t('imageEditor.zoomValue', { percent: Math.round(modelValue.zoom * 100) })"
        data-testid="cropper-zoom"
        @input="onSlider"
      />
      <button
        type="button"
        class="cropper-btn"
        :aria-label="t('imageEditor.zoomIn')"
        :title="t('imageEditor.zoomIn')"
        :disabled="modelValue.zoom >= maxZoom"
        @click="zoomBy(BUTTON_ZOOM_STEP)"
      >
        <Icon name="zoom-in" :size="18" />
      </button>
      <span class="cropper-divider" aria-hidden="true" />
      <button
        type="button"
        class="cropper-btn"
        :aria-label="t('imageEditor.rotateLeft')"
        :title="t('imageEditor.rotateLeft')"
        data-testid="cropper-rotate-left"
        @click="rotate(-90)"
      >
        <Icon name="rotate-ccw" :size="18" />
      </button>
      <button
        type="button"
        class="cropper-btn"
        :aria-label="t('imageEditor.rotateRight')"
        :title="t('imageEditor.rotateRight')"
        data-testid="cropper-rotate-right"
        @click="rotate(90)"
      >
        <Icon name="rotate-cw" :size="18" />
      </button>
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import Icon from '@/components/common/Icon.vue'
import {
  clampCrop,
  cropDrawMatrix,
  cropRect,
  maxZoomFor,
  normalizeRotation,
  panCrop,
  rotateCrop,
  rotatedSize,
  zoomCrop,
  type CropState,
  type Rect,
  type Rotation,
} from '@/utils/cropGeometry'
import type { FrameShape } from '@/utils/imageCrop'

interface Props {
  /** Upright image; `preview` is drawn, scaled to width×height. */
  source: { preview: CanvasImageSource; width: number; height: number }
  modelValue: CropState
  /** Width over height; 'original' follows the turned image. */
  aspect: number | 'original'
  shape?: FrameShape
  /** Corner radius over frame width; 'rounded' only. */
  radius?: number
  /** Smallest crop width in source pixels. */
  minCropWidth?: number
  label: string
}

const props = withDefaults(defineProps<Props>(), {
  shape: 'rect',
  radius: 0,
  minCropWidth: 64,
})

const emit = defineEmits<{
  'update:modelValue': [state: CropState]
  confirm: []
}>()

const { t } = useI18n()

const SLIDER_STEPS = 1000
const BUTTON_ZOOM_STEP = 1.25
/** Frame px per arrow key press; Shift multiplies by 4. */
const KEY_PAN_STEP = 10
const KEY_ZOOM_STEP = 1.1
/** exp(-deltaY * k) per wheel event; ctrlKey wheels are trackpad pinches with small deltas. */
const WHEEL_ZOOM_RATE = 0.0015
const PINCH_WHEEL_ZOOM_RATE = 0.01
const LINE_HEIGHT_PX = 16

const hintId = `cropper-hint-${Math.random().toString(36).slice(2, 8)}`
const stageRef = ref<HTMLElement | null>(null)
const canvasRef = ref<HTMLCanvasElement | null>(null)
const stage = ref({ width: 0, height: 0 })
const dragging = ref(false)

const size = computed(() => ({ width: props.source.width, height: props.source.height }))

function aspectAt(rotation: Rotation): number {
  if (props.aspect !== 'original') return props.aspect
  const turned = rotatedSize(size.value, rotation)
  return turned.width / turned.height
}

const aspect = computed(() => aspectAt(props.modelValue.rotation))

function maxZoomAt(rotation: Rotation): number {
  return maxZoomFor(size.value, aspectAt(rotation), props.minCropWidth, rotation)
}

const maxZoom = computed(() => maxZoomAt(props.modelValue.rotation))

const sliderValue = computed(() =>
  maxZoom.value > 1 ? Math.round((SLIDER_STEPS * Math.log(props.modelValue.zoom)) / Math.log(maxZoom.value)) : 0,
)

const fullStage = computed<Rect>(() => ({ x: 0, y: 0, width: stage.value.width, height: stage.value.height }))

/** Frame rect in stage CSS px: the aspect fitted inside the stage less its padding. */
const frame = computed<Rect>(() => {
  const { width, height } = stage.value
  const pad = width < 420 ? 16 : 32
  const availW = Math.max(1, width - pad * 2)
  const availH = Math.max(1, height - pad * 2)
  let w = availW
  let h = w / aspect.value
  if (h > availH) {
    h = availH
    w = h * aspect.value
  }
  return { x: (width - w) / 2, y: (height - h) / 2, width: w, height: h }
})

function rectPath(r: Rect): string {
  return `M${r.x} ${r.y}H${r.x + r.width}V${r.y + r.height}H${r.x}Z`
}

const shapePath = computed(() => {
  const f = frame.value
  if (props.shape === 'circle') {
    const rx = f.width / 2
    const ry = f.height / 2
    const cx = f.x + rx
    const cy = f.y + ry
    return `M${cx - rx} ${cy}A${rx} ${ry} 0 1 0 ${cx + rx} ${cy}A${rx} ${ry} 0 1 0 ${cx - rx} ${cy}Z`
  }
  if (props.shape === 'rounded') {
    const r = Math.min(props.radius * f.width, f.width / 2, f.height / 2)
    const right = f.x + f.width
    const bottom = f.y + f.height
    return `M${f.x + r} ${f.y}H${right - r}A${r} ${r} 0 0 1 ${right} ${f.y + r}V${bottom - r}`
      + `A${r} ${r} 0 0 1 ${right - r} ${bottom}H${f.x + r}A${r} ${r} 0 0 1 ${f.x} ${bottom - r}`
      + `V${f.y + r}A${r} ${r} 0 0 1 ${f.x + r} ${f.y}Z`
  }
  return rectPath(f)
})

function update(next: CropState) {
  emit('update:modelValue', next)
}

/** Frame px per turned-image px. */
function frameScale(): number {
  return frame.value.width / cropRect(props.modelValue, size.value, aspect.value).width
}

function panBy(dx: number, dy: number) {
  update(panCrop(props.modelValue, dx, dy, frameScale(), size.value, aspect.value, maxZoom.value))
}

/** `anchor` in stage CSS px; the frame centre when absent. */
function zoomTo(zoom: number, anchor?: { x: number; y: number }) {
  const f = frame.value
  const unit = anchor
    ? { x: (anchor.x - f.x) / f.width, y: (anchor.y - f.y) / f.height }
    : { x: 0.5, y: 0.5 }
  update(zoomCrop(props.modelValue, zoom, unit, size.value, aspect.value, maxZoom.value))
}

function zoomBy(factor: number, anchor?: { x: number; y: number }) {
  zoomTo(props.modelValue.zoom * factor, anchor)
}

function rotate(delta: 90 | -90) {
  const next = normalizeRotation(props.modelValue.rotation + delta)
  update(rotateCrop(props.modelValue, delta, size.value, aspectAt(next), maxZoomAt(next)))
}

function onSlider(event: Event) {
  const value = Number((event.target as HTMLInputElement).value)
  zoomTo(Math.pow(maxZoom.value, value / SLIDER_STEPS))
}

// Pointer gestures: one pointer pans, two pointers pinch about their midpoint.
const pointers = new Map<number, { x: number; y: number }>()

function stagePoint(event: PointerEvent | WheelEvent): { x: number; y: number } {
  const rect = stageRef.value?.getBoundingClientRect()
  return { x: event.clientX - (rect?.left ?? 0), y: event.clientY - (rect?.top ?? 0) }
}

function onPointerDown(event: PointerEvent) {
  if (event.button !== 0 && event.pointerType === 'mouse') return
  stageRef.value?.focus({ preventScroll: true })
  try {
    stageRef.value?.setPointerCapture(event.pointerId)
  } catch {
    // Synthetic events carry no active pointer.
  }
  pointers.set(event.pointerId, stagePoint(event))
  dragging.value = true
}

function onPointerMove(event: PointerEvent) {
  const previous = pointers.get(event.pointerId)
  if (!previous) return
  const current = stagePoint(event)
  if (pointers.size === 1) {
    pointers.set(event.pointerId, current)
    panBy(current.x - previous.x, current.y - previous.y)
    return
  }
  const others = [...pointers.entries()].filter(([id]) => id !== event.pointerId)
  const other = others[0]?.[1]
  pointers.set(event.pointerId, current)
  if (!other) return
  const prevMid = { x: (previous.x + other.x) / 2, y: (previous.y + other.y) / 2 }
  const mid = { x: (current.x + other.x) / 2, y: (current.y + other.y) / 2 }
  const prevDist = Math.hypot(previous.x - other.x, previous.y - other.y)
  const dist = Math.hypot(current.x - other.x, current.y - other.y)
  const panned = panCrop(props.modelValue, mid.x - prevMid.x, mid.y - prevMid.y, frameScale(), size.value, aspect.value, maxZoom.value)
  const f = frame.value
  const anchor = { x: (mid.x - f.x) / f.width, y: (mid.y - f.y) / f.height }
  const ratio = prevDist > 0 ? dist / prevDist : 1
  update(zoomCrop(panned, panned.zoom * ratio, anchor, size.value, aspect.value, maxZoom.value))
}

function onPointerUp(event: PointerEvent) {
  pointers.delete(event.pointerId)
  if (pointers.size === 0) dragging.value = false
}

function onWheel(event: WheelEvent) {
  const scale = event.deltaMode === 1 ? LINE_HEIGHT_PX : event.deltaMode === 2 ? stage.value.height : 1
  const rate = event.ctrlKey ? PINCH_WHEEL_ZOOM_RATE : WHEEL_ZOOM_RATE
  zoomBy(Math.exp(-event.deltaY * scale * rate), stagePoint(event))
}

function onKeydown(event: KeyboardEvent) {
  const step = KEY_PAN_STEP * (event.shiftKey ? 4 : 1)
  // Arrow keys move the crop window; the image moves the other way.
  switch (event.key) {
    case 'ArrowLeft': panBy(step, 0); break
    case 'ArrowRight': panBy(-step, 0); break
    case 'ArrowUp': panBy(0, step); break
    case 'ArrowDown': panBy(0, -step); break
    case '+':
    case '=':
      zoomBy(KEY_ZOOM_STEP)
      break
    case '-':
    case '_':
      zoomBy(1 / KEY_ZOOM_STEP)
      break
    case 'Enter':
      emit('confirm')
      break
    default:
      return
  }
  event.preventDefault()
  event.stopPropagation()
}

let frameRequest = 0

function draw() {
  frameRequest = 0
  const canvas = canvasRef.value
  const ctx = canvas?.getContext('2d')
  if (!canvas || !ctx || stage.value.width === 0) return
  const dpr = Math.min(3, Math.max(1, window.devicePixelRatio || 1))
  const width = Math.round(stage.value.width * dpr)
  const height = Math.round(stage.value.height * dpr)
  if (canvas.width !== width) canvas.width = width
  if (canvas.height !== height) canvas.height = height
  ctx.setTransform(1, 0, 0, 1, 0, 0)
  ctx.clearRect(0, 0, width, height)
  const f = frame.value
  const [a, b, c, d, e, g] = cropDrawMatrix(props.modelValue, size.value, aspect.value, f)
  ctx.setTransform(dpr * a, dpr * b, dpr * c, dpr * d, dpr * (e + f.x), dpr * (g + f.y))
  ctx.imageSmoothingEnabled = true
  ctx.imageSmoothingQuality = 'high'
  ctx.drawImage(props.source.preview, 0, 0, props.source.width, props.source.height)
}

function scheduleDraw() {
  if (frameRequest || typeof requestAnimationFrame !== 'function') {
    if (!frameRequest) draw()
    return
  }
  frameRequest = requestAnimationFrame(draw)
}

watch([() => props.modelValue, frame, () => props.source], scheduleDraw)

// A changed aspect or source moves the crop limits.
watch([aspect, () => props.source], () => {
  const clamped = clampCrop(props.modelValue, size.value, aspect.value, maxZoom.value)
  const m = props.modelValue
  if (clamped.zoom !== m.zoom || clamped.cx !== m.cx || clamped.cy !== m.cy) update(clamped)
})

let resizeObserver: ResizeObserver | null = null

function measure() {
  const el = stageRef.value
  if (!el) return
  stage.value = { width: el.clientWidth, height: el.clientHeight }
}

onMounted(() => {
  measure()
  if (typeof ResizeObserver === 'function' && stageRef.value) {
    resizeObserver = new ResizeObserver(measure)
    resizeObserver.observe(stageRef.value)
  }
  scheduleDraw()
})

onBeforeUnmount(() => {
  resizeObserver?.disconnect()
  if (frameRequest && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frameRequest)
})

defineExpose({ focus: () => stageRef.value?.focus({ preventScroll: true }) })
</script>

<style scoped>
.image-cropper {
  display: flex;
  flex-direction: column;
  gap: var(--space-2);
}

/* Checkerboard shows through transparent pixels. */
.cropper-stage {
  position: relative;
  height: clamp(220px, 46vh, 360px);
  overflow: hidden;
  border-radius: var(--radius-md);
  background-color: var(--background-tertiary);
  background-image:
    conic-gradient(var(--background-quaternary) 25%, transparent 0 50%, var(--background-quaternary) 0 75%, transparent 0);
  background-size: 16px 16px;
  cursor: grab;
  touch-action: none;
  user-select: none;
  -webkit-user-select: none;
  outline: none;
}

.cropper-stage.is-dragging {
  cursor: grabbing;
}

.cropper-stage:focus-visible {
  box-shadow: 0 0 0 2px var(--harmony-primary);
}

.cropper-canvas,
.cropper-mask {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  pointer-events: none;
}

.mask-outside {
  fill: rgba(0, 0, 0, 0.62);
}

.mask-corners {
  fill: rgba(0, 0, 0, 0.32);
}

.mask-outline {
  fill: none;
  stroke: rgba(255, 255, 255, 0.9);
  stroke-width: 1.5;
}

.mask-grid line {
  stroke: rgba(255, 255, 255, 0.35);
  stroke-width: 1;
}

.cropper-hint {
  margin: 0;
  color: var(--text-muted);
  font-size: var(--font-size-xs);
  line-height: var(--line-height-normal);
}

.cropper-controls {
  display: flex;
  align-items: center;
  gap: var(--space-2);
}

.cropper-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  flex-shrink: 0;
  padding: 0;
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-md);
  background: transparent;
  color: var(--text-secondary);
  cursor: pointer;
  transition: background-color var(--transition-fast), color var(--transition-fast), border-color var(--transition-fast);
}

.cropper-btn:hover:not(:disabled) {
  background: var(--background-modifier-hover);
  border-color: var(--border-hover);
  color: var(--text-primary);
}

.cropper-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}

.cropper-btn:focus-visible,
.cropper-zoom:focus-visible {
  outline: 2px solid var(--harmony-primary);
  outline-offset: 2px;
}

.cropper-zoom {
  flex: 1;
  min-width: 0;
  accent-color: var(--harmony-primary);
  cursor: pointer;
}

.cropper-zoom:disabled {
  cursor: not-allowed;
}

.cropper-divider {
  width: 1px;
  height: 20px;
  margin: 0 var(--space-1);
  background: var(--border-primary);
}
</style>
