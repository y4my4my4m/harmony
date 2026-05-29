-- =============================================================================
-- Harmony Database Schema - Triggers
-- =============================================================================
-- CREATE TRIGGER statements that attach trigger functions to tables
-- =============================================================================

-- ---------------------------------------------------------------------------
-- PROFILE TRIGGERS
-- ---------------------------------------------------------------------------

-- Sanitize user-controlled profile text (anti-spoofing + length clamp) on all writes
DROP TRIGGER IF EXISTS sanitize_profile_text_trigger ON public.profiles;
CREATE TRIGGER sanitize_profile_text_trigger
    BEFORE INSERT OR UPDATE ON public.profiles
    FOR EACH ROW
    EXECUTE FUNCTION public.sanitize_profile_text();

-- ---------------------------------------------------------------------------
-- USER-INPUT TEXT SANITIZATION (servers/channels/roles/threads/etc.)
-- These BEFORE triggers also cover SECURITY DEFINER RPC write paths
-- (create_thread, update_group_name, ban/kick reasons, emoji reactions).
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS sanitize_server_text_trigger ON public.servers;
CREATE TRIGGER sanitize_server_text_trigger
    BEFORE INSERT OR UPDATE ON public.servers
    FOR EACH ROW EXECUTE FUNCTION public.sanitize_server_text();

DROP TRIGGER IF EXISTS sanitize_channel_text_trigger ON public.channels;
CREATE TRIGGER sanitize_channel_text_trigger
    BEFORE INSERT OR UPDATE ON public.channels
    FOR EACH ROW EXECUTE FUNCTION public.sanitize_channel_text();

DROP TRIGGER IF EXISTS sanitize_category_name_trigger ON public.channel_categories;
CREATE TRIGGER sanitize_category_name_trigger
    BEFORE INSERT OR UPDATE ON public.channel_categories
    FOR EACH ROW EXECUTE FUNCTION public.sanitize_entity_name('100', 'required');

DROP TRIGGER IF EXISTS sanitize_role_name_trigger ON public.server_roles;
CREATE TRIGGER sanitize_role_name_trigger
    BEFORE INSERT OR UPDATE ON public.server_roles
    FOR EACH ROW EXECUTE FUNCTION public.sanitize_entity_name('100', 'required');

DROP TRIGGER IF EXISTS sanitize_thread_name_trigger ON public.threads;
CREATE TRIGGER sanitize_thread_name_trigger
    BEFORE INSERT OR UPDATE ON public.threads
    FOR EACH ROW EXECUTE FUNCTION public.sanitize_entity_name('100', 'required');

DROP TRIGGER IF EXISTS sanitize_conversation_name_trigger ON public.conversations;
CREATE TRIGGER sanitize_conversation_name_trigger
    BEFORE INSERT OR UPDATE ON public.conversations
    FOR EACH ROW EXECUTE FUNCTION public.sanitize_entity_name('100', 'optional');

DROP TRIGGER IF EXISTS sanitize_server_folder_name_trigger ON public.server_folders;
CREATE TRIGGER sanitize_server_folder_name_trigger
    BEFORE INSERT OR UPDATE ON public.server_folders
    FOR EACH ROW EXECUTE FUNCTION public.sanitize_entity_name('64', 'optional');

DROP TRIGGER IF EXISTS sanitize_emoji_name_trigger ON public.emojis;
CREATE TRIGGER sanitize_emoji_name_trigger
    BEFORE INSERT OR UPDATE ON public.emojis
    FOR EACH ROW EXECUTE FUNCTION public.sanitize_entity_name('64', 'optional');

DROP TRIGGER IF EXISTS sanitize_bot_text_trigger ON public.bots;
CREATE TRIGGER sanitize_bot_text_trigger
    BEFORE INSERT OR UPDATE ON public.bots
    FOR EACH ROW EXECUTE FUNCTION public.sanitize_bot_text();

DROP TRIGGER IF EXISTS sanitize_report_text_trigger ON public.reports;
CREATE TRIGGER sanitize_report_text_trigger
    BEFORE INSERT OR UPDATE ON public.reports
    FOR EACH ROW EXECUTE FUNCTION public.sanitize_report_text();

DROP TRIGGER IF EXISTS sanitize_user_list_text_trigger ON public.user_lists;
CREATE TRIGGER sanitize_user_list_text_trigger
    BEFORE INSERT OR UPDATE ON public.user_lists
    FOR EACH ROW EXECUTE FUNCTION public.sanitize_user_list_text();

DROP TRIGGER IF EXISTS sanitize_member_nickname_trigger ON public.user_servers;
CREATE TRIGGER sanitize_member_nickname_trigger
    BEFORE INSERT OR UPDATE ON public.user_servers
    FOR EACH ROW EXECUTE FUNCTION public.sanitize_member_nickname();

DROP TRIGGER IF EXISTS sanitize_post_text_trigger ON public.posts;
CREATE TRIGGER sanitize_post_text_trigger
    BEFORE INSERT OR UPDATE ON public.posts
    FOR EACH ROW EXECUTE FUNCTION public.sanitize_post_text();

-- Promote first local user to instance admin
DROP TRIGGER IF EXISTS promote_first_user_to_admin_trigger ON public.profiles;
CREATE TRIGGER promote_first_user_to_admin_trigger
    BEFORE INSERT ON public.profiles
    FOR EACH ROW
    EXECUTE FUNCTION public.promote_first_user_to_admin();

-- Create notification preferences when profile is created
DROP TRIGGER IF EXISTS create_notification_preferences_trigger ON public.profiles;
CREATE TRIGGER create_notification_preferences_trigger
    AFTER INSERT ON public.profiles
    FOR EACH ROW
    EXECUTE FUNCTION public.create_notification_preferences();

