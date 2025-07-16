// ActivityPub Following endpoint 
// /users/{username}/following

import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

interface ActivityPubFollowing {
  '@context': string | string[]
  id: string
  type: 'OrderedCollection'
  totalItems: number
  first?: string
  last?: string
  orderedItems?: string[]
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
    
    // Extract username from query parameter (passed by nginx rewrite)
    const username = url.searchParams.get('username')

    if (!username) {
      return new Response('Username required', { 
        status: 400, 
        headers: corsHeaders 
      })
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!
    const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
    const supabase = createClient(supabaseUrl, supabaseKey)
    const ourDomain = Deno.env.get('DOMAIN') || 'har.mony.lol'
    const baseUrl = `https://${ourDomain}`

    // Look up user
    const { data: user, error: userError } = await supabase
      .from('profiles')
      .select('id, username, domain')
      .eq('username', username)
      .eq('domain', ourDomain)
      .eq('is_local', true)
      .single()

    if (userError || !user) {
      return new Response('User not found', { 
        status: 404, 
        headers: corsHeaders 
      })
    }

    // Check privacy settings
    const { data: profile } = await supabase
      .from('profiles')
      .select('privacy_settings')
      .eq('id', user.id)
      .single()

    // Check if following should be hidden
    if (profile?.privacy_settings?.hide_following) {
      return new Response(JSON.stringify({
        '@context': 'https://www.w3.org/ns/activitystreams',
        id: `${baseUrl}/users/${username}/following`,
        type: 'OrderedCollection',
        totalItems: 0,
        orderedItems: []
      }), {
        status: 200,
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/activity+json; charset=utf-8',
          'Cache-Control': 'public, max-age=300'
        }
      })
    }

    const followingId = `${baseUrl}/users/${username}/following`

    // Check if requesting paginated results
    const page = url.searchParams.get('page')
    
    if (page) {
      // Return paginated following
      const limit = 20
      const offset = (parseInt(page) - 1) * limit

      const { data: follows, error: followsError } = await supabase
        .from('follows')
        .select(`
          following:profiles!follows_following_id_fkey(
            federated_id, username, domain
          )
        `)
        .eq('follower_id', user.id)
        .eq('status', 'accepted')
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1)

      if (followsError) {
        console.error('Failed to fetch following:', followsError)
        return new Response('Failed to fetch following', { 
          status: 500, 
          headers: corsHeaders 
        })
      }

      // Convert to ActivityPub actor URLs
      const followingActors = follows?.map(follow => {
        const following = follow.following as any
        return following.federated_id || `https://${following.domain}/users/${following.username}`
      }).filter(Boolean) || []

      const followingPage = {
        '@context': 'https://www.w3.org/ns/activitystreams',
        id: `${followingId}?page=${page}`,
        type: 'OrderedCollectionPage',
        partOf: followingId,
        orderedItems: followingActors,
        next: followingActors.length === limit ? `${followingId}?page=${parseInt(page) + 1}` : undefined,
        prev: parseInt(page) > 1 ? `${followingId}?page=${parseInt(page) - 1}` : undefined
      }

      return new Response(JSON.stringify(followingPage, null, 2), {
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/activity+json; charset=utf-8',
          'Cache-Control': 'public, max-age=300'
        }
      })
    }

    // Return following summary
    const { count } = await supabase
      .from('follows')
      .select('*', { count: 'exact', head: true })
      .eq('follower_id', user.id)
      .eq('status', 'accepted')

    const following: ActivityPubFollowing = {
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: followingId,
      type: 'OrderedCollection',
      totalItems: count || 0,
      first: count && count > 0 ? `${followingId}?page=1` : undefined,
      last: count && count > 0 ? `${followingId}?page=${Math.ceil(count / 20)}` : undefined
    }

    return new Response(JSON.stringify(following, null, 2), {
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/activity+json; charset=utf-8',
        'Cache-Control': 'public, max-age=300'
      }
    })

  } catch (error) {
    console.error('Following endpoint error:', error)
    return new Response('Internal server error', { 
      status: 500, 
      headers: corsHeaders 
    })
  }
})
