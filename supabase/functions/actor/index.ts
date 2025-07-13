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
  url?: string
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
      icon: user.avatar_url ? {
        type: 'Image',
        mediaType: 'image/jpeg',
        url: user.avatar_url.startsWith('http') ? user.avatar_url : `${baseUrl}${user.avatar_url}`
      } : undefined,
      inbox: `${actorId}/inbox`,
      outbox: `${actorId}/outbox`, // TODO: Implement outbox endpoint
      following: `${actorId}/following`, // TODO: Implement following endpoint  
      followers: `${actorId}/followers`, // TODO: Implement followers endpoint
      featured: `${actorId}/featured`, // TODO: Implement featured endpoint
      publicKey: {
        id: `${actorId}#main-key`,
        owner: actorId,
        publicKeyPem: user.public_key || ''
      },
      endpoints: {
        sharedInbox: `${baseUrl}/api/activitypub/inbox` // This exists in nginx config
      },
      url: `${baseUrl}/social/profile/${username}`
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