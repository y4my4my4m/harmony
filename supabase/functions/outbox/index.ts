// ActivityPub Outbox endpoint for user posts
// /users/{username}/outbox

import { serve } from "https://deno.land/std@0.168.0/http/server.ts"
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2'

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
          media_attachments, content_warning, in_reply_to
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

      // Helper function to extract attachments and emoji tags from content
      const extractMediaAndEmojis = (content: any) => {
        const attachments: any[] = [];
        const emojis: any[] = [];
        
        if (Array.isArray(content)) {
          content.forEach(item => {
            if (item.type === 'file') {
              // ActivityPub standard attachment
              const attachment: any = {
                type: 'Document',
                url: item.url,
                mediaType: item.fileType === 'image' ? 'image/jpeg' : 
                          item.fileType === 'video' ? 'video/mp4' : 
                          item.fileType === 'audio' ? 'audio/mpeg' : 'application/octet-stream'
              };
              
              if (item.fileName) {
                attachment.name = item.fileName;
              }
              
              attachments.push(attachment);
            } else if (item.type === 'emoji' && item.emoji) {
              // Misskey-compatible emoji tag
              emojis.push({
                id: item.emoji.url || `${baseUrl}/emojis/${item.emoji.id}`,
                type: 'Emoji',
                name: `:${item.emoji.name}:`,
                icon: {
                  type: 'Image',
                  url: item.emoji.url || `${baseUrl}/emojis/${item.emoji.id}.png`
                }
              });
            }
          });
        }
        
        return { attachments, emojis };
      };

      // Convert posts to ActivityPub Create activities
      const activities = posts?.map(post => {
        const { attachments, emojis } = extractMediaAndEmojis(post.content);
        
        const activityObject: any = {
          id: post.ap_id || `${baseUrl}/posts/${post.id}`,
          type: post.ap_type || 'Note',
          attributedTo: `${baseUrl}/users/${username}`,
          content: formatPostContent(post.content),
          published: post.created_at,
          to: post.visibility === 'public' ? ['https://www.w3.org/ns/activitystreams#Public'] : [],
          cc: [],
          ...(post.content_warning && { summary: post.content_warning }),
          ...(post.in_reply_to && { inReplyTo: post.in_reply_to })
        };
        
        // Add attachments if present
        if (attachments.length > 0) {
          activityObject.attachment = attachments;
        }
        
        // Add emoji tags if present (Misskey compatibility)
        if (emojis.length > 0) {
          activityObject.tag = (activityObject.tag || []).concat(emojis);
        }
        
        // Also add media_attachments for backward compatibility
        if (post.media_attachments && post.media_attachments.length > 0) {
          if (!activityObject.attachment) {
            activityObject.attachment = [];
          }
          activityObject.attachment = activityObject.attachment.concat(post.media_attachments);
        }
        
        return {
          '@context': 'https://www.w3.org/ns/activitystreams',
          id: `${baseUrl}/users/${username}/activities/create/${post.id}`,
          type: 'Create',
          actor: `${baseUrl}/users/${username}`,
          published: post.created_at,
          object: activityObject
        };
      }) || []

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
        } else if (item.type === 'emoji') {
          // Misskey-compatible emoji format
          if (item.emoji && item.emoji.url) {
            return `:${item.emoji.name}:`;
          }
          return `:${item.emoji?.name || 'emoji'}:`;
        } else if (item.type === 'file') {
          // Files should be handled as attachments in ActivityPub, not inline content
          // Return empty string as files are added to the attachment array separately
          return '';
        }
        return '';
      })
      .join('');
  }
  return String(content || '');
}
