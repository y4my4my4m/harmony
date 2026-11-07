import { computed, ref } from 'vue'
import type { LightboxItem } from '@/components/common/MediaLightbox.vue'
import { driveViewerItem, type DriveFileSource } from './driveFormat'

/**
 * An image or video file shown in the media viewer (MediaLightbox). The item follows the signed
 * URL cache, so a file opened before its original is signed shows once the signing lands.
 */
export function useDriveLightbox() {
  const shown = ref<{ file: DriveFileSource; name: string } | null>(null)
  const item = computed<LightboxItem | null>(() =>
    shown.value ? driveViewerItem(shown.value.file, shown.value.name) : null)

  function open(file: DriveFileSource, name: string): void {
    if (file.kind === 'image' || file.kind === 'video') shown.value = { file: { ...file }, name }
  }

  function close(): void {
    shown.value = null
  }

  return { shown, item, open, close }
}
