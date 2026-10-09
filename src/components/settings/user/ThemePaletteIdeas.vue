<template>
  <div class="palette-ideas">
    <div class="pi-head">
      <span class="pi-title">Palette ideas</span>
      <div class="pi-actions">
        <button type="button" class="pi-action" title="Random palette" @click="surprise">
          <Icon name="shuffle" :size="14" />
          <span>Surprise me</span>
        </button>
        <button type="button" class="pi-action" title="Build a palette from an image" @click="fileInput?.click()">
          <Icon name="image" :size="14" />
          <span>From image</span>
        </button>
        <input
          ref="fileInput"
          type="file"
          accept="image/*"
          class="pi-file"
          tabindex="-1"
          aria-hidden="true"
          @change="onImagePicked"
        />
      </div>
    </div>

    <div class="pi-moods" role="radiogroup" aria-label="Palette mood">
      <button
        v-for="(m, id) in PALETTE_MOODS"
        :key="id"
        type="button"
        role="radio"
        class="pi-mood"
        :class="{ active: mood === id }"
        :aria-checked="mood === id"
        @click="mood = id"
      >{{ m.label }}</button>
    </div>

    <div class="pi-grid">
      <button
        v-for="s in suggestions"
        :key="s.id"
        type="button"
        class="pi-card"
        :title="`${s.label}: primary ${s.colors.customPrimaryColor}, accent ${s.colors.customAccentColor}`"
        @click="emit('apply', s.colors)"
      >
        <span class="pi-mock" :style="{ background: s.preview.main }">
          <span class="pi-mock-rail" :style="{ background: s.preview.sidebar }" />
          <span class="pi-mock-body">
            <span class="pi-mock-head" :style="{ background: s.preview.header }" />
            <span class="pi-mock-line" :style="{ background: s.preview.accent }" />
            <span class="pi-mock-line short" :style="{ background: mutedLine }" />
            <span class="pi-mock-btn" :style="{ background: s.preview.primary }" />
          </span>
        </span>
        <span class="pi-card-label">{{ s.label }}</span>
      </button>
    </div>

    <div v-if="imageSwatches.length" class="pi-image-row">
      <img v-if="imageUrl" :src="imageUrl" alt="" class="pi-image-thumb" />
      <span
        v-for="sw in imageSwatches"
        :key="sw.hex"
        class="pi-image-swatch"
        :style="{ background: sw.hex, flexGrow: Math.max(1, Math.round(sw.weight * 10)) }"
        :title="sw.hex"
      />
    </div>
    <p v-if="imageError" class="pi-error">{{ imageError }}</p>
  </div>
</template>

<script setup lang="ts">
import { computed, onBeforeUnmount, ref } from 'vue'
import Icon from '@/components/common/Icon.vue'
import {
  PALETTE_MOODS,
  extractImageSwatches,
  paletteFromImage,
  randomPalette,
  suggestPalettes,
  type ImageSwatch,
  type PaletteMood,
  type ThemeColors,
  type ThemeMode,
} from '@/utils/themeHarmony'

const props = defineProps<{
  mode: ThemeMode
  /** Hue source for the suggestions; the editor passes its primary. */
  seed: string
}>()

const emit = defineEmits<{ apply: [colors: ThemeColors] }>()

const mood = ref<PaletteMood>('balanced')
const fileInput = ref<HTMLInputElement | null>(null)
const imageSwatches = ref<ImageSwatch[]>([])
const imageUrl = ref<string | null>(null)
const imageError = ref<string | null>(null)

const suggestions = computed(() => suggestPalettes(props.seed, props.mode, mood.value))
const mutedLine = computed(() => (props.mode === 'dark' ? 'rgb(255 255 255 / 0.22)' : 'rgb(0 0 0 / 0.18)'))

function surprise() {
  emit('apply', randomPalette(props.mode).colors)
}

/** Longest side of the bitmap the swatches are read from, in px. */
const SAMPLE_EDGE = 96

async function readPixels(file: File): Promise<Uint8ClampedArray> {
  const bitmap = await createImageBitmap(file)
  const scale = Math.min(1, SAMPLE_EDGE / Math.max(bitmap.width, bitmap.height))
  const w = Math.max(1, Math.round(bitmap.width * scale))
  const h = Math.max(1, Math.round(bitmap.height * scale))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) throw new Error('no 2d context')
  ctx.drawImage(bitmap, 0, 0, w, h)
  bitmap.close()
  return ctx.getImageData(0, 0, w, h).data
}

