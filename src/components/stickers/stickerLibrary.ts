import type { Sticker } from '@/services/stickerService'

/** How one sticker library writes; the caller binds the scope. */
export interface StickerLibraryAdapter {
  upload(file: File, name: string, description: string, onProgress: (fraction: number) => void): Promise<Sticker>
  update(sticker: Sticker, changes: { name: string; description: string }): Promise<Sticker>
  remove(sticker: Sticker): Promise<void>
}
