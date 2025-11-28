/**
 * Database Listener - Listens for PostgreSQL NOTIFY events
 * 
 * This is how the federation backend knows when to federate content:
 * 1. User creates post → Supabase
 * 2. Database trigger → NOTIFY 'post_created'
 * 3. This listener receives notification
 * 4. Process and federate
 */

import { getSupabaseClient } from '../config/supabase.js';
import config from '../config/index.js';
import { DeliveryQueue } from '../activitypub/DeliveryQueue.js';
import { createPostActivity, createLikeActivity, createReblogActivity } from './FederationHandlers.js';
import { logger } from '../utils/logger.js';
import { convertContentToHTML, extractActivityPubTags, extractAttachments } from '../utils/contentUtils.js';

/**
 * Start listening to database notifications
 */
export async function startDatabaseListener(): Promise<void> {
  logger.info('🔊 Starting database notification listener...');

  const supabase = getSupabaseClient();

  // Subscribe to real-time changes for federation events  
  const channel = supabase
    .channel('federation-events')
    
    // DEBUG: Listen to ALL events on ALL tables to see if realtime works at all
    // Filter out high-frequency tables that create noise (timeline_entries, notifications, ap_activities)
    .on(
      'postgres_changes',
      {
        event: '*',
        schema: 'public',
        table: '*',
      },
      async (payload) => {
        // Skip logging for high-frequency tables that aren't relevant to federation debugging
        const noisyTables = ['timeline_entries', 'notifications', 'ap_activities'];
        if (noisyTables.includes(payload.table)) {
          // Use debug level for noisy tables
          logger.debug(`🔔 REALTIME EVENT: ${payload.eventType} on ${payload.table}`, {
            id: payload.new?.id || payload.old?.id,
            table: payload.table
          });
          return;
        }
        
        logger.info(`🔔 REALTIME EVENT: ${payload.eventType} on ${payload.table}`, {
          id: payload.new?.id || payload.old?.id,
          table: payload.table
        });
      }
    )
    
    // Listen to posts
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'posts',
      },
      async (payload) => {
        logger.info('📬 REALTIME: Post INSERT received:', {
          id: payload.new.id,
          is_local: payload.new.is_local,
          visibility: payload.new.visibility,
          author_id: payload.new.author_id
        });
        
        // Only process local public/unlisted posts
        if (payload.new.is_local && ['public', 'unlisted'].includes(payload.new.visibility)) {
          logger.info('📝 Processing post for federation:', payload.new.id);
          await handleNewPost(payload.new);
        } else {
          logger.debug(`Skipping post: is_local=${payload.new.is_local}, visibility=${payload.new.visibility}`);
        }
      }
    )
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'post_interactions',
        filter: 'interaction_type=eq.emoji_reaction',
      },
      async (payload) => {
        logger.info('❤️  New reaction detected:', payload.new.id);
        await handleNewReaction(payload.new);
      }
    )
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'post_interactions',
        filter: 'interaction_type=eq.favorite',
      },
      async (payload) => {
        logger.info('⭐ New favorite/like detected:', payload.new.id);
        await handleNewReaction(payload.new);
      }
    )
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'follows',
      },
      async (payload) => {
        logger.info('👥 New follow detected:', payload.new.id);
        await handleNewFollow(payload.new);
      }
    )
    .on(
      'postgres_changes',
      {
        event: 'UPDATE',
        schema: 'public',
        table: 'profiles',
      },
      async (payload) => {
        logger.info('📝 Profile update detected:', payload.new.id);
        await handleProfileUpdate(payload.old, payload.new);
      }
    )
    // Listen for post updates (deletions, pins, and edits)
    .on(
      'postgres_changes',
      {
        event: 'UPDATE',
        schema: 'public',
        table: 'posts',
      },
      async (payload) => {
        // Handle deletion events (is_deleted changed from false to true)
        if (payload.new.is_deleted && !payload.old?.is_deleted) {
          logger.info('🗑️ Post deletion detected:', payload.new.id);
          await handlePostDeletion(payload.new, payload.old);
        }
        // Handle pin/unpin events (is_pinned changed)
        else if (payload.new.is_pinned !== payload.old?.is_pinned) {
          logger.info(`📌 Post ${payload.new.is_pinned ? 'pinned' : 'unpinned'}:`, payload.new.id);
          await handlePinChange(payload.new, payload.old);
        }
        // Handle post edits (content or content_warning changed)
        else if (
          payload.new.updated_at !== payload.old?.updated_at &&
          (JSON.stringify(payload.new.content) !== JSON.stringify(payload.old?.content) ||
           payload.new.content_warning !== payload.old?.content_warning)
        ) {
          logger.info('✏️ Post edit detected:', payload.new.id);
          await handlePostEdit(payload.new, payload.old);
        }
      }
    )
    // Listen for new blocks
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'user_blocks',
      },
      async (payload) => {
        logger.info('🚫 New block detected:', payload.new.id);
        await handleNewBlock(payload.new);
      }
    )
    // Listen for block removals (unblock)
    .on(
      'postgres_changes',
      {
        event: 'DELETE',
        schema: 'public',
        table: 'user_blocks',
      },
      async (payload) => {
        logger.info('✅ Unblock detected:', payload.old?.id);
        await handleUnblock(payload.old);
      }
    )
    // Listen for new reports
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'reports',
      },
      async (payload) => {
        logger.info('🚩 New report detected:', payload.new.id);
        await handleNewReport(payload.new);
      }
    )
    // Listen for unfollow events
    .on(
      'postgres_changes',
      {
        event: 'DELETE',
        schema: 'public',
        table: 'follows',
      },
      async (payload) => {
        logger.info('👤 Unfollow detected:', payload.old?.id);
        await handleUnfollow(payload.old);
      }
    )
    // Listen for reaction/reblog removals
    .on(
      'postgres_changes',
      {
        event: 'DELETE',
        schema: 'public',
        table: 'post_interactions',
      },
      async (payload) => {
        logger.info('↩️ Interaction removal detected:', payload.old?.id);
        await handleInteractionRemoval(payload.old);
      }
    )
    // Listen for DM messages - federate to remote recipients
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'messages',
      },
      async (payload) => {
        // Only process messages in conversations (DMs), not channel messages
        if (payload.new.conversation_id && !payload.new.metadata?.federated) {
          logger.info('💬 DM message detected:', {
            id: payload.new.id,
            conversation_id: payload.new.conversation_id
          });
          await handleNewDM(payload.new);
        }
      }
    )
    // Listen for new message reactions (DMs)
    .on(
      'postgres_changes',
      {
        event: 'INSERT',
        schema: 'public',
        table: 'reactions',
      },
      async (payload) => {
        logger.info('💬❤️ New message reaction detected:', payload.new.id);
        await handleNewMessageReaction(payload.new);
      }
    )
    // Listen for message reaction removals (DMs)
    .on(
      'postgres_changes',
      {
        event: 'DELETE',
        schema: 'public',
        table: 'reactions',
      },
      async (payload) => {
        logger.info('💬💔 Message reaction removed:', payload.old?.id);
        await handleMessageReactionRemoval(payload.old);
      }
    )
    .subscribe((status, err) => {
      logger.info(`📡 Realtime subscription status: ${status}`);
      
      if (err) {
        logger.error('❌ Realtime subscription error:', err);
      }
      
      if (status === 'SUBSCRIBED') {
        logger.info('✅ Database listener active - watching for federation events');
      } else if (status === 'CHANNEL_ERROR') {
        logger.error('❌ Database listener channel error');
      } else if (status === 'TIMED_OUT') {
        logger.error('❌ Database listener timed out');
      } else if (status === 'CLOSED') {
        logger.warn('⚠️  Database listener closed');
      }
    });

  logger.info('🎧 Database listener subscribed to federation events');
  
  // Log channel state after a moment
  setTimeout(() => {
    logger.info(`📊 Channel state: ${channel.state}`);
  }, 2000);
}

