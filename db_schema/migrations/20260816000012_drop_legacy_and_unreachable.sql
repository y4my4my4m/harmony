-- Removes code that production carries and the repository does not: the
-- database-side ActivityPub pipeline, 75 unreachable functions, a duplicate
-- follow-counter trigger, and two leftover tables.
--
-- Every statement is IF EXISTS and none of these objects exist in init/, so this
-- is a no-op against a fresh build and the drift gate stays green.
--
-- ---------------------------------------------------------------------------
-- 1. The database-side ActivityPub pipeline
-- ---------------------------------------------------------------------------
-- unified_activitypub_processing_trigger fires AFTER UPDATE on ap_activities
-- whenever status becomes 'processing', and runs a full inbound pipeline:
-- Follow, Accept, Reject, Undo, Create, Update, Delete, Like and Announce, with
-- its own retry counter and exponential backoff.
--
-- federation-backend does the same work. InboxHandler stores the activity,
-- calls claim_ap_activity - which sets status = 'processing' - and then calls
-- ActivityProcessor.processIncomingActivity on the same activity. The claim was
-- meant as an idempotency guard for the worker; instead it is what starts the
-- database pipeline, so every inbound federated activity is processed twice.
--
-- This is not a fallback. claim_ap_activity is called only by
-- federation-backend, and the inbox HTTP endpoint lives in federation-backend,
-- so if that service is down no activity arrives and nothing sets 'processing'.
-- The pipeline's only entry point is an action by the service it would have to
-- be standing in for. The two halves do not even agree on a vocabulary: the
-- trigger writes status 'processed', complete_ap_activity writes 'completed'.
--
-- The 18 functions below are reachable only from that trigger; the one outside
-- caller, process_ap_activity_on_update, is itself on the unreachable list.

BEGIN;

-- Each DROP FUNCTION is wrapped so a dependency skips that one statement rather
-- than aborting the run. Against production this changes nothing: every name
-- here was checked for a trigger binding, a caller among the surviving
-- functions, a policy/view/default reference and an rpc() call site, and all
-- four are empty. Other instances carry bindings production does not - a local
-- dev database still has trigger_unified_profile_federation on profiles - and
-- there the function is left in place and named, which is the honest outcome:
-- something still uses it there.

DROP TRIGGER IF EXISTS unified_activitypub_processing_trigger ON public.ap_activities;

DO $do$ BEGIN
    DROP FUNCTION IF EXISTS public.build_emoji_reaction_activity(p_interaction_id uuid, p_user_id uuid, p_post_id uuid, p_emoji_id uuid, p_custom_emoji_content text, p_is_undo boolean);
EXCEPTION WHEN dependent_objects_still_exist THEN
    RAISE NOTICE 'kept (still referenced here): %', 'build_emoji_reaction_activity';
END $do$;
DO $do$ BEGIN
    DROP FUNCTION IF EXISTS public.build_post_create_activity(p_post_id uuid, p_author_id uuid);
EXCEPTION WHEN dependent_objects_still_exist THEN
    RAISE NOTICE 'kept (still referenced here): %', 'build_post_create_activity';
END $do$;
DO $do$ BEGIN
    DROP FUNCTION IF EXISTS public.convert_ap_to_jsonb(html_content text, tags jsonb);
EXCEPTION WHEN dependent_objects_still_exist THEN
    RAISE NOTICE 'kept (still referenced here): %', 'convert_ap_to_jsonb';
END $do$;
DO $do$ BEGIN
    DROP FUNCTION IF EXISTS public.convert_content_to_html(p_content jsonb, p_instance_domain text);
EXCEPTION WHEN dependent_objects_still_exist THEN
    RAISE NOTICE 'kept (still referenced here): %', 'convert_content_to_html';
END $do$;
DO $do$ BEGIN
    DROP FUNCTION IF EXISTS public.handle_activitypub_activity_processing();
EXCEPTION WHEN dependent_objects_still_exist THEN
    RAISE NOTICE 'kept (still referenced here): %', 'handle_activitypub_activity_processing';
END $do$;
DO $do$ BEGIN
    DROP FUNCTION IF EXISTS public.handle_incoming_messages(activity_id uuid, activity_data jsonb, actor_profile record, instance_domain text);
EXCEPTION WHEN dependent_objects_still_exist THEN
    RAISE NOTICE 'kept (still referenced here): %', 'handle_incoming_messages';
