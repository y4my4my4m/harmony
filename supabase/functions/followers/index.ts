// ActivityPub Followers endpoint 
// /users/{username}/followers

import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

interface ActivityPubFollowers {
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
    
    // Extract username from path
    let username = ''
    const originalUri = req.headers.get('X-Original-URI')
    if (originalUri) {
      const match = originalUri.match(/\/users\/([^/]+)\/followers/)
      username = match ? match[1] : ''
    } else {
      const pathParts = url.pathname.split('/')
      const userIndex = pathParts.indexOf('users')
      username = userIndex >= 0 ? pathParts[userIndex + 1] : ''
    }

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

    const baseUrl = `https://${ourDomain}`
    const followersId = `${baseUrl}/users/${username}/followers`

    // Check if requesting paginated results
    const page = url.searchParams.get('page')
    
    if (page) {
      // Return paginated followers
      const limit = 20
      const offset = (parseInt(page) - 1) * limit

      const { data: follows, error: followsError } = await supabase
        .from('follows')
        .select(`
          follower:profiles!follows_follower_id_fkey(
            federated_id, username, domain
          )
        `)
        .eq('following_id', user.id)
        .eq('status', 'accepted')
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1)

      if (followsError) {
        console.error('Failed to fetch followers:', followsError)
        return new Response('Failed to fetch followers', { 
          status: 500, 
          headers: corsHeaders 
        })
      }

      // Convert to ActivityPub actor URLs
      const followerActors = follows?.map(follow => {
        const follower = follow.follower as any
        return follower.federated_id || `https://${follower.domain}/users/${follower.username}`
      }).filter(Boolean) || []

      const followersPage = {
        '@context': 'https://www.w3.org/ns/activitystreams',
        id: `${followersId}?page=${page}`,
        type: 'OrderedCollectionPage',
        partOf: followersId,
        orderedItems: followerActors,
        next: followerActors.length === limit ? `${followersId}?page=${parseInt(page) + 1}` : undefined,
        prev: parseInt(page) > 1 ? `${followersId}?page=${parseInt(page) - 1}` : undefined
      }

      return new Response(JSON.stringify(followersPage, null, 2), {
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/activity+json; charset=utf-8',
          'Cache-Control': 'public, max-age=300'
        }
      })
    }

    // Return followers summary
    const { count } = await supabase
      .from('follows')
      .select('*', { count: 'exact', head: true })
      .eq('following_id', user.id)
      .eq('status', 'accepted')

    const followers: ActivityPubFollowers = {
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: followersId,
      type: 'OrderedCollection',
      totalItems: count || 0,
      first: count && count > 0 ? `${followersId}?page=1` : undefined,
      last: count && count > 0 ? `${followersId}?page=${Math.ceil(count / 20)}` : undefined
    }

    return new Response(JSON.stringify(followers, null, 2), {
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/activity+json; charset=utf-8',
        'Cache-Control': 'public, max-age=300'
      }
    })

  } catch (error) {
    console.error('Followers endpoint error:', error)
    return new Response('Internal server error', { 
      status: 500, 
      headers: corsHeaders 
    })
  }
})