/**
 * Handle new post creation
 */
async function handleNewPost(postEvent: any): Promise<void> {
  try {
    // Check if post should be federated
    if (!postEvent.is_local || !['public', 'unlisted'].includes(postEvent.visibility)) {
      logger.debug(`Skipping federation for post ${postEvent.id}: not public or local`);
      return;
    }

    logger.info(`🌐 Federating new post: ${postEvent.id}`);

    // Get full post data (realtime events might not include all columns)
    const supabase = getSupabaseClient();
    const { data: post } = await supabase
      .from('posts')
      .select('*')
      .eq('id', postEvent.id)
      .single();

    if (!post) {
      logger.error(`Post not found: ${postEvent.id}`);
      return;
    }

    // Get author profile
    const { data: author } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', post.author_id)
      .single();

    if (!author) {
      logger.error(`Author not found for post ${post.id}`);
      return;
    }

    // Determine the type of post:
    // 1. Quote post: has metadata.is_quote AND metadata.reblog_of → Create Note with quoteUrl
    // 2. Pure reblog: has ap_type='Announce' or metadata.reblog_of but NOT is_quote → Announce
    // 3. Regular post: everything else → Create Note
    const isQuotePost = post.metadata?.is_quote && post.metadata?.reblog_of;
    const isPureReblog = !isQuotePost && (post.ap_type === 'Announce' || post.metadata?.reblog_of);
    
    let activity;
    
    if (isQuotePost) {
      // Quote post - create a Note with quoteUrl (handled in createPostActivity)
      logger.info(`📝 Detected quote post, creating Note with quoteUrl`);
      activity = await createPostActivity(post, author);
    } else if (isPureReblog) {
      // Pure reblog - create an Announce activity
      logger.info(`📢 Detected reblog post, creating Announce activity`);
      
      try {
        activity = await createReblogActivity(author, post);
        logger.info(`📢 Created Announce activity for reblog of ${post.metadata?.reblog_of}`);
      } catch (reblogError) {
        logger.error('Failed to create reblog activity:', reblogError);
        return;
      }
    } else {
      // Regular post - create a Create activity with Note
      activity = await createPostActivity(post, author);
    }

    // Broadcast to followers
    await DeliveryQueue.broadcastToFollowers(author.id, activity);
    
    // Also deliver to mentioned users (they might not be followers) - for posts and quote posts
    if (!isPureReblog && Array.isArray(post.content)) {
      const mentions = post.content.filter((part: any) => part.type === 'mention');
      
      for (const mention of mentions) {
        if (!mention.isLocal && mention.domain) {
          // Get mentioned user's inbox
          const { data: mentionedUser } = await supabase
            .from('profiles')
            .select('inbox_url')
            .eq('username', mention.username)
            .eq('domain', mention.domain)
            .single();
          
          if (mentionedUser?.inbox_url) {
            logger.info(`📧 Delivering to mentioned user: ${mention.username}@${mention.domain}`);
            await DeliveryQueue.sendToInbox(mentionedUser.inbox_url, activity, author.id);
          }
        }
      }
    }

    const postType = isQuotePost ? 'Quote post' : isPureReblog ? 'Reblog' : 'Post';
    logger.info(`✅ ${postType} ${post.id} queued for federation`);
  } catch (error) {
    logger.error('Failed to handle new post:', error);
  }
}

