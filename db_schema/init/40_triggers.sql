-- =============================================================================
-- Harmony Database Schema - Triggers
-- =============================================================================
-- CREATE TRIGGER statements that attach trigger functions to tables
-- =============================================================================

-- ---------------------------------------------------------------------------
-- PROFILE TRIGGERS
-- ---------------------------------------------------------------------------

-- Create notification preferences when profile is created
CREATE TRIGGER create_notification_preferences_trigger
    AFTER INSERT ON public.profiles
    FOR EACH ROW
    EXECUTE FUNCTION public.create_notification_preferences();

-- ---------------------------------------------------------------------------
-- SERVER LIMIT ENFORCEMENT TRIGGERS
-- ---------------------------------------------------------------------------

-- Enforce maximum 100 channels per server
CREATE TRIGGER enforce_channel_limit
    BEFORE INSERT ON public.channels
    FOR EACH ROW
    EXECUTE FUNCTION public.check_channel_limit();

-- Enforce maximum 25 categories per server
CREATE TRIGGER enforce_category_limit
    BEFORE INSERT ON public.channel_categories
    FOR EACH ROW
    EXECUTE FUNCTION public.check_category_limit();

-- ---------------------------------------------------------------------------
-- SERVER TRIGGERS
-- ---------------------------------------------------------------------------

-- Create default role when server is created
CREATE TRIGGER trigger_create_default_role
    AFTER INSERT ON public.servers
    FOR EACH ROW
    EXECUTE FUNCTION public.create_default_server_role();

-- Create default server structure (channels, categories)
CREATE TRIGGER auto_create_default_server_structure
    AFTER INSERT ON public.servers
    FOR EACH ROW
    EXECUTE FUNCTION public.trigger_create_default_server_structure();

-- Assign default role when member joins
CREATE TRIGGER trigger_assign_default_role
    AFTER INSERT OR UPDATE OF status ON public.user_servers
    FOR EACH ROW
    EXECUTE FUNCTION public.assign_default_role_to_member();

-- Set member instance from profile
CREATE TRIGGER auto_set_member_instance
    BEFORE INSERT ON public.user_servers
    FOR EACH ROW
    EXECUTE FUNCTION public.set_member_instance();

-- System message when a user joins a server
CREATE TRIGGER trigger_member_join_system_message
    AFTER INSERT ON public.user_servers
    FOR EACH ROW
    EXECUTE FUNCTION public.handle_member_join_system_message();

-- Prevent deletion of protected roles
CREATE TRIGGER trigger_prevent_protected_role_deletion
    BEFORE DELETE ON public.server_roles
    FOR EACH ROW
    EXECUTE FUNCTION public.prevent_protected_role_deletion();

-- Update channel overrides timestamp
CREATE TRIGGER trigger_channel_overrides_updated_at
    BEFORE UPDATE ON public.channel_permission_overrides
    FOR EACH ROW
    EXECUTE FUNCTION public.update_roles_updated_at();

-- ---------------------------------------------------------------------------
-- TIMELINE TRIGGERS
-- ---------------------------------------------------------------------------

-- Create timeline entries when post is created
CREATE TRIGGER create_comprehensive_timeline_entries_trigger
    AFTER INSERT ON public.posts
    FOR EACH ROW
    EXECUTE FUNCTION public.create_comprehensive_timeline_entries();

-- Add existing posts to new follower timeline
CREATE TRIGGER add_posts_to_new_follower_timeline
    AFTER INSERT OR UPDATE ON public.follows
    FOR EACH ROW
    WHEN (NEW.status = 'accepted')
    EXECUTE FUNCTION public.add_existing_posts_to_new_follower_timeline();

-- Backfill timeline on follow acceptance
CREATE TRIGGER backfill_timeline_on_follow_trigger
    AFTER INSERT OR UPDATE OF status ON public.follows
    FOR EACH ROW
    WHEN (NEW.status = 'accepted')
    EXECUTE FUNCTION public.backfill_timeline_on_follow();

-- Remove timeline entries on unfollow
CREATE TRIGGER remove_timeline_on_unfollow_trigger
    BEFORE DELETE ON public.follows
    FOR EACH ROW
    EXECUTE FUNCTION public.remove_timeline_on_unfollow();