-- ---------------------------------------------------------------------------
-- ACTIVITY COUNTERS (profiles.message_count, profiles.voice_minutes)
-- ---------------------------------------------------------------------------
-- Function bodies live with the triggers themselves to keep this self-contained.
CREATE OR REPLACE FUNCTION public.tg_profile_message_counter()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.user_id IS NOT NULL THEN
            UPDATE public.profiles
               SET message_count = message_count + 1
             WHERE id = NEW.user_id;
        END IF;
        RETURN NEW;
    ELSIF TG_OP = 'DELETE' THEN
        IF OLD.user_id IS NOT NULL THEN
            UPDATE public.profiles
               SET message_count = GREATEST(message_count - 1, 0)
             WHERE id = OLD.user_id;
        END IF;
        RETURN OLD;
    END IF;
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_profile_message_counter_ins ON public.messages;
DROP TRIGGER IF EXISTS trg_profile_message_counter_del ON public.messages;
CREATE TRIGGER trg_profile_message_counter_ins
    AFTER INSERT ON public.messages
    FOR EACH ROW EXECUTE FUNCTION public.tg_profile_message_counter();
CREATE TRIGGER trg_profile_message_counter_del
    AFTER DELETE ON public.messages
    FOR EACH ROW EXECUTE FUNCTION public.tg_profile_message_counter();

-- (Message and post content length limits are enforced via CHECK constraints
--  defined in `02_tables_core.sql` / `04_tables_servers.sql`. See
--  `public.jsonb_text_content_length` for the IMMUTABLE helper used by both.)

CREATE OR REPLACE FUNCTION public.tg_profile_voice_counter()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    minutes bigint;
BEGIN
    IF OLD.user_id IS NULL OR OLD.joined_at IS NULL THEN
        RETURN OLD;
    END IF;
    minutes := GREATEST(
        FLOOR(EXTRACT(EPOCH FROM (now() - OLD.joined_at)) / 60.0)::bigint,
        0
    );
    IF minutes > 0 THEN
        UPDATE public.profiles
           SET voice_minutes = voice_minutes + minutes
         WHERE id = OLD.user_id;
    END IF;
    RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_profile_voice_counter_del ON public.voice_channel_participants;
CREATE TRIGGER trg_profile_voice_counter_del
    AFTER DELETE ON public.voice_channel_participants
    FOR EACH ROW EXECUTE FUNCTION public.tg_profile_voice_counter();

-- ---------------------------------------------------------------------------
-- SERVER LIMIT ENFORCEMENT TRIGGERS
-- ---------------------------------------------------------------------------

-- Enforce maximum 100 channels per server
DROP TRIGGER IF EXISTS enforce_channel_limit ON public.channels;
CREATE TRIGGER enforce_channel_limit
    BEFORE INSERT ON public.channels
    FOR EACH ROW
    EXECUTE FUNCTION public.check_channel_limit();

-- Enforce maximum 25 categories per server
DROP TRIGGER IF EXISTS enforce_category_limit ON public.channel_categories;
CREATE TRIGGER enforce_category_limit
    BEFORE INSERT ON public.channel_categories
    FOR EACH ROW
    EXECUTE FUNCTION public.check_category_limit();

-- ---------------------------------------------------------------------------
-- SERVER TRIGGERS
-- ---------------------------------------------------------------------------

-- Create default role when server is created
DROP TRIGGER IF EXISTS trigger_create_default_role ON public.servers;
CREATE TRIGGER trigger_create_default_role
    AFTER INSERT ON public.servers
    FOR EACH ROW
    EXECUTE FUNCTION public.create_default_server_role();

-- Create default server structure (channels, categories)
DROP TRIGGER IF EXISTS auto_create_default_server_structure ON public.servers;
CREATE TRIGGER auto_create_default_server_structure
    AFTER INSERT ON public.servers
    FOR EACH ROW
    EXECUTE FUNCTION public.trigger_create_default_server_structure();

-- Assign default role when member joins
DROP TRIGGER IF EXISTS trigger_assign_default_role ON public.user_servers;
CREATE TRIGGER trigger_assign_default_role
    AFTER INSERT OR UPDATE OF status ON public.user_servers
    FOR EACH ROW
    EXECUTE FUNCTION public.assign_default_role_to_member();

-- Set member instance from profile
DROP TRIGGER IF EXISTS auto_set_member_instance ON public.user_servers;
CREATE TRIGGER auto_set_member_instance
    BEFORE INSERT ON public.user_servers
    FOR EACH ROW
    EXECUTE FUNCTION public.set_member_instance();

-- System message when a user joins a server
DROP TRIGGER IF EXISTS trigger_member_join_system_message ON public.user_servers;
CREATE TRIGGER trigger_member_join_system_message
    AFTER INSERT ON public.user_servers
    FOR EACH ROW
    EXECUTE FUNCTION public.handle_member_join_system_message();

-- Prevent deletion of protected roles
DROP TRIGGER IF EXISTS trigger_prevent_protected_role_deletion ON public.server_roles;
CREATE TRIGGER trigger_prevent_protected_role_deletion
    BEFORE DELETE ON public.server_roles
    FOR EACH ROW
    EXECUTE FUNCTION public.prevent_protected_role_deletion();

-- Update channel overrides timestamp
DROP TRIGGER IF EXISTS trigger_channel_overrides_updated_at ON public.channel_permission_overrides;
CREATE TRIGGER trigger_channel_overrides_updated_at
    BEFORE UPDATE ON public.channel_permission_overrides
    FOR EACH ROW
    EXECUTE FUNCTION public.update_roles_updated_at();

-- ---------------------------------------------------------------------------
-- TIMELINE TRIGGERS
-- ---------------------------------------------------------------------------

