import { getSupabaseClient } from '../config/supabase.js';
import { logger } from '../utils/logger.js';
import {
  actorToProfile,
  noteToContent,
  extractFollowData,
  extractLikeData,
  extractAnnounceData,
  extractDeleteData,
  normalizeActor,
} from './converters/fromActivityPub.js';
import { VoiceActivityHandler } from './VoiceActivityHandler.js';

export class ActivityProcessor {
  /**
   * Check if an actor is suspended on our instance
   */
  private static async isActorSuspended(actorUrl: string): Promise<boolean> {
    const supabase = getSupabaseClient();
    const { data } = await supabase
      .from('profiles')
      .select('is_suspended')
      .eq('federated_id', actorUrl)
      .maybeSingle();
    
    return data?.is_suspended === true;
  }

  /**
   * Process incoming ActivityPub activity
   */
  static async processIncomingActivity(activity: any): Promise<void> {
    // Check if actor is suspended on our instance
    const actorUrl = normalizeActor(activity.actor);
    if (actorUrl && await this.isActorSuspended(actorUrl)) {
      logger.info(`🚫 Ignoring activity from suspended user: ${actorUrl}`);
      return;
    }

    switch (activity.type) {
      case 'Follow':
        await this.processFollow(activity);
        break;
      case 'Accept':
        await this.processAccept(activity);
        break;
      case 'Reject':
        await this.processReject(activity);
        break;
      case 'Create':
        await this.processCreate(activity);
        break;
      case 'Update':
        await this.processUpdate(activity);
        break;
      case 'Delete':
        await this.processDelete(activity);
        break;
      case 'Like':
      case 'EmojiReaction':
        await this.processLike(activity);
        break;
      case 'Announce':
        await this.processAnnounce(activity);
        break;
      case 'Undo':
        await this.processUndo(activity);
        break;
      case 'Add':
        await this.processAdd(activity);
        break;
      case 'Remove':
        await this.processRemove(activity);
        break;
      case 'Flag':
        await this.processFlag(activity);
        break;
      case 'Block':
        await this.processBlock(activity);
        break;
      default:
        // Check for Harmony voice activities
        if (VoiceActivityHandler.isVoiceActivity(activity)) {
          await VoiceActivityHandler.processVoiceActivity(activity);
        } else {
          logger.info(`Unhandled activity type: ${activity.type}`);
        }
    }
  }

  /**
   * Process Follow activity
   */
  private static async processFollow(activity: any): Promise<void> {
    const { followerUrl, followingUrl } = extractFollowData(activity);
    const supabase = getSupabaseClient();

    // Ensure remote user exists
    await this.ensureRemoteUser(followerUrl);

    // Get follower and following IDs
    const { data: follower } = await supabase
      .from('profiles')
      .select('id')
      .eq('federated_id', followerUrl)
      .single();

    const { data: following } = await supabase
      .from('profiles')
      .select('id')
      .eq('federated_id', followingUrl)
      .single();

    if (!follower || !following) {
      logger.error('Failed to find users for follow relationship');
      return;
    }

    // Create follow relationship (auto-accept)
    const { data: followResult, error: followError } = await supabase.from('follows').upsert({
      follower_id: follower.id,
      following_id: following.id,
      status: 'accepted',
      ap_id: activity.id,
      is_local: false,
      accepted_at: new Date().toISOString()
    }, {
      onConflict: 'follower_id,following_id'
    }).select();

    if (followError) {
      logger.error('Failed to create follow relationship:', followError);
      return;
    }

    logger.info(`Follow created and auto-accepted: ${followerUrl} → ${followingUrl}`);

    // Send Accept activity back to follower
    const { data: followingUser } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', following.id)
      .single();
    
    if (followingUser && followingUser.is_local) {
      const { createAcceptActivity } = await import('./converters/toActivityPub.js');
      const { DeliveryQueue } = await import('./DeliveryQueue.js');
      
      const acceptActivity = createAcceptActivity(followingUser, activity);
      
      // Get follower's inbox
      const { data: followerUser } = await supabase
        .from('profiles')
        .select('inbox_url')
        .eq('id', follower.id)
        .single();
      
      if (followerUser?.inbox_url) {
        await DeliveryQueue.sendToInbox(followerUser.inbox_url, acceptActivity, followingUser.id);
        logger.info(`✅ Sent Accept activity to ${followerUrl}`);
      }
    }
  }

  /**
   * Process Accept activity
   */
  private static async processAccept(activity: any): Promise<void> {
    const supabase = getSupabaseClient();

    // Update follow status to accepted
    if (activity.object && activity.object.type === 'Follow') {
      await supabase
        .from('follows')
        .update({ status: 'accepted' })
        .eq('ap_activity_id', activity.object.id);

      logger.info(`Follow accepted: ${activity.object.id}`);
    }
  }

  /**
   * Process Reject activity
   */
  private static async processReject(activity: any): Promise<void> {
    const supabase = getSupabaseClient();

    // Update follow status to rejected or delete
    if (activity.object && activity.object.type === 'Follow') {
      await supabase
        .from('follows')
        .delete()
        .eq('ap_activity_id', activity.object.id);

      logger.info(`Follow rejected: ${activity.object.id}`);
    }
  }

