// WebFinger endpoint for ActivityPub user discovery
// /.well-known/webfinger

import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

interface WebFingerResponse {
  subject: string
  links: Array<{
    rel: string
    type?: string
    href: string
  }>
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
    const resource = url.searchParams.get('resource')

    if (!resource) {
      return new Response('Missing resource parameter', { 
        status: 400, 
        headers: corsHeaders 
      })
    }

    // Parse resource - should be acct:username@domain
    const match = resource.match(/^acct:([^@]+)@(.+)$/)
    if (!match) {
      return new Response('Invalid resource format', { 
        status: 400, 
        headers: corsHeaders 
      })
    }

    const [, username, domain] = match
    
    // Only handle requests for our domain
    const ourDomain = Deno.env.get('DOMAIN') || 'har.mony.lol'
    if (domain !== ourDomain) {
      return new Response('Not found', { 
        status: 404, 
        headers: corsHeaders 
      })
    }

    // Look up user in database
    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const supabase = createClient(supabaseUrl, supabaseKey)

    const { data: user, error } = await supabase
      .from('profiles')
      .select('username, domain, is_local, display_name, avatar_url, bio')
      .eq('username', username)
      .eq('domain', domain)
      .eq('is_local', true)
      .single()

    if (error || !user) {
      return new Response('User not found', { 
        status: 404, 
        headers: corsHeaders 
      })
    }

    // Build WebFinger response
    const baseUrl = `https://${ourDomain}`
    const avatarBase = 'https://db.mony.lol/storage/v1/object/public/avatars/'
    
    const links = [
      {
        rel: 'self',
        type: 'application/activity+json',
        href: `${baseUrl}/users/${username}`
      },
      {
        rel: 'http://webfinger.net/rel/profile-page',
        type: 'text/html',
        href: `${baseUrl}/users/${username}`
      }
    ]

    // Add avatar link if user has one
    if (user.avatar_url) {
      const fullAvatarUrl = user.avatar_url.startsWith('http') ? user.avatar_url : `${avatarBase}${user.avatar_url}`
      
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
      
      links.push({
        rel: 'http://webfinger.net/rel/avatar',
        type: getMediaType(fullAvatarUrl),
        href: fullAvatarUrl
      })
    }

    const webfingerResponse: WebFingerResponse = {
      subject: resource,
      links
    }

    return new Response(JSON.stringify(webfingerResponse), {
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': 'public, max-age=3600' // Cache for 1 hour
      }
    })

  } catch (error) {
    console.error('WebFinger error:', error)
    return new Response('Internal server error', { 
      status: 500, 
      headers: corsHeaders 
    })
  }
}) 