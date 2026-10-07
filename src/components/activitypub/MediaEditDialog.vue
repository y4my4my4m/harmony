<!-- MediaEditDialog - One editor per composer attachment: crop, focal point and alt text -->
<template>
  <ImageEditorShell
    :title="t('imageEditor.title.media')"
    :busy="saving"
    wide
    @cancel="emit('cancel')"
    @confirm="save"
  >
    <template v-if="isImage">
      <div v-if="tabs.length > 1" class="media-edit-tabs" role="tablist" :aria-label="t('imageEditor.title.media')">
        <button
          v-for="tab in tabs"
          :id="`${uid}-tab-${tab}`"
          :key="tab"
          type="button"
          role="tab"
          class="media-edit-tab"
          :class="{ active: activeTab === tab }"
          :aria-selected="activeTab === tab"
          :aria-controls="`${uid}-panel-${tab}`"
          :tabindex="activeTab === tab ? 0 : -1"
          :data-testid="`media-edit-tab-${tab}`"
          @click="selectTab(tab)"
          @keydown="onTabKeydown"
        >
          <Icon :name="tab === 'crop' ? 'crop' : 'crosshair'" :size="16" />
          {{ tab === 'crop' ? t('imageEditor.tabCrop') : t('imageEditor.tabFocalPoint') }}
        </button>
      </div>

      <div
        v-if="activeTab === 'crop'"
        :id="`${uid}-panel-crop`"
        class="media-edit-panel"
        role="tabpanel"
        :aria-labelledby="`${uid}-tab-crop`"
      >
        <div v-if="status === 'loading'" class="media-edit-state" role="status">
          <LoadingSpinner :size="24" />
          <span>{{ t('imageEditor.loading') }}</span>
        </div>
        <template v-else-if="status === 'ready' && source">
          <fieldset class="media-edit-aspects">
            <legend class="media-edit-label">{{ t('imageEditor.aspect') }}</legend>
            <label v-for="option in MEDIA_ASPECTS" :key="option.key" class="media-edit-aspect" :class="{ active: aspectKey === option.key }">
              <input
                v-model="aspectKey"
                type="radio"
                :name="`${uid}-aspect`"
                :value="option.key"
                :data-testid="`media-aspect-${option.key}`"
              />
              <span>{{ aspectLabel(option.key) }}</span>
            </label>
          </fieldset>
          <ImageCropper
            ref="cropperRef"
            v-model="crop"
            :source="source"
            :aspect="aspectKey === 'original' ? 'original' : aspectRatio"
            :min-crop-width="MEDIA_MIN_CROP_WIDTH"
            :label="t('imageEditor.cropArea')"
            @confirm="save"
          />
        </template>
      </div>

      <div
        v-else-if="activeTab === 'focus'"
        :id="`${uid}-panel-focus`"
        class="media-edit-panel"
        role="tabpanel"
        :aria-labelledby="tabs.length > 1 ? `${uid}-tab-focus` : undefined"
        :aria-label="tabs.length > 1 ? undefined : t('imageEditor.tabFocalPoint')"
      >
        <p v-if="animated" class="media-edit-note" data-testid="media-animated-note">
          <Icon name="info" :size="16" />
          <span>{{ t('imageEditor.animatedMediaNote') }}</span>
        </p>
        <FocalPointPicker
          v-if="focalSrc"
          ref="focalRef"
          v-model="focus"
          :src="focalSrc"
          :aspect="focalAspect"
        />
        <div v-else class="media-edit-state" role="status">
          <LoadingSpinner :size="24" />
        </div>
      </div>
    </template>

    <div class="media-edit-alt">
      <label :for="`${uid}-alt`" class="media-edit-label">{{ t('activitypub.altTextLabel') }}</label>
      <textarea
        :id="`${uid}-alt`"
        ref="altRef"
        v-model="description"
        class="media-edit-alt-input"
        rows="3"
        :maxlength="ALT_TEXT_MAX"
        :placeholder="t('activitypub.altTextPlaceholder')"
        :aria-describedby="`${uid}-alt-count`"
        data-testid="media-alt-input"
      />
      <span :id="`${uid}-alt-count`" class="media-edit-count">{{ description.length }} / {{ ALT_TEXT_MAX }}</span>
    </div>

    <p v-if="exportFailed" class="media-edit-note media-edit-note--error" role="alert">
      <Icon name="alert-circle" :size="16" />
      <span>{{ t('imageEditor.exportFailed') }}</span>
    </p>

    <template #footer>
      <button type="button" class="btn btn-ghost" :disabled="saving" @click="emit('cancel')">
        {{ t('common.cancel') }}
      </button>
      <button type="button" class="btn btn-primary" data-testid="media-edit-save" :disabled="saving" @click="save">
        <Icon v-if="saving" name="spinner" :size="16" class="spin" />
        {{ t('common.save') }}
      </button>
    </template>
  </ImageEditorShell>
