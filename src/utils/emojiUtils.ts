import { supabase } from '@/supabase'

/**
 * uses imgproxy to get the public URL for a server icon
 */
export function getEmojiUrl(emojiUrl: string | null | undefined, size: number = 48): string {
    if (!emojiUrl || typeof emojiUrl !== 'string') {
        return '';
    }
    // if the URL is like 
    //  http(s)://anywebsite:portornoport/storage/v1/object/public/emojis/6acd38e6-5939-41ab-bc60-255cdf4cf97a/2d06f6ba-4c21-4c84-a963-db65148ac543/72e069a4-09df-4cdc-9ed7-796c86850d8f.webp
    // it should be transformed into: 6acd38e6-5939-41ab-bc60-255cdf4cf97a/2d06f6ba-4c21-4c84-a963-db65148ac543/72e069a4-09df-4cdc-9ed7-796c86850d8f.webp
    
    if (emojiUrl.startsWith('http://') || emojiUrl.startsWith('https://')) {
        const pathMatch = emojiUrl.match(/\/storage\/v1\/object\/public\/emojis\/(.+)$/);
        if (pathMatch) {
            emojiUrl = pathMatch[1];
        } else {
            console.warn('Emoji URL does not match expected Supabase storage format:', emojiUrl);
            // return '';
        }
    }
    const { data } = supabase.storage
        .from('emojis')
        .getPublicUrl(emojiUrl, {
            transform: { width: size, height: size, resize: 'contain', quality: 80 }
        })
    return data.publicUrl
}
