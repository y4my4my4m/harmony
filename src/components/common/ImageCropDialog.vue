<!-- ImageCropDialog - Crop step for avatars, banners and icons; animated images pass through uncropped -->
<template>
  <ImageEditorShell
    :title="t(`imageEditor.title.${kind}`)"
    :busy="status === 'loading' || exporting"
    @cancel="emit('cancel')"
    @confirm="apply"
  >
    <div v-if="status === 'loading'" class="crop-dialog-state" role="status">
      <LoadingSpinner :size="24" />
      <span>{{ t('imageEditor.loading') }}</span>
    </div>

    <ImageCropper
      v-else-if="status === 'ready' && source"
      ref="cropperRef"
      v-model="crop"
      :source="source"
      :aspect="preset.aspect"
      :shape="preset.shape"
      :radius="preset.radius"
      :min-crop-width="preset.minCropWidth"
      :label="t('imageEditor.cropArea')"
      @confirm="apply"
    />

    <div v-else-if="status === 'animated'" class="crop-dialog-animated">
      <div class="crop-dialog-animated-stage">
        <div
          class="crop-dialog-animated-frame"
          :style="{ '--frame-aspect': String(preset.aspect), borderRadius: frameRadius }"
        >
          <img :src="objectUrl ?? undefined" alt="" draggable="false" />
        </div>
      </div>
      <p class="crop-dialog-note" data-testid="crop-animated-note">
        <Icon name="info" :size="16" />
        <span>{{ t('imageEditor.animatedNote') }}</span>
      </p>
    </div>

    <p v-else class="crop-dialog-note crop-dialog-note--error" role="alert">
      <Icon name="alert-circle" :size="16" />
      <span>{{ t('imageEditor.decodeFailed') }}</span>
    </p>

    <p v-if="exportFailed" class="crop-dialog-note crop-dialog-note--error" role="alert">
      <Icon name="alert-circle" :size="16" />
      <span>{{ t('imageEditor.exportFailed') }}</span>
    </p>

    <template #footer>
      <button type="button" class="btn btn-ghost" :disabled="exporting" @click="emit('cancel')">
        {{ t('common.cancel') }}
      </button>
      <button
        v-if="status === 'error' || exportFailed"
        type="button"
        class="btn btn-secondary"
        :disabled="exporting"
        @click="emit('confirm', file)"
      >
        {{ t('imageEditor.useOriginal') }}
      </button>
      <button
        type="button"
        class="btn btn-primary"
        data-testid="crop-apply"
        :disabled="status === 'loading' || status === 'error' || exporting"
        @click="apply"
      >
        <Icon v-if="exporting" name="spinner" :size="16" class="spin" />
        {{ t('imageEditor.apply') }}
      </button>
    </template>
  </ImageEditorShell>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import Icon from '@/components/common/Icon.vue'
import LoadingSpinner from '@/components/common/LoadingSpinner.vue'
import ImageCropper from '@/components/common/ImageCropper.vue'
import ImageEditorShell from '@/components/common/ImageEditorShell.vue'
import { initialCrop, type CropState } from '@/utils/cropGeometry'
import {
  CROP_PRESETS,
  exportCrop,
  inspectImageFile,
  loadCropSource,
  type CropPresetKind,
  type CropSource,
} from '@/utils/imageCrop'

interface Props {
  file: File
  kind: CropPresetKind
}

const props = defineProps<Props>()

const emit = defineEmits<{
  confirm: [file: File]
  cancel: []
}>()

const { t } = useI18n()

type Status = 'loading' | 'ready' | 'animated' | 'error'

const status = ref<Status>('loading')
const source = shallowRef<CropSource | null>(null)
const crop = ref<CropState>({ rotation: 0, zoom: 1, cx: 0, cy: 0 })
const objectUrl = ref<string | null>(null)
const exporting = ref(false)
const exportFailed = ref(false)
const cropperRef = ref<InstanceType<typeof ImageCropper> | null>(null)

const preset = computed(() => CROP_PRESETS[props.kind])

// 'circle' and 'rounded' presets are square, so one percentage serves both axes.
const frameRadius = computed(() => {
  if (preset.value.shape === 'circle') return '50%'
  if (preset.value.shape === 'rounded') return `${(preset.value.radius ?? 0) * 100}%`
  return '0'
})

function release() {
  source.value?.close()
  source.value = null
  if (objectUrl.value) URL.revokeObjectURL(objectUrl.value)
  objectUrl.value = null
}

let loadToken = 0

async function load(file: File) {
  const token = ++loadToken
  release()
  status.value = 'loading'
  exportFailed.value = false
  const info = await inspectImageFile(file)
  if (token !== loadToken) return
  if (info.animated) {
    objectUrl.value = URL.createObjectURL(file)
    status.value = 'animated'
    return
  }
  const loaded = await loadCropSource(file).catch(() => null)
  if (token !== loadToken) {
    loaded?.close()
    return
  }
  if (!loaded) {
    status.value = 'error'
    return
  }
  source.value = loaded
  crop.value = initialCrop({ width: loaded.width, height: loaded.height })
  status.value = 'ready'
  await nextTick()
  cropperRef.value?.focus()
}

async function apply() {
  if (exporting.value) return
  if (status.value === 'animated') {
    emit('confirm', props.file)
    return
  }
  if (status.value !== 'ready' || !source.value) return
  exporting.value = true
  exportFailed.value = false
  try {
    const out = await exportCrop(source.value, crop.value, preset.value.aspect, preset.value.output, props.file.name)
    if (out) emit('confirm', out)
    else exportFailed.value = true
  } catch {
    exportFailed.value = true
  } finally {
    exporting.value = false
  }
}

watch(() => props.file, load, { immediate: true })

onBeforeUnmount(() => {
  loadToken++
  release()
})
</script>

<style scoped>
.crop-dialog-state {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-3);
  min-height: 240px;
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
}

.crop-dialog-animated {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.crop-dialog-animated-stage {
  display: flex;
  align-items: center;
  justify-content: center;
  height: clamp(220px, 46vh, 360px);
  padding: var(--space-4);
  border-radius: var(--radius-md);
  background: var(--background-tertiary);
}

/* Fits the frame aspect inside the stage less its padding, as ImageCropper does. */
.crop-dialog-animated-frame {
  width: min(100%, calc((clamp(220px, 46vh, 360px) - 2 * var(--space-4)) * var(--frame-aspect)));
  aspect-ratio: var(--frame-aspect);
  overflow: hidden;
  outline: 1.5px solid rgba(255, 255, 255, 0.9);
  background: var(--background-quaternary);
}

.crop-dialog-animated-frame img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}

.crop-dialog-note {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  margin: var(--space-3) 0 0;
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-md);
  background: var(--background-modifier-hover);
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
  line-height: var(--line-height-normal);
}

.crop-dialog-note :deep(.icon-wrap) {
  margin-top: 2px;
  flex-shrink: 0;
}

.crop-dialog-note--error {
  background: color-mix(in srgb, var(--error) 12%, transparent);
  color: var(--text-primary);
}

.spin {
  animation: crop-dialog-spin 1s linear infinite;
}

@keyframes crop-dialog-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
