import { supabase } from '@/supabase'
import { useInstanceSettingsStore } from '@/stores/useInstanceSettings'

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

/** Hostnames that serve our local Supabase storage (for transforms). Set via VITE_STORAGE_DOMAIN (comma-separated). */
function getLocalStorageHostnames(): Set<string> {
    const out = new Set<string>();
    try {
        const supabaseUrl = import.meta.env.VITE_SUPABASE_URL;
        if (supabaseUrl) {
            out.add(new URL(supabaseUrl).hostname);
        }
        const storageDomain = import.meta.env.VITE_STORAGE_DOMAIN as string | undefined;
        if (storageDomain) {
            storageDomain.split(',').map((h: string) => h.trim()).filter(Boolean).forEach((h: string) => out.add(h));
        }
    } catch {
      /* ignore invalid env URLs */
    }
    return out;
}

const LOCAL_STORAGE_HOSTNAMES = getLocalStorageHostnames();

/**
 * Get the public URL for an emoji, handling both local and remote emojis.
 * Local emojis are processed through Supabase storage with imgproxy transform (resize, quality from instance config, default 100).
 * Remote emojis (from federated instances) are returned as-is.
 */
export function getEmojiUrl(emojiUrl: string | null | undefined, size: number = 48): string {
    if (!emojiUrl || typeof emojiUrl !== 'string') {
        return '';
    }

    // Static asset emojis (unified emoji pack like Mutant Standard)
    if (emojiUrl.startsWith('/assets/')) {
        return emojiUrl;
    }

    const quality = getEmojiTransformQuality()

    if (emojiUrl.startsWith('http://') || emojiUrl.startsWith('https://')) {
        try {
            const urlObj = new URL(emojiUrl);
            const pathMatch = emojiUrl.match(/\/storage\/v1\/object\/public\/emojis\/(.+)$/);
            const isLocalStorage = LOCAL_STORAGE_HOSTNAMES.has(urlObj.hostname);

            if (pathMatch && isLocalStorage) {
                const emojiPath = pathMatch[1];
                const optimizedSize = Math.min(size, 128);
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
            transform: { width: size, height: size, resize: 'contain', quality }
        });
    return data.publicUrl;
}
