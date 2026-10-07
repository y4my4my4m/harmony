import { useInstanceSettingsStore } from '@/stores/useInstanceSettings'
import { canonicalEmojiSize } from '@/utils/imageTransformUtils'
import { isLocalStorageHostname, publicImageUrl } from '@/utils/storageImageUtils'
import { knownRenderFallback } from '@/utils/renderFallback'

const DEFAULT_EMOJI_TRANSFORM_QUALITY = 80

const DISCORD_CUSTOM_EMOJI_RE = /^discord:[^:]*:(\d+)$/

export function discordCustomEmojiUrlFromIdentifier(
  identifier: string | null | undefined,
): string | null {
  if (!identifier) return null
  const match = DISCORD_CUSTOM_EMOJI_RE.exec(identifier)
  if (!match) return null
  return `https://cdn.discordapp.com/emojis/${match[1]}.png`
}

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
                return knownRenderFallback(publicImageUrl('emojis', emojiPath, {
                    width: optimizedSize, height: optimizedSize, resize: 'contain', quality
                }));
            }
            return emojiUrl;
        } catch (_) {
            return emojiUrl;
        }
    }
    
    // If it's just a path (legacy case), process through local storage
    return knownRenderFallback(publicImageUrl('emojis', emojiUrl, {
        width: canonicalEmojiSize(size), height: canonicalEmojiSize(size), resize: 'contain', quality
    }));
}