-- Create timeline entries when post is created
DROP TRIGGER IF EXISTS create_comprehensive_timeline_entries_trigger ON public.posts;
CREATE TRIGGER create_comprehensive_timeline_entries_trigger
    AFTER INSERT ON public.posts
    FOR EACH ROW
    EXECUTE FUNCTION public.create_comprehensive_timeline_entries();

-- Home-feed realtime push per recipient (local + remote, no Node hop).
DROP TRIGGER IF EXISTS trg_broadcast_home_feed_entry ON public.timeline_entries;
CREATE TRIGGER trg_broadcast_home_feed_entry
    AFTER INSERT ON public.timeline_entries
    FOR EACH ROW
    EXECUTE FUNCTION public.broadcast_home_feed_entry();

-- Add existing posts to new follower timeline
DROP TRIGGER IF EXISTS add_posts_to_new_follower_timeline ON public.follows;
CREATE TRIGGER add_posts_to_new_follower_timeline
    AFTER INSERT OR UPDATE ON public.follows
    FOR EACH ROW
    WHEN (NEW.status = 'accepted')
    EXECUTE FUNCTION public.add_existing_posts_to_new_follower_timeline();

-- Backfill timeline on follow acceptance
DROP TRIGGER IF EXISTS backfill_timeline_on_follow_trigger ON public.follows;
CREATE TRIGGER backfill_timeline_on_follow_trigger
    AFTER INSERT OR UPDATE OF status ON public.follows
    FOR EACH ROW
    WHEN (NEW.status = 'accepted')
    EXECUTE FUNCTION public.backfill_timeline_on_follow();

-- Remove timeline entries on unfollow
DROP TRIGGER IF EXISTS remove_timeline_on_unfollow_trigger ON public.follows;
CREATE TRIGGER remove_timeline_on_unfollow_trigger
    BEFORE DELETE ON public.follows
    FOR EACH ROW
    EXECUTE FUNCTION public.remove_timeline_on_unfollow();

-- Keep profiles.followers_count / following_count in sync with `follows`.
DROP TRIGGER IF EXISTS trg_update_follow_counts ON public.follows;
CREATE TRIGGER trg_update_follow_counts
    AFTER INSERT OR UPDATE OF status OR DELETE ON public.follows
    FOR EACH ROW
    EXECUTE FUNCTION public.update_follow_counts();

-- ---------------------------------------------------------------------------
-- POST TRIGGERS
-- ---------------------------------------------------------------------------

-- Handle post soft delete
DROP TRIGGER IF EXISTS on_post_soft_delete ON public.posts;
CREATE TRIGGER on_post_soft_delete
    AFTER UPDATE OF is_deleted ON public.posts
    FOR EACH ROW
    EXECUTE FUNCTION public.handle_post_soft_delete();

-- Cascade delete reblogs when original is deleted
DROP TRIGGER IF EXISTS cascade_delete_reblogs_trigger ON public.posts;
CREATE TRIGGER cascade_delete_reblogs_trigger
    AFTER UPDATE OF is_deleted ON public.posts
    FOR EACH ROW
    WHEN ((NEW.is_deleted = true) AND (OLD.is_deleted = false OR OLD.is_deleted IS NULL))
    EXECUTE FUNCTION public.cascade_delete_reblogs();

-- Extract hashtags from posts
DROP TRIGGER IF EXISTS extract_hashtags_on_post_insert ON public.posts;
CREATE TRIGGER extract_hashtags_on_post_insert
    AFTER INSERT ON public.posts
    FOR EACH ROW
    EXECUTE FUNCTION public.trigger_extract_post_hashtags();

-- ---------------------------------------------------------------------------
-- MESSAGE TRIGGERS
-- ---------------------------------------------------------------------------

-- Update messages.updated_at
DROP TRIGGER IF EXISTS handle_updated_at ON public.messages;
CREATE TRIGGER handle_updated_at
    BEFORE INSERT OR UPDATE ON public.messages
    FOR EACH ROW
    EXECUTE FUNCTION public.handle_messages_updated_at();

-- Index message for search
DROP TRIGGER IF EXISTS trigger_index_message ON public.messages;
CREATE TRIGGER trigger_index_message
    AFTER INSERT OR UPDATE OF content, channel_id, conversation_id, user_id, is_deleted ON public.messages
    FOR EACH ROW
    EXECUTE FUNCTION public.index_message();

-- Process local link previews (Harmony post URLs only, pure SQL, no HTTP)
-- External URLs are enriched by the federation backend asynchronously
DROP TRIGGER IF EXISTS trg_process_local_link_previews ON public.messages;
CREATE TRIGGER trg_process_local_link_previews
    BEFORE INSERT ON public.messages
    FOR EACH ROW
    WHEN ((NEW.metadata ->> 'federated') IS DISTINCT FROM 'true')
    EXECUTE FUNCTION public.process_local_link_previews();

-- ---------------------------------------------------------------------------
-- REACTION TRIGGERS
-- ---------------------------------------------------------------------------

-- Update favorites_count / reblogs_count on post interactions
DROP TRIGGER IF EXISTS trigger_update_post_reaction_counts ON public.post_interactions;
CREATE TRIGGER trigger_update_post_reaction_counts
    AFTER INSERT OR DELETE ON public.post_interactions
    FOR EACH ROW
    EXECUTE FUNCTION public.update_post_reaction_counts();

-- Check post emoji reaction limit
DROP TRIGGER IF EXISTS trigger_check_emoji_reaction_limit ON public.post_interactions;
CREATE TRIGGER trigger_check_emoji_reaction_limit
    BEFORE INSERT ON public.post_interactions
    FOR EACH ROW
    EXECUTE FUNCTION public.check_emoji_reaction_limit();

-- Check message emoji reaction limit
DROP TRIGGER IF EXISTS trigger_check_message_emoji_reaction_limit ON public.reactions;
CREATE TRIGGER trigger_check_message_emoji_reaction_limit
    BEFORE INSERT ON public.reactions
    FOR EACH ROW
    EXECUTE FUNCTION public.check_message_emoji_reaction_limit();

