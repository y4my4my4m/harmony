// ActivityPub Outbox endpoint for user posts and federation delivery
// GET /users/{username}/outbox - serves ActivityPub outbox collections
// POST /delivery - processes federation delivery queue

import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'
import { processDeliveryQueue } from './delivery.ts'

interface ActivityPubOutbox {
  '@context': string | string[]
  id: string
  type: 'OrderedCollection'
  totalItems: number
  first?: string
  last?: string
  orderedItems?: any[]
}

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
}

serve(async (req: Request) => {
  // Handle CORS preflight
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders })
  }

  try {
    const url = new URL(req.url)
    
    // Route: POST /delivery - process federation delivery queue
    if (req.method === 'POST' && url.pathname.endsWith('/delivery')) {
      try {
        const supabaseUrl = Deno.env.get('SUPABASE_URL')!
        const supabaseKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
        const supabase = createClient(supabaseUrl, supabaseKey)
        
        const result = await processDeliveryQueue(supabase)
        
        return new Response(JSON.stringify({
          success: true,
          ...result
        }), {
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json'
          }
        })
      } catch (error) {
        console.error('Federation delivery error:', error)
        return new Response(JSON.stringify({
          success: false,
          error: error.message
        }), {
          status: 500,
          headers: {
            ...corsHeaders,
            'Content-Type': 'application/json'
          }
        })
      }
    }
    
    // Route: GET /users/{username}/outbox - serve ActivityPub outbox collection
    if (req.method !== 'GET') {
      return new Response('Method not allowed', { 
        status: 405, 
        headers: corsHeaders 
      })
    }
    
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
    const outboxId = `${baseUrl}/users/${username}/outbox`

    // Check if requesting paginated results
    const page = url.searchParams.get('page')
    
    if (page) {
      // Return paginated posts
      const limit = 20
      const offset = (parseInt(page) - 1) * limit

      const { data: posts, error: postsError } = await supabase
        .from('posts')
        .select(`
          id, content, visibility, created_at, ap_id, ap_type,
          content_warning, in_reply_to
        `)
        .eq('author_id', user.id)
        .eq('is_local', true)
        .in('visibility', ['public', 'unlisted'])
        .order('created_at', { ascending: false })
        .range(offset, offset + limit - 1)

      if (postsError) {
        console.error('Failed to fetch posts:', postsError)
        return new Response('Failed to fetch posts', { 
          status: 500, 
          headers: corsHeaders 
        })
      }

      // Convert posts to ActivityPub Create activities using unified database functions
      const activities = await Promise.all(posts?.map(async post => {
        // Get properly formatted content and tags from unified database functions
        const { data: htmlContent, error: htmlContentError } = await supabase.rpc(
          'convert_unified_content_to_activitypub_html', 
          { content: post.content }
        );
        if (htmlContentError) {
          console.error('Failed to convert content to ActivityPub HTML:', htmlContentError);
        }

        const { data: allTags, error: allTagsError } = await supabase.rpc(
          'extract_all_activitypub_tags',
          { content: post.content }
        );
        if (allTagsError) {
          console.error('Failed to extract ActivityPub tags:', allTagsError);
        }

        const { data: attachments, error: attachmentsError } = await supabase.rpc(
          'extract_activitypub_attachments',
          { content: post.content }
        );
        if (attachmentsError) {
          console.error('Failed to extract ActivityPub attachments:', attachmentsError);
        }
        
        const activityObject: any = {
          id: post.ap_id || `${baseUrl}/posts/${post.id}`,
          type: post.ap_type || 'Note',
          attributedTo: `${baseUrl}/users/${username}`,
          content: htmlContent || '',
          published: post.created_at,
          to: post.visibility === 'public' ? ['https://www.w3.org/ns/activitystreams#Public'] : [],
          cc: [],
          ...(allTags && allTags.length > 0 && { tag: allTags }),
          ...(attachments && attachments.length > 0 && { attachment: attachments }),
          ...(post.content_warning && { summary: post.content_warning }),
          ...(post.in_reply_to && { inReplyTo: post.in_reply_to })
        };
        
        return {
          '@context': [
            'https://www.w3.org/ns/activitystreams',
            'https://w3id.org/security/v1',
            {
              'Hashtag': 'as:Hashtag',
              'sensitive': 'as:sensitive',
              'toot': 'http://joinmastodon.org/ns#',
              'Emoji': 'toot:Emoji'
            }
          ],
          id: `${baseUrl}/users/${username}/activities/create/${post.id}`,
          type: 'Create',
          actor: `${baseUrl}/users/${username}`,
          published: post.created_at,
          object: activityObject
        };
      })) || []

      const outboxPage = {
        '@context': 'https://www.w3.org/ns/activitystreams',
        id: `${outboxId}?page=${page}`,
        type: 'OrderedCollectionPage',
        partOf: outboxId,
        orderedItems: activities,
        next: activities.length === limit ? `${outboxId}?page=${parseInt(page) + 1}` : undefined,
        prev: parseInt(page) > 1 ? `${outboxId}?page=${parseInt(page) - 1}` : undefined
      }

      return new Response(JSON.stringify(outboxPage, null, 2), {
        headers: {
          ...corsHeaders,
          'Content-Type': 'application/activity+json; charset=utf-8',
          'Cache-Control': 'public, max-age=300'
        }
      })
    }

    // Return outbox summary (first page)
    const { count } = await supabase
      .from('posts')
      .select('*', { count: 'exact', head: true })
      .eq('author_id', user.id)
      .eq('is_local', true)
      .in('visibility', ['public', 'unlisted'])

    const outbox: ActivityPubOutbox = {
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: outboxId,
      type: 'OrderedCollection',
      totalItems: count || 0,
      first: count && count > 0 ? `${outboxId}?page=1` : undefined,
      last: count && count > 0 ? `${outboxId}?page=${Math.ceil(count / 20)}` : undefined
    }

    return new Response(JSON.stringify(outbox, null, 2), {
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/activity+json; charset=utf-8',
        'Cache-Control': 'public, max-age=300'
      }
    })

  } catch (error) {
    console.error('Outbox endpoint error:', error)
    return new Response('Internal server error', { 
      status: 500, 
      headers: corsHeaders 
    })
  }
})
