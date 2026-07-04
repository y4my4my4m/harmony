import { Router, Request, Response } from 'express';
import { getSupabaseClient, getSupabaseClientWithAuth } from '../config/supabase.js';
import { asyncHandler } from '../middleware/errorHandler.js';
import { postToNote } from './converters/toActivityPub.js';
import { renderPostPage, renderOEmbed } from './postPageRenderer.js';
import config from '../config/index.js';

const router = Router();

/**
 * User outbox endpoint with cursor-based pagination
 * GET /users/:username/outbox
 * Query params:
 *   - cursor: ID of last post (for cursor-based pagination)
 *   - page: Page number (legacy, for backwards compatibility)
 *   - limit: Items per page (default 20, max 100)
 *   - type: Filter by activity type (optional: 'Create', 'Announce')
 *   - min_date / max_date: Date range filter (ISO strings)
 */
router.get(
  '/users/:username/outbox',
  asyncHandler(async (req: Request, res: Response) => {
    const { username } = req.params;
    const cursor = req.query.cursor as string | undefined;
    const page = req.query.page as string | undefined;
    const limit = Math.min(parseInt(req.query.limit as string) || 20, 100);
    const activityType = req.query.type as string | undefined;
    const minDate = req.query.min_date as string | undefined;
    const maxDate = req.query.max_date as string | undefined;
    const supabase = getSupabaseClient();

    const { data: user, error: userError } = await supabase
      .from('profiles')
      .select('*')
      .eq('username', username)
      .eq('is_local', true)
      .single();

    if (userError || !user) {
      res.status(404).json({ error: 'User not found' });
      return;
    }

    const baseUrl = `https://${config.INSTANCE_DOMAIN}`;
    const outboxUrl = `${baseUrl}/users/${username}/outbox`;

    // If no page/cursor, return collection metadata
    if (!page && !cursor) {
      let countQuery = supabase
        .from('posts')
        .select('*', { count: 'exact', head: true })
        .eq('author_id', user.id)
        .eq('is_local', true)
        .eq('is_deleted', false);

      if (activityType === 'Announce') {
        countQuery = countQuery.not('metadata->reblog_of', 'is', null);
      } else if (activityType === 'Create') {
        countQuery = countQuery.is('metadata->reblog_of', null);
      }

      const { count } = await countQuery;

      res.setHeader('Content-Type', 'application/activity+json');
      // Allow remote servers to cache outbox collection for 5 minutes
      res.setHeader('Cache-Control', 'public, max-age=300');
      res.json({
        '@context': 'https://www.w3.org/ns/activitystreams',
        id: outboxUrl,
        type: 'OrderedCollection',
        totalItems: count || 0,
        first: `${outboxUrl}?cursor=start&limit=${limit}`,
      });
      return;
    }

    let query = supabase
      .from('posts')
      .select('*')
      .eq('author_id', user.id)
      .eq('is_local', true)
      .eq('is_deleted', false)
      .order('created_at', { ascending: false })
      .limit(limit + 1);

    if (cursor && cursor !== 'start') {
      const { data: cursorPost } = await supabase
        .from('posts')
        .select('created_at')
        .eq('id', cursor)
        .single();
      
      if (cursorPost) {
        query = query.lt('created_at', cursorPost.created_at);
      }
    } else if (page) {
      // Legacy page-based pagination
      const pageNum = parseInt(page) || 1;
      const offset = (pageNum - 1) * limit;
      query = query.range(offset, offset + limit - 1);
    }

    if (activityType === 'Announce') {
      query = query.not('metadata->reblog_of', 'is', null);
    } else if (activityType === 'Create') {
      query = query.is('metadata->reblog_of', null);
    }

    if (minDate) {
      query = query.gte('created_at', minDate);
    }
    if (maxDate) {
      query = query.lte('created_at', maxDate);
    }

    const { data: posts } = await query;
    const hasMore = (posts?.length || 0) > limit;
    const items = (posts || []).slice(0, limit);
    const lastItem = items[items.length - 1];

    const orderedItems = items.map((post: any) => {
      const isReblog = post.metadata?.reblog_of || post.metadata?.is_reblog;
      
      if (isReblog) {
        // Announce (reblog)
        return {
          '@context': 'https://www.w3.org/ns/activitystreams',
          id: post.ap_id || `${baseUrl}/activities/${post.id}`,
          type: 'Announce',
          actor: `${baseUrl}/users/${username}`,
          published: post.created_at,
          to: ['https://www.w3.org/ns/activitystreams#Public'],
          cc: [`${baseUrl}/users/${username}/followers`],
          object: post.metadata?.reblog_of_ap_url || `${baseUrl}/posts/${post.metadata?.reblog_of}`,
        };
      } else {
        return {
          '@context': 'https://www.w3.org/ns/activitystreams',
          id: `${baseUrl}/activities/${post.id}`,
          type: 'Create',
          actor: `${baseUrl}/users/${username}`,
          published: post.created_at,
          to: ['https://www.w3.org/ns/activitystreams#Public'],
          cc: [`${baseUrl}/users/${username}/followers`],
          object: postToNote(post, user),
        };
      }
    });

    const response: any = {
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: cursor 
        ? `${outboxUrl}?cursor=${cursor}&limit=${limit}` 
        : `${outboxUrl}?page=${page || 1}`,
      type: 'OrderedCollectionPage',
      partOf: outboxUrl,
      orderedItems,
    };

    if (hasMore && lastItem?.id) {
      response.next = `${outboxUrl}?cursor=${lastItem.id}&limit=${limit}`;
    }

    // Legacy prev link for page-based
    if (page && parseInt(page) > 1) {
      response.prev = `${outboxUrl}?page=${parseInt(page) - 1}`;
    }

    res.setHeader('Content-Type', 'application/activity+json');
    // Allow remote servers to cache outbox page for 5 minutes
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.json(response);
  })
);