  /**
   * Process Create activity (new post/message/poll)
   */
  private static async processCreate(activity: any): Promise<void> {
    const object = activity.object;
    const supabase = getSupabaseClient();

    // Handle Question type (polls) - store as Note with poll metadata
    if (object.type === 'Question') {
      logger.info(`📊 Processing poll: ${object.id}`);
      await this.processCreatePoll(activity, object);
      return;
    }

    if (object.type === 'Note' || object.type === 'Article') {
      // Ensure author exists
      await this.ensureRemoteUser(normalizeActor(activity.actor));

      // Get author ID
      const { data: author } = await supabase
        .from('profiles')
        .select('id')
        .eq('federated_id', normalizeActor(activity.actor))
        .single();

      if (!author) {
        logger.error('Failed to find author for post');
        return;
      }

      // Convert content (returns raw HTML for now)
      const rawContent = noteToContent(object);
      
      // Check for quote post (quoteUrl for Fediverse, _misskey_quote for Misskey)
      const quoteUrl = object.quoteUrl || object._misskey_quote;
      
      logger.info('📝 Processing ActivityPub Note: ' + JSON.stringify({
        id: object.id,
        inReplyTo: object.inReplyTo,
        quoteUrl: quoteUrl,
        contentPreview: object.content?.substring(0, 100)
      }));
      
      const content = rawContent;

      // Determine visibility
      const visibility = this.determineVisibility(object);

      // Route direct messages to messages table, everything else to posts
      if (visibility === 'direct' || visibility === 'private') {
        await this.handleDirectMessage(object, author.id, content);
      } else {
        // Handle reply threading - fetch parent posts if missing and find conversation root
        let parentPostId: string | null = null;
        let conversationRootId: string | null = null;

        if (object.inReplyTo) {
          const replyResult = await this.resolveReplyChain(object.inReplyTo);
          parentPostId = replyResult.parentPostId;
          conversationRootId = replyResult.conversationRootId;
        }

        // Handle quote posts - fetch/create the quoted post and store reference
        let quotedPostData: any = null;
        if (quoteUrl) {
          logger.info(`📝 Processing quote post, quoted URL: ${quoteUrl}`);
          quotedPostData = await this.resolveQuotedPost(quoteUrl);
        }

        // Build metadata object
        const metadata: any = {};
        if (object.inReplyTo) {
          metadata.in_reply_to_ap_url = object.inReplyTo;
        }
        if (quotedPostData) {
          metadata.is_quote = true;
          metadata.reblog_of = quotedPostData.id;
          metadata.quote_ap_url = quoteUrl;
        }

        // Create post with proper reply threading and quote support
        // in_reply_to is a UUID column for the parent post ID
        const postData: any = {
          ap_id: object.id,
          author_id: author.id,
          content,
          visibility,
          is_local: false,
          in_reply_to: parentPostId,
          conversation_root_id: conversationRootId,
          created_at: object.published || new Date().toISOString(),
          metadata,
          // Content warning (ActivityPub uses 'summary' for CW)
          content_warning: object.summary || null,
          // Sensitive flag
          is_sensitive: object.sensitive === true,
        };

        // Add reblog data for quote posts (for display purposes)
        if (quotedPostData) {
          postData.reblog = {
            id: quotedPostData.id,
            content: quotedPostData.content,
            created_at: quotedPostData.created_at,
            visibility: quotedPostData.visibility,
          };
          
          // Get quoted post author for reblog_author field
          const { data: quotedAuthor } = await supabase
            .from('profiles')
            .select('id, username, display_name, avatar_url, domain, is_local')
            .eq('id', quotedPostData.author_id)
            .single();
          
          if (quotedAuthor) {
            postData.reblog_author = quotedAuthor;
          }
        }

        const { error } = await supabase.from('posts').upsert(postData);

        if (error) {
          logger.error('Failed to create post from activity:', error);
        } else {
          const postType = quotedPostData ? 'quote post' : 'post';
          logger.info(`✅ Created ${postType} from ${object.id}${parentPostId ? ` (reply to ${parentPostId})` : ''}${quotedPostData ? ` (quoting ${quotedPostData.id})` : ''}`);
        }
      }
    }
  }

  /**
   * Resolve a quoted post - fetch if not local
   */
  private static async resolveQuotedPost(quoteUrl: string): Promise<any | null> {
    const supabase = getSupabaseClient();

    // First check if quoted post exists locally by ap_id
    const { data: existingPost } = await supabase
      .from('posts')
      .select('id, content, created_at, visibility, author_id')
      .eq('ap_id', quoteUrl)
      .maybeSingle();

    if (existingPost) {
      logger.info(`📝 Found quoted post locally: ${existingPost.id}`);
      return existingPost;
    }

    // Try extracting UUID from URL (for local posts)
    if (quoteUrl.includes('/posts/')) {
      const uuidMatch = quoteUrl.match(/\/posts\/([a-f0-9-]{36})/);
      if (uuidMatch) {
        const { data: postById } = await supabase
          .from('posts')
          .select('id, content, created_at, visibility, author_id')
          .eq('id', uuidMatch[1])
          .maybeSingle();
        
        if (postById) {
          logger.info(`📝 Found quoted post by UUID: ${postById.id}`);
          return postById;
        }
      }
    }

    // Fetch the quoted post from remote
    logger.info(`📝 Fetching quoted post from remote: ${quoteUrl}`);
    const fetchedPost = await this.fetchAndCreateRemotePost(quoteUrl);
    
    if (fetchedPost) {
      logger.info(`📝 Created quoted post from remote: ${fetchedPost.id}`);
    }
    
    return fetchedPost;
  }

  /**
   * Resolve reply chain - fetch missing parent posts and find conversation root
   * Returns the parent post ID and conversation root ID
   */
  private static async resolveReplyChain(inReplyToUrl: string, depth = 0): Promise<{
    parentPostId: string | null;
    conversationRootId: string | null;
  }> {
    const MAX_DEPTH = 10; // Prevent infinite loops
    const supabase = getSupabaseClient();

    if (depth > MAX_DEPTH) {
      logger.warn(`Reply chain too deep (>${MAX_DEPTH}), stopping resolution`);
      return { parentPostId: null, conversationRootId: null };
    }

    // First check if parent post exists locally
    let parentPost = null;
    
    // Try by ap_id
    const { data: postByApId } = await supabase
      .from('posts')
      .select('id, in_reply_to, conversation_root_id')
      .eq('ap_id', inReplyToUrl)
      .maybeSingle();
    
    parentPost = postByApId;

    // Try extracting UUID from URL
    if (!parentPost && inReplyToUrl.includes('/posts/')) {
      const uuidMatch = inReplyToUrl.match(/\/posts\/([a-f0-9-]{36})/);
      if (uuidMatch) {
        const { data: postById } = await supabase
          .from('posts')
          .select('id, in_reply_to, conversation_root_id')
          .eq('id', uuidMatch[1])
          .maybeSingle();
        parentPost = postById;
      }
    }

    // If parent doesn't exist locally, try to fetch it from remote
    if (!parentPost) {
      logger.info(`🔍 Parent post not found locally, fetching: ${inReplyToUrl}`);
      parentPost = await this.fetchAndCreateRemotePost(inReplyToUrl);
    }

    if (!parentPost) {
      logger.warn(`Could not resolve parent post: ${inReplyToUrl}`);
      return { parentPostId: null, conversationRootId: null };
    }

    // If parent already has a conversation_root_id, use it
    if (parentPost.conversation_root_id) {
      return {
        parentPostId: parentPost.id,
        conversationRootId: parentPost.conversation_root_id
      };
    }

    // If parent is not a reply (no in_reply_to), it IS the conversation root
    if (!parentPost.in_reply_to) {
      return {
        parentPostId: parentPost.id,
        conversationRootId: parentPost.id
      };
    }

    // Parent is also a reply - recurse to find the root
    const parentResult = await this.resolveReplyChain(parentPost.in_reply_to, depth + 1);
    
    // Update the parent post with its conversation_root_id if we found it
    if (parentResult.conversationRootId && !parentPost.conversation_root_id) {
      await supabase
        .from('posts')
        .update({ conversation_root_id: parentResult.conversationRootId })
        .eq('id', parentPost.id);
    }

    return {
      parentPostId: parentPost.id,
      conversationRootId: parentResult.conversationRootId || parentPost.id
    };
  }