</template>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { useI18n } from 'vue-i18n'
import Icon from '@/components/common/Icon.vue'
import LoadingSpinner from '@/components/common/LoadingSpinner.vue'
import ImageCropper from '@/components/common/ImageCropper.vue'
import FocalPointPicker from '@/components/common/FocalPointPicker.vue'
import ImageEditorShell from '@/components/common/ImageEditorShell.vue'
import { initialCrop, isIdentityCrop, remapCropUnits, type CropState } from '@/utils/cropGeometry'
import { attachmentFocus, clampFocus, focusFromNormalized, focusToNormalized, isCentredFocus, type Focus } from '@/utils/focalPoint'
import { exportCrop, inspectImageFile, loadCropSource, renderCropPreview, type CropSource } from '@/utils/imageCrop'
import {
  MEDIA_ASPECTS,
  MEDIA_MIN_CROP_WIDTH,
  mediaAspectRatio,
  type EditableMedia,
  type MediaAspectKey,
  type MediaCrop,
  type MediaEdit,
} from '@/utils/mediaEdit'

// Mastodon's media description limit.
const ALT_TEXT_MAX = 1500

type Tab = 'crop' | 'focus'

interface Props {
  attachment: EditableMedia
  /** 'alt' opens on the first tab with the description field focused. */
  initialFocus?: Tab | 'alt'
}

const props = withDefaults(defineProps<Props>(), { initialFocus: 'crop' })

const emit = defineEmits<{
  save: [edit: MediaEdit]
  cancel: []
}>()

const { t } = useI18n()

const uid = `media-edit-${Math.random().toString(36).slice(2, 8)}`
const isImage = computed(() => props.attachment.type === 'image')
/** The file crops start from: the picked file, never an earlier crop. */
const originalFile = computed(() => props.attachment.originalFile ?? props.attachment.file ?? null)

const status = ref<'loading' | 'ready' | 'unavailable'>('loading')
const animated = ref(false)
const source = shallowRef<CropSource | null>(null)
const crop = ref<CropState>({ rotation: 0, zoom: 1, cx: 0, cy: 0 })
const aspectKey = ref<MediaAspectKey>(props.attachment.crop?.aspect ?? 'original')
const focus = ref<Focus>(props.attachment.focus ?? attachmentFocus(props.attachment) ?? { x: 0, y: 0 })
const description = ref(props.attachment.description ?? '')
const saving = ref(false)
const exportFailed = ref(false)
const previewUrl = ref<string | null>(null)
const cropperRef = ref<InstanceType<typeof ImageCropper> | null>(null)
const focalRef = ref<InstanceType<typeof FocalPointPicker> | null>(null)
const altRef = ref<HTMLTextAreaElement | null>(null)

/** Set once the loaded crop is in place; the placeholder crop before it maps no point. */
let tracking = false

function aspectLabel(key: MediaAspectKey): string {
  if (key === 'original') return t('imageEditor.aspectOriginal')
  if (key === 'square') return t('imageEditor.aspectSquare')
  return key
}

const canCrop = computed(() => status.value === 'ready' && !!source.value)
const tabs = computed<Tab[]>(() => (canCrop.value || status.value === 'loading' ? ['crop', 'focus'] : ['focus']))
const activeTab = ref<Tab>(props.initialFocus === 'focus' ? 'focus' : 'crop')

const size = computed(() => ({ width: source.value?.width ?? 1, height: source.value?.height ?? 1 }))
const aspectRatio = computed(() => mediaAspectRatio(aspectKey.value, size.value, crop.value.rotation))

