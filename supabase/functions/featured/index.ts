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

    // Get pinned/featured posts
    // For now, we'll return empty collection since we don't have pinned posts implemented
    // TODO: Add pinned posts functionality to the posts table
    const { data: featuredPosts, error: postsError } = await supabase
      .from('posts')
      .select(`
        id, content, visibility, created_at, ap_id, ap_type,
        media_attachments, content_warning, in_reply_to
      `)
      .eq('author_id', user.id)
      .eq('is_local', true)
      .eq('is_pinned', true) // This column doesn't exist yet, so this will return empty
      .in('visibility', ['public', 'unlisted'])
      .order('created_at', { ascending: false })
      .limit(10)

    // Convert posts to ActivityPub Note objects
    const featuredItems = featuredPosts?.map(post => ({
      id: post.ap_id || `${baseUrl}/posts/${post.id}`,
      type: post.ap_type || 'Note',
      attributedTo: `${baseUrl}/users/${username}`,
      content: formatPostContent(post.content),
      published: post.created_at,
      to: post.visibility === 'public' ? ['https://www.w3.org/ns/activitystreams#Public'] : [],
      cc: [],
      ...(post.content_warning && { summary: post.content_warning }),
      ...(post.in_reply_to && { inReplyTo: post.in_reply_to }),
      ...(post.media_attachments && post.media_attachments.length > 0 && {
        attachment: post.media_attachments
      })
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

// Helper function to format post content for ActivityPub federation
function formatPostContent(content: any): string {
  if (Array.isArray(content)) {
    return content
      .map(item => {
        if (item.type === 'text') {
          return item.text || '';
        } else if (item.type === 'mention') {
          // Convert unified mention format to ActivityPub HTML with proper h-card structure
          const username = item.username || '';
          const domain = item.domain || 'har.mony.lol';
          const href = item.url || `https://${domain}/@${username}`;
          const displayName = item.isLocal ? `@${username}` : `@${username}@${domain}`;
          return `<span class="h-card"><a href="${href}" class="u-url mention">${displayName}</a></span>`;
        } else if (item.type === 'url') {
          return `<a href="${item.url}" target="_blank" rel="noopener">${item.text || item.url}</a>`;
        }
        return '';
      })
      .join('');
  }
  return String(content || '');
}
