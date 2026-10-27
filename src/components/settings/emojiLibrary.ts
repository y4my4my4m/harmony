import { MAX_IMAGE_SOURCE_BYTES } from '@/utils/imageResize'

/** An emoji library row: a server emoji or a personal one. */
export interface LibraryEmoji {
  id: string
  name: string
  url: string | null
  file_size?: number | null
  created_at?: string | Date | null
  usage_count?: number | null
  is_ai_generated?: boolean
}

export type EmojiLibraryOperation = 'upload' | 'rename' | 'delete'

/** The operations behind one emoji library: a server's, or the caller's personal one. */
export interface EmojiUploadProgress {
  /** Fraction of the image sent, 0 to 1. */
  onProgress?: (fraction: number) => void
}

export interface EmojiLibraryAdapter<E extends LibraryEmoji = LibraryEmoji> {
  /** The created emoji; null for a refusal without a reason. Throws UploadRejectedError with a user-facing message. */
  upload(file: File, options?: EmojiUploadProgress): Promise<E | null>
  rename(emoji: E, name: string): Promise<void>
  remove(emoji: E): Promise<void>
  removeMany(emojis: E[]): Promise<{ success: string[]; failed: string[] }>
  /** User-facing text for a failure; null keeps the operation's generic message. */
  describeError?(operation: EmojiLibraryOperation, error: unknown): string | null
}

/** Context strings; everything else in the library is shared. */
export interface EmojiLibraryTexts {
  title: string
  empty: string
  emptyHint?: string
  confirmDelete: (name: string) => string
}

/** rename_my_emoji's name rule; a subset of EMOJI_SHORTCODE_INNER. */
export const EMOJI_NAME = /^[A-Za-z0-9_-]{2,64}$/

/** Files of a multi-file pick worth uploading; SVG is refused, it carries scriptable markup. */
export function emojiUploadCandidates(files: File[]): { files: File[]; notImage: string[]; tooLarge: string[] } {
  const accepted: File[] = []
  const notImage: string[] = []
  const tooLarge: string[] = []
  for (const file of files) {
    if (!file.type.startsWith('image/') || file.type === 'image/svg+xml') notImage.push(file.name)
    else if (file.size > MAX_IMAGE_SOURCE_BYTES) tooLarge.push(file.name)
    else accepted.push(file)
  }
  return { files: accepted, notImage, tooLarge }
}

/** max null: no limit. */
export function hasRoomFor(held: number, adding: number, max: number | null): boolean {
  return max === null || held + adding <= max
}

export function formatEmojiFileSize(bytes: number): string {
  if (bytes <= 0) return '0 B'
  const units = ['B', 'KB', 'MB']
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  return `${parseFloat((bytes / 1024 ** i).toFixed(1))} ${units[i]}`
}