END $do$;
DO $do$ BEGIN
    DROP FUNCTION IF EXISTS public.is_activitypub_direct_message(object_data jsonb, instance_domain text);
EXCEPTION WHEN dependent_objects_still_exist THEN
    RAISE NOTICE 'kept (still referenced here): %', 'is_activitypub_direct_message';
END $do$;
DO $do$ BEGIN
    DROP FUNCTION IF EXISTS public.process_accept_activity(activity_id uuid, activity_data jsonb, actor_profile record);
EXCEPTION WHEN dependent_objects_still_exist THEN
    RAISE NOTICE 'kept (still referenced here): %', 'process_accept_activity';
END $do$;
DO $do$ BEGIN
    DROP FUNCTION IF EXISTS public.process_activitypub_public_post(activity_id uuid, activity_data jsonb, actor_profile record, instance_domain text);
EXCEPTION WHEN dependent_objects_still_exist THEN
    RAISE NOTICE 'kept (still referenced here): %', 'process_activitypub_public_post';
END $do$;
DO $do$ BEGIN
    DROP FUNCTION IF EXISTS public.process_announce_activity(activity_id uuid, activity_data jsonb, actor_profile record);
EXCEPTION WHEN dependent_objects_still_exist THEN
    RAISE NOTICE 'kept (still referenced here): %', 'process_announce_activity';
END $do$;
DO $do$ BEGIN
    DROP FUNCTION IF EXISTS public.process_create_activity(activity_id uuid, activity_data jsonb, actor_profile record, instance_domain text);
EXCEPTION WHEN dependent_objects_still_exist THEN
    RAISE NOTICE 'kept (still referenced here): %', 'process_create_activity';
END $do$;
DO $do$ BEGIN
    DROP FUNCTION IF EXISTS public.process_delete_activity(activity_id uuid, activity_data jsonb, actor_profile record);
EXCEPTION WHEN dependent_objects_still_exist THEN
    RAISE NOTICE 'kept (still referenced here): %', 'process_delete_activity';
END $do$;
DO $do$ BEGIN
    DROP FUNCTION IF EXISTS public.process_follow_activity(activity_id uuid, activity_data jsonb, actor_profile record, instance_domain text);
EXCEPTION WHEN dependent_objects_still_exist THEN
    RAISE NOTICE 'kept (still referenced here): %', 'process_follow_activity';
END $do$;
DO $do$ BEGIN
    DROP FUNCTION IF EXISTS public.process_like_activity(activity_id uuid, activity_data jsonb, actor_profile record);
EXCEPTION WHEN dependent_objects_still_exist THEN
    RAISE NOTICE 'kept (still referenced here): %', 'process_like_activity';
END $do$;
DO $do$ BEGIN
    DROP FUNCTION IF EXISTS public.process_reject_activity(activity_id uuid, activity_data jsonb, actor_profile record);
EXCEPTION WHEN dependent_objects_still_exist THEN
    RAISE NOTICE 'kept (still referenced here): %', 'process_reject_activity';
END $do$;
DO $do$ BEGIN
    DROP FUNCTION IF EXISTS public.process_undo_activity(activity_id uuid, activity_data jsonb, actor_profile record);
EXCEPTION WHEN dependent_objects_still_exist THEN
    RAISE NOTICE 'kept (still referenced here): %', 'process_undo_activity';
END $do$;
DO $do$ BEGIN
    DROP FUNCTION IF EXISTS public.process_update_activity(activity_id uuid, activity_data jsonb, actor_profile record);
EXCEPTION WHEN dependent_objects_still_exist THEN
    RAISE NOTICE 'kept (still referenced here): %', 'process_update_activity';
END $do$;
DO $do$ BEGIN
    DROP FUNCTION IF EXISTS public.strip_mentions_from_dm_content(content jsonb);
EXCEPTION WHEN dependent_objects_still_exist THEN
    RAISE NOTICE 'kept (still referenced here): %', 'strip_mentions_from_dm_content';
END $do$;

-- ---------------------------------------------------------------------------
-- 2. Unreachable functions
-- ---------------------------------------------------------------------------
-- scripts/find-unreachable.sh produced this list; each name was then re-checked
-- against a production dump for a trigger binding, a caller among the functions
-- that survive this migration, a reference from a policy, view, column default
-- or constraint, and an rpc() call site in src/, federation-backend/src or
-- bot-gateway/src. All four are empty for all 75.
--
-- None is defined in init/ or in any migration, so nothing in the repository
-- loses a definition here.
--
-- Dropped rather than revoked because 20260809000001 already revoked the
-- client-facing surface and a release has passed. Restoring one means restoring
-- its definition from a dump, which is why this migration is the record of what
-- was removed.