-- ---------------------------------------------------------------------------
-- POST TRIGGERS
-- ---------------------------------------------------------------------------

-- Handle post soft delete
CREATE TRIGGER on_post_soft_delete
    AFTER UPDATE OF is_deleted ON public.posts
    FOR EACH ROW
    EXECUTE FUNCTION public.handle_post_soft_delete();

-- Cascade delete reblogs when original is deleted
CREATE TRIGGER cascade_delete_reblogs_trigger
    AFTER UPDATE OF is_deleted ON public.posts
    FOR EACH ROW
    WHEN ((NEW.is_deleted = true) AND (OLD.is_deleted = false OR OLD.is_deleted IS NULL))
    EXECUTE FUNCTION public.cascade_delete_reblogs();

-- Extract hashtags from posts
CREATE TRIGGER extract_hashtags_on_post_insert
    AFTER INSERT ON public.posts
    FOR EACH ROW
    EXECUTE FUNCTION public.trigger_extract_post_hashtags();

-- ---------------------------------------------------------------------------
-- MESSAGE TRIGGERS
-- ---------------------------------------------------------------------------

-- Update messages.updated_at
CREATE TRIGGER handle_updated_at
    BEFORE INSERT OR UPDATE ON public.messages
    FOR EACH ROW
    EXECUTE FUNCTION public.handle_messages_updated_at();

-- Index message for search
CREATE TRIGGER trigger_index_message
    AFTER INSERT OR UPDATE OF content, channel_id, conversation_id, user_id, is_deleted ON public.messages
    FOR EACH ROW
    EXECUTE FUNCTION public.index_message();

-- Process local link previews
CREATE TRIGGER trg_process_local_link_previews
    BEFORE INSERT ON public.messages
    FOR EACH ROW
    WHEN ((NEW.metadata ->> 'federated') IS DISTINCT FROM 'true')
    EXECUTE FUNCTION public.process_local_link_previews();

-- Process message link previews
CREATE TRIGGER trg_process_message_link_previews
    BEFORE INSERT ON public.messages
    FOR EACH ROW
    WHEN ((NEW.metadata ->> 'federated') IS DISTINCT FROM 'true')
    EXECUTE FUNCTION public.process_message_link_previews();

-- Webhook external link previews
CREATE TRIGGER trg_webhook_external_link_previews
    AFTER INSERT ON public.messages
    FOR EACH ROW
    WHEN ((NEW.metadata ->> 'federated') IS DISTINCT FROM 'true')
    EXECUTE FUNCTION public.webhook_external_link_previews();

-- ---------------------------------------------------------------------------
-- REACTION TRIGGERS
-- ---------------------------------------------------------------------------

-- Check post emoji reaction limit
CREATE TRIGGER trigger_check_emoji_reaction_limit
    BEFORE INSERT ON public.post_interactions
    FOR EACH ROW
    EXECUTE FUNCTION public.check_emoji_reaction_limit();

-- Check message emoji reaction limit
CREATE TRIGGER trigger_check_message_emoji_reaction_limit
    BEFORE INSERT ON public.reactions
    FOR EACH ROW
    EXECUTE FUNCTION public.check_message_emoji_reaction_limit();

-- ---------------------------------------------------------------------------
-- UNIFIED NOTIFICATION TRIGGERS (follows, reactions, post interactions)
-- ---------------------------------------------------------------------------

CREATE TRIGGER trigger_unified_notification_follows
    AFTER INSERT ON public.follows
    FOR EACH ROW
    EXECUTE FUNCTION public.handle_unified_notification_processing();

CREATE TRIGGER trigger_unified_notification_interactions
    AFTER INSERT ON public.post_interactions
    FOR EACH ROW
    EXECUTE FUNCTION public.handle_unified_notification_processing();

CREATE TRIGGER trigger_unified_notification_reactions
    AFTER INSERT ON public.reactions
    FOR EACH ROW
    EXECUTE FUNCTION public.handle_unified_notification_processing();

-- ---------------------------------------------------------------------------
-- PUSH SUBSCRIPTION TRIGGERS
-- ---------------------------------------------------------------------------

-- Update push subscription timestamp
CREATE TRIGGER push_subscriptions_update_timestamp
    BEFORE UPDATE ON public.push_subscriptions
    FOR EACH ROW
    EXECUTE FUNCTION public.update_push_subscription_timestamp();