-- ---------------------------------------------------------------------------
-- UNIFIED NOTIFICATION TRIGGERS (follows, reactions, post interactions)
-- ---------------------------------------------------------------------------

DROP TRIGGER IF EXISTS trigger_unified_notification_follows ON public.follows;
CREATE TRIGGER trigger_unified_notification_follows
    AFTER INSERT ON public.follows
    FOR EACH ROW
    EXECUTE FUNCTION public.handle_unified_notification_processing();

DROP TRIGGER IF EXISTS trigger_unified_notification_interactions ON public.post_interactions;
CREATE TRIGGER trigger_unified_notification_interactions
    AFTER INSERT ON public.post_interactions
    FOR EACH ROW
    EXECUTE FUNCTION public.handle_unified_notification_processing();

DROP TRIGGER IF EXISTS trigger_unified_notification_reactions ON public.reactions;
CREATE TRIGGER trigger_unified_notification_reactions
    AFTER INSERT ON public.reactions
    FOR EACH ROW
    EXECUTE FUNCTION public.handle_unified_notification_processing();

-- ---------------------------------------------------------------------------
-- PUSH SUBSCRIPTION TRIGGERS
-- ---------------------------------------------------------------------------

-- Update push subscription timestamp
DROP TRIGGER IF EXISTS push_subscriptions_update_timestamp ON public.push_subscriptions;
CREATE TRIGGER push_subscriptions_update_timestamp
    BEFORE UPDATE ON public.push_subscriptions
    FOR EACH ROW
    EXECUTE FUNCTION public.update_push_subscription_timestamp();

-- ---------------------------------------------------------------------------
-- NOTIFICATION TRIGGERS
-- ---------------------------------------------------------------------------

-- Increment unread mentions
DROP TRIGGER IF EXISTS trigger_increment_unread_mentions ON public.notifications;
CREATE TRIGGER trigger_increment_unread_mentions
    AFTER INSERT ON public.notifications
    FOR EACH ROW
    WHEN ((NEW.type)::text = ANY (ARRAY['mention', 'activitypub_mention']::text[]))
    EXECUTE FUNCTION public.increment_unread_mentions();

-- Handle local post mention notifications
DROP TRIGGER IF EXISTS trigger_handle_local_post_mention_notifications ON public.posts;
CREATE TRIGGER trigger_handle_local_post_mention_notifications
    AFTER INSERT ON public.posts
    FOR EACH ROW
    WHEN ((NEW.is_local = true) AND (NEW.is_federated = false))
    EXECUTE FUNCTION public.handle_local_post_mention_notifications();

-- Handle post mention notifications (all posts)
DROP TRIGGER IF EXISTS trigger_handle_post_mention_notifications ON public.posts;
CREATE TRIGGER trigger_handle_post_mention_notifications
    AFTER INSERT ON public.posts
    FOR EACH ROW
    WHEN (NEW.content IS NOT NULL)
    EXECUTE FUNCTION public.handle_post_mention_notifications();

-- Handle post reply notifications
DROP TRIGGER IF EXISTS trigger_handle_post_reply_notifications ON public.posts;
CREATE TRIGGER trigger_handle_post_reply_notifications
    AFTER INSERT ON public.posts
    FOR EACH ROW
    WHEN (NEW.in_reply_to IS NOT NULL)
    EXECUTE FUNCTION public.handle_post_reply_notifications();

-- ---------------------------------------------------------------------------
-- FEDERATION TRIGGERS
-- ---------------------------------------------------------------------------

-- On INSERT: default updated_at to created_at so federated posts don't appear edited
DROP TRIGGER IF EXISTS handle_posts_insert_updated_at ON public.posts;
CREATE TRIGGER handle_posts_insert_updated_at
    BEFORE INSERT ON public.posts
    FOR EACH ROW
    EXECUTE FUNCTION public.handle_posts_insert_updated_at();

-- Auto-set is_sensitive for posts by force_sensitive authors
DROP TRIGGER IF EXISTS enforce_force_sensitive_on_posts ON public.posts;
CREATE TRIGGER enforce_force_sensitive_on_posts
    BEFORE INSERT ON public.posts
    FOR EACH ROW
    EXECUTE FUNCTION public.enforce_force_sensitive();

-- Set updated_at on content edits (not on federation_status or count changes)
DROP TRIGGER IF EXISTS handle_posts_updated_at ON public.posts;
CREATE TRIGGER handle_posts_updated_at
    BEFORE UPDATE ON public.posts
    FOR EACH ROW
    EXECUTE FUNCTION public.handle_posts_updated_at();

-- Queue post for federation
DROP TRIGGER IF EXISTS trigger_federate_post ON public.posts;
CREATE TRIGGER trigger_federate_post
    BEFORE INSERT OR UPDATE ON public.posts
    FOR EACH ROW
    WHEN (NEW.is_local = true)
    EXECUTE FUNCTION public.trigger_queue_post_federation();

-- Handle post federation
DROP TRIGGER IF EXISTS trigger_post_federation ON public.posts;
CREATE TRIGGER trigger_post_federation
    AFTER INSERT ON public.posts
    FOR EACH ROW
    EXECUTE FUNCTION public.handle_post_federation();

-- Queue follow for federation
DROP TRIGGER IF EXISTS trigger_federate_follow ON public.follows;
CREATE TRIGGER trigger_federate_follow
    BEFORE INSERT ON public.follows
    FOR EACH ROW
    EXECUTE FUNCTION public.trigger_queue_follow_federation();

DROP TRIGGER IF EXISTS trigger_federate_follow_delete ON public.follows;
CREATE TRIGGER trigger_federate_follow_delete
    AFTER DELETE ON public.follows
    FOR EACH ROW
    EXECUTE FUNCTION public.trigger_queue_follow_federation();