DO $do$ BEGIN
    DROP FUNCTION IF EXISTS public.check_timeline_health(p_user_id uuid);
EXCEPTION WHEN dependent_objects_still_exist THEN
    RAISE NOTICE 'kept (still referenced here): %', 'check_timeline_health';
END $do$;
DO $do$ BEGIN
    DROP FUNCTION IF EXISTS public.classify_activitypub_activity(p_activity_data jsonb, p_instance_domain text);
EXCEPTION WHEN dependent_objects_still_exist THEN
    RAISE NOTICE 'kept (still referenced here): %', 'classify_activitypub_activity';
END $do$;
DO $do$ BEGIN
    DROP FUNCTION IF EXISTS public.cleanup_expired_key_requests();
EXCEPTION WHEN dependent_objects_still_exist THEN
    RAISE NOTICE 'kept (still referenced here): %', 'cleanup_expired_key_requests';
END $do$;
DO $do$ BEGIN
    DROP FUNCTION IF EXISTS public.cleanup_old_federation_deliveries();
EXCEPTION WHEN dependent_objects_still_exist THEN
    RAISE NOTICE 'kept (still referenced here): %', 'cleanup_old_federation_deliveries';
END $do$;
DO $do$ BEGIN
    DROP FUNCTION IF EXISTS public.cleanup_stale_view_contexts();
EXCEPTION WHEN dependent_objects_still_exist THEN
    RAISE NOTICE 'kept (still referenced here): %', 'cleanup_stale_view_contexts';
END $do$;
DO $do$ BEGIN
    DROP FUNCTION IF EXISTS public.count_unused_recovery_codes(p_user_id uuid);
EXCEPTION WHEN dependent_objects_still_exist THEN
    RAISE NOTICE 'kept (still referenced here): %', 'count_unused_recovery_codes';
END $do$;
DO $do$ BEGIN
    DROP FUNCTION IF EXISTS public.create_activitypub_note_activity(post_id uuid);
EXCEPTION WHEN dependent_objects_still_exist THEN
    RAISE NOTICE 'kept (still referenced here): %', 'create_activitypub_note_activity';
END $do$;
DO $do$ BEGIN
    DROP FUNCTION IF EXISTS public.create_default_role();
EXCEPTION WHEN dependent_objects_still_exist THEN
    RAISE NOTICE 'kept (still referenced here): %', 'create_default_role';
END $do$;
DO $do$ BEGIN
    DROP FUNCTION IF EXISTS public.create_system_message(p_channel_id uuid, p_message_type text, p_data jsonb);
EXCEPTION WHEN dependent_objects_still_exist THEN
    RAISE NOTICE 'kept (still referenced here): %', 'create_system_message';
END $do$;
DO $do$ BEGIN
    DROP FUNCTION IF EXISTS public.extract_activitypub_emoji_tags(content jsonb);
EXCEPTION WHEN dependent_objects_still_exist THEN
    RAISE NOTICE 'kept (still referenced here): %', 'extract_activitypub_emoji_tags';
END $do$;
DO $do$ BEGIN
    DROP FUNCTION IF EXISTS public.extract_activitypub_hashtag_tags(content jsonb);
EXCEPTION WHEN dependent_objects_still_exist THEN
    RAISE NOTICE 'kept (still referenced here): %', 'extract_activitypub_hashtag_tags';
END $do$;
DO $do$ BEGIN
    DROP FUNCTION IF EXISTS public.extract_activitypub_tags(content jsonb);
EXCEPTION WHEN dependent_objects_still_exist THEN
    RAISE NOTICE 'kept (still referenced here): %', 'extract_activitypub_tags';
END $do$;
DO $do$ BEGIN
    DROP FUNCTION IF EXISTS public.extract_custom_emoji_for_federation(content_text text);
EXCEPTION WHEN dependent_objects_still_exist THEN
    RAISE NOTICE 'kept (still referenced here): %', 'extract_custom_emoji_for_federation';
END $do$;
DO $do$ BEGIN
    DROP FUNCTION IF EXISTS public.extract_mentions(content jsonb);
EXCEPTION WHEN dependent_objects_still_exist THEN
    RAISE NOTICE 'kept (still referenced here): %', 'extract_mentions';