-- ---------------------------------------------------------------------------
-- NOTIFICATION TRIGGERS
-- ---------------------------------------------------------------------------

-- Increment unread mentions
CREATE TRIGGER trigger_increment_unread_mentions
    AFTER INSERT ON public.notifications
    FOR EACH ROW
    WHEN ((NEW.type)::text = ANY (ARRAY['mention', 'activitypub_mention']::text[]))
    EXECUTE FUNCTION public.increment_unread_mentions();

-- Handle local post mention notifications
CREATE TRIGGER trigger_handle_local_post_mention_notifications
    AFTER INSERT ON public.posts
    FOR EACH ROW
    WHEN ((NEW.is_local = true) AND (NEW.is_federated = false))
    EXECUTE FUNCTION public.handle_local_post_mention_notifications();

-- Handle post mention notifications (all posts)
CREATE TRIGGER trigger_handle_post_mention_notifications
    AFTER INSERT ON public.posts
    FOR EACH ROW
    WHEN (NEW.content IS NOT NULL)
    EXECUTE FUNCTION public.handle_post_mention_notifications();

-- ---------------------------------------------------------------------------
-- FEDERATION TRIGGERS
-- ---------------------------------------------------------------------------

-- Queue post for federation
CREATE TRIGGER trigger_federate_post
    BEFORE INSERT OR UPDATE ON public.posts
    FOR EACH ROW
    WHEN (NEW.is_local = true)
    EXECUTE FUNCTION public.trigger_queue_post_federation();

-- Handle post federation
CREATE TRIGGER trigger_post_federation
    AFTER INSERT ON public.posts
    FOR EACH ROW
    EXECUTE FUNCTION public.handle_post_federation();

-- Queue follow for federation
CREATE TRIGGER trigger_federate_follow
    BEFORE INSERT ON public.follows
    FOR EACH ROW
    EXECUTE FUNCTION public.trigger_queue_follow_federation();

CREATE TRIGGER trigger_federate_follow_delete
    AFTER DELETE ON public.follows
    FOR EACH ROW
    EXECUTE FUNCTION public.trigger_queue_follow_federation();

-- Queue post interaction for federation
CREATE TRIGGER trigger_federate_post_interaction
    BEFORE INSERT ON public.post_interactions
    FOR EACH ROW
    EXECUTE FUNCTION public.trigger_queue_interaction_federation();

CREATE TRIGGER trigger_federate_post_interaction_delete
    AFTER DELETE ON public.post_interactions
    FOR EACH ROW
    EXECUTE FUNCTION public.trigger_queue_interaction_federation();

-- Handle post interaction federation
CREATE TRIGGER trigger_post_interaction_federation
    AFTER INSERT OR DELETE ON public.post_interactions
    FOR EACH ROW
    EXECUTE FUNCTION public.handle_post_interaction_federation();

-- Queue profile update for federation
CREATE TRIGGER trigger_federate_profile
    AFTER UPDATE ON public.profiles
    FOR EACH ROW
    WHEN (NEW.is_local = true)
    EXECUTE FUNCTION public.trigger_queue_profile_federation();

-- Handle remote user suspension
CREATE TRIGGER trigger_handle_remote_user_suspension
    AFTER UPDATE OF is_suspended ON public.profiles
    FOR EACH ROW
    WHEN (NEW.is_suspended = true)
    EXECUTE FUNCTION public.handle_remote_user_suspension();

-- Queue channel message for federation
CREATE TRIGGER trigger_federate_channel_message
    BEFORE INSERT ON public.messages
    FOR EACH ROW
    WHEN ((NEW.channel_id IS NOT NULL) AND (NEW.conversation_id IS NULL))
    EXECUTE FUNCTION public.trigger_queue_channel_message_federation();

-- Smart route channel message
CREATE TRIGGER smart_route_channel_message
    AFTER INSERT ON public.messages
    FOR EACH ROW
    WHEN (NEW.channel_id IS NOT NULL)
    EXECUTE FUNCTION public.route_channel_message();

-- Handle message federation
CREATE TRIGGER trg_handle_message_federation
    AFTER INSERT ON public.messages
    FOR EACH ROW
    EXECUTE FUNCTION public.handle_message_federation();