async function onImagePicked(event: Event) {
  const input = event.target as HTMLInputElement
  const file = input.files?.[0]
  input.value = ''
  if (!file) return
  imageError.value = null
  try {
    const swatches = extractImageSwatches(await readPixels(file))
    const colors = paletteFromImage(swatches, props.mode, mood.value)
    if (!colors) {
      imageError.value = 'That image has no opaque pixels to sample.'
      return
    }
    if (imageUrl.value) URL.revokeObjectURL(imageUrl.value)
    imageUrl.value = URL.createObjectURL(file)
    imageSwatches.value = swatches
    emit('apply', colors)
  } catch {
    imageError.value = 'Could not read that image.'
  }
}

onBeforeUnmount(() => {
  if (imageUrl.value) URL.revokeObjectURL(imageUrl.value)
})
</script>

<style scoped>
.palette-ideas {
  display: flex;
  flex-direction: column;
  gap: 10px;
}

.pi-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 6px 8px;
}

.pi-title {
  white-space: nowrap;
  font-size: 12px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.02em;
  color: var(--text-secondary);
}

.pi-actions {
  display: flex;
  gap: 6px;
}

.pi-action {
  white-space: nowrap;
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px 9px;
  border-radius: 999px;
  border: 1px solid var(--border-color);
  background: var(--background-tertiary);
  color: var(--text-secondary);
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
  transition: color 0.12s ease, border-color 0.12s ease, background 0.12s ease;
}

.pi-action:hover {
  color: var(--text-primary);
  border-color: var(--harmony-primary);
  background: var(--harmony-primary-alpha, var(--background-quaternary));
}

.pi-file {
  display: none;
}

.pi-moods {
  display: flex;
  gap: 4px;
  padding: 3px;
  border-radius: 8px;
  background: var(--background-tertiary);
  border: 1px solid var(--border-color);
}

.pi-mood {
  flex: 1;
  padding: 5px 0;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--text-tertiary);
  font-size: 11px;
  font-weight: 600;
  cursor: pointer;
}

.pi-mood:hover {
  color: var(--text-primary);
}

.pi-mood.active {
  background: var(--background-quaternary);
  color: var(--text-primary);
  box-shadow: 0 1px 2px rgb(0 0 0 / 0.2);
}

.pi-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 8px;
}

.pi-card {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 4px;
  border: 1px solid var(--border-color);
  border-radius: 8px;
  background: var(--background-tertiary);
  cursor: pointer;
  transition: transform 0.12s ease, border-color 0.12s ease;
}

.pi-card:hover {
  border-color: var(--harmony-primary);
  transform: translateY(-1px);
}

.pi-card:active {
  transform: translateY(0);
}

/* Miniature layout: sidebar column, header bar, two text lines, a button. */
.pi-mock {
  display: flex;
  height: 46px;
  border-radius: 5px;
  overflow: hidden;
}

.pi-mock-rail {
  width: 28%;
}

.pi-mock-body {
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 0 5px 5px;
}

.pi-mock-head {
  height: 8px;
  margin: 0 -5px 1px;
}

.pi-mock-line {
  height: 3px;
  width: 80%;
  border-radius: 2px;
}

.pi-mock-line.short {
  width: 55%;
}

.pi-mock-btn {
  margin-top: auto;
  align-self: flex-end;
  width: 42%;
  height: 8px;
  border-radius: 3px;
}

.pi-card-label {
  font-size: 10px;
  font-weight: 600;
  color: var(--text-secondary);
  text-align: center;
}

.pi-image-row {
  display: flex;
  align-items: center;
  gap: 3px;
  height: 22px;
}

.pi-image-thumb {
  width: 22px;
  height: 22px;
  border-radius: 4px;
  object-fit: cover;
  margin-right: 4px;
}

.pi-image-swatch {
  height: 14px;
  border-radius: 3px;
  min-width: 8px;
}

.pi-error {
  margin: 0;
  font-size: 11px;
  color: var(--error, #ed4245);
}
</style>