END $do$;
DO $do$ BEGIN
    DROP FUNCTION IF EXISTS public.get_encryption_session(p_local_user_id uuid, p_remote_user_id uuid, p_local_device_id text, p_remote_device_id text);
EXCEPTION WHEN dependent_objects_still_exist THEN
    RAISE NOTICE 'kept (still referenced here): %', 'get_encryption_session';
END $do$;
DO $do$ BEGIN
    DROP FUNCTION IF EXISTS public.get_featured_posts_hybrid(p_author_id uuid, p_limit integer);
EXCEPTION WHEN dependent_objects_still_exist THEN
    RAISE NOTICE 'kept (still referenced here): %', 'get_featured_posts_hybrid';
END $do$;
DO $do$ BEGIN
    DROP FUNCTION IF EXISTS public.get_federation_config();
EXCEPTION WHEN dependent_objects_still_exist THEN
    RAISE NOTICE 'kept (still referenced here): %', 'get_federation_config';
END $do$;
DO $do$ BEGIN
    DROP FUNCTION IF EXISTS public.get_follow_status(current_user_id uuid, target_user_id uuid);
EXCEPTION WHEN dependent_objects_still_exist THEN
    RAISE NOTICE 'kept (still referenced here): %', 'get_follow_status';
END $do$;
DO $do$ BEGIN
    DROP FUNCTION IF EXISTS public.get_instance_config(p_key text);
EXCEPTION WHEN dependent_objects_still_exist THEN
    RAISE NOTICE 'kept (still referenced here): %', 'get_instance_config';
END $do$;
DO $do$ BEGIN
    DROP FUNCTION IF EXISTS public.get_or_create_conversation(user1_uuid uuid, user2_uuid uuid);
EXCEPTION WHEN dependent_objects_still_exist THEN
    RAISE NOTICE 'kept (still referenced here): %', 'get_or_create_conversation';
END $do$;
DO $do$ BEGIN
    DROP FUNCTION IF EXISTS public.get_pinned_messages(p_channel_id uuid, p_conversation_id uuid);
EXCEPTION WHEN dependent_objects_still_exist THEN
    RAISE NOTICE 'kept (still referenced here): %', 'get_pinned_messages';
END $do$;
DO $do$ BEGIN
    DROP FUNCTION IF EXISTS public.get_public_instance_info();
EXCEPTION WHEN dependent_objects_still_exist THEN
    RAISE NOTICE 'kept (still referenced here): %', 'get_public_instance_info';
END $do$;
DO $do$ BEGIN
    DROP FUNCTION IF EXISTS public.get_recent_admin_activity(p_limit integer);
EXCEPTION WHEN dependent_objects_still_exist THEN
    RAISE NOTICE 'kept (still referenced here): %', 'get_recent_admin_activity';
END $do$;
DO $do$ BEGIN
    DROP FUNCTION IF EXISTS public.get_server_encryption_policy(p_server_id uuid);
EXCEPTION WHEN dependent_objects_still_exist THEN
    RAISE NOTICE 'kept (still referenced here): %', 'get_server_encryption_policy';
END $do$;
DO $do$ BEGIN
    DROP FUNCTION IF EXISTS public.get_system_stats();
EXCEPTION WHEN dependent_objects_still_exist THEN
    RAISE NOTICE 'kept (still referenced here): %', 'get_system_stats';
END $do$;
DO $do$ BEGIN
    DROP FUNCTION IF EXISTS public.get_user_bookmarks(p_user_id uuid, p_limit integer, p_cursor timestamp with time zone);
EXCEPTION WHEN dependent_objects_still_exist THEN
    RAISE NOTICE 'kept (still referenced here): %', 'get_user_bookmarks';
END $do$;
DO $do$ BEGIN
    DROP FUNCTION IF EXISTS public.get_user_conversations_with_participants(user_uuid uuid);
EXCEPTION WHEN dependent_objects_still_exist THEN
    RAISE NOTICE 'kept (still referenced here): %', 'get_user_conversations_with_participants';
END $do$;
DO $do$ BEGIN
    DROP FUNCTION IF EXISTS public.get_user_featured_posts(p_author_id uuid, p_limit integer);
EXCEPTION WHEN dependent_objects_still_exist THEN
    RAISE NOTICE 'kept (still referenced here): %', 'get_user_featured_posts';
END $do$;
DO $do$ BEGIN
    DROP FUNCTION IF EXISTS public.get_user_id_from_username(username_param text);