-- Queue post interaction for federation
DROP TRIGGER IF EXISTS trigger_federate_post_interaction ON public.post_interactions;
CREATE TRIGGER trigger_federate_post_interaction
    BEFORE INSERT ON public.post_interactions
    FOR EACH ROW
    EXECUTE FUNCTION public.trigger_queue_interaction_federation();

DROP TRIGGER IF EXISTS trigger_federate_post_interaction_delete ON public.post_interactions;
CREATE TRIGGER trigger_federate_post_interaction_delete
    AFTER DELETE ON public.post_interactions
    FOR EACH ROW
    EXECUTE FUNCTION public.trigger_queue_interaction_federation();

-- Handle post interaction federation
DROP TRIGGER IF EXISTS trigger_post_interaction_federation ON public.post_interactions;
CREATE TRIGGER trigger_post_interaction_federation
    AFTER INSERT OR DELETE ON public.post_interactions
    FOR EACH ROW
    EXECUTE FUNCTION public.handle_post_interaction_federation();

-- Queue profile update for federation
DROP TRIGGER IF EXISTS trigger_federate_profile ON public.profiles;
CREATE TRIGGER trigger_federate_profile
    AFTER UPDATE ON public.profiles
    FOR EACH ROW
    WHEN (NEW.is_local = true)
    EXECUTE FUNCTION public.trigger_queue_profile_federation();

-- Handle remote user suspension
DROP TRIGGER IF EXISTS trigger_handle_remote_user_suspension ON public.profiles;
CREATE TRIGGER trigger_handle_remote_user_suspension
    AFTER UPDATE OF is_suspended ON public.profiles
    FOR EACH ROW
    WHEN (NEW.is_suspended = true)
    EXECUTE FUNCTION public.handle_remote_user_suspension();

-- Queue channel message for federation
DROP TRIGGER IF EXISTS trigger_federate_channel_message ON public.messages;
CREATE TRIGGER trigger_federate_channel_message
    BEFORE INSERT ON public.messages
    FOR EACH ROW
    WHEN ((NEW.channel_id IS NOT NULL) AND (NEW.conversation_id IS NULL))
    EXECUTE FUNCTION public.trigger_queue_channel_message_federation();

-- Smart route channel message
DROP TRIGGER IF EXISTS smart_route_channel_message ON public.messages;
CREATE TRIGGER smart_route_channel_message
    AFTER INSERT ON public.messages
    FOR EACH ROW
    WHEN (NEW.channel_id IS NOT NULL)
    EXECUTE FUNCTION public.route_channel_message();

-- Handle message federation (DM/group-chat/mention notifications)
DROP TRIGGER IF EXISTS trg_handle_message_federation ON public.messages;
CREATE TRIGGER trg_handle_message_federation
    AFTER INSERT ON public.messages
    FOR EACH ROW
    EXECUTE FUNCTION public.handle_message_federation();

-- Notify user when added to a conversation
DROP TRIGGER IF EXISTS trg_conversation_participant_added ON public.conversation_participants;
CREATE TRIGGER trg_conversation_participant_added
    AFTER INSERT ON public.conversation_participants
    FOR EACH ROW
    EXECUTE FUNCTION public.handle_conversation_participant_added();

-- Queue federation when a group participant leaves
DROP TRIGGER IF EXISTS trg_group_participant_left ON public.conversation_participants;
CREATE TRIGGER trg_group_participant_left
    AFTER UPDATE ON public.conversation_participants
    FOR EACH ROW
    EXECUTE FUNCTION public.handle_group_participant_left();

-- Queue channel message edit for federation
DROP TRIGGER IF EXISTS trigger_federate_channel_message_edit ON public.messages;
CREATE TRIGGER trigger_federate_channel_message_edit
    AFTER UPDATE OF content ON public.messages
    FOR EACH ROW
    WHEN ((NEW.channel_id IS NOT NULL) AND (NEW.conversation_id IS NULL) AND (NEW.is_deleted = false))
    EXECUTE FUNCTION public.trigger_queue_channel_message_edit_federation();

-- Queue channel message delete for federation
DROP TRIGGER IF EXISTS trigger_federate_channel_message_delete ON public.messages;
CREATE TRIGGER trigger_federate_channel_message_delete
    AFTER UPDATE OF is_deleted ON public.messages
    FOR EACH ROW
    WHEN ((NEW.channel_id IS NOT NULL) AND (NEW.conversation_id IS NULL) AND (NEW.is_deleted = true) AND (OLD.is_deleted = false))
    EXECUTE FUNCTION public.trigger_queue_channel_message_delete_federation();

-- Queue DM for federation
DROP TRIGGER IF EXISTS trigger_federate_dm ON public.messages;
CREATE TRIGGER trigger_federate_dm
    BEFORE INSERT ON public.messages
    FOR EACH ROW
    WHEN (NEW.conversation_id IS NOT NULL)
    EXECUTE FUNCTION public.trigger_queue_dm_federation();

-- Queue channel reaction for federation
DROP TRIGGER IF EXISTS trigger_federate_channel_reaction ON public.reactions;
CREATE TRIGGER trigger_federate_channel_reaction
    BEFORE INSERT ON public.reactions
    FOR EACH ROW
    EXECUTE FUNCTION public.trigger_queue_channel_reaction_federation();

DROP TRIGGER IF EXISTS trigger_federate_channel_reaction_delete ON public.reactions;
CREATE TRIGGER trigger_federate_channel_reaction_delete
    AFTER DELETE ON public.reactions
    FOR EACH ROW
    EXECUTE FUNCTION public.trigger_queue_channel_reaction_delete_federation();