  /**
   * Fetch a remote post and create it locally
   */
  private static async fetchAndCreateRemotePost(postUrl: string): Promise<{
    id: string;
    in_reply_to: string | null;
    conversation_root_id: string | null;
  } | null> {
    const supabase = getSupabaseClient();

    try {
      const response = await fetch(postUrl, {
        headers: {
          'Accept': 'application/activity+json, application/ld+json',
        },
      });

      if (!response.ok) {
        logger.warn(`Failed to fetch remote post ${postUrl}: ${response.status}`);
        return null;
      }

      const remoteObject = await response.json();

      // Only handle Note/Article types
      if (remoteObject.type !== 'Note' && remoteObject.type !== 'Article') {
        logger.warn(`Remote object is not a Note/Article: ${remoteObject.type}`);
        return null;
      }

      // Ensure author exists
      const authorUrl = normalizeActor(remoteObject.attributedTo || remoteObject.actor);
      await this.ensureRemoteUser(authorUrl);

      // Get author ID
      const { data: author } = await supabase
        .from('profiles')
        .select('id')
        .eq('federated_id', authorUrl)
        .single();

      if (!author) {
        logger.warn(`Could not find/create author for remote post`);
        return null;
      }

      // Convert content
      const content = noteToContent(remoteObject);
      const visibility = this.determineVisibility(remoteObject);

      // Create the remote post
      const { data: newPost, error } = await supabase
        .from('posts')
        .insert({
          ap_id: remoteObject.id,
          author_id: author.id,
          content,
          visibility,
          is_local: false,
          in_reply_to: remoteObject.inReplyTo || null,
          created_at: remoteObject.published || new Date().toISOString(),
          // Content warning (ActivityPub uses 'summary' for CW)
          content_warning: remoteObject.summary || null,
          // Sensitive flag
          is_sensitive: remoteObject.sensitive === true,
        })
        .select('id, in_reply_to, conversation_root_id')
        .single();

      if (error) {
        logger.error('Failed to create remote post:', error);
        return null;
      }

      logger.info(`✅ Fetched and created remote post: ${remoteObject.id}`);
      return newPost;
    } catch (error) {
      logger.warn(`Error fetching remote post ${postUrl}:`, error);
      return null;
    }
  }

  /**
   * Process Update activity (profile update, post edit)
   */
  private static async processUpdate(activity: any): Promise<void> {
    const object = activity.object;
    const supabase = getSupabaseClient();

    if (object.type === 'Person') {
      // Update user profile
      const profileData = actorToProfile(object);

      await supabase
        .from('profiles')
        .update({
          display_name: profileData.display_name,
          bio: profileData.bio,
          avatar_url: profileData.avatar,
          banner_url: profileData.banner,
          public_key: profileData.public_key,
        })
        .eq('federated_id', object.id);

      logger.info(`Updated profile: ${object.id}`);
    } else if (object.type === 'Note' || object.type === 'Article') {
      // Handle post edits
      logger.info(`✏️ Processing post edit: ${object.id}`);
      
      // Find the existing post
      const { data: existingPost } = await supabase
        .from('posts')
        .select('id, author_id')
        .eq('ap_id', object.id)
        .maybeSingle();

      if (!existingPost) {
        logger.warn(`Post not found for edit: ${object.id}`);
        return;
      }

      // Convert content
      const content = noteToContent(object);
      
      // Update the post
      const { error: updateError } = await supabase
        .from('posts')
        .update({
          content,
          content_warning: object.summary || null,
          is_sensitive: object.sensitive === true,
          updated_at: new Date().toISOString(),
        })
        .eq('id', existingPost.id);

      if (updateError) {
        logger.error('Failed to update post:', updateError);
      } else {
        logger.info(`✏️ Updated post: ${object.id}`);
      }
    }
  }

  /**
   * Process Delete activity
   */
  private static async processDelete(activity: any): Promise<void> {
    const { objectUrl } = extractDeleteData(activity);
    const supabase = getSupabaseClient();

    // Try to soft-delete post by ap_id (correct column)
    const { error: postError } = await supabase
      .from('posts')
      .update({ is_deleted: true, deleted_at: new Date().toISOString() })
      .eq('ap_id', objectUrl);

    // Try to soft-delete message by metadata.ap_id
    const { error: messageError } = await supabase
      .from('messages')
      .update({ is_deleted: true })
      .eq('metadata->>ap_id', objectUrl);

    if (!postError || !messageError) {
      logger.info(`Deleted object: ${objectUrl}`);
    }
  }