EXCEPTION WHEN dependent_objects_still_exist THEN
    RAISE NOTICE 'kept (still referenced here): %', 'get_user_id_from_username';
END $do$;
DO $do$ BEGIN
    DROP FUNCTION IF EXISTS public.get_user_private_key(p_user_id uuid);
EXCEPTION WHEN dependent_objects_still_exist THEN
    RAISE NOTICE 'kept (still referenced here): %', 'get_user_private_key';
END $do$;
DO $do$ BEGIN
    DROP FUNCTION IF EXISTS public.get_users_needing_prekeys(p_threshold integer);
EXCEPTION WHEN dependent_objects_still_exist THEN
    RAISE NOTICE 'kept (still referenced here): %', 'get_users_needing_prekeys';
END $do$;
DO $do$ BEGIN
    DROP FUNCTION IF EXISTS public.handle_outgoing_messages();
EXCEPTION WHEN dependent_objects_still_exist THEN
    RAISE NOTICE 'kept (still referenced here): %', 'handle_outgoing_messages';
END $do$;
DO $do$ BEGIN
    DROP FUNCTION IF EXISTS public.handle_post_reactions_federation();
EXCEPTION WHEN dependent_objects_still_exist THEN
    RAISE NOTICE 'kept (still referenced here): %', 'handle_post_reactions_federation';
END $do$;
DO $do$ BEGIN
    DROP FUNCTION IF EXISTS public.handle_profile_update_federation();
EXCEPTION WHEN dependent_objects_still_exist THEN
    RAISE NOTICE 'kept (still referenced here): %', 'handle_profile_update_federation';
END $do$;
DO $do$ BEGIN
    DROP FUNCTION IF EXISTS public.handle_reactions_federation();
EXCEPTION WHEN dependent_objects_still_exist THEN
    RAISE NOTICE 'kept (still referenced here): %', 'handle_reactions_federation';
END $do$;
DO $do$ BEGIN
    DROP FUNCTION IF EXISTS public.handle_unified_profile_federation();
EXCEPTION WHEN dependent_objects_still_exist THEN
    RAISE NOTICE 'kept (still referenced here): %', 'handle_unified_profile_federation';
END $do$;
DO $do$ BEGIN
    DROP FUNCTION IF EXISTS public.increment_session_message_count(p_session_id uuid);
EXCEPTION WHEN dependent_objects_still_exist THEN
    RAISE NOTICE 'kept (still referenced here): %', 'increment_session_message_count';
END $do$;
DO $do$ BEGIN
    DROP FUNCTION IF EXISTS public.insert_ap_activity_safe(p_ap_id text, p_ap_type text, p_actor_ap_id text, p_activity_data jsonb, p_origin_domain text, p_to_addresses text[], p_cc_addresses text[], p_is_local boolean);
EXCEPTION WHEN dependent_objects_still_exist THEN
    RAISE NOTICE 'kept (still referenced here): %', 'insert_ap_activity_safe';
END $do$;
DO $do$ BEGIN
    DROP FUNCTION IF EXISTS public.is_emoji_reaction_activity(p_activity jsonb);
EXCEPTION WHEN dependent_objects_still_exist THEN
    RAISE NOTICE 'kept (still referenced here): %', 'is_emoji_reaction_activity';
END $do$;
DO $do$ BEGIN
    DROP FUNCTION IF EXISTS public.is_local_user(p_user_id uuid);
EXCEPTION WHEN dependent_objects_still_exist THEN
    RAISE NOTICE 'kept (still referenced here): %', 'is_local_user';
END $do$;
DO $do$ BEGIN
    DROP FUNCTION IF EXISTS public.is_user_in_conversation(user_uuid uuid, conversation_uuid uuid);
EXCEPTION WHEN dependent_objects_still_exist THEN
    RAISE NOTICE 'kept (still referenced here): %', 'is_user_in_conversation';
END $do$;
DO $do$ BEGIN
    DROP FUNCTION IF EXISTS public.is_user_suspended(p_user_id uuid);
EXCEPTION WHEN dependent_objects_still_exist THEN
    RAISE NOTICE 'kept (still referenced here): %', 'is_user_suspended';
END $do$;
DO $do$ BEGIN
    DROP FUNCTION IF EXISTS public.log_activity_processing_event(p_activity_id uuid, p_ap_id text, p_ap_type text, p_status text, p_error_message text);