-- Queue channel message edit for federation
CREATE TRIGGER trigger_federate_channel_message_edit
    AFTER UPDATE OF content ON public.messages
    FOR EACH ROW
    WHEN ((NEW.channel_id IS NOT NULL) AND (NEW.conversation_id IS NULL) AND (NEW.is_deleted = false))
    EXECUTE FUNCTION public.trigger_queue_channel_message_edit_federation();

-- Queue channel message delete for federation
CREATE TRIGGER trigger_federate_channel_message_delete
    AFTER UPDATE OF is_deleted ON public.messages
    FOR EACH ROW
    WHEN ((NEW.channel_id IS NOT NULL) AND (NEW.conversation_id IS NULL) AND (NEW.is_deleted = true) AND (OLD.is_deleted = false))
    EXECUTE FUNCTION public.trigger_queue_channel_message_delete_federation();

-- Queue DM for federation
CREATE TRIGGER trigger_federate_dm
    BEFORE INSERT ON public.messages
    FOR EACH ROW
    WHEN (NEW.conversation_id IS NOT NULL)
    EXECUTE FUNCTION public.trigger_queue_dm_federation();

-- Queue channel reaction for federation
CREATE TRIGGER trigger_federate_channel_reaction
    BEFORE INSERT ON public.reactions
    FOR EACH ROW
    EXECUTE FUNCTION public.trigger_queue_channel_reaction_federation();

CREATE TRIGGER trigger_federate_channel_reaction_delete
    AFTER DELETE ON public.reactions
    FOR EACH ROW
    EXECUTE FUNCTION public.trigger_queue_channel_reaction_delete_federation();

-- Queue message reaction for federation
CREATE TRIGGER trigger_federate_message_reaction
    BEFORE INSERT ON public.reactions
    FOR EACH ROW
    EXECUTE FUNCTION public.trigger_queue_message_reaction_federation();

CREATE TRIGGER trigger_federate_message_reaction_delete
    AFTER DELETE ON public.reactions
    FOR EACH ROW
    EXECUTE FUNCTION public.trigger_queue_message_reaction_federation();

-- Queue block for federation
CREATE TRIGGER trigger_federate_block
    BEFORE INSERT ON public.user_blocks
    FOR EACH ROW
    EXECUTE FUNCTION public.trigger_queue_block_federation();

CREATE TRIGGER trigger_federate_block_delete
    AFTER DELETE ON public.user_blocks
    FOR EACH ROW
    EXECUTE FUNCTION public.trigger_queue_block_federation();

-- Queue report for federation
CREATE TRIGGER trigger_federate_report
    BEFORE INSERT ON public.reports
    FOR EACH ROW
    EXECUTE FUNCTION public.trigger_queue_report_federation();

-- Queue voice channel join/leave for federation
CREATE TRIGGER trigger_federate_voice_channel_join
    BEFORE INSERT ON public.voice_channel_participants
    FOR EACH ROW
    EXECUTE FUNCTION public.trigger_queue_voice_channel_join_federation();

CREATE TRIGGER trigger_federate_voice_channel_leave
    AFTER DELETE ON public.voice_channel_participants
    FOR EACH ROW
    EXECUTE FUNCTION public.trigger_queue_voice_channel_leave_federation();

-- Route server membership changes
CREATE TRIGGER route_membership_federation
    AFTER INSERT OR UPDATE ON public.user_servers
    FOR EACH ROW
    EXECUTE FUNCTION public.route_server_membership();

-- Route server leave
CREATE TRIGGER route_leave_federation
    AFTER DELETE ON public.user_servers
    FOR EACH ROW
    EXECUTE FUNCTION public.route_server_leave();

-- Cleanup dead federation endpoints
CREATE TRIGGER federation_endpoint_health_cleanup_trigger
    AFTER UPDATE OF is_dead ON public.federation_endpoint_health
    FOR EACH ROW
    WHEN ((NEW.is_dead = true) AND (OLD.is_dead IS NULL OR OLD.is_dead = false))
    EXECUTE FUNCTION public.trigger_cleanup_dead_endpoint();

DO $$
BEGIN
    RAISE NOTICE 'Triggers created successfully';
END $$;