/** Image shown by the focal point picker: the crop as it will upload, or the attachment itself. */
const focalSrc = computed(() =>
  canCrop.value ? previewUrl.value : props.attachment.preview_url || props.attachment.url || null,
)
const focalAspect = computed(() => (canCrop.value ? aspectRatio.value : 1))

function revokePreview() {
  if (previewUrl.value) URL.revokeObjectURL(previewUrl.value)
  previewUrl.value = null
}

async function refreshPreview() {
  if (!source.value) return
  const blob = await renderCropPreview(source.value, crop.value, aspectRatio.value).catch(() => null)
  revokePreview()
  if (blob) previewUrl.value = URL.createObjectURL(blob)
}

async function load() {
  const file = originalFile.value
  if (!isImage.value || !file) {
    status.value = 'unavailable'
    activeTab.value = 'focus'
    return
  }
  const info = await inspectImageFile(file)
  if (info.animated) {
    animated.value = true
    status.value = 'unavailable'
    activeTab.value = 'focus'
    return
  }
  const loaded = await loadCropSource(file).catch(() => null)
  if (!loaded) {
    status.value = 'unavailable'
    activeTab.value = 'focus'
    return
  }
  source.value = loaded
  const saved = props.attachment.crop
  crop.value = saved?.state ?? initialCrop({ width: loaded.width, height: loaded.height })
  status.value = 'ready'
  await nextTick()
  tracking = true
  if (activeTab.value === 'focus') await refreshPreview()
}

// The focus is a point on the cropped image; a new crop keeps it on the same source pixel.
watch([crop, aspectRatio], ([next, nextAspect], [prev, prevAspect]) => {
  if (!tracking || isCentredFocus(focus.value)) return
  const moved = remapCropUnits(
    focusToNormalized(focus.value),
    size.value,
    { state: prev, aspect: prevAspect },
    { state: next, aspect: nextAspect },
  )
  focus.value = focusFromNormalized(moved)
})

async function selectTab(tab: Tab) {
  activeTab.value = tab
  if (tab === 'focus' && canCrop.value) await refreshPreview()
  await nextTick()
  if (tab === 'crop') cropperRef.value?.focus()
  else focalRef.value?.focus()
}

function onTabKeydown(event: KeyboardEvent) {
  if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return
  event.preventDefault()
  const list = tabs.value
  const index = list.indexOf(activeTab.value)
  const next = list[(index + (event.key === 'ArrowRight' ? 1 : list.length - 1)) % list.length]
  document.getElementById(`${uid}-tab-${next}`)?.focus()
  void selectTab(next)
}

function sameCrop(a: MediaCrop | null | undefined, b: MediaCrop): boolean {
  if (!a || a.aspect !== b.aspect) return false
  const s = a.state
  const u = b.state
  return s.rotation === u.rotation && Math.abs(s.zoom - u.zoom) < 1e-6 && Math.abs(s.cx - u.cx) < 1e-3 && Math.abs(s.cy - u.cy) < 1e-3
}

async function save() {
  if (saving.value) return
  exportFailed.value = false
  const edit: MediaEdit = {
    description: description.value.trim(),
    focus: isImage.value && !isCentredFocus(focus.value) ? clampFocus(focus.value) : null,
  }
  const original = originalFile.value
  if (canCrop.value && source.value && original) {
    const next: MediaCrop = { state: { ...crop.value }, aspect: aspectKey.value }
    if (isIdentityCrop(next.state, size.value, aspectRatio.value)) {
      if (props.attachment.file !== original) edit.file = original
      edit.crop = null
    } else if (!sameCrop(props.attachment.crop, next) || props.attachment.file === original) {
      saving.value = true
      try {
        const out = await exportCrop(source.value, next.state, aspectRatio.value, null, original.name)
        if (!out) {
          exportFailed.value = true
          return
        }
        edit.file = out
        edit.originalFile = original
        edit.crop = next
      } catch {
        exportFailed.value = true
        return
      } finally {
        saving.value = false
      }
    }
  }
  emit('save', edit)
}

