// ActivityPub Actor endpoint for user profiles
// /users/{username}

import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

interface ActivityPubActor {
  '@context': string | string[]
  id: string
  type: 'Person' | 'Service' | 'Group'
  preferredUsername: string
  name?: string
  summary?: string
  icon?: {
    type: 'Image'
    mediaType: string
    url: string
  }
  image?: {
    type: 'Image'
    mediaType: string
    url: string
  }
  inbox: string
  outbox: string
  following: string
  followers: string
  featured?: string
  publicKey: {
    id: string
    owner: string
    publicKeyPem: string
  }
  endpoints?: {
    sharedInbox?: string
  }
  url?: string,
  published?: string
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, OPTIONS',
}

serve(async (req: Request) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  if (req.method !== 'GET') {
    return new Response('Method not allowed', { 
      status: 405, 
      headers: corsHeaders 
    })
  }

  try {
    const url = new URL(req.url)
    
    // Extract username from path - handle both direct and rewritten paths
    let username = ''
    
    // Check if it's a rewritten path from nginx
    const originalUri = req.headers.get('X-Original-URI')
    if (originalUri) {
      const match = originalUri.match(/\/users\/([^/]+)/)
      username = match ? match[1] : ''
    } else {
      // Fallback to direct path parsing
      const pathParts = url.pathname.split('/')
      username = pathParts[pathParts.length - 1]
    }

    if (!username) {
      return new Response('Username required', { 
        status: 400, 
        headers: corsHeaders 
      })
    }

    // Check Accept header for ActivityPub
    const acceptHeader = req.headers.get('Accept') || ''
    const wantsActivityPub = acceptHeader.includes('application/activity+json') || 
                           acceptHeader.includes('application/ld+json')

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const supabaseRemoteUrl = 'https://db.mony.lol'
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const supabase = createClient(supabaseUrl, supabaseKey)

    const ourDomain = Deno.env.get('DOMAIN') || 'har.mony.lol'

    // Look up user in database
    const { data: user, error } = await supabase
      .from('profiles')
      .select('*')
      .eq('username', username)
      .eq('domain', ourDomain)
      .eq('is_local', true)
      .single()

    if (error) {
      console.log('Debug - Database error:', error)
    }

    if (error || !user) {
      return new Response('User not found', { 
        status: 404, 
        headers: corsHeaders 
      })
    }

    // If browser request, redirect to profile page
    if (!wantsActivityPub) {
      return new Response('', {
        status: 302,
        headers: {
          ...corsHeaders,
          'Location': `https://${ourDomain}/social/profile/${username}`
        }
      })
    }

    // Build ActivityPub Actor document
    const baseUrl = `https://${ourDomain}`
    const actorId = `${baseUrl}/users/${username}`
    
    // Helper function to get proper avatar URL
    const getProperAvatarUrl = (avatarUrl: string | null | undefined): string | undefined => {
      if (!avatarUrl || typeof avatarUrl !== 'string') {
        return undefined
      }

      // If it's already a full URL, return as-is
      if (avatarUrl.startsWith('http://') || avatarUrl.startsWith('https://')) {
        return avatarUrl
      }

      // If it's a Supabase storage path, construct proper public URL
      if (avatarUrl.includes('/') && !avatarUrl.startsWith('/')) {
        return `${supabaseRemoteUrl}/storage/v1/object/public/avatars/${avatarUrl}`
      }

      // If it's a local path, convert to full URL
      if (avatarUrl.startsWith('/')) {
        return `${baseUrl}${avatarUrl}`
      }

      return undefined
    }
    
    // Helper function to get media type from file extension
    const getMediaType = (url: string): string => {
      const extension = url.toLowerCase().split('.').pop()
      switch (extension) {
        case 'jpg':
        case 'jpeg':
          return 'image/jpeg'
        case 'png':
          return 'image/png'
        case 'webp':
          return 'image/webp'
        case 'gif':
          return 'image/gif'
        case 'svg':
          return 'image/svg+xml'
        default:
          return 'image/jpeg' // fallback
      }
    }
    
    const avatarUrl = getProperAvatarUrl(user.avatar_url)
    const bannerUrl = getProperAvatarUrl(user.banner_url) // Reuse the same URL processing logic
    
    const actor: ActivityPubActor = {
      '@context': [
        'https://www.w3.org/ns/activitystreams',
        'https://w3id.org/security/v1'
      ],
      id: actorId,
      type: 'Person',
      preferredUsername: user.username,
      name: user.display_name || user.username,
      summary: user.bio || '',
      icon: avatarUrl ? {
        type: 'Image',
        mediaType: getMediaType(avatarUrl),
        url: avatarUrl
      } : undefined,
      image: bannerUrl ? {
        type: 'Image',
        mediaType: getMediaType(bannerUrl),
        url: bannerUrl
      } : undefined,
      inbox: `${actorId}/inbox`,
      outbox: `${actorId}/outbox`,
      following: `${actorId}/following`,
      followers: `${actorId}/followers`,
      featured: `${actorId}/featured`,
      publicKey: {
        id: `${actorId}#main-key`,
        owner: actorId,
        publicKeyPem: user.public_key || ''
      },
      endpoints: {
        sharedInbox: `${baseUrl}/api/activitypub/inbox` // This exists in nginx config
      },
      url: `${baseUrl}/social/profile/${username}`,
      published: user.created_at
    }

    // Remove undefined fields
    const cleanActor = JSON.parse(JSON.stringify(actor))

    return new Response(JSON.stringify(cleanActor, null, 2), {
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/activity+json; charset=utf-8',
        'Cache-Control': 'public, max-age=300' // Cache for 5 minutes
      }
    })

  } catch (error) {
    console.error('Actor endpoint error:', error)
    return new Response('Internal server error', { 
      status: 500, 
      headers: corsHeaders 
    })
  }
}) 