  /**
   * Process Like activity (including emoji reactions)
   */
  private static async processLike(activity: any): Promise<void> {
    const { actorUrl, objectUrl, emoji, emojiUrl, emojiName } = extractLikeData(activity);
    const supabase = getSupabaseClient();
    
    logger.info(`📊 Extracted Like data: emoji="${emoji}", emojiUrl="${emojiUrl}", emojiName="${emojiName}"`);

    // Ensure user exists
    await this.ensureRemoteUser(actorUrl);

    // Get user ID
    const { data: user } = await supabase
      .from('profiles')
      .select('id')
      .eq('federated_id', actorUrl)
      .single();

    if (!user) {
      logger.error('Failed to find user for like');
      return;
    }

    // Find target - could be a post OR a message (DM)
    let post = null;
    let message = null;
    
    // Check if this is a message (DM) reaction - try multiple methods
    // Method 1: Local message URL with UUID
    if (objectUrl.includes('/messages/')) {
      const uuidMatch = objectUrl.match(/\/messages\/([a-f0-9-]{36})/);
      if (uuidMatch) {
        const messageId = uuidMatch[1];
        const { data: messageById } = await supabase
          .from('messages')
          .select('id, conversation_id')
          .eq('id', messageId)
          .maybeSingle();
        message = messageById;
        
        if (message) {
          logger.info(`📨 Found message for reaction by local ID: ${messageId}`);
        }
      }
    }
    
    // Method 2: Try finding message by ap_id in metadata (for remote DMs)
    // This handles when a remote user reacts to their own message they sent us
    if (!message) {
      const { data: messageByApId } = await supabase
        .from('messages')
        .select('id, conversation_id')
        .eq('metadata->>ap_id', objectUrl)
        .maybeSingle();
      
      if (messageByApId) {
        message = messageByApId;
        logger.info(`📨 Found message for reaction by ap_id: ${objectUrl}`);
      }
    }
    
    // If still not a message, try to find as a post
    if (!message) {
      // Method 1: Try by ap_id
      const { data: postByApId } = await supabase
        .from('posts')
        .select('id')
        .eq('ap_id', objectUrl)
        .maybeSingle();
      
      post = postByApId;
      
      // Method 2: If not found, try extracting UUID from URL
      if (!post && objectUrl.includes('/posts/')) {
        const uuidMatch = objectUrl.match(/\/posts\/([a-f0-9-]{36})/);
        if (uuidMatch) {
          const postId = uuidMatch[1];
          const { data: postById } = await supabase
            .from('posts')
            .select('id')
            .eq('id', postId)
            .maybeSingle();
          post = postById;
        }
      }
    }

    // Handle message (DM) reaction
    if (message) {
      let emojiId = null;
      
      // For custom emojis with URLs, get or create emoji entry
      if (emojiUrl && emojiName) {
        logger.info(`🔍 Processing remote emoji for message reaction: ${emojiName} from ${emojiUrl}`);
        
        const cleanName = emojiName.replace(/:/g, '');
        const emojiDomain = new URL(emojiUrl).hostname;
        
        // Cache in remote_emojis_cache
        try {
          await supabase.rpc('upsert_remote_emoji', {
            p_shortcode: cleanName,
            p_origin_domain: emojiDomain,
            p_full_code: `:${cleanName}@${emojiDomain}:`,
            p_url: emojiUrl,
          });
        } catch (cacheError) {
          logger.debug(`Could not cache emoji: ${cacheError}`);
        }
        
        // Check if emoji exists
        const { data: existingEmoji } = await supabase
          .from('emojis')
          .select('id')
          .eq('url', emojiUrl)
          .maybeSingle();
        
        if (existingEmoji) {
          emojiId = existingEmoji.id;
        } else {
          // Create new emoji entry
          const { data: newEmoji } = await supabase
            .from('emojis')
            .insert({
              name: cleanName,
              url: emojiUrl,
              server_id: null,
              uploader: user.id,
              domain: emojiDomain,
            })
            .select('id')
            .single();
          
          if (newEmoji) {
            emojiId = newEmoji.id;
          }
        }
      } else {
        // Standard emoji - find or create by name
        let normalizedEmoji = emoji || '❤️';
        if (!emoji || normalizedEmoji === '❤' || normalizedEmoji === '❤️') {
          normalizedEmoji = '❤️';
        }
        
        const { data: existingEmoji } = await supabase
          .from('emojis')
          .select('id')
          .eq('name', normalizedEmoji)
          .is('server_id', null)
          .maybeSingle();
        
        if (existingEmoji) {
          emojiId = existingEmoji.id;
        } else {
          // Create unicode emoji entry
          const { data: newEmoji } = await supabase
            .from('emojis')
            .insert({
              name: normalizedEmoji,
              url: null, // Unicode emojis don't have URLs
              server_id: null,
              uploader: user.id,
            })
            .select('id')
            .single();
          
          if (newEmoji) {
            emojiId = newEmoji.id;
          }
        }
      }
      
      if (!emojiId) {
        logger.error('❌ Could not find or create emoji for message reaction');
        return;
      }
      
      // Check if reaction already exists
      const { data: existing } = await supabase
        .from('reactions')
        .select('id')
        .eq('message_id', message.id)
        .eq('user_id', user.id)
        .eq('emoji_id', emojiId)
        .maybeSingle();
      
      if (existing) {
        logger.info(`🔄 Reaction already exists for user ${user.id} on message ${message.id}`);
        return;
      }
      
      // Insert into reactions table (for messages/DMs)
      const { error: reactionError } = await supabase.from('reactions').insert({
        message_id: message.id,
        user_id: user.id,
        emoji_id: emojiId,
        metadata: { federated: true, from_domain: new URL(actorUrl).hostname }
      });
      
      if (reactionError) {
        logger.error('❌ Failed to insert message reaction:', reactionError);
      } else {
        logger.info(`✅ Added reaction to message ${message.id}: ${emoji || '❤️'}`);
      }
      return;
    }

    // Handle post reaction (existing logic)
    if (post) {
      let emojiId = null;
      
      // For custom emojis with URLs, cache in remote_emojis_cache for the importer
      // and use the emojis table for the reaction
      if (emojiUrl && emojiName) {
        logger.info(`🔍 Processing remote emoji: ${emojiName} from ${emojiUrl}`);
        
        const cleanName = emojiName.replace(/:/g, ''); // Remove colons
        const emojiDomain = new URL(emojiUrl).hostname;
        
        // Cache in remote_emojis_cache for the emoji importer feature
        try {
          await supabase.rpc('upsert_remote_emoji', {
            p_shortcode: cleanName,
            p_origin_domain: emojiDomain,
            p_full_code: `:${cleanName}@${emojiDomain}:`,
            p_url: emojiUrl,
          });
          logger.info(`📬 Cached remote emoji in importer: ${cleanName}@${emojiDomain}`);
        } catch (cacheError) {
          logger.debug(`Could not cache emoji: ${cacheError}`);
        }
        
        // Check if emoji already exists in emojis table (for reaction tracking)
        const { data: existingEmoji, error: existingError } = await supabase
          .from('emojis')
          .select('id')
          .eq('url', emojiUrl)
          .maybeSingle();
        
        if (existingError) {
          logger.error('Error checking for existing emoji:', existingError);
        }
        
        if (existingEmoji) {
          emojiId = existingEmoji.id;
          logger.info(`♻️  Using existing emoji ID: ${emojiId}`);
        } else {
          // Create new emoji entry for this remote custom emoji (with domain set)
          logger.info(`➕ Creating new emoji entry: ${cleanName}@${emojiDomain}`);
          
          const { data: newEmoji, error: insertError } = await supabase
            .from('emojis')
            .insert({
              name: cleanName,
              url: emojiUrl,
              server_id: null, // Global/federated emoji
              uploader: user.id,
              domain: emojiDomain, // Mark as remote emoji
            })
            .select('id')
            .single();
          
          if (insertError) {
            logger.error('❌ Failed to create emoji:', insertError);
          } else if (newEmoji) {
            emojiId = newEmoji.id;
            logger.info(`✨ Created emoji entry for remote emoji: ${cleanName}@${emojiDomain} (ID: ${emojiId})`);
          }
        }
      }
      
      // Add reaction/like to post using post_interactions table
      logger.info(`💾 Inserting reaction: emoji_id=${emojiId}, custom_content=${emoji}`);
      
      // Check if reaction already exists to avoid duplicates
      const { data: existing } = await supabase
        .from('post_interactions')
        .select('id')
        .eq('post_id', post.id)
        .eq('user_id', user.id)
        .eq('interaction_type', 'emoji_reaction')
        .maybeSingle();
      
      if (existing) {
        logger.info(`🔄 Reaction already exists for user ${user.id} on post ${post.id}`);
        return;
      }
      
      // Normalize the emoji content - ensure consistent representation
      // Different Unicode representations of heart can cause grouping issues
      let normalizedEmoji = emoji || '❤️';
      
      // Normalize common heart variants to a single representation
      // This ensures Mastodon favorites all group together
      if (!emoji || normalizedEmoji === '❤' || normalizedEmoji === '❤️') {
        normalizedEmoji = '❤️'; // Standard red heart with variation selector
      }
      
      const { error: interactionError } = await supabase.from('post_interactions').insert({
        post_id: post.id,
        user_id: user.id,
        interaction_type: 'emoji_reaction',
        emoji_id: emojiId, // Use created/found emoji ID
        custom_emoji_content: normalizedEmoji,
        is_local: false,
      });

      if (interactionError) {
        logger.error('❌ Failed to insert reaction:', interactionError);
      } else {
        logger.info(`✅ Added reaction to post ${post.id}: ${emoji || '❤️'}${emojiUrl ? ` with URL: ${emojiUrl}` : ' (no URL)'}`);
      }
    } else {
      logger.warn(`Post or message not found for like: ${objectUrl}`);
    }
  }

