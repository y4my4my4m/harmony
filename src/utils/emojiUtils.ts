import { supabase } from '@/supabase'

/**
 * Get the public URL for an emoji, handling both local and remote emojis
 * Local emojis are processed through Supabase storage with transformation
 * Remote emojis (from federated instances) are returned as-is
 */
export function getEmojiUrl(emojiUrl: string | null | undefined, size: number = 48): string {
    if (!emojiUrl || typeof emojiUrl !== 'string') {
        return '';
    }

    // Static asset emojis (unified emoji pack like Mutant Standard)
    // These are served directly from /assets/, not through Supabase storage
    if (emojiUrl.startsWith('/assets/')) {
        return emojiUrl;
    }

    // Check if this is a remote emoji URL (from another instance)
    // Remote emojis should be returned as-is without local processing
    if (emojiUrl.startsWith('http://') || emojiUrl.startsWith('https://')) {
        // Extract domain from URL
        try {
            const urlObj = new URL(emojiUrl);
            const localSupabaseUrl = new URL(import.meta.env.VITE_SUPABASE_URL);
            
            // Check if this is a local Supabase storage URL (same domain as our instance)
            const pathMatch = emojiUrl.match(/\/storage\/v1\/object\/public\/emojis\/(.+)$/);
            if (pathMatch && urlObj.hostname === localSupabaseUrl.hostname) {
                // This is a LOCAL emoji, process through Supabase storage with transformation
                const emojiPath = pathMatch[1];
                const { data } = supabase.storage
                    .from('emojis')
                    .getPublicUrl(emojiPath, {
                        transform: { width: size, height: size, resize: 'contain', quality: 80 }
                    });
                return data.publicUrl;
            } else {
                // This is a REMOTE emoji URL, return as-is (don't process through local storage)
                return emojiUrl;
            }
        } catch (e) {
            // Invalid URL, return as-is
            return emojiUrl;
        }
    }
    
    // If it's just a path (legacy case), process through local storage
    const { data } = supabase.storage
        .from('emojis')
        .getPublicUrl(emojiUrl, {
            transform: { width: size, height: size, resize: 'contain', quality: 80 }
        });
    return data.publicUrl;
}