/**
 * Serve a single post.
 *
 * Content negotiation:
 *  - Accept: application/activity+json → ActivityPub Note (JSON)
 *  - Anything else (browsers, crawlers) → HTML page with OG meta tags
 *
 * Only public and unlisted posts are served to anonymous viewers.
 */
router.get(
  '/posts/:postId',
  asyncHandler(async (req: Request, res: Response) => {
    const { postId } = req.params;
    const accept = req.headers.accept || '';

    const wantsActivityPub =
      accept.includes('application/activity+json') ||
      accept.includes('application/ld+json');

    const supabase = getSupabaseClient();

    const { data: post, error } = await supabase
      .from('posts')
      .select(`
        *,
        author:profiles!posts_author_id_fkey (
          id, username, display_name, avatar_url, domain, is_local, public_key, federation_metadata
        )
      `)
      .eq('id', postId)
      .eq('is_deleted', false)
      .maybeSingle();

    if (error || !post || !post.author) {
      if (wantsActivityPub) {
        return res.status(404).json({ error: 'Post not found' });
      }
      return res.status(404).send(render404Page());
    }

    if (!wantsActivityPub && post.visibility !== 'public' && post.visibility !== 'unlisted') {
      return res.status(404).send(render404Page());
    }

    if (wantsActivityPub) {
      const note = postToNote(post, post.author);

      if (post.in_reply_to) {
        const { data: parent } = await supabase
          .from('posts')
          .select('ap_id, id')
          .eq('id', post.in_reply_to)
          .maybeSingle();
        if (parent) {
          note.inReplyTo = parent.ap_id || `https://${config.INSTANCE_DOMAIN}/posts/${parent.id}`;
        }
      }

      res.setHeader('Content-Type', 'application/activity+json');
      res.setHeader('Cache-Control', 'public, max-age=300');
      return res.json(note);
    }

    // HTML response for browsers and crawlers
    const html = renderPostPage(post, post.author);
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=300');
    // Override helmet's strict CSP for this page: allow inline script (auth
    // redirect) and images from any HTTPS source (avatars, emojis, media
    // from federated instances)
    res.setHeader('Content-Security-Policy',
      "default-src 'self'; script-src 'self' 'unsafe-inline'; img-src 'self' data: https:; style-src 'self' 'unsafe-inline'; font-src 'self' https:;");
    return res.send(html);
  })
);

/**
 * oEmbed endpoint - allows platforms to embed Harmony posts.
 * GET /oembed?url=https://domain/posts/:id&format=json
 */
router.get(
  '/oembed',
  asyncHandler(async (req: Request, res: Response) => {
    const url = req.query.url as string;
    if (!url) {
      return res.status(400).json({ error: 'Missing url parameter' });
    }

    const postIdMatch = url.match(/\/posts\/([0-9a-f-]+)/);
    if (!postIdMatch) {
      return res.status(404).json({ error: 'Invalid post URL' });
    }

    const supabase = getSupabaseClient();
    const { data: post } = await supabase
      .from('posts')
      .select(`
        *,
        author:profiles!posts_author_id_fkey (
          id, username, display_name, avatar_url, domain, is_local
        )
      `)
      .eq('id', postIdMatch[1])
      .eq('is_deleted', false)
      .in('visibility', ['public', 'unlisted'])
      .maybeSingle();

    if (!post || !post.author) {
      return res.status(404).json({ error: 'Post not found' });
    }

    const oembed = renderOEmbed(post, post.author);
    res.setHeader('Content-Type', 'application/json+oembed');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    return res.json(oembed);
  })
);

