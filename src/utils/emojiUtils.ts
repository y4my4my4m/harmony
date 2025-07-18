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

    // Check if this is a remote emoji URL (from another instance)
    // Remote emojis should be returned as-is without local processing
    if (emojiUrl.startsWith('http://') || emojiUrl.startsWith('https://')) {
        // Check if this is a local Supabase storage URL
        const pathMatch = emojiUrl.match(/\/storage\/v1\/object\/public\/emojis\/(.+)$/);
        if (pathMatch) {
            // This is a local emoji, process through Supabase storage with transformation
            const emojiPath = pathMatch[1];
            const { data } = supabase.storage
                .from('emojis')
                .getPublicUrl(emojiPath, {
                    transform: { width: size, height: size, resize: 'contain', quality: 80 }
                });
            return data.publicUrl;
        } else {
            // This is a remote emoji URL, return as-is
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