/**
 * Handle new reaction
 */
async function handleNewReaction(interaction: any): Promise<void> {
  try {
    const supabase = getSupabaseClient();

    // Get the post to find its author and URL
    const { data: post } = await supabase
      .from('posts')
      .select('id, author_id, ap_id')
      .eq('id', interaction.post_id)
      .single();

    if (!post || !post.ap_id) {
      // Note: For local posts, ap_id is set by a trigger AFTER the INSERT.
      // This realtime listener fires before the trigger runs, so ap_id is null.
      // The reaction federation is handled by the frontend's FederationActivityService
      // which inserts into ap_activities, triggering separate federation.
      logger.debug('Reaction on post without ap_id (likely handled via ap_activities table), skipping realtime handler');
      return;
    }

    // Get user who reacted
    const { data: user } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', interaction.user_id)
      .single();

    if (!user || !user.is_local) {
      logger.debug('Reaction from remote user, skipping');
      return;
    }

    // Get emoji data if it's a custom emoji
    let emojiContent = interaction.custom_emoji_content; // For unicode emojis
    let emojiData = null;
    
    if (interaction.emoji_id) {
      const { data: emoji } = await supabase
        .from('emojis')
        .select('name, url')
        .eq('id', interaction.emoji_id)
        .single();
      
      if (emoji) {
        emojiData = emoji;
        emojiContent = `:${emoji.name}:`; // Misskey format
      }
    }
    
    logger.info(`🌐 Federating reaction: ${emojiContent} on post ${post.id}`);

    // Create Like activity with proper emoji data
    const activity = await createLikeActivity(user, post.ap_id, emojiContent, emojiData);

    // Send to post author's inbox (if remote)
    const { data: postAuthor } = await supabase
      .from('profiles')
      .select('inbox_url, is_local')
      .eq('id', post.author_id)
      .single();

    if (postAuthor && !postAuthor.is_local && postAuthor.inbox_url) {
      await DeliveryQueue.sendToInbox(postAuthor.inbox_url, activity, user.id);
      logger.info(`✅ Reaction queued for delivery to ${postAuthor.inbox_url}`);
    }
  } catch (error) {
    logger.error('Failed to handle new reaction:', error);
  }
}

/**
 * Handle new follow
 */
async function handleNewFollow(follow: any): Promise<void> {
  try {
    const supabase = getSupabaseClient();

    // Get follower (must be local)
    const { data: follower } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', follow.follower_id)
      .single();

    if (!follower || !follower.is_local) {
      logger.debug('Follow from remote user, skipping outgoing federation');
      return;
    }

    // Get following (check if remote)
    const { data: following } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', follow.following_id)
      .single();

    if (!following || following.is_local) {
      logger.debug('Follow of local user, no federation needed');
      return;
    }

    logger.info(`🌐 Federating follow: ${follower.username} → ${following.username}`);

    // Import inside function to avoid circular dependency
    const { createFollowActivity } = await import('./FederationHandlers.js');
    const activity = createFollowActivity(follower, following);

    // Send to following's inbox
    if (following.inbox_url) {
      await DeliveryQueue.sendToInbox(following.inbox_url, activity, follower.id);
      logger.info(`✅ Follow request queued for delivery to ${following.inbox_url}`);
    }
  } catch (error) {
    logger.error('Failed to handle new follow:', error);
  }
}

/**
 * Handle profile update
 */
