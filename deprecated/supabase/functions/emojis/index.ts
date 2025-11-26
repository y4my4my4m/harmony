// Emoji endpoint for ActivityPub emoji discovery
// /emojis/{id}

import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
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
function createActivityPubEmoji(emoji: any, baseUrl: string) {
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

serve(async (req: Request) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  if (req.method !== 'GET') {
    return new Response('Method not allowed', { 
      status: 405, 
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }

  try {
    const url = new URL(req.url)
    
    // Try to get emoji ID from nginx header first
    const emojiId = req.headers.get('X-Emoji-ID') || 
                   // Fallback: look for UUID pattern in the path
                   (() => {
                     const pathParts = url.pathname.split('/')
                     const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
                     return pathParts.find(part => uuidPattern.test(part)) || pathParts[pathParts.length - 1]
                   })()

    console.log(`Full URL: ${req.url}`)
    console.log(`Pathname: ${url.pathname}`)
    console.log(`X-Emoji-ID header: ${req.headers.get('X-Emoji-ID')}`)
    console.log(`Handling emoji request for ID: ${emojiId}`)

    if (!emojiId) {
      return new Response(JSON.stringify({ error: 'Emoji ID required' }), {
        status: 400,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    // Create Supabase client
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const supabase = createClient(supabaseUrl, supabaseKey)

    // Fetch emoji from database
    const { data: emoji, error } = await supabase
      .from('emojis')
      .select('*')
      .eq('id', emojiId)
      .single()

    if (error || !emoji) {
      return new Response(JSON.stringify({ error: 'Emoji not found' }), {
        status: 404,
        headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      })
    }

    // Create ActivityPub emoji response
    const baseUrl = `${url.protocol}//${url.host}`
    const activityPubEmoji = createActivityPubEmoji(emoji, baseUrl)

    return new Response(JSON.stringify(activityPubEmoji, null, 2), {
      status: 200,
      headers: { 
        ...corsHeaders, 
        'Content-Type': 'application/activity+json; charset=utf-8' 
      }
    })

  } catch (error) {
    console.error('Error handling emoji request:', error)
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    })
  }
})
