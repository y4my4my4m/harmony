import { supabase } from '@/supabase';

interface EmojiRow {
  id: string;
  created_at: string;
  updated_at?: string;
  name: string;
  url: string;
  uploader: string;
  server_id: string;
  usage_count?: number;
  last_used?: string;
}

/**
 * Gets the proper media type from the file URL
 */
function getMediaTypeFromUrl(url: string): string {
  const extension = url.split('.').pop()?.toLowerCase();
  
  switch (extension) {
    case 'gif':
      return 'image/gif';
    case 'png':
      return 'image/png';
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'webp':
      return 'image/webp';
    case 'svg':
      return 'image/svg+xml';
    default:
      return 'image/png'; // fallback
  }
}

/**
 * Creates an ActivityPub-compatible emoji object
 */
export function createActivityPubEmoji(emoji: EmojiRow, baseUrl: string) {
  return {
    "@context": [
      "https://www.w3.org/ns/activitystreams",
      {
        "toot": "http://joinmastodon.org/ns#",
        "Emoji": "toot:Emoji",
        "focalPoint": {
          "@container": "@list",
          "@id": "toot:focalPoint"
        }
      }
    ],
    "id": `${baseUrl}/emojis/${emoji.id}`,
    "type": "Emoji",
    "name": `:${emoji.name}:`,
    "updated": emoji.updated_at || emoji.created_at,
    "icon": {
      "type": "Image",
      "mediaType": getMediaTypeFromUrl(emoji.url),
      "url": emoji.url
    }
  };
}

/**
 * Fetches an emoji by ID from the database
 */
export async function getEmojiById(id: string): Promise<EmojiRow | null> {
  try {
    const { data, error } = await supabase
      .from('emojis')
      .select('*')
      .eq('id', id)
      .single();

    if (error) {
      console.error('Error fetching emoji:', error);
      return null;
    }

    return data as EmojiRow;
  } catch (error) {
    console.error('Unexpected error fetching emoji:', error);
    return null;
  }
}

/**
 * Handles emoji API requests
 */
export async function handleEmojiRequest(id: string, baseUrl: string) {
  const emoji = await getEmojiById(id);
  
  if (!emoji) {
    return {
      status: 404,
      data: { error: 'Emoji not found' }
    };
  }

  const activityPubEmoji = createActivityPubEmoji(emoji, baseUrl);
  
  return {
    status: 200,
    data: activityPubEmoji
  };
}