async function handleProfileUpdate(oldProfile: any, newProfile: any): Promise<void> {
  try {
    // Only federate updates for local users
    if (!newProfile.is_local) {
      logger.debug('Profile update for remote user, skipping');
      return;
    }

    // Check if any federable fields changed
    const fieldsChanged = 
      oldProfile.display_name !== newProfile.display_name ||
      oldProfile.bio !== newProfile.bio ||
      oldProfile.avatar_url !== newProfile.avatar_url ||
      oldProfile.banner_url !== newProfile.banner_url;

    if (!fieldsChanged) {
      logger.debug('No federable fields changed, skipping');
      return;
    }

    logger.info(`🌐 Federating profile update: ${newProfile.username}`);
    logger.info('Changed fields:', {
      display_name: oldProfile.display_name !== newProfile.display_name ? `"${oldProfile.display_name}" → "${newProfile.display_name}"` : 'no change',
      bio: oldProfile.bio !== newProfile.bio ? 'changed' : 'no change',
      avatar_url: oldProfile.avatar_url !== newProfile.avatar_url ? `"${oldProfile.avatar_url}" → "${newProfile.avatar_url}"` : 'no change',
      banner_url: oldProfile.banner_url !== newProfile.banner_url ? `"${oldProfile.banner_url}" → "${newProfile.banner_url}"` : 'no change',
    });

    const supabase = getSupabaseClient();

    // Get full profile data (realtime might not include all fields)
    const { data: profile } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', newProfile.id)
      .single();

    if (!profile) {
      logger.error(`Profile not found: ${newProfile.id}`);
      return;
    }

    // Create Update activity
    const { createProfileUpdateActivity } = await import('./FederationHandlers.js');
    const activity = createProfileUpdateActivity(profile);

    // Log what we're sending
    logger.info('Update activity object:', {
      id: activity.id,
      type: activity.type,
      actor: activity.actor,
      hasIcon: !!activity.object.icon,
      iconUrl: activity.object.icon?.url,
      hasImage: !!activity.object.image,
      imageUrl: activity.object.image?.url,
    });

    // Broadcast to followers
    await DeliveryQueue.broadcastToFollowers(profile.id, activity);

    logger.info(`✅ Profile update for ${profile.username} queued for federation`);
  } catch (error) {
    logger.error('Failed to handle profile update:', error);
  }
}

/**
 * Handle post deletion - send Delete or Undo Announce activity
 */
async function handlePostDeletion(deletedPost: any, _oldPost: any): Promise<void> {
  try {
    const supabase = getSupabaseClient();

    // Get full post data (realtime events may not include all fields)
    const { data: post } = await supabase
      .from('posts')
      .select('*')
      .eq('id', deletedPost.id)
      .single();

    if (!post) {
      logger.error(`Post not found for deletion: ${deletedPost.id}`);
      return;
    }

    // Only federate deletions for local posts
    if (!post.is_local) {
      logger.debug('Deletion of remote post, skipping federation');
      return;
    }

    // Get author profile
    const { data: author } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', post.author_id)
      .single();

    if (!author) {
      logger.error(`Author not found for post deletion: ${post.author_id}`);
      return;
    }

    const { createDeleteActivity, createUndoAnnounceActivity } = await import('./FederationHandlers.js');
    
    // Determine post type:
    // - Quote posts: have metadata.is_quote AND are federated as Notes → send Delete
    // - Pure reblogs: have ap_type='Announce' but NOT is_quote → send Undo Announce
    // - Regular posts: everything else → send Delete
    const isQuotePost = post.metadata?.is_quote;
    const isPureReblog = !isQuotePost && (post.ap_type === 'Announce' || post.metadata?.reblog_of);
    
    let activity;
    let activityType: string;
    
    if (isPureReblog) {
      // This is an unreblog - send Undo Announce
      logger.info(`📢 Detected reblog deletion, creating Undo Announce activity`);
      activity = await createUndoAnnounceActivity(author, post);
      activityType = 'Undo Announce';
    } else {
      // Quote post or regular post deletion - send Delete
      logger.info(`🗑️ Federating ${isQuotePost ? 'quote post' : 'post'} deletion: ${post.id}`);
      activity = createDeleteActivity(author, post);
      activityType = 'Delete';
    }

    // Broadcast to followers
    await DeliveryQueue.broadcastToFollowers(author.id, activity);

    logger.info(`✅ ${activityType} activity for ${post.id} queued for federation`);
  } catch (error) {
    logger.error('Failed to handle post deletion:', error);
  }
}

/**
 * Handle unfollow - send Undo Follow activity
 */
async function handleUnfollow(deletedFollow: any): Promise<void> {
  try {
    if (!deletedFollow) {
      logger.debug('No follow data in deletion event');
      return;
    }

    const supabase = getSupabaseClient();

    // Get follower (must be local)
    const { data: follower } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', deletedFollow.follower_id)
      .single();

    if (!follower || !follower.is_local) {
      logger.debug('Unfollow from remote user, skipping outgoing federation');
      return;
    }

    // Get following (check if remote)
    const { data: following } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', deletedFollow.following_id)
      .single();

    if (!following || following.is_local) {
      logger.debug('Unfollow of local user, no federation needed');
      return;
    }

    logger.info(`🌐 Federating unfollow: ${follower.username} → ${following.username}`);

    const { createUndoFollowActivity } = await import('./FederationHandlers.js');
    const activity = createUndoFollowActivity(follower, following, deletedFollow);

    // Send to following's inbox
    if (following.inbox_url) {
      await DeliveryQueue.sendToInbox(following.inbox_url, activity, follower.id);
      logger.info(`✅ Undo Follow queued for delivery to ${following.inbox_url}`);
    }
  } catch (error) {
    logger.error('Failed to handle unfollow:', error);
  }
}

/**
 * Handle interaction removal - send Undo Like for reactions
 */
