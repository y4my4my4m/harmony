import { supabase } from '@/supabase'
import { useInstanceSettingsStore } from '@/stores/useInstanceSettings'
import { canonicalEmojiSize } from '@/utils/imageTransformUtils'
import { isLocalStorageHostname } from '@/utils/storageImageUtils'

const DEFAULT_EMOJI_TRANSFORM_QUALITY = 80

function getEmojiTransformQuality(): number {
  try {
    const store = useInstanceSettingsStore()
    const q = store.settings.customEmojiTransformQuality
    if (typeof q === 'number' && !Number.isNaN(q)) {
      return Math.min(100, Math.max(1, Math.round(q)))
    }
  } catch {
    /* Pinia not active yet */
  }
  return DEFAULT_EMOJI_TRANSFORM_QUALITY
}

/**
 * Get the public URL for an emoji, handling both local and remote emojis.
 * Local emojis are processed through Supabase storage with imgproxy transform (resize, quality from instance config, default 100).
 * Remote emojis (from federated instances) are returned as-is.
 */
export function getEmojiUrl(emojiUrl: string | null | undefined, size: number = 48): string {
    if (!emojiUrl || typeof emojiUrl !== 'string') {
        return '';
    }

    // Static asset emojis (unified emoji pack, e.g. twemoji SVGs)
    if (emojiUrl.startsWith('/assets/')) {
        return emojiUrl;
    }

    const quality = getEmojiTransformQuality()

    if (emojiUrl.startsWith('http://') || emojiUrl.startsWith('https://')) {
        try {
            const urlObj = new URL(emojiUrl);
            const pathMatch = emojiUrl.match(/\/storage\/v1\/object\/public\/emojis\/(.+)$/);
            const isLocalStorage = isLocalStorageHostname(urlObj.hostname);

            if (pathMatch && isLocalStorage) {
                const emojiPath = pathMatch[1];
                const optimizedSize = canonicalEmojiSize(size);
                const { data } = supabase.storage
                    .from('emojis')
                    .getPublicUrl(emojiPath, {
                        transform: { width: optimizedSize, height: optimizedSize, resize: 'contain', quality }
                    });
                return data.publicUrl;
            }
            return emojiUrl;
        } catch (_) {
            return emojiUrl;
        }
    }
    
    // If it's just a path (legacy case), process through local storage
    const { data } = supabase.storage
        .from('emojis')
        .getPublicUrl(emojiUrl, {
            transform: { width: canonicalEmojiSize(size), height: canonicalEmojiSize(size), resize: 'contain', quality }
        });
    return data.publicUrl;
}