EXCEPTION WHEN dependent_objects_still_exist THEN
    RAISE NOTICE 'kept (still referenced here): %', 'log_activity_processing_event';
END $do$;
DO $do$ BEGIN
    DROP FUNCTION IF EXISTS public.make_absolute_url(base_url text, candidate text);
EXCEPTION WHEN dependent_objects_still_exist THEN
    RAISE NOTICE 'kept (still referenced here): %', 'make_absolute_url';
END $do$;
DO $do$ BEGIN
    DROP FUNCTION IF EXISTS public.mark_instance_reachable(p_domain text);
EXCEPTION WHEN dependent_objects_still_exist THEN
    RAISE NOTICE 'kept (still referenced here): %', 'mark_instance_reachable';
END $do$;
DO $do$ BEGIN
    DROP FUNCTION IF EXISTS public.mark_instance_unreachable(p_domain text);
EXCEPTION WHEN dependent_objects_still_exist THEN
    RAISE NOTICE 'kept (still referenced here): %', 'mark_instance_unreachable';
END $do$;
DO $do$ BEGIN
    DROP FUNCTION IF EXISTS public.mark_notification_read(notification_id uuid);
EXCEPTION WHEN dependent_objects_still_exist THEN
    RAISE NOTICE 'kept (still referenced here): %', 'mark_notification_read';
END $do$;
DO $do$ BEGIN
    DROP FUNCTION IF EXISTS public.mark_notifications_read(p_user_id uuid, p_notification_ids uuid[]);
EXCEPTION WHEN dependent_objects_still_exist THEN
    RAISE NOTICE 'kept (still referenced here): %', 'mark_notifications_read';
END $do$;
DO $do$ BEGIN
    DROP FUNCTION IF EXISTS public.moderate_instance(p_admin_id uuid, p_domain text, p_action text, p_reason text);
EXCEPTION WHEN dependent_objects_still_exist THEN
    RAISE NOTICE 'kept (still referenced here): %', 'moderate_instance';
END $do$;
DO $do$ BEGIN
    DROP FUNCTION IF EXISTS public.normalize_hashtag(tag text);
EXCEPTION WHEN dependent_objects_still_exist THEN
    RAISE NOTICE 'kept (still referenced here): %', 'normalize_hashtag';
END $do$;
DO $do$ BEGIN
    DROP FUNCTION IF EXISTS public.notify_federation_event();
EXCEPTION WHEN dependent_objects_still_exist THEN
    RAISE NOTICE 'kept (still referenced here): %', 'notify_federation_event';
END $do$;
DO $do$ BEGIN
    DROP FUNCTION IF EXISTS public.notify_new_activity();
EXCEPTION WHEN dependent_objects_still_exist THEN
    RAISE NOTICE 'kept (still referenced here): %', 'notify_new_activity';
END $do$;
DO $do$ BEGIN
    DROP FUNCTION IF EXISTS public.pause_activitypub_cron_jobs();
EXCEPTION WHEN dependent_objects_still_exist THEN
    RAISE NOTICE 'kept (still referenced here): %', 'pause_activitypub_cron_jobs';
END $do$;
DO $do$ BEGIN
    DROP FUNCTION IF EXISTS public.process_activitypub_note(note_data jsonb, actor_profile_id uuid, instance_domain text);
EXCEPTION WHEN dependent_objects_still_exist THEN
    RAISE NOTICE 'kept (still referenced here): %', 'process_activitypub_note';
END $do$;
DO $do$ BEGIN
    DROP FUNCTION IF EXISTS public.process_ap_activity_on_update();
EXCEPTION WHEN dependent_objects_still_exist THEN
    RAISE NOTICE 'kept (still referenced here): %', 'process_ap_activity_on_update';
END $do$;
DO $do$ BEGIN
    DROP FUNCTION IF EXISTS public.process_incoming_emoji_reaction(p_activity_id text, p_activity jsonb, p_actor_uri text, p_actor_domain text);
EXCEPTION WHEN dependent_objects_still_exist THEN
    RAISE NOTICE 'kept (still referenced here): %', 'process_incoming_emoji_reaction';
END $do$;
DO $do$ BEGIN
    DROP FUNCTION IF EXISTS public.process_incoming_private_message(p_activity_id uuid, p_activity_data jsonb, p_actor_profile_id uuid, p_instance_domain text);
EXCEPTION WHEN dependent_objects_still_exist THEN
    RAISE NOTICE 'kept (still referenced here): %', 'process_incoming_private_message';