async function handleInteractionRemoval(deletedInteraction: any): Promise<void> {
  try {
    if (!deletedInteraction) {
      logger.debug('No interaction data in deletion event');
      return;
    }

    const supabase = getSupabaseClient();

    // Get the user who removed the interaction
    const { data: user } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', deletedInteraction.user_id)
      .single();

    if (!user || !user.is_local) {
      logger.debug('Interaction removal from remote user, skipping');
      return;
    }

    // Get the post
    const { data: post } = await supabase
      .from('posts')
      .select('id, ap_id, author_id')
      .eq('id', deletedInteraction.post_id)
      .single();

    if (!post) {
      logger.debug('Post not found for interaction removal');
      return;
    }

    // Only federate if the post has an ap_id (is federated)
    if (!post.ap_id) {
      // Same as handleNewReaction - ap_id might not be set yet for local posts
      logger.debug('Interaction removal on post without ap_id, skipping realtime handler');
      return;
    }

    // Get post author to send Undo
    const { data: postAuthor } = await supabase
      .from('profiles')
      .select('inbox_url, is_local')
      .eq('id', post.author_id)
      .single();

    // Only need to send if author is remote
    if (!postAuthor || postAuthor.is_local) {
      logger.debug('Post author is local, no federation needed for interaction removal');
      return;
    }

    // Handle based on interaction type
    if (deletedInteraction.interaction_type === 'emoji_reaction' || 
        deletedInteraction.interaction_type === 'favorite') {
      logger.info(`🌐 Federating reaction removal on post ${post.id}`);
      
      const { createUndoLikeActivity } = await import('./FederationHandlers.js');
      const activity = createUndoLikeActivity(user, post.ap_id);

      if (postAuthor.inbox_url) {
        await DeliveryQueue.sendToInbox(postAuthor.inbox_url, activity, user.id);
        logger.info(`✅ Undo Like queued for delivery to ${postAuthor.inbox_url}`);
      }
    }
    // Note: Reblog removals are handled via post deletion (Undo Announce)
  } catch (error) {
    logger.error('Failed to handle interaction removal:', error);
  }
}

/**
 * Handle pin/unpin changes - send Add/Remove activity
 */
async function handlePinChange(post: any, oldPost: any): Promise<void> {
  try {
    const supabase = getSupabaseClient();

    // Get full post data
    const { data: fullPost } = await supabase
      .from('posts')
      .select('*')
      .eq('id', post.id)
      .single();

    if (!fullPost || !fullPost.is_local) {
      logger.debug('Cannot federate pin change for non-local post');
      return;
    }

    // Get author
    const { data: author } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', fullPost.author_id)
      .single();

    if (!author || !author.is_local) {
      return;
    }

    const { createAddToFeaturedActivity, createRemoveFromFeaturedActivity } = await import('./FederationHandlers.js');
    
    const isPinned = post.is_pinned && !oldPost?.is_pinned;
    const isUnpinned = !post.is_pinned && oldPost?.is_pinned;

    let activity;
    if (isPinned) {
      activity = createAddToFeaturedActivity(author, fullPost);
      logger.info(`📌 Federating pin for post ${post.id}`);
    } else if (isUnpinned) {
      activity = createRemoveFromFeaturedActivity(author, fullPost);
      logger.info(`📌 Federating unpin for post ${post.id}`);
    } else {
      return;
    }

    // Get followers to notify
    const { data: followers } = await supabase
      .from('follows')
      .select('follower:profiles!follows_follower_id_fkey(id, inbox_url, is_local, shared_inbox_url)')
      .eq('following_id', author.id)
      .eq('status', 'accepted');

    if (!followers || followers.length === 0) {
      logger.debug('No followers to notify about pin change');
      return;
    }

    // Collect unique inboxes
    const inboxes = new Set<string>();
    for (const follow of followers) {
      const follower = follow.follower as any;
      if (!follower?.is_local && follower?.inbox_url) {
        inboxes.add(follower.shared_inbox_url || follower.inbox_url);
      }
    }

    // Send to all follower inboxes
    for (const inbox of inboxes) {
      await DeliveryQueue.sendToInbox(inbox, activity, author.id);
    }

    logger.info(`📌 Pin change federated to ${inboxes.size} inboxes`);
  } catch (error) {
    logger.error('Failed to handle pin change:', error);
  }
}

/**
 * Handle new block - send Block activity
 */
async function handleNewBlock(block: any): Promise<void> {
  try {
    const supabase = getSupabaseClient();

    // Get blocker
    const { data: blocker } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', block.blocker_id)
      .single();

    // Get blocked user (column is blocked_user_id in user_blocks table)
    const { data: blocked } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', block.blocked_user_id)
      .single();

    if (!blocker?.is_local || !blocked) {
      logger.debug('Block not from local user or blocked user not found');
      return;
    }

    // Only federate if blocked user is remote
    if (blocked.is_local) {
      logger.debug('Blocked user is local, no federation needed');
      return;
    }

    const { createBlockActivity } = await import('./FederationHandlers.js');
    const activity = createBlockActivity(blocker, blocked);

    if (blocked.inbox_url) {
      await DeliveryQueue.sendToInbox(blocked.inbox_url, activity, blocker.id);
      logger.info(`🚫 Block federated to ${blocked.inbox_url}`);
    }
  } catch (error) {
    logger.error('Failed to handle new block:', error);
  }
}