onMounted(async () => {
  await load()
  await nextTick()
  if (props.initialFocus === 'alt' || !isImage.value) altRef.value?.focus()
  else if (activeTab.value === 'crop') cropperRef.value?.focus()
  else focalRef.value?.focus()
})

onBeforeUnmount(() => {
  source.value?.close()
  revokePreview()
})
</script>

<style scoped>
.media-edit-tabs {
  display: flex;
  gap: var(--space-1);
  margin-bottom: var(--space-3);
  padding: 3px;
  border-radius: var(--radius-md);
  background: var(--background-tertiary);
}

.media-edit-tab {
  flex: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-2);
  min-height: 34px;
  padding: 0 var(--space-3);
  border: none;
  border-radius: var(--radius-base);
  background: transparent;
  color: var(--text-secondary);
  font: inherit;
  font-size: var(--font-size-sm);
  font-weight: var(--font-weight-medium);
  cursor: pointer;
  transition: background-color var(--transition-fast), color var(--transition-fast);
}

.media-edit-tab:hover {
  color: var(--text-primary);
}

.media-edit-tab.active {
  background: var(--background-quinary);
  color: var(--text-primary);
  box-shadow: var(--shadow-small);
}

.media-edit-tab:focus-visible {
  outline: 2px solid var(--harmony-primary);
  outline-offset: 1px;
}

.media-edit-panel {
  display: flex;
  flex-direction: column;
  gap: var(--space-3);
}

.media-edit-state {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--space-3);
  min-height: 220px;
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
}

.media-edit-label {
  display: block;
  margin-bottom: var(--space-2);
  padding: 0;
  color: var(--text-secondary);
  font-size: var(--font-size-xs);
  font-weight: var(--font-weight-semibold);
}

.media-edit-aspects {
  display: flex;
  flex-wrap: wrap;
  gap: var(--space-2);
  margin: 0;
  padding: 0;
  border: none;
}

.media-edit-aspects legend {
  width: 100%;
}

.media-edit-aspect {
  position: relative;
  display: inline-flex;
  align-items: center;
  min-height: 32px;
  padding: 0 var(--space-3);
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-full);
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
  cursor: pointer;
  transition: background-color var(--transition-fast), border-color var(--transition-fast), color var(--transition-fast);
}

.media-edit-aspect:hover {
  border-color: var(--border-hover);
  color: var(--text-primary);
}

.media-edit-aspect.active {
  border-color: var(--harmony-primary);
  background: color-mix(in srgb, var(--harmony-primary) 14%, transparent);
  color: var(--text-primary);
}

.media-edit-aspect input {
  position: absolute;
  inset: 0;
  margin: 0;
  opacity: 0;
  cursor: pointer;
}

.media-edit-aspect:has(input:focus-visible) {
  outline: 2px solid var(--harmony-primary);
  outline-offset: 2px;
}

.media-edit-alt {
  display: flex;
  flex-direction: column;
  margin-top: var(--space-4);
}

.media-edit-alt-input {
  width: 100%;
  min-height: 72px;
  padding: var(--space-2) var(--space-3);
  border: 1px solid var(--border-primary);
  border-radius: var(--radius-md);
  background: var(--input-bg);
  color: var(--text-primary);
  font: inherit;
  font-size: var(--font-size-sm);
  line-height: var(--line-height-normal);
  resize: vertical;
}

.media-edit-alt-input:focus {
  outline: none;
  border-color: var(--harmony-primary);
}

.media-edit-count {
  align-self: flex-end;
  margin-top: var(--space-1);
  color: var(--text-muted);
  font-size: var(--font-size-xs);
  font-variant-numeric: tabular-nums;
}

.media-edit-note {
  display: flex;
  align-items: flex-start;
  gap: var(--space-2);
  margin: 0;
  padding: var(--space-2) var(--space-3);
  border-radius: var(--radius-md);
  background: var(--background-modifier-hover);
  color: var(--text-secondary);
  font-size: var(--font-size-sm);
  line-height: var(--line-height-normal);
}

.media-edit-note--error {
  margin-top: var(--space-3);
  background: color-mix(in srgb, var(--error) 12%, transparent);
  color: var(--text-primary);
}

.spin {
  animation: media-edit-spin 1s linear infinite;
}

@keyframes media-edit-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
