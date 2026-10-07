import { computed, shallowRef } from 'vue'
import type { CropPresetKind } from '@/utils/imageCrop'

interface CropRequest {
  id: number
  file: File
  kind: CropPresetKind
  resolve: (file: File | null) => void
}

let nextId = 0
const pending = shallowRef<CropRequest | null>(null)
const cropRequest = computed(() => pending.value)

/**
 * Promise-based crop step for avatar, banner and icon uploads: `cropImage`
 * resolves with the file to upload, or null on cancel. One request is
 * pending at a time; a new request cancels the one in flight.
 */
export function useImageCrop() {
  function cropImage(file: File, kind: CropPresetKind): Promise<File | null> {
    pending.value?.resolve(null)
    return new Promise<File | null>((resolve) => {
      pending.value = { id: ++nextId, file, kind, resolve }
    })
  }

  function settle(file: File | null) {
    const request = pending.value
    pending.value = null
    request?.resolve(file)
  }

  return {
    cropImage,
    cropRequest,
    settle,
  }
}