/**
 * Handle unblock - send Undo Block activity
 */
async function handleUnblock(block: any): Promise<void> {
  try {
    if (!block) return;

    const supabase = getSupabaseClient();

    // Get blocker
    const { data: blocker } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', block.blocker_id)
      .single();

    // Get blocked user (column is blocked_user_id in user_blocks table)
    const { data: blocked } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', block.blocked_user_id)
      .single();

    if (!blocker?.is_local || !blocked) {
      return;
    }

    // Only federate if blocked user is remote
    if (blocked.is_local) {
      return;
    }

    const { createUndoBlockActivity } = await import('./FederationHandlers.js');
    const activity = createUndoBlockActivity(blocker, blocked);

    if (blocked.inbox_url) {
      await DeliveryQueue.sendToInbox(blocked.inbox_url, activity, blocker.id);
      logger.info(`✅ Unblock federated to ${blocked.inbox_url}`);
    }
  } catch (error) {
    logger.error('Failed to handle unblock:', error);
  }
}

/**
 * Handle post edit - send Update activity
 */
async function handlePostEdit(editedPost: any, _oldPost: any): Promise<void> {
  try {
    const supabase = getSupabaseClient();

    // Get full post data
    const { data: post } = await supabase
      .from('posts')
      .select('*')
      .eq('id', editedPost.id)
      .single();

    if (!post || !post.is_local) {
      logger.debug('Cannot federate edit for non-local post');
      return;
    }

    // Only federate public/unlisted posts
    if (!['public', 'unlisted'].includes(post.visibility)) {
      logger.debug('Skipping edit federation for private post');
      return;
    }

    // Get author
    const { data: author } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', post.author_id)
      .single();

    if (!author || !author.is_local) {
      return;
    }

    const { createPostUpdateActivity } = await import('./FederationHandlers.js');
    const activity = await createPostUpdateActivity(post, author);

    logger.info(`✏️ Federating post edit: ${post.id}`);

    // Get followers to notify
    const { data: followers } = await supabase
      .from('follows')
      .select('follower:profiles!follows_follower_id_fkey(id, inbox_url, is_local, shared_inbox_url)')
      .eq('following_id', author.id)
      .eq('status', 'accepted');

    if (!followers || followers.length === 0) {
      logger.debug('No followers to notify about post edit');
      return;
    }

    // Collect unique inboxes
    const inboxes = new Set<string>();
    for (const follow of followers) {
      const follower = follow.follower as any;
      if (!follower?.is_local && follower?.inbox_url) {
        inboxes.add(follower.shared_inbox_url || follower.inbox_url);
      }
    }

    // Send to all follower inboxes
    for (const inbox of inboxes) {
      await DeliveryQueue.sendToInbox(inbox, activity, author.id);
    }

    logger.info(`✏️ Post edit federated to ${inboxes.size} inboxes`);
  } catch (error) {
    logger.error('Failed to handle post edit:', error);
  }
}

/**
 * Handle new report - send Flag activity to remote instance
 */
async function handleNewReport(report: any): Promise<void> {
  try {
    // Skip if this report came from federation (source === 'federation')
    if (report.source === 'federation') {
      logger.debug('Report is from federation, not re-federating');
      return;
    }

    const supabase = getSupabaseClient();

    // Get reporter
    const { data: reporter } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', report.reporter_id)
      .single();

    if (!reporter?.is_local) {
      return;
    }

    // Get reported user
    const { data: reportedUser } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', report.reported_user_id)
      .single();

    if (!reportedUser) {
      return;
    }

    // Only federate if reported user is remote
    if (reportedUser.is_local) {
      logger.debug('Reported user is local, no federation needed');
      return;
    }

    // Get reported post if applicable
    let reportedPost = null;
    if (report.reported_post_id) {
      const { data: post } = await supabase
        .from('posts')
        .select('*')
        .eq('id', report.reported_post_id)
        .single();
      reportedPost = post;
    }

    const { createFlagActivity } = await import('./FederationHandlers.js');
    const activity = createFlagActivity(reporter, reportedUser, reportedPost, report.reason);

    // Send to the reported user's instance inbox
    const instanceDomain = reportedUser.domain;
    const instanceInbox = `https://${instanceDomain}/inbox`;

    await DeliveryQueue.sendToInbox(instanceInbox, activity, reporter.id);
    logger.info(`🚩 Report federated to ${instanceInbox}`);
  } catch (error) {
    logger.error('Failed to handle new report:', error);
  }
}

/**
 * Handle new DM messages - federate to remote recipients
 * This replaces the database trigger handle_outgoing_messages for DMs
 */
