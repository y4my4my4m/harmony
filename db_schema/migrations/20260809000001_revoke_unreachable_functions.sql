-- Removes 47 unreachable functions from the client-callable surface.
--
-- Supabase grants EXECUTE on every function in public to anon and
-- authenticated by default, so each of these is an unauthenticated HTTP
-- endpoint; 30 of them run SECURITY DEFINER and bypass RLS.
--
-- No entry point reaches them: scripts/find-unreachable.sh traverses the call
-- graph from every RPC name, trigger, RLS policy, cron schedule, view and
-- column default, with caller matching deliberately over-inclusive.
--
-- Revoked rather than dropped. If something outside this repository calls one,
-- the failure is a permission error that names the function and is undone by a
-- single GRANT, instead of a missing-function error after the definition is
-- gone. Dropping follows once a release has passed without one.
--
-- service_role keeps access: it bypasses RLS by design and is not reachable
-- with a public key.

REVOKE ALL ON FUNCTION public.add_user_prekeys(p_user_id uuid, p_device_id text, p_prekeys jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.archive_popular_hashtags() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.backfill_timeline_entries() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.check_encryption_policy(p_server_id uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.cleanup_expired_statuses() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.cleanup_expired_voice_calls() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.cleanup_inactive_hashtags() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.cleanup_old_notifications() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.cleanup_old_trending_data() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.cleanup_stale_user_sessions() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.cleanup_stale_voice_participants() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.clear_orphaned_public_keys() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.create_default_notification_preferences(p_user_id uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.create_notification_structured(p_user_id uuid, p_type character varying, p_data jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.create_notification_with_spam_prevention(p_user_id uuid, p_type text, p_source_user_id uuid, p_title text, p_message text, p_data jsonb, p_server_id uuid, p_channel_id uuid, p_conversation_id uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.detect_message_features(content_parts jsonb) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.disable_federation_triggers() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.enable_conversation_encryption(p_conversation_id uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.enable_federation_triggers() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.end_user_session(p_user_id uuid, p_session_token text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.generate_livekit_token(room_name text, room_type text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_channel_server_id(channel_uuid uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_conversation_encryption_status(p_conversation_id uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_conversation_participants(conversation_uuid uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_conversation_thread(p_conversation_id text, p_user_id uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_custom_status(p_user_id uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_livekit_config() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_next_folder_position(p_user_id uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_next_server_position(p_user_id uuid, p_folder_id uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_supporter_badge(p_user_id uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_timeline(p_user_id uuid, p_limit integer, p_before timestamp without time zone) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_unread_notification_count(p_user_id uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_unused_prekey(p_user_id uuid, p_device_id text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_user_prekey_bundle(p_user_id uuid, p_device_id text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_voice_channel_participants(p_channel_id uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.has_muted(target_user_id uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.is_author_suspended(p_author_id uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.is_muted_by(target_user_id uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.record_metric(p_metric_type text, p_metric_name text, p_value double precision, p_unit text, p_labels jsonb, p_source text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.reset_user_encryption(p_user_id uuid, p_device_id text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.rotate_prekeys(p_user_id uuid, p_device_id text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.run_trending_maintenance() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.safe_upsert_remote_profile(p_username text, p_domain text, p_federated_id text, p_display_name text, p_avatar_url text, p_banner_url text, p_bio text, p_public_key text, p_inbox_url text, p_outbox_url text, p_followers_url text, p_following_url text, p_shared_inbox_url text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.server_has_remote_members(p_server_id uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.update_session_context(p_session_token text, p_server_id uuid, p_channel_id uuid, p_conversation_id uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.update_session_heartbeat(p_session_token text, p_status text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.user_has_encryption(p_user_id uuid) FROM PUBLIC, anon, authenticated;