  /**
   * Process Announce activity (reblog/boost)
   */
  private static async processAnnounce(activity: any): Promise<void> {
    const { actorUrl, objectUrl, published } = extractAnnounceData(activity);
    const supabase = getSupabaseClient();

    logger.info(`📢 Processing Announce: ${actorUrl} reblogged ${objectUrl}`);

    // Ensure user exists
    await this.ensureRemoteUser(actorUrl);

    // Get user ID
    const { data: user } = await supabase
      .from('profiles')
      .select('id')
      .eq('federated_id', actorUrl)
      .single();

    if (!user) {
      logger.error('Failed to find user for announce');
      return;
    }

    // Find original post - try ap_id first (correct column), then by UUID extraction
    let originalPost = null;
    
    // Method 1: Try by ap_id (correct column name)
    const { data: postByApId } = await supabase
      .from('posts')
      .select('id, content, visibility, author_id, created_at, ap_id')
      .eq('ap_id', objectUrl)
      .maybeSingle();
    
    originalPost = postByApId;
    
    // Method 2: If not found, try extracting UUID from URL
    // Support both /posts/{uuid} and /activities/{uuid} URL formats
    if (!originalPost) {
      const uuidMatch = objectUrl.match(/\/(?:posts|activities)\/([a-f0-9-]{36})/);
      if (uuidMatch) {
        const postId = uuidMatch[1];
        logger.info(`🔍 Trying to find post by UUID: ${postId}`);
        const { data: postById } = await supabase
          .from('posts')
          .select('id, content, visibility, author_id, created_at, ap_id')
          .eq('id', postId)
          .maybeSingle();
        originalPost = postById;
        if (postById) {
          logger.info(`✅ Found post by UUID: ${postId}`);
        }
      }
    }

    // Method 3: If still not found, try to fetch and create the remote post
    if (!originalPost) {
      logger.info(`Original post not found locally, attempting to fetch: ${objectUrl}`);
      try {
        const response = await fetch(objectUrl, {
          headers: {
            'Accept': 'application/activity+json, application/ld+json',
          },
        });
        
        if (response.ok) {
          const remotePost = await response.json();
          if (remotePost.type === 'Note' || remotePost.type === 'Article') {
            // Ensure the remote author exists
            const authorUrl = normalizeActor(remotePost.attributedTo || remotePost.actor);
            await this.ensureRemoteUser(authorUrl);
            
            // Get author ID
            const { data: author } = await supabase
              .from('profiles')
              .select('id')
              .eq('federated_id', authorUrl)
              .single();
            
            if (author) {
              // Create the original post
              const content = noteToContent(remotePost);
              const visibility = this.determineVisibility(remotePost);
              
              const { data: newPost, error: createError } = await supabase
                .from('posts')
                .insert({
                  ap_id: remotePost.id,
                  author_id: author.id,
                  content,
                  visibility,
                  is_local: false,
                  created_at: remotePost.published || new Date().toISOString(),
                })
                .select('id, content, visibility, author_id, created_at, ap_id')
                .single();
              
              if (!createError && newPost) {
                originalPost = newPost;
                logger.info(`Created remote post ${remotePost.id} for reblog`);
              }
            }
          }
        }
      } catch (fetchError) {
        logger.warn(`Failed to fetch remote post for reblog: ${objectUrl}`, fetchError);
      }
    }

    if (!originalPost) {
      logger.warn(`Original post not found for announce: ${objectUrl}`);
      return;
    }

    // Check if reblog already exists to avoid duplicates
    const { data: existingReblog } = await supabase
      .from('posts')
      .select('id')
      .eq('ap_id', activity.id)
      .maybeSingle();
    
    if (existingReblog) {
      logger.info(`Reblog already exists: ${activity.id}`);
      return;
    }

    // Get original post author for reblog_author field
    const { data: originalAuthor } = await supabase
      .from('profiles')
      .select('id, username, display_name, avatar_url, domain, is_local')
      .eq('id', originalPost.author_id)
      .single();

    // Create reblog post with proper metadata and reblog fields
    // The database constraint requires either content OR reblog to be non-null
    const { error: insertError } = await supabase.from('posts').insert({
      ap_id: activity.id, // Set ap_id for the reblog itself
      author_id: user.id,
      content: [], // Reblogs have no content of their own
      visibility: 'public',
      is_local: false,
      is_federated: true,
      ap_type: 'Announce',
      // The reblog field is required for the posts_content_not_empty constraint
      reblog: {
        id: originalPost.id,
        content: originalPost.content,
        created_at: originalPost.created_at,
        visibility: originalPost.visibility,
        ap_id: originalPost.ap_id || objectUrl,
      },
      reblog_author: originalAuthor || null,
      metadata: {
        reblog_of: originalPost.id,
        original_ap_id: originalPost.ap_id || objectUrl,
        original_author_id: originalPost.author_id,
      },
      created_at: published || new Date().toISOString(),
    });

    if (insertError) {
      logger.error('Failed to create reblog post:', insertError);
    } else {
      // Also create a post_interaction record for the reblog
      await supabase.from('post_interactions').insert({
        user_id: user.id,
        post_id: originalPost.id,
        interaction_type: 'reblog',
        ap_id: activity.id,
        is_local: false,
      }).catch(err => logger.warn('Failed to create reblog interaction:', err));
      
      // Increment reblogs_count on original post
      await supabase.rpc('increment_post_reblogs', { p_post_id: originalPost.id })
        .catch(err => logger.warn('Failed to increment reblog count:', err));

      logger.info(`✅ Created reblog of ${originalPost.id} by ${user.id}`);
    }
  }

