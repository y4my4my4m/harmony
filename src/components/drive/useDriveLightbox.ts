import { computed, ref } from 'vue'
import { driveLightboxItem, type DriveFileSource, type DriveLightboxItem } from './driveFormat'

/**
 * A Drive file shown in the app lightbox (MediaLightbox). The item follows the signed URL
 * cache, so a file opened before its original is signed shows once the signing lands.
 */
export function useDriveLightbox() {
  const shown = ref<{ file: DriveFileSource; alt: string } | null>(null)
  const item = computed<DriveLightboxItem | null>(() =>
    shown.value ? driveLightboxItem(shown.value.file, shown.value.alt) : null)

  function open(file: DriveFileSource, alt: string): void {
    if (file.kind === 'image' || file.kind === 'video') shown.value = { file: { ...file }, alt }
  }

  function close(): void {
    shown.value = null
  }

  return { shown, item, open, close }
}