-- Queue message reaction for federation
DROP TRIGGER IF EXISTS trigger_federate_message_reaction ON public.reactions;
CREATE TRIGGER trigger_federate_message_reaction
    BEFORE INSERT ON public.reactions
    FOR EACH ROW
    EXECUTE FUNCTION public.trigger_queue_message_reaction_federation();

DROP TRIGGER IF EXISTS trigger_federate_message_reaction_delete ON public.reactions;
CREATE TRIGGER trigger_federate_message_reaction_delete
    AFTER DELETE ON public.reactions
    FOR EACH ROW
    EXECUTE FUNCTION public.trigger_queue_message_reaction_federation();

-- Queue block for federation
DROP TRIGGER IF EXISTS trigger_federate_block ON public.user_blocks;
CREATE TRIGGER trigger_federate_block
    BEFORE INSERT ON public.user_blocks
    FOR EACH ROW
    EXECUTE FUNCTION public.trigger_queue_block_federation();

DROP TRIGGER IF EXISTS trigger_federate_block_delete ON public.user_blocks;
CREATE TRIGGER trigger_federate_block_delete
    AFTER DELETE ON public.user_blocks
    FOR EACH ROW
    EXECUTE FUNCTION public.trigger_queue_block_federation();

-- Queue channel CRUD for federation
DROP TRIGGER IF EXISTS trigger_federate_channel ON public.channels;
CREATE TRIGGER trigger_federate_channel
    BEFORE INSERT OR UPDATE ON public.channels
    FOR EACH ROW
    EXECUTE FUNCTION public.trigger_queue_channel_federation();

DROP TRIGGER IF EXISTS trigger_federate_channel_delete ON public.channels;
CREATE TRIGGER trigger_federate_channel_delete
    AFTER DELETE ON public.channels
    FOR EACH ROW
    EXECUTE FUNCTION public.trigger_queue_channel_federation();

-- Queue category CRUD for federation
DROP TRIGGER IF EXISTS trigger_federate_category ON public.channel_categories;
CREATE TRIGGER trigger_federate_category
    BEFORE INSERT OR UPDATE ON public.channel_categories
    FOR EACH ROW
    EXECUTE FUNCTION public.trigger_queue_category_federation();

DROP TRIGGER IF EXISTS trigger_federate_category_delete ON public.channel_categories;
CREATE TRIGGER trigger_federate_category_delete
    AFTER DELETE ON public.channel_categories
    FOR EACH ROW
    EXECUTE FUNCTION public.trigger_queue_category_federation();

-- Queue server update for federation
DROP TRIGGER IF EXISTS trigger_federate_server_update ON public.servers;
CREATE TRIGGER trigger_federate_server_update
    AFTER UPDATE ON public.servers
    FOR EACH ROW
    EXECUTE FUNCTION public.trigger_queue_server_update_federation();

-- Queue report for federation
DROP TRIGGER IF EXISTS trigger_federate_report ON public.reports;
CREATE TRIGGER trigger_federate_report
    BEFORE INSERT ON public.reports
    FOR EACH ROW
    EXECUTE FUNCTION public.trigger_queue_report_federation();

-- Queue voice channel join/leave for federation
DROP TRIGGER IF EXISTS trigger_federate_voice_channel_join ON public.voice_channel_participants;
CREATE TRIGGER trigger_federate_voice_channel_join
    BEFORE INSERT ON public.voice_channel_participants
    FOR EACH ROW
    EXECUTE FUNCTION public.trigger_queue_voice_channel_join_federation();

DROP TRIGGER IF EXISTS trigger_federate_voice_channel_leave ON public.voice_channel_participants;
CREATE TRIGGER trigger_federate_voice_channel_leave
    AFTER DELETE ON public.voice_channel_participants
    FOR EACH ROW
    EXECUTE FUNCTION public.trigger_queue_voice_channel_leave_federation();

-- Route server membership changes
DROP TRIGGER IF EXISTS route_membership_federation ON public.user_servers;
CREATE TRIGGER route_membership_federation
    AFTER INSERT OR UPDATE ON public.user_servers
    FOR EACH ROW
    EXECUTE FUNCTION public.route_server_membership();

-- Route server leave
DROP TRIGGER IF EXISTS route_leave_federation ON public.user_servers;
CREATE TRIGGER route_leave_federation
    AFTER DELETE ON public.user_servers
    FOR EACH ROW
    EXECUTE FUNCTION public.route_server_leave();

-- Cleanup dead federation endpoints
DROP TRIGGER IF EXISTS federation_endpoint_health_cleanup_trigger ON public.federation_endpoint_health;
CREATE TRIGGER federation_endpoint_health_cleanup_trigger
    AFTER UPDATE OF is_dead ON public.federation_endpoint_health
    FOR EACH ROW
    WHEN ((NEW.is_dead = true) AND (OLD.is_dead IS NULL OR OLD.is_dead = false))
    EXECUTE FUNCTION public.trigger_cleanup_dead_endpoint();

-- Federate thread creation/updates
DROP TRIGGER IF EXISTS trigger_federate_thread ON public.threads;
CREATE TRIGGER trigger_federate_thread
    BEFORE INSERT OR UPDATE ON public.threads
    FOR EACH ROW
    EXECUTE FUNCTION public.trigger_queue_thread_federation();

-- Unpin message on soft-delete
DROP TRIGGER IF EXISTS trigger_unpin_on_delete ON public.messages;
CREATE TRIGGER trigger_unpin_on_delete
    BEFORE UPDATE OF is_deleted ON public.messages
    FOR EACH ROW
    WHEN (NEW.is_deleted = true AND OLD.is_deleted = false AND OLD.is_pinned = true)
    EXECUTE FUNCTION public.handle_pinned_message_delete();

-- =========================================================================
-- User Event Broadcast triggers (Phase 1 scalability)
-- These call realtime.send() to push compact events to the user's
-- broadcast channel, eliminating per-table postgres_changes subscriptions
-- for notifications and unread_counts.
-- =========================================================================