  /**
   * Process Undo activity
   */
  private static async processUndo(activity: any): Promise<void> {
    const object = activity.object;
    const supabase = getSupabaseClient();

    logger.info(`🔄 Processing Undo activity from ${activity.actor}`);
    logger.debug(`Undo object: ${JSON.stringify(object)?.substring(0, 500)}`);

    if (!object) {
      logger.warn('Undo activity has no object, skipping');
      return;
    }

    // Handle string object (just the ID of the original activity)
    const objectType = typeof object === 'string' ? null : object.type;
    
    // If object is a string, we need to look up what type it was
    if (typeof object === 'string') {
      logger.info(`🔍 Undo object is a string ID: ${object}`);
      // Try to find the original activity by its ID
      const { data: originalActivity } = await supabase
        .from('ap_activities')
        .select('ap_type, activity_data')
        .eq('ap_id', object)
        .maybeSingle();
      
      if (originalActivity) {
        logger.info(`Found original activity type: ${originalActivity.ap_type}`);
        // Process based on the original activity type
        await this.processUndoByType(originalActivity.ap_type, originalActivity.activity_data, activity.actor);
        return;
      } else {
        logger.warn(`Could not find original activity: ${object}`);
        return;
      }
    }

    switch (objectType) {
      case 'Follow': {
        // Remove follow
        const { followerUrl, followingUrl } = extractFollowData(object);
        logger.info(`🔄 Undoing follow: ${followerUrl} → ${followingUrl}`);
        
        const { data: follower } = await supabase
          .from('profiles')
          .select('id')
          .eq('federated_id', followerUrl)
          .single();

        const { data: following } = await supabase
          .from('profiles')
          .select('id')
          .eq('federated_id', followingUrl)
          .single();

        if (!follower) {
          logger.warn(`Follower not found: ${followerUrl}`);
        }
        if (!following) {
          logger.warn(`Following not found: ${followingUrl}`);
        }

        if (follower && following) {
          const { error } = await supabase
            .from('follows')
            .delete()
            .eq('follower_id', follower.id)
            .eq('following_id', following.id);

          if (error) {
            logger.error(`Failed to delete follow:`, error);
          } else {
            logger.info(`✅ Undid follow: ${followerUrl} → ${followingUrl}`);
          }
        }
        break;
      }

      case 'Like':
      case 'EmojiReaction': {
        await this.processUndoReaction(object, activity.actor);
        break;
      }

      case 'Announce': {
        // Remove reblog by ap_id (correct column)
        const announceId = typeof object === 'string' ? object : object.id;
        logger.info(`🔄 Undoing announce: ${announceId}`);
        
        // First get the reblog post to find the original
        const { data: reblogPost } = await supabase
          .from('posts')
          .select('id, metadata')
          .eq('ap_id', announceId)
          .maybeSingle();
        
        if (reblogPost) {
          // Delete the reblog post
          const { error: deleteError } = await supabase
            .from('posts')
            .delete()
            .eq('id', reblogPost.id);
          
          if (deleteError) {
            logger.error(`Failed to delete reblog post:`, deleteError);
          }
          
          // Also remove the interaction record if the original post is known
          const originalPostId = reblogPost.metadata?.reblog_of;
          if (originalPostId) {
            const actorUrl = normalizeActor(activity.actor);
        const { data: user } = await supabase
          .from('profiles')
          .select('id')
          .eq('federated_id', actorUrl)
          .single();

            if (user) {
              await supabase
                .from('post_interactions')
                .delete()
                .eq('user_id', user.id)
                .eq('post_id', originalPostId)
                .eq('interaction_type', 'reblog');
            }
          }
          logger.info(`✅ Undid announce: ${announceId}`);
        } else {
          logger.warn(`Reblog post not found for Undo: ${announceId}`);
        }
        break;
      }
      
      default:
        logger.warn(`Unhandled Undo object type: ${objectType}`);
    }
  }

  /**
   * Process Undo for Like/EmojiReaction (supports both posts and messages/DMs)
   */
  private static async processUndoReaction(object: any, actorUrl: string): Promise<void> {
    const supabase = getSupabaseClient();
    const { actorUrl: likeActorUrl, objectUrl } = extractLikeData(object);
    
    logger.info(`🔄 Undoing reaction from ${likeActorUrl} on ${objectUrl}`);
    
    const { data: user } = await supabase
      .from('profiles')
      .select('id')
      .eq('federated_id', likeActorUrl)
      .single();

    if (!user) {
      logger.warn(`User not found for Undo reaction: ${likeActorUrl}`);
      return;
    }

    // Check if this is a message (DM) reaction
    if (objectUrl.includes('/messages/')) {
      const uuidMatch = objectUrl.match(/\/messages\/([a-f0-9-]{36})/);
      if (uuidMatch) {
        const messageId = uuidMatch[1];
        logger.info(`🔄 Undoing message reaction on ${messageId}`);
        
        // Delete from reactions table (for messages)
        const { error, count } = await supabase
          .from('reactions')
          .delete()
          .eq('user_id', user.id)
          .eq('message_id', messageId);

        if (error) {
          logger.error(`Failed to delete message reaction:`, error);
        } else {
          logger.info(`✅ Undid message reaction on ${objectUrl} (deleted ${count || 'unknown'} records)`);
        }
      }
      return;
    }

    // Handle post reactions
    let post = null;
    
    // Try by ap_id first
    const { data: postByApId } = await supabase
      .from('posts')
      .select('id')
      .eq('ap_id', objectUrl)
      .maybeSingle();
    
    post = postByApId;
    
    // Fallback: try extracting UUID from URL (for local posts)
    if (!post && objectUrl.includes('/posts/')) {
      const uuidMatch = objectUrl.match(/\/posts\/([a-f0-9-]{36})/);
      if (uuidMatch) {
        logger.info(`🔍 Trying to find local post by UUID: ${uuidMatch[1]}`);
        const { data: postById } = await supabase
          .from('posts')
          .select('id')
          .eq('id', uuidMatch[1])
          .maybeSingle();
        post = postById;
      }
    }

    if (!post) {
      logger.warn(`Post not found for Undo reaction: ${objectUrl}`);
      return;
    }

    // Delete from post_interactions
    const { error, count } = await supabase
      .from('post_interactions')
      .delete()
      .eq('user_id', user.id)
      .eq('post_id', post.id)
      .in('interaction_type', ['favorite', 'emoji_reaction']);

    if (error) {
      logger.error(`Failed to delete reaction:`, error);
    } else {
      logger.info(`✅ Undid reaction on ${objectUrl} (deleted ${count || 'unknown'} records)`);
    }
  }

  /**
   * Process Undo by looking up the original activity type
   */
  private static async processUndoByType(activityType: string, activityData: any, actorUrl: string): Promise<void> {
    logger.info(`🔄 Processing Undo by type: ${activityType}`);
    
    switch (activityType) {
      case 'Like':
      case 'EmojiReaction':
        await this.processUndoReaction(activityData, actorUrl);
        break;
      case 'Follow':
        // Extract follow data from the stored activity
        if (activityData) {
          const supabase = getSupabaseClient();
          const { followerUrl, followingUrl } = extractFollowData(activityData);
          
          const { data: follower } = await supabase
            .from('profiles')
            .select('id')
            .eq('federated_id', followerUrl)
            .single();

          const { data: following } = await supabase
              .from('profiles')
              .select('id')
            .eq('federated_id', followingUrl)
              .single();
            
          if (follower && following) {
              await supabase
              .from('follows')
                .delete()
              .eq('follower_id', follower.id)
              .eq('following_id', following.id);
            logger.info(`✅ Undid follow: ${followerUrl} → ${followingUrl}`);
          }
        }
        break;
      case 'Announce':
        // Handle via ap_id lookup
        if (activityData?.id) {
          const supabase = getSupabaseClient();
          await supabase
            .from('posts')
            .delete()
            .eq('ap_id', activityData.id);
          logger.info(`✅ Undid announce: ${activityData.id}`);
        }
        break;
      default:
        logger.warn(`Unknown activity type for Undo: ${activityType}`);
    }
  }

