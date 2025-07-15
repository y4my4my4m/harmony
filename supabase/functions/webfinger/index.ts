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
    const supabaseRemoteUrl = 'https://db.mony.lol'

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
    const avatarUrl = getProperAvatarUrl(user.avatar_url)
    if (avatarUrl) {
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
        type: getMediaType(avatarUrl),
        href: avatarUrl
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