DROP TRIGGER IF EXISTS trg_broadcast_notification ON public.notifications;
CREATE TRIGGER trg_broadcast_notification
    AFTER INSERT OR UPDATE ON public.notifications
    FOR EACH ROW
    EXECUTE FUNCTION public.broadcast_notification_event();

DROP TRIGGER IF EXISTS trg_broadcast_unread_count ON public.unread_counts;
CREATE TRIGGER trg_broadcast_unread_count
    AFTER INSERT OR UPDATE OR DELETE ON public.unread_counts
    FOR EACH ROW
    EXECUTE FUNCTION public.broadcast_unread_count_event();

-- Phase 2: DM conversations, user servers, server metadata
DROP TRIGGER IF EXISTS trg_broadcast_conversation_participant ON public.conversation_participants;
CREATE TRIGGER trg_broadcast_conversation_participant
    AFTER INSERT ON public.conversation_participants
    FOR EACH ROW
    EXECUTE FUNCTION public.broadcast_conversation_participant_event();

DROP TRIGGER IF EXISTS trg_broadcast_user_server ON public.user_servers;
CREATE TRIGGER trg_broadcast_user_server
    AFTER INSERT OR DELETE ON public.user_servers
    FOR EACH ROW
    EXECUTE FUNCTION public.broadcast_user_server_event();

DROP TRIGGER IF EXISTS trg_broadcast_server_change ON public.servers;
CREATE TRIGGER trg_broadcast_server_change
    AFTER UPDATE ON public.servers
    FOR EACH ROW
    EXECUTE FUNCTION public.broadcast_server_change_event();

DROP TRIGGER IF EXISTS trg_broadcast_encryption_settings ON public.server_encryption_settings;
DROP TRIGGER IF EXISTS trg_broadcast_server_settings ON public.server_encryption_settings;
CREATE TRIGGER trg_broadcast_server_settings
    AFTER INSERT OR UPDATE ON public.server_encryption_settings
    FOR EACH ROW
    EXECUTE FUNCTION public.broadcast_server_settings_change();

-- Server structure broadcasts (channels, categories, threads, membership, roles, permissions)
DROP TRIGGER IF EXISTS trg_broadcast_channel_change ON public.channels;
CREATE TRIGGER trg_broadcast_channel_change
    AFTER INSERT OR UPDATE OR DELETE ON public.channels
    FOR EACH ROW
    EXECUTE FUNCTION public.broadcast_channel_change();

DROP TRIGGER IF EXISTS trg_broadcast_category_change ON public.channel_categories;
CREATE TRIGGER trg_broadcast_category_change
    AFTER INSERT OR UPDATE OR DELETE ON public.channel_categories
    FOR EACH ROW
    EXECUTE FUNCTION public.broadcast_category_change();

DROP TRIGGER IF EXISTS trg_broadcast_membership_event ON public.server_membership_events;
CREATE TRIGGER trg_broadcast_membership_event
    AFTER INSERT ON public.server_membership_events
    FOR EACH ROW
    EXECUTE FUNCTION public.broadcast_membership_event();

DROP TRIGGER IF EXISTS trg_broadcast_thread_change ON public.threads;
CREATE TRIGGER trg_broadcast_thread_change
    AFTER INSERT OR UPDATE OR DELETE ON public.threads
    FOR EACH ROW
    EXECUTE FUNCTION public.broadcast_thread_change();

DROP TRIGGER IF EXISTS trg_broadcast_role_change ON public.server_roles;
CREATE TRIGGER trg_broadcast_role_change
    AFTER INSERT OR UPDATE OR DELETE ON public.server_roles
    FOR EACH ROW
    EXECUTE FUNCTION public.broadcast_role_change();

DROP TRIGGER IF EXISTS trg_broadcast_user_role_change ON public.user_roles;
CREATE TRIGGER trg_broadcast_user_role_change
    AFTER INSERT OR DELETE ON public.user_roles
    FOR EACH ROW
    EXECUTE FUNCTION public.broadcast_user_role_change();

DROP TRIGGER IF EXISTS trg_broadcast_permission_override ON public.channel_permission_overrides;
CREATE TRIGGER trg_broadcast_permission_override
    AFTER INSERT OR UPDATE OR DELETE ON public.channel_permission_overrides
    FOR EACH ROW
    EXECUTE FUNCTION public.broadcast_permission_override_change();

-- Snapshot post_interactions.custom_emoji_content before emoji delete
DROP TRIGGER IF EXISTS trg_prepare_emoji_deletion ON public.emojis;
CREATE TRIGGER trg_prepare_emoji_deletion
    BEFORE DELETE ON public.emojis
    FOR EACH ROW
    EXECUTE FUNCTION public.prepare_emoji_deletion();

-- Emoji broadcasts → server-presence:{server_id}
DROP TRIGGER IF EXISTS trg_broadcast_emoji_change ON public.emojis;
CREATE TRIGGER trg_broadcast_emoji_change
    AFTER INSERT OR UPDATE OR DELETE ON public.emojis
    FOR EACH ROW
    EXECUTE FUNCTION public.broadcast_emoji_change();

-- Key request broadcasts → user:{user_id}
DROP TRIGGER IF EXISTS trg_broadcast_key_request_event ON public.megolm_key_requests;
CREATE TRIGGER trg_broadcast_key_request_event
    AFTER INSERT OR UPDATE ON public.megolm_key_requests
    FOR EACH ROW
    EXECUTE FUNCTION public.broadcast_key_request_event();

-- Conversation update broadcasts → user:{participant_id}
DROP TRIGGER IF EXISTS trg_broadcast_conversation_updated ON public.conversations;
CREATE TRIGGER trg_broadcast_conversation_updated
    AFTER UPDATE ON public.conversations
    FOR EACH ROW
    EXECUTE FUNCTION public.broadcast_conversation_updated();

