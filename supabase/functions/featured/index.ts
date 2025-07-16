// ActivityPub Featured posts endpoint 
// /users/{username}/featured (pinned posts)

import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

interface ActivityPubFeatured {
  '@context': string | string[]
  id: string
  type: 'OrderedCollection'
  totalItems: number
  orderedItems: any[]
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
    const featuredId = `${baseUrl}/users/${username}/featured`

    // Get featured posts using the corrected database function
    const { data: featuredPosts, error: postsError } = await supabase
      .rpc('get_user_featured_posts', {
        p_author_id: user.id,
        p_limit: 10
      })

    if (postsError) {
      console.error('Failed to fetch featured posts:', postsError)
      return new Response('Failed to fetch featured posts', { 
        status: 500, 
        headers: corsHeaders 
      })
    }

    // Convert posts to ActivityPub Note objects
    const featuredItems = await Promise.all(featuredPosts?.map(async post => {
      // Get properly formatted content and tags from database
      const { data: htmlContent } = await supabase.rpc(
        'convert_unified_content_to_activitypub_html', 
        { content: post.content }
      )

      const { data: allTags } = await supabase.rpc(
        'extract_all_activitypub_tags',
        { content: post.content }
      )
      
      const noteObject: any = {
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
        id: post.ap_id || `${baseUrl}/posts/${post.id}`,
        type: post.ap_type || 'Note',
        attributedTo: `${baseUrl}/users/${username}`,
        content: htmlContent || '',
        published: post.created_at,
        to: post.visibility === 'public' ? ['https://www.w3.org/ns/activitystreams#Public'] : [],
        cc: [],
        tag: allTags || [],
        ...(post.content_warning && { summary: post.content_warning }),
        ...(post.in_reply_to && { inReplyTo: post.in_reply_to })
      };
      
      // Add legacy media_attachments for backward compatibility
      if (post.media_attachments && post.media_attachments.length > 0) {
        if (!noteObject.attachment) {
          noteObject.attachment = [];
        }
        noteObject.attachment = noteObject.attachment.concat(post.media_attachments);
      }
      
      return noteObject;
    })) || []

    const featured: ActivityPubFeatured = {
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: featuredId,
      type: 'OrderedCollection',
      totalItems: featuredItems.length,
      orderedItems: featuredItems
    }

    return new Response(JSON.stringify(featured, null, 2), {
      headers: {
        ...corsHeaders,
        'Content-Type': 'application/activity+json; charset=utf-8',
        'Cache-Control': 'public, max-age=300'
      }
    })

  } catch (error) {
    console.error('Featured endpoint error:', error)
    return new Response('Internal server error', { 
      status: 500, 
      headers: corsHeaders 
    })
  }
})