function render404Page(): string {
  const domain = config.INSTANCE_DOMAIN;
  const instanceName = config.INSTANCE_NAME;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Post not found - ${instanceName}</title>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      background: #0d1117; color: #e6edf3;
      display: flex; justify-content: center; align-items: center;
      min-height: 100vh; margin: 0;
    }
    .msg { text-align: center; }
    .msg h1 { font-size: 48px; margin-bottom: 8px; color: #8b949e; }
    .msg p { color: #8b949e; margin-bottom: 24px; }
    .msg a {
      color: #58a6ff; text-decoration: none;
      padding: 10px 20px; border: 1px solid #30363d; border-radius: 8px;
    }
    .msg a:hover { background: #161b22; }
  </style>
</head>
<body>
  <div class="msg">
    <h1>404</h1>
    <p>This post doesn't exist or is not publicly visible.</p>
    <a href="https://${domain}">Go to ${instanceName}</a>
  </div>
</body>
</html>`;
}

/**
 * Likes collection for a post
 * GET /posts/:postId/likes
 */
router.get(
  '/posts/:postId/likes',
  asyncHandler(async (req: Request, res: Response) => {
    const { postId } = req.params;
    const supabase = getSupabaseClient();
    const postUrl = `https://${config.INSTANCE_DOMAIN}/posts/${postId}`;

    const { data: post } = await supabase
      .from('posts')
      .select('id, ap_id')
      .eq('id', postId)
      .eq('is_deleted', false)
      .maybeSingle();

    if (!post) {
      return res.status(404).json({ error: 'Post not found' });
    }

    const { count } = await supabase
      .from('post_interactions')
      .select('id', { count: 'exact', head: true })
      .eq('post_id', postId)
      .in('interaction_type', ['emoji_reaction', 'favorite']);

    const page = req.query.page as string | undefined;
    const collectionUrl = `${postUrl}/likes`;

    if (!page) {
      res.setHeader('Content-Type', 'application/activity+json');
      return res.json({
        '@context': 'https://www.w3.org/ns/activitystreams',
        id: collectionUrl,
        type: 'OrderedCollection',
        totalItems: count || 0,
        first: `${collectionUrl}?page=1`,
      });
    }

    const pageNum = parseInt(page, 10) || 1;
    const limit = 50;
    const offset = (pageNum - 1) * limit;

    const { data: interactions } = await supabase
      .from('post_interactions')
      .select(`
        id, interaction_type, created_at, custom_emoji_content,
        profile:profiles!post_interactions_user_id_fkey ( id, username, domain, is_local, ap_id ),
        emoji:emojis ( name, url )
      `)
      .eq('post_id', postId)
      .in('interaction_type', ['emoji_reaction', 'favorite'])
      .order('created_at', { ascending: true })
      .range(offset, offset + limit - 1);

    const items = (interactions || []).map((i: any) => {
      const profile = i.profile;
      const actorUrl = profile?.is_local
        ? `https://${config.INSTANCE_DOMAIN}/users/${profile.username}`
        : profile?.ap_id || `https://${profile?.domain}/users/${profile?.username}`;

      const item: any = {
        type: 'Like',
        actor: actorUrl,
        object: post.ap_id || postUrl,
      };

      if (i.emoji?.name) {
        item.content = i.emoji.url ? `:${i.emoji.name}:` : i.emoji.name;
      } else if (i.custom_emoji_content) {
        item.content = i.custom_emoji_content;
      }
      return item;
    });

    const totalItems = count || 0;
    const result: any = {
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: `${collectionUrl}?page=${pageNum}`,
      type: 'OrderedCollectionPage',
      partOf: collectionUrl,
      totalItems,
      orderedItems: items,
    };

    if (offset + limit < totalItems) {
      result.next = `${collectionUrl}?page=${pageNum + 1}`;
    }

    res.setHeader('Content-Type', 'application/activity+json');
    return res.json(result);
  })
);

/**
 * Replies collection for a post
 * GET /posts/:postId/replies
 */