-- Protected role modification guard
DROP TRIGGER IF EXISTS trigger_prevent_protected_role_modification ON public.server_roles;
CREATE TRIGGER trigger_prevent_protected_role_modification
    BEFORE UPDATE ON public.server_roles
    FOR EACH ROW
    EXECUTE FUNCTION public.prevent_protected_role_modification();

-- Presence broadcasts (member join/leave, profile changes)
DROP TRIGGER IF EXISTS trg_broadcast_user_server_change ON public.user_servers;
CREATE TRIGGER trg_broadcast_user_server_change
    AFTER INSERT OR DELETE ON public.user_servers
    FOR EACH ROW
    EXECUTE FUNCTION public.broadcast_user_server_change();

DROP TRIGGER IF EXISTS trg_broadcast_profile_change ON public.profiles;
CREATE TRIGGER trg_broadcast_profile_change
    AFTER UPDATE ON public.profiles
    FOR EACH ROW
    EXECUTE FUNCTION public.broadcast_profile_change();

-- User-scoped broadcasts (mutes, blocks)
DROP TRIGGER IF EXISTS trg_broadcast_user_mute ON public.user_mutes;
CREATE TRIGGER trg_broadcast_user_mute
    AFTER INSERT OR DELETE ON public.user_mutes
    FOR EACH ROW
    EXECUTE FUNCTION public.broadcast_user_mute_change();

DROP TRIGGER IF EXISTS trg_broadcast_user_block ON public.user_blocks;
CREATE TRIGGER trg_broadcast_user_block
    AFTER INSERT OR DELETE ON public.user_blocks
    FOR EACH ROW
    EXECUTE FUNCTION public.broadcast_user_block_change();

-- ---------------------------------------------------------------------------
-- Unread count triggers
-- ---------------------------------------------------------------------------
CREATE UNIQUE INDEX IF NOT EXISTS idx_unread_counts_user_channel
    ON public.unread_counts(user_id, channel_id) WHERE channel_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_unread_counts_user_conversation
    ON public.unread_counts(user_id, conversation_id) WHERE conversation_id IS NOT NULL;

DROP TRIGGER IF EXISTS trigger_new_message_unread ON public.messages;
CREATE TRIGGER trigger_new_message_unread
    AFTER INSERT ON public.messages
    FOR EACH ROW
    WHEN (NEW.channel_id IS NOT NULL AND NEW.is_deleted = false AND NEW.is_system = false)
    EXECUTE FUNCTION public.handle_new_message_unread();

DROP TRIGGER IF EXISTS trigger_new_dm_unread ON public.messages;
CREATE TRIGGER trigger_new_dm_unread
    AFTER INSERT ON public.messages
    FOR EACH ROW
    WHEN (NEW.conversation_id IS NOT NULL AND NEW.is_deleted = false AND NEW.is_system = false)
    EXECUTE FUNCTION public.handle_new_dm_unread();

-- ---------------------------------------------------------------------------
-- Thread message insert: auto-add member + update stats
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS trigger_thread_message_insert ON public.messages;
CREATE TRIGGER trigger_thread_message_insert
    AFTER INSERT ON public.messages
    FOR EACH ROW
    WHEN (NEW.thread_id IS NOT NULL)
    EXECUTE FUNCTION public.thread_message_handler();

-- ---------------------------------------------------------------------------
-- Thread message delete: decrement count + update last message
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS trigger_thread_message_delete ON public.messages;
CREATE TRIGGER trigger_thread_message_delete
    AFTER DELETE OR UPDATE OF is_deleted ON public.messages
    FOR EACH ROW
    WHEN (OLD.thread_id IS NOT NULL)
    EXECUTE FUNCTION public.thread_message_delete_handler();

-- ---------------------------------------------------------------------------
-- Thread reply notification trigger
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS trigger_thread_reply_notification ON public.messages;
CREATE TRIGGER trigger_thread_reply_notification
    AFTER INSERT ON public.messages
    FOR EACH ROW
    WHEN (NEW.thread_id IS NOT NULL AND NEW.is_deleted = false AND NEW.is_system = false)
    EXECUTE FUNCTION public.handle_thread_reply_notification();

-- ---------------------------------------------------------------------------
-- Role mention notification trigger
-- ---------------------------------------------------------------------------
DROP TRIGGER IF EXISTS trigger_role_mention_notifications ON public.messages;
CREATE TRIGGER trigger_role_mention_notifications
    AFTER INSERT ON public.messages
    FOR EACH ROW
    WHEN (NEW.channel_id IS NOT NULL AND NEW.is_system = false)
    EXECUTE FUNCTION public.handle_role_mention_notifications();

-- =========================================================================
-- ActivityPub broadcast triggers: posts, interactions, follows
-- =========================================================================
DROP TRIGGER IF EXISTS trg_broadcast_post_event ON public.posts;
CREATE TRIGGER trg_broadcast_post_event
    AFTER INSERT OR UPDATE OR DELETE ON public.posts
    FOR EACH ROW
    EXECUTE FUNCTION public.broadcast_post_event();

DROP TRIGGER IF EXISTS trg_broadcast_post_interaction ON public.post_interactions;
CREATE TRIGGER trg_broadcast_post_interaction
    AFTER INSERT OR DELETE ON public.post_interactions
    FOR EACH ROW
    EXECUTE FUNCTION public.broadcast_post_interaction_event();

DROP TRIGGER IF EXISTS trg_broadcast_follow_event ON public.follows;
CREATE TRIGGER trg_broadcast_follow_event
    AFTER INSERT OR UPDATE OR DELETE ON public.follows
    FOR EACH ROW
    EXECUTE FUNCTION public.broadcast_follow_event();

DO $$
BEGIN
    RAISE NOTICE 'Triggers created successfully';
END $$;