  /**
   * Process Create activity for polls (Question type)
   * Stores the poll as a post with poll data in metadata
   */
  private static async processCreatePoll(activity: any, object: any): Promise<void> {
    const supabase = getSupabaseClient();

    // Ensure author exists
    await this.ensureRemoteUser(normalizeActor(activity.actor));

    const { data: author } = await supabase
      .from('profiles')
      .select('id')
      .eq('federated_id', normalizeActor(activity.actor))
      .single();

    if (!author) {
      logger.error('Failed to find author for poll');
      return;
    }

    // Extract poll options
    const options = [];
    
    // oneOf = single choice, anyOf = multiple choice
    const pollOptions = object.oneOf || object.anyOf || [];
    const isMultipleChoice = !!object.anyOf;
    
    for (const option of pollOptions) {
      if (option.type === 'Note') {
        options.push({
          name: option.name || '',
          votes: option.replies?.totalItems || 0,
        });
      }
    }

    // Calculate end time
    let endTime = null;
    if (object.endTime) {
      endTime = object.endTime;
    } else if (object.closed) {
      endTime = object.closed;
    }

    // Convert content
    const content = noteToContent(object);
    const visibility = this.determineVisibility(object);

    // Build poll metadata
    const pollMetadata = {
      is_poll: true,
      poll_options: options,
      poll_multiple_choice: isMultipleChoice,
      poll_end_time: endTime,
      poll_voters_count: object.votersCount || 0,
      poll_closed: !!object.closed || (endTime && new Date(endTime) < new Date()),
    };

    // Store as a post with poll metadata
    const { error } = await supabase.from('posts').upsert({
      ap_id: object.id,
      ap_type: 'Question',
      author_id: author.id,
      content,
      visibility,
      is_local: false,
      created_at: object.published || new Date().toISOString(),
      content_warning: object.summary || null,
      is_sensitive: object.sensitive === true,
      metadata: pollMetadata,
    });

    if (error) {
      logger.error('Failed to create poll post:', error);
    } else {
      logger.info(`📊 Created poll: ${object.id} with ${options.length} options`);
    }
  }

  /**
   * Process Add activity (pinning posts to featured collection)
   */
  private static async processAdd(activity: any): Promise<void> {
    const supabase = getSupabaseClient();
    const actorUrl = normalizeActor(activity.actor);
    const targetUrl = activity.target; // Should be the featured collection URL
    const objectUrl = typeof activity.object === 'string' ? activity.object : activity.object?.id;

    // Check if this is adding to featured collection
    if (!targetUrl?.includes('/featured') || !objectUrl) {
      logger.info(`Add activity not for featured collection, skipping`);
      return;
    }

    logger.info(`📌 Processing Add to featured: ${objectUrl}`);

    // Find the post by ap_id
    const { data: post, error } = await supabase
      .from('posts')
      .select('id, author_id')
      .eq('ap_id', objectUrl)
      .maybeSingle();

    if (error || !post) {
      logger.warn(`Post not found for pinning: ${objectUrl}`);
      return;
    }

    // Update the post to be pinned
    await supabase
      .from('posts')
      .update({ is_pinned: true })
      .eq('id', post.id);

    logger.info(`📌 Pinned post: ${objectUrl}`);
  }

  /**
   * Process Remove activity (unpinning posts from featured collection)
   */
  private static async processRemove(activity: any): Promise<void> {
    const supabase = getSupabaseClient();
    const targetUrl = activity.target;
    const objectUrl = typeof activity.object === 'string' ? activity.object : activity.object?.id;

    // Check if this is removing from featured collection
    if (!targetUrl?.includes('/featured') || !objectUrl) {
      logger.info(`Remove activity not for featured collection, skipping`);
      return;
    }

    logger.info(`📌 Processing Remove from featured: ${objectUrl}`);

    // Find and unpin the post
    const { error } = await supabase
      .from('posts')
      .update({ is_pinned: false })
      .eq('ap_id', objectUrl);

    if (!error) {
      logger.info(`📌 Unpinned post: ${objectUrl}`);
    }
  }

  /**
   * Process Flag activity (reports from other instances)
   */
  private static async processFlag(activity: any): Promise<void> {
    const supabase = getSupabaseClient();
    const actorUrl = normalizeActor(activity.actor);
    const objects = Array.isArray(activity.object) ? activity.object : [activity.object];
    const content = activity.content || 'No reason provided';

    logger.info(`🚩 Processing Flag from ${actorUrl}: ${objects.length} objects`);

    // Ensure reporter exists
    await this.ensureRemoteUser(actorUrl);

    const { data: reporter } = await supabase
      .from('profiles')
      .select('id')
      .eq('federated_id', actorUrl)
      .single();

    if (!reporter) {
      logger.warn(`Could not find reporter for Flag activity`);
      return;
    }

    // Process each flagged object (can be users or posts)
    for (const obj of objects) {
      const objectUrl = typeof obj === 'string' ? obj : obj?.id;
      if (!objectUrl) continue;

      // Determine if it's a user or post
      const isUserReport = objectUrl.includes('/users/');
      
      if (isUserReport) {
        // User report
        const { data: reportedUser } = await supabase
          .from('profiles')
          .select('id')
          .eq('federated_id', objectUrl)
          .maybeSingle();

        if (reportedUser) {
          await supabase.from('reports').insert({
            reporter_id: reporter.id,
            reported_user_id: reportedUser.id,
            reason: content,
            report_type: 'user',
            source: 'federation',
            source_instance: new URL(actorUrl).hostname,
            status: 'pending',
            ap_id: activity.id,
          });
          logger.info(`🚩 Created user report for ${objectUrl}`);
        }
      } else {
        // Post report
        const { data: reportedPost } = await supabase
          .from('posts')
          .select('id, author_id')
          .eq('ap_id', objectUrl)
          .maybeSingle();

        if (reportedPost) {
          await supabase.from('reports').insert({
            reporter_id: reporter.id,
            reported_user_id: reportedPost.author_id,
            reported_post_id: reportedPost.id,
            reason: content,
            report_type: 'post',
            source: 'federation',
            source_instance: new URL(actorUrl).hostname,
            status: 'pending',
            ap_id: activity.id,
          });
          logger.info(`🚩 Created post report for ${objectUrl}`);
        }
      }
    }
  }

  /**
   * Process Block activity (federated blocks)
   */
  private static async processBlock(activity: any): Promise<void> {
    const supabase = getSupabaseClient();
    const actorUrl = normalizeActor(activity.actor);
    const blockedUrl = typeof activity.object === 'string' ? activity.object : activity.object?.id;

    if (!blockedUrl) {
      logger.warn(`Block activity missing object`);
      return;
    }

    logger.info(`🚫 Processing Block: ${actorUrl} → ${blockedUrl}`);

    // Ensure both users exist
    await this.ensureRemoteUser(actorUrl);

    const { data: blocker } = await supabase
      .from('profiles')
      .select('id')
      .eq('federated_id', actorUrl)
      .single();

    const { data: blocked } = await supabase
      .from('profiles')
      .select('id')
      .eq('federated_id', blockedUrl)
      .maybeSingle();

    if (!blocker || !blocked) {
      logger.warn(`Could not find users for Block activity`);
      return;
    }

    // Create or update block relationship
    await supabase.from('user_blocks').upsert({
      blocker_id: blocker.id,
      blocked_user_id: blocked.id,
      block_type: 'full',
      is_federated: true,
      ap_id: activity.id,
    }, {
      onConflict: 'blocker_id,blocked_user_id',
    });

    // Also remove any follow relationships
    await supabase
      .from('follows')
      .delete()
      .or(`and(follower_id.eq.${blocker.id},following_id.eq.${blocked.id}),and(follower_id.eq.${blocked.id},following_id.eq.${blocker.id})`);

    logger.info(`🚫 Blocked: ${actorUrl} → ${blockedUrl}`);
  }