END $do$;
DO $do$ BEGIN
    DROP FUNCTION IF EXISTS public.queue_activity_for_federation(p_activity_id uuid, p_target_domains text[], p_priority integer, p_immediate boolean);
EXCEPTION WHEN dependent_objects_still_exist THEN
    RAISE NOTICE 'kept (still referenced here): %', 'queue_activity_for_federation';
END $do$;
DO $do$ BEGIN
    DROP FUNCTION IF EXISTS public.resolve_activitypub_emoji(p_emoji_tag jsonb, p_content text, p_actor_domain text);
EXCEPTION WHEN dependent_objects_still_exist THEN
    RAISE NOTICE 'kept (still referenced here): %', 'resolve_activitypub_emoji';
END $do$;
DO $do$ BEGIN
    DROP FUNCTION IF EXISTS public.resume_activitypub_cron_jobs();
EXCEPTION WHEN dependent_objects_still_exist THEN
    RAISE NOTICE 'kept (still referenced here): %', 'resume_activitypub_cron_jobs';
END $do$;
DO $do$ BEGIN
    DROP FUNCTION IF EXISTS public.save_encryption_session(p_local_user_id uuid, p_remote_user_id uuid, p_session_state text, p_local_device_id text, p_remote_device_id text);
EXCEPTION WHEN dependent_objects_still_exist THEN
    RAISE NOTICE 'kept (still referenced here): %', 'save_encryption_session';
END $do$;
DO $do$ BEGIN
    DROP FUNCTION IF EXISTS public.search_users(p_query text, p_limit integer, p_local_only boolean);
EXCEPTION WHEN dependent_objects_still_exist THEN
    RAISE NOTICE 'kept (still referenced here): %', 'search_users';
END $do$;
DO $do$ BEGIN
    DROP FUNCTION IF EXISTS public.send_accept_activity_for_follow(follow_activity_id uuid, local_user_id uuid);
EXCEPTION WHEN dependent_objects_still_exist THEN
    RAISE NOTICE 'kept (still referenced here): %', 'send_accept_activity_for_follow';
END $do$;
DO $do$ BEGIN
    DROP FUNCTION IF EXISTS public.send_notification_to_followers(notification_type character varying, target_user_id uuid, notification_data jsonb, from_user_id uuid, priority character varying);
EXCEPTION WHEN dependent_objects_still_exist THEN
    RAISE NOTICE 'kept (still referenced here): %', 'send_notification_to_followers';
END $do$;
DO $do$ BEGIN
    DROP FUNCTION IF EXISTS public.send_notification_to_server_members(notification_type character varying, target_server_id uuid, notification_data jsonb, channel_id uuid, from_user_id uuid, exclude_user_ids uuid[], priority character varying);
EXCEPTION WHEN dependent_objects_still_exist THEN
    RAISE NOTICE 'kept (still referenced here): %', 'send_notification_to_server_members';
END $do$;
DO $do$ BEGIN
    DROP FUNCTION IF EXISTS public.should_create_notification(p_user_id uuid, p_type character varying, p_server_id uuid, p_channel_id uuid, p_conversation_id uuid);
EXCEPTION WHEN dependent_objects_still_exist THEN
    RAISE NOTICE 'kept (still referenced here): %', 'should_create_notification';
END $do$;
DO $do$ BEGIN
    DROP FUNCTION IF EXISTS public.strip_dm_mentions(content jsonb, local_instance_domain text);
EXCEPTION WHEN dependent_objects_still_exist THEN
    RAISE NOTICE 'kept (still referenced here): %', 'strip_dm_mentions';
END $do$;
DO $do$ BEGIN
    DROP FUNCTION IF EXISTS public.update_post_counters();
EXCEPTION WHEN dependent_objects_still_exist THEN
    RAISE NOTICE 'kept (still referenced here): %', 'update_post_counters';
END $do$;
DO $do$ BEGIN
    DROP FUNCTION IF EXISTS public.update_updated_at_column();
EXCEPTION WHEN dependent_objects_still_exist THEN
    RAISE NOTICE 'kept (still referenced here): %', 'update_updated_at_column';
END $do$;
DO $do$ BEGIN
    DROP FUNCTION IF EXISTS public.upsert_user_session(p_user_id uuid, p_session_token text, p_platform text, p_form_factor text, p_is_pwa boolean, p_browser text, p_user_agent text, p_status text, p_server_id uuid, p_channel_id uuid, p_conversation_id uuid);