async function handleNewDM(message: any): Promise<void> {
  try {
    const supabase = getSupabaseClient();
    const domain = config.INSTANCE_DOMAIN;
    
    // Get the sender profile
    const { data: sender } = await supabase
      .from('profiles')
      .select('id, username, display_name, avatar_url, domain, is_local, federated_id')
      .eq('id', message.user_id)
      .single();
    
    if (!sender) {
      logger.warn(`Could not find sender for DM: ${message.user_id}`);
      return;
    }
    
    // Only federate messages from local users
    if (!sender.is_local) {
      logger.debug('Skipping federation for message from remote user');
      return;
    }
    
    // Get all participants in the conversation (excluding sender)
    const { data: participants, error: participantsError } = await supabase
      .from('conversation_participants')
      .select('user_id')
      .eq('conversation_id', message.conversation_id)
      .neq('user_id', message.user_id)
      .is('left_at', null);
    
    if (participantsError) {
      logger.error('Error fetching conversation participants:', participantsError);
      return;
    }
    
    if (!participants || participants.length === 0) {
      logger.debug('No other participants in conversation');
      return;
    }
    
    logger.debug(`Found ${participants.length} participant(s) in conversation`);
    
    // Get profiles for all participants
    const participantIds = participants.map(p => p.user_id);
    const { data: profiles, error: profilesError } = await supabase
      .from('profiles')
      .select('id, username, domain, federated_id, is_local, inbox_url')
      .in('id', participantIds);
    
    if (profilesError) {
      logger.error('Error fetching participant profiles:', profilesError);
      return;
    }
    
    logger.debug(`Fetched ${profiles?.length || 0} profile(s):`, 
      profiles?.map(p => ({ username: p.username, domain: p.domain, is_local: p.is_local }))
    );
    
    // Filter to only remote users (federated users have is_local = false and a domain)
    const remoteUsers = (profiles || []).filter(
      (p: any) => p.is_local === false && p.domain
    );
    
    if (remoteUsers.length === 0) {
      logger.debug('All DM recipients are local (no remote users to federate to)');
      return;
    }
    
    logger.info(`📮 Federating DM to ${remoteUsers.length} remote recipient(s):`, 
      remoteUsers.map((p: any) => `${p.username}@${p.domain}`)
    );
    
    // Build sender URL
    const senderUrl = `https://${domain}/users/${sender.username}`;
    const messageUrl = `https://${domain}/messages/${message.id}`;
    
    // Convert content to HTML
    // Use shared content utilities for consistent HTML conversion
    const htmlContent = convertContentToHTML(message.content);
    
    // Extract attachments and tags using shared utilities
    const attachments = extractAttachments(message.content);
    const tags = extractActivityPubTags(message.content);
    
    // Send to each remote recipient
    for (const profile of remoteUsers) {
      const recipientUrl = profile.federated_id || `https://${profile.domain}/users/${profile.username}`;
      const activityId = `${senderUrl}#dm-${message.id}-${profile.id}`;
      
      // Add recipient as mention tag
      const mentionTag = {
        type: 'Mention',
        href: recipientUrl,
        name: `@${profile.username}@${profile.domain}`
      };
      
      // Create Note object (DM format)
      const note = {
        id: messageUrl,
        type: 'Note',
        attributedTo: senderUrl,
        published: message.created_at,
        content: htmlContent,
        contentMap: { en: htmlContent },
        attachment: attachments,
        tag: [...tags, mentionTag],
        to: [recipientUrl],    // Direct addressing
        cc: [],                // Empty CC for DMs
        directMessage: true    // Explicit DM flag
      };
      
      // Create ActivityPub Create activity
      const activity = {
        '@context': 'https://www.w3.org/ns/activitystreams',
        id: activityId,
        type: 'Create',
        actor: senderUrl,
        published: message.created_at,
        object: note,
        to: [recipientUrl],
        cc: []
      };
      
      // Resolve inbox URL
      let inboxUrl = profile.inbox_url;
      
      if (!inboxUrl) {
        // Try to get shared inbox from instances table
        const { data: instance } = await supabase
          .from('instances')
          .select('shared_inbox_url')
          .eq('domain', profile.domain)
          .single();
        
        inboxUrl = instance?.shared_inbox_url || `https://${profile.domain}/inbox`;
      }
      
      // Deliver the activity
      await DeliveryQueue.enqueue(activity, inboxUrl, sender.id);
      
      logger.info(`✅ DM federated to ${profile.username}@${profile.domain}`);
    }
  } catch (error) {
    logger.error('Error handling DM federation:', error);
  }
}

/**
 * Handle new message reaction (DM reaction federation)
 * When a local user reacts to a DM, federate the Like activity to all remote participants
 */