router.get(
  '/posts/:postId/replies',
  asyncHandler(async (req: Request, res: Response) => {
    const { postId } = req.params;
    const supabase = getSupabaseClient();
    const postUrl = `https://${config.INSTANCE_DOMAIN}/posts/${postId}`;

    const { data: post } = await supabase
      .from('posts')
      .select('id, ap_id')
      .eq('id', postId)
      .eq('is_deleted', false)
      .maybeSingle();

    if (!post) {
      return res.status(404).json({ error: 'Post not found' });
    }

    const { count } = await supabase
      .from('posts')
      .select('id', { count: 'exact', head: true })
      .eq('in_reply_to', postId)
      .eq('is_deleted', false);

    const page = req.query.page as string | undefined;
    const collectionUrl = `${postUrl}/replies`;

    if (!page) {
      res.setHeader('Content-Type', 'application/activity+json');
      return res.json({
        '@context': 'https://www.w3.org/ns/activitystreams',
        id: collectionUrl,
        type: 'OrderedCollection',
        totalItems: count || 0,
        first: `${collectionUrl}?page=1`,
      });
    }

    const pageNum = parseInt(page, 10) || 1;
    const limit = 20;
    const offset = (pageNum - 1) * limit;

    const { data: replies } = await supabase
      .from('posts')
      .select(`
        id, ap_id, created_at, content, visibility, content_warning, is_sensitive,
        author:profiles!posts_author_id_fkey ( id, username, display_name, avatar_url, domain, is_local )
      `)
      .eq('in_reply_to', postId)
      .eq('is_deleted', false)
      .order('created_at', { ascending: true })
      .range(offset, offset + limit - 1);

    const items = (replies || []).map((reply: any) =>
      postToNote(reply, reply.author)
    );

    const totalItems = count || 0;
    const result: any = {
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: `${collectionUrl}?page=${pageNum}`,
      type: 'OrderedCollectionPage',
      partOf: collectionUrl,
      totalItems,
      orderedItems: items,
    };

    if (offset + limit < totalItems) {
      result.next = `${collectionUrl}?page=${pageNum + 1}`;
    }

    res.setHeader('Content-Type', 'application/activity+json');
    return res.json(result);
  })
);

/**
 * Process delivery queue (called by cron or manually)
 * POST /api/activitypub/process-delivery
 * Requires admin authentication.
 */
router.post(
  '/api/activitypub/process-delivery',
  asyncHandler(async (req: Request, res: Response) => {
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Authorization required' });
      return;
    }

    const supabaseAuth = getSupabaseClientWithAuth(authHeader.substring(7));
    const { data: { user }, error: authError } = await supabaseAuth.auth.getUser();
    if (authError || !user) {
      res.status(401).json({ error: 'Invalid token' });
      return;
    }

    const supabase = getSupabaseClient();
    const { data: profile } = await supabase
      .from('profiles')
      .select('is_admin')
      .eq('auth_user_id', user.id)
      .single();

    if (!profile?.is_admin) {
      res.status(403).json({ error: 'Admin access required' });
      return;
    }

    const { DeliveryQueue } = await import('./DeliveryQueue.js');
    
    const result = await DeliveryQueue.processQueue();

    res.json({
      success: true,
      ...result,
    });
  })
);

/**
 * GET /messages/:id
 * Serve a DM message as an ActivityPub Note object so remote instances
 * can dereference inReplyTo references pointing to our messages.
 * Only returns messages that have been federated (federation_status = 'completed').
 * Requires HTTP Signature or Accept: application/activity+json.
 */
router.get(
  '/messages/:id',
  asyncHandler(async (req: Request, res: Response) => {
    const accept = req.headers.accept || '';
    const isAPRequest = accept.includes('application/activity+json')
      || accept.includes('application/ld+json');

    if (!isAPRequest) {
      res.status(406).json({ error: 'Not Acceptable' });
      return;
    }

    const messageId = req.params.id;
    if (!messageId || !/^[a-f0-9-]{36}$/.test(messageId)) {
      res.status(404).json({ error: 'Not found' });
      return;
    }

    const supabase = getSupabaseClient();
    const domain = config.INSTANCE_DOMAIN;

    const { data: message, error } = await supabase
      .from('messages')
      .select(`
        id, content, created_at, metadata,
        user:profiles!messages_user_id_fkey(id, username),
        conversation:conversations!messages_conversation_id_fkey(id, type)
      `)
      .eq('id', messageId)
      .eq('federation_status', 'completed')
      .single();

    if (error || !message || !message.user) {
      res.status(404).json({ error: 'Not found' });
      return;
    }

    const author = message.user as any;
    const conv = message.conversation as any;

    const note: any = {
      '@context': 'https://www.w3.org/ns/activitystreams',
      id: `https://${domain}/messages/${message.id}`,
      type: 'Note',
      attributedTo: `https://${domain}/users/${author.username}`,
      published: message.created_at,
      content: typeof message.content === 'string' ? message.content : '',
    };

    if (message.metadata?.conversation) {
      note.conversation = message.metadata.conversation;
    }
    if (message.metadata?.in_reply_to_ap) {
      note.inReplyTo = message.metadata.in_reply_to_ap;
    }

    if (conv?.type === 'group') {
      note['harmony:conversationType'] = 'group';
      note['harmony:conversationId'] = message.conversation_id;
    }

    note.directMessage = true;

    res.set('Content-Type', 'application/activity+json; charset=utf-8');
    res.set('Cache-Control', 'max-age=300');
    res.json(note);
  })
);

export default router;