EXCEPTION WHEN dependent_objects_still_exist THEN
    RAISE NOTICE 'kept (still referenced here): %', 'upsert_user_session';
END $do$;
DO $do$ BEGIN
    DROP FUNCTION IF EXISTS public.use_one_time_prekey(p_user_id uuid, p_device_id text, p_prekey_id integer, p_used_by uuid);
EXCEPTION WHEN dependent_objects_still_exist THEN
    RAISE NOTICE 'kept (still referenced here): %', 'use_one_time_prekey';
END $do$;
DO $do$ BEGIN
    DROP FUNCTION IF EXISTS public.user_has_recovery_key(p_user_id uuid);
EXCEPTION WHEN dependent_objects_still_exist THEN
    RAISE NOTICE 'kept (still referenced here): %', 'user_has_recovery_key';
END $do$;
DO $do$ BEGIN
    DROP FUNCTION IF EXISTS public.user_is_conversation_member(p_conversation_id uuid, p_user_id uuid);
EXCEPTION WHEN dependent_objects_still_exist THEN
    RAISE NOTICE 'kept (still referenced here): %', 'user_is_conversation_member';
END $do$;
DO $do$ BEGIN
    DROP FUNCTION IF EXISTS public.verify_rls_status(p_schema text);
EXCEPTION WHEN dependent_objects_still_exist THEN
    RAISE NOTICE 'kept (still referenced here): %', 'verify_rls_status';
END $do$;
DO $do$ BEGIN
    DROP FUNCTION IF EXISTS public.verify_user_password(password text);
EXCEPTION WHEN dependent_objects_still_exist THEN
    RAISE NOTICE 'kept (still referenced here): %', 'verify_user_password';
END $do$;

-- ---------------------------------------------------------------------------
-- 3. Duplicate follow counters
-- ---------------------------------------------------------------------------
-- trigger_update_follow_counters and trg_update_follow_counts both maintain
-- profiles.followers_count and profiles.following_count, and both fire on
-- INSERT, DELETE and UPDATE of public.follows. Every accepted follow has been
-- counted twice.
--
-- trg_update_follow_counts is the one the repository defines and tests, and it
-- is the one that survives. The backfill afterwards recomputes both columns
-- from public.follows, which is the source of truth, so it repairs whatever the
-- double counting left rather than trying to subtract it.

DROP TRIGGER IF EXISTS trigger_update_follow_counters ON public.follows;
DO $do$ BEGIN
    DROP FUNCTION IF EXISTS public.update_follow_counters();
EXCEPTION WHEN dependent_objects_still_exist THEN
    RAISE NOTICE 'kept (still referenced here): %', 'update_follow_counters';
END $do$;

UPDATE public.profiles p
   SET followers_count = c.n
  FROM (SELECT following_id AS id, count(*) AS n
          FROM public.follows WHERE status = 'accepted' GROUP BY 1) c
 WHERE p.id = c.id AND p.followers_count IS DISTINCT FROM c.n;

UPDATE public.profiles p
   SET followers_count = 0
 WHERE p.followers_count <> 0
   AND NOT EXISTS (SELECT 1 FROM public.follows f
                    WHERE f.following_id = p.id AND f.status = 'accepted');

UPDATE public.profiles p
   SET following_count = c.n
  FROM (SELECT follower_id AS id, count(*) AS n
          FROM public.follows WHERE status = 'accepted' GROUP BY 1) c
 WHERE p.id = c.id AND p.following_count IS DISTINCT FROM c.n;

UPDATE public.profiles p
   SET following_count = 0
 WHERE p.following_count <> 0
   AND NOT EXISTS (SELECT 1 FROM public.follows f
                    WHERE f.follower_id = p.id AND f.status = 'accepted');

-- ---------------------------------------------------------------------------
-- 4. Leftover tables
-- ---------------------------------------------------------------------------
-- Neither is created by init/ or by any migration, neither is named by any
-- function, view, policy or foreign key in production, and neither appears in
-- application code. conversation_backup_pre_cleanup is a one-off backup taken
-- before a cleanup; hashtag_archive carries only its own constraint.
--
-- No CASCADE: if something does depend on one of these, this migration should
-- fail and say so rather than take the dependent with it.

DROP TABLE IF EXISTS public.conversation_backup_pre_cleanup;
DROP TABLE IF EXISTS public.hashtag_archive;

COMMIT;