async function handleNewMessageReaction(reaction: any): Promise<void> {
  try {
    const supabase = getSupabaseClient();
    const domain = config.INSTANCE_DOMAIN;

    // Skip if this is a federated reaction (has federated metadata)
    if (reaction.metadata?.federated) {
      logger.debug('Skipping federated reaction');
      return;
    }

    // Get the user who reacted
    const { data: user } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', reaction.user_id)
      .single();

    if (!user || !user.is_local) {
      logger.debug('Reaction from remote user, skipping outbound federation');
      return;
    }

    // Get the message that was reacted to
    const { data: message } = await supabase
      .from('messages')
      .select('id, user_id, conversation_id')
      .eq('id', reaction.message_id)
      .single();

    if (!message || !message.conversation_id) {
      logger.debug('Message not found or not a DM');
      return;
    }

    // Get all participants in the conversation (not just message author)
    const { data: participants } = await supabase
      .from('conversation_participants')
      .select(`
        user_id,
        profiles!inner (
          id,
          username,
          domain,
          is_local,
          inbox_url,
          federated_id
        )
      `)
      .eq('conversation_id', message.conversation_id)
      .neq('user_id', reaction.user_id) // Exclude the user who reacted
      .is('left_at', null);

    // Filter to only remote participants
    const remoteParticipants = participants?.filter(
      (p: any) => !p.profiles.is_local && p.profiles.domain
    ).map((p: any) => p.profiles);

    if (!remoteParticipants || remoteParticipants.length === 0) {
      logger.debug('No remote participants in conversation, no federation needed');
      return;
    }

    // Get emoji data
    let emojiContent = '❤️'; // Default
    let emojiData = null;

    if (reaction.emoji_id) {
      logger.debug(`Looking up emoji_id: ${reaction.emoji_id}`);
      
      const { data: emoji, error: emojiError } = await supabase
        .from('emojis')
        .select('id, name, url, display_name')
        .eq('id', reaction.emoji_id)
        .single();

      if (emojiError) {
        logger.warn(`Failed to fetch emoji ${reaction.emoji_id}:`, emojiError.message);
      }

      if (emoji) {
        logger.debug(`Found emoji: name=${emoji.name}, display_name=${emoji.display_name}, url=${emoji.url}`);
        emojiData = { name: emoji.name, url: emoji.url };
        
        // Prefer display_name, then name, use shortcode format for custom emojis
        const emojiName = emoji.display_name || emoji.name;
        emojiContent = emoji.url ? `:${emojiName}:` : emojiName;
      } else {
        logger.warn(`Emoji not found for id ${reaction.emoji_id}, using default ❤️`);
      }
    }

    // Build the message URL
    const messageUrl = `https://${domain}/messages/${message.id}`;

    // Create Like activity
    const activity = await createLikeActivity(user, messageUrl, emojiContent, emojiData);

    // Send to all remote participants
    for (const participant of remoteParticipants) {
      logger.info(`🌐 Federating message reaction: ${emojiContent} (emoji_id: ${reaction.emoji_id}) to ${participant.username}@${participant.domain}`);

      const inboxUrl = participant.inbox_url || `https://${participant.domain}/inbox`;
      await DeliveryQueue.sendToInbox(inboxUrl, activity, user.id);
      logger.info(`✅ Message reaction queued for delivery to ${inboxUrl}`);
    }
  } catch (error) {
    logger.error('Failed to handle message reaction:', error);
  }
}

/**
 * Handle message reaction removal (Undo Like for DMs)
 * When a local user removes a reaction from a DM, federate Undo Like to all remote participants
 */
async function handleMessageReactionRemoval(deletedReaction: any): Promise<void> {
  try {
    if (!deletedReaction) {
      logger.debug('No deleted reaction data');
      return;
    }

    const supabase = getSupabaseClient();
    const domain = config.INSTANCE_DOMAIN;

    // Get the user who removed the reaction
    const { data: user } = await supabase
      .from('profiles')
      .select('*')
      .eq('id', deletedReaction.user_id)
      .single();

    if (!user || !user.is_local) {
      logger.debug('Reaction removal from remote user, skipping outbound federation');
      return;
    }

    // Get the message
    const { data: message } = await supabase
      .from('messages')
      .select('id, user_id, conversation_id')
      .eq('id', deletedReaction.message_id)
      .single();

    if (!message || !message.conversation_id) {
      logger.debug('Message not found or not a DM');
      return;
    }

    // Get all participants in the conversation
    const { data: participants } = await supabase
      .from('conversation_participants')
      .select(`
        user_id,
        profiles!inner (
          id,
          username,
          domain,
          is_local,
          inbox_url
        )
      `)
      .eq('conversation_id', message.conversation_id)
      .neq('user_id', deletedReaction.user_id)
      .is('left_at', null);

    // Filter to only remote participants
    const remoteParticipants = participants?.filter(
      (p: any) => !p.profiles.is_local && p.profiles.domain
    ).map((p: any) => p.profiles);

    if (!remoteParticipants || remoteParticipants.length === 0) {
      logger.debug('No remote participants in conversation, no federation needed');
      return;
    }

    // Build the message URL
    const messageUrl = `https://${domain}/messages/${message.id}`;

    // Create Undo Like activity
    const { createUndoLikeActivity } = await import('./FederationHandlers.js');
    const activity = createUndoLikeActivity(user, messageUrl);

    // Send to all remote participants
    for (const participant of remoteParticipants) {
      logger.info(`🌐 Federating message reaction removal to ${participant.username}@${participant.domain}`);

      const inboxUrl = participant.inbox_url || `https://${participant.domain}/inbox`;
      await DeliveryQueue.sendToInbox(inboxUrl, activity, user.id);
      logger.info(`✅ Message Undo Like queued for delivery to ${inboxUrl}`);
    }
  } catch (error) {
    logger.error('Failed to handle message reaction removal:', error);
  }
}

// Content conversion functions are now in utils/contentUtils.ts
// Used by: DMs, Channel Messages, Posts - ensuring consistent federation output