  /**
   * Ensure remote user exists in database (fetch if needed)
   * @param actorUrl - The ActivityPub actor URL
   * @param forceRefresh - If true, refresh profile even if user exists (for stale data)
   */
  private static async ensureRemoteUser(actorUrl: string, forceRefresh: boolean = false): Promise<any | null> {
    const supabase = getSupabaseClient();

    // Check if user already exists - also check by the URL as an alias
    // (the canonical federated_id might differ from the URL we were given)
    const { data: existing } = await supabase
      .from('profiles')
      .select('id, updated_at, federated_id, username, display_name, avatar_url, color')
      .or(`federated_id.eq.${actorUrl}`)
      .maybeSingle();

    if (existing && !forceRefresh) {
      // Check if profile is stale (older than 24 hours)
      const updatedAt = new Date(existing.updated_at);
      const hoursSinceUpdate = (Date.now() - updatedAt.getTime()) / (1000 * 60 * 60);
      
      if (hoursSinceUpdate < 24) {
        return existing; // User exists and is fresh enough
      }
      // Profile is stale, refresh it
      logger.info(`Profile for ${actorUrl} is stale (${Math.round(hoursSinceUpdate)}h old), refreshing...`);
    } else if (existing && forceRefresh) {
      logger.info(`Force refreshing profile for ${actorUrl}`);
    }

    // Fetch actor from remote server
    try {
      const response = await fetch(actorUrl, {
        headers: {
          'Accept': 'application/activity+json, application/ld+json',
        },
      });

      if (!response.ok) {
        logger.error(`Failed to fetch actor ${actorUrl}: ${response.status}`);
        return existing || null;
      }

      const actor = await response.json();
      const profileData = actorToProfile(actor);

      // Upsert remote user - map field names to database columns
      // This handles both initial creation and refreshing stale profiles
      const profileRecord: any = {
        username: profileData.username,
        domain: profileData.domain,
        display_name: profileData.display_name,
        bio: profileData.bio,
        avatar_url: profileData.avatar,   // Map avatar -> avatar_url
        banner_url: profileData.banner,   // Map banner -> banner_url
        public_key: profileData.public_key,
        federated_id: profileData.federated_id,
        inbox_url: profileData.inbox_url,
        outbox_url: profileData.outbox_url,
        followers_url: profileData.followers_url,
        following_url: profileData.following_url,
        is_local: false,
        updated_at: new Date().toISOString(), // Track when we last synced
        last_synced_at: new Date().toISOString(), // Also update last_synced_at
      };

      // Include Harmony extension: profile color
      if (profileData.color) {
        profileRecord.color = profileData.color;
      }

      const { data: upserted } = await supabase
        .from('profiles')
        .upsert(profileRecord, {
          onConflict: 'federated_id',
        })
        .select('id, username, display_name, avatar_url, federated_id, color')
        .single();

      const action = existing ? 'Refreshed' : 'Created';
      logger.info(`${action} remote user: ${actorUrl}${profileData.banner ? ' (with banner)' : ''}`);
      
      return upserted || null;
    } catch (error) {
      logger.error(`Error fetching remote actor ${actorUrl}:`, error);
      return existing || null;
    }
  }

  /**
   * Handle direct message (store in messages table instead of posts)
   */
  private static async handleDirectMessage(
    object: any,
    authorId: string,
    content: any[]
  ): Promise<void> {
    const supabase = getSupabaseClient();
    
    // Extract mentioned users (recipients)
    const to = Array.isArray(object.to) ? object.to : [object.to].filter(Boolean);
    const cc = Array.isArray(object.cc) ? object.cc : [object.cc].filter(Boolean);
    const allRecipients = [...to, ...cc];
    
    // Get local user IDs from the recipient URLs
    const recipientIds: string[] = [];
    for (const recipientUrl of allRecipients) {
      if (typeof recipientUrl !== 'string') continue;
      
      const { data: recipient } = await supabase
        .from('profiles')
        .select('id, is_local')
        .eq('federated_id', recipientUrl)
        .single();
      
      if (recipient?.is_local) {
        recipientIds.push(recipient.id);
      }
    }
    
    if (recipientIds.length === 0) {
      logger.warn(`Direct message ${object.id} has no local recipients`);
      return;
    }
    
    // For each local recipient, find or create DM conversation using the database function
    for (const recipientId of recipientIds) {
      try {
        // Use the existing get_or_create_conversation function
        const { data: conversationId, error: convError } = await supabase
          .rpc('get_or_create_conversation', {
            user1_uuid: authorId,
            user2_uuid: recipientId
          });
        
        if (convError || !conversationId) {
          logger.error(`Failed to get/create conversation:`, convError);
          continue;
        }
        
        logger.info(`Using conversation ${conversationId} for DM`);
        
        // Store message in messages table
        const { error: messageError } = await supabase
          .from('messages')
          .insert({
            user_id: authorId,
            conversation_id: conversationId,
            content,
            metadata: {
              ap_id: object.id,
              from_domain: new URL(object.attributedTo || object.actor).hostname,
              original_url: object.url || object.id,
              published: object.published,
            },
            created_at: object.published || new Date().toISOString(),
          });
        
        if (messageError) {
          logger.error(`Failed to create DM from activity:`, messageError);
        } else {
          logger.info(`✅ Created DM in conversation ${conversationId} from ${object.id}`);
        }
      } catch (error) {
        logger.error(`Error handling DM for recipient ${recipientId}:`, error);
      }
    }
  }

  /**
   * Determine post visibility from ActivityPub 'to' and 'cc' fields
   */
  private static determineVisibility(object: any): string {
    const to = Array.isArray(object.to) ? object.to : [object.to].filter(Boolean);
    const cc = Array.isArray(object.cc) ? object.cc : [object.cc].filter(Boolean);

    const publicUrl = 'https://www.w3.org/ns/activitystreams#Public';

    // Public: has Public in 'to'
    if (to.includes(publicUrl)) {
      return 'public';
    }
    
    // Unlisted: has Public in 'cc' but not 'to'
    if (cc.includes(publicUrl)) {
      return 'unlisted';
    }
    
    // Direct message: addressed to specific users only (no Public, no followers collection)
    // Check if all recipients are individual user URLs (not collections)
    const allRecipients = [...to, ...cc];
    const hasFollowersCollection = allRecipients.some(url => 
      typeof url === 'string' && url.includes('/followers')
    );
    
    if (!hasFollowersCollection && allRecipients.length > 0) {
      // Only specific users mentioned, no followers collection = direct message
      return 'direct';
    }
    
    // Followers-only: has followers collection but no Public
    if (hasFollowersCollection) {
      return 'followers';
    }
    
    // Default to unlisted if we can't determine
    return 'unlisted';
  }
}

