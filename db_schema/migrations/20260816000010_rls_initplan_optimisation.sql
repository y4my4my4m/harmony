-- Restores the RLS initplan optimisation where the migration stream removed it.
--
-- Supabase calls this auth_rls_initplan. A policy written
--
--   USING (user_id = auth.uid())
--
-- re-evaluates that function once per row scanned; wrapping it in a scalar
-- subquery lets the planner hoist it into an InitPlan, evaluated once per query.
-- Same rows, fewer evaluations.
--
-- The wrapping was applied inconsistently and in both directions. init/ wrapped
-- auth.uid() but not get_current_profile_id(); several migrations wrapped
-- get_current_profile_id() but left auth.uid() bare. init/30_rls_policies.sql and
-- init/31_rls_policies_extended.sql now wrap get_current_profile_id(),
-- is_current_user_admin() and is_current_user_moderator() inside every
-- CREATE POLICY, which leaves only the auth.uid() cases below.
--
-- An earlier version of this file was generated from an init/ tree that still
-- had the bare form, so against a live database it would have UNWRAPPED 199
-- policies, replacing an InitPlan with a per-row call on nearly every
-- RLS-protected table. Production already carries 81 wrapped auth.uid() and 199
-- wrapped get_current_profile_id(), so what follows matches what it already has
-- and only moves instances that lack it.
--
-- ALTER POLICY, not DROP and CREATE, so the policy is never absent and the
-- command and role list are untouched. Each is wrapped because ALTER POLICY has
-- no IF EXISTS and the policy set is not identical everywhere.

BEGIN;

DO $do$ BEGIN
    ALTER POLICY announcement_reads_insert_own ON public.announcement_reads
        WITH CHECK ((user_id = ( SELECT auth.uid() AS uid)));
EXCEPTION WHEN undefined_object OR undefined_table OR undefined_column THEN
    RAISE NOTICE 'skipped (not applicable here): %', 'announcement_reads_insert_own ON public.announcement_reads';
END $do$;

DO $do$ BEGIN
    ALTER POLICY announcement_reads_select_own ON public.announcement_reads
        USING ((user_id = ( SELECT auth.uid() AS uid)));
EXCEPTION WHEN undefined_object OR undefined_table OR undefined_column THEN
    RAISE NOTICE 'skipped (not applicable here): %', 'announcement_reads_select_own ON public.announcement_reads';
END $do$;

DO $do$ BEGIN
    ALTER POLICY "Service role can manage actor cache" ON public.ap_actor_cache
        USING ((( SELECT auth.role() AS role) = 'service_role'::text));
EXCEPTION WHEN undefined_object OR undefined_table OR undefined_column THEN
    RAISE NOTICE 'skipped (not applicable here): %', '"Service role can manage actor cache" ON public.ap_actor_cache';
END $do$;

DO $do$ BEGIN
    ALTER POLICY "Service role can manage object cache" ON public.ap_object_cache
        USING ((( SELECT auth.role() AS role) = 'service_role'::text));
EXCEPTION WHEN undefined_object OR undefined_table OR undefined_column THEN
    RAISE NOTICE 'skipped (not applicable here): %', '"Service role can manage object cache" ON public.ap_object_cache';
END $do$;

DO $do$ BEGIN
    ALTER POLICY "Server members can view bot permissions" ON public.bot_server_permissions
        USING ((EXISTS ( SELECT 1
   FROM (public.user_servers
     JOIN public.profiles ON ((profiles.id = user_servers.user_id)))
  WHERE ((user_servers.server_id = bot_server_permissions.server_id) AND (profiles.auth_user_id = ( SELECT auth.uid() AS uid))))));
EXCEPTION WHEN undefined_object OR undefined_table OR undefined_column THEN
    RAISE NOTICE 'skipped (not applicable here): %', '"Server members can view bot permissions" ON public.bot_server_permissions';
END $do$;

DO $do$ BEGIN
    ALTER POLICY "Server owners can manage bot permissions" ON public.bot_server_permissions
        USING ((EXISTS ( SELECT 1
   FROM (public.servers
     JOIN public.profiles ON ((profiles.id = servers.owner)))
  WHERE ((servers.id = bot_server_permissions.server_id) AND (profiles.auth_user_id = ( SELECT auth.uid() AS uid))))));
EXCEPTION WHEN undefined_object OR undefined_table OR undefined_column THEN
    RAISE NOTICE 'skipped (not applicable here): %', '"Server owners can manage bot permissions" ON public.bot_server_permissions';
END $do$;

DO $do$ BEGIN
    ALTER POLICY "Bot owners can manage tokens" ON public.bot_tokens
        USING ((EXISTS ( SELECT 1
   FROM (public.bots
     JOIN public.profiles ON ((profiles.id = bots.owner_id)))
  WHERE ((bots.id = bot_tokens.bot_id) AND (profiles.auth_user_id = ( SELECT auth.uid() AS uid))))));
EXCEPTION WHEN undefined_object OR undefined_table OR undefined_column THEN
    RAISE NOTICE 'skipped (not applicable here): %', '"Bot owners can manage tokens" ON public.bot_tokens';
END $do$;

DO $do$ BEGIN
    ALTER POLICY "Bot owners can manage bots" ON public.bots
        USING ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = bots.owner_id) AND (profiles.auth_user_id = ( SELECT auth.uid() AS uid))))))
        WITH CHECK ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = bots.owner_id) AND (profiles.auth_user_id = ( SELECT auth.uid() AS uid))))));
EXCEPTION WHEN undefined_object OR undefined_table OR undefined_column THEN
    RAISE NOTICE 'skipped (not applicable here): %', '"Bot owners can manage bots" ON public.bots';
END $do$;

DO $do$ BEGIN
    ALTER POLICY "Public bots are viewable by everyone" ON public.bots
        USING (((is_public = true) OR (EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = bots.owner_id) AND (profiles.auth_user_id = ( SELECT auth.uid() AS uid)))))));
EXCEPTION WHEN undefined_object OR undefined_table OR undefined_column THEN
    RAISE NOTICE 'skipped (not applicable here): %', '"Public bots are viewable by everyone" ON public.bots';
END $do$;

DO $do$ BEGIN
    ALTER POLICY conversations_insert_authenticated ON public.conversations
        WITH CHECK ((created_by = ( SELECT ( SELECT public.get_current_profile_id() AS get_current_profile_id) AS get_current_profile_id)));
EXCEPTION WHEN undefined_object OR undefined_table OR undefined_column THEN
    RAISE NOTICE 'skipped (not applicable here): %', 'conversations_insert_authenticated ON public.conversations';
END $do$;

DO $do$ BEGIN
    ALTER POLICY emojis_delete_instance_admin ON public.emojis
        USING (((scope = 'instance'::text) AND ( SELECT profiles.is_admin
   FROM public.profiles
  WHERE (profiles.auth_user_id = ( SELECT auth.uid() AS uid)))));
EXCEPTION WHEN undefined_object OR undefined_table OR undefined_column THEN
    RAISE NOTICE 'skipped (not applicable here): %', 'emojis_delete_instance_admin ON public.emojis';
END $do$;

DO $do$ BEGIN
    ALTER POLICY emojis_insert_instance_admin ON public.emojis
        WITH CHECK (((scope = 'instance'::text) AND ( SELECT profiles.is_admin
   FROM public.profiles
  WHERE (profiles.auth_user_id = ( SELECT auth.uid() AS uid)))));
EXCEPTION WHEN undefined_object OR undefined_table OR undefined_column THEN
    RAISE NOTICE 'skipped (not applicable here): %', 'emojis_insert_instance_admin ON public.emojis';
END $do$;

DO $do$ BEGIN
    ALTER POLICY emojis_update_instance_admin ON public.emojis
        USING (((scope = 'instance'::text) AND ( SELECT profiles.is_admin
   FROM public.profiles
  WHERE (profiles.auth_user_id = ( SELECT auth.uid() AS uid)))));
EXCEPTION WHEN undefined_object OR undefined_table OR undefined_column THEN
    RAISE NOTICE 'skipped (not applicable here): %', 'emojis_update_instance_admin ON public.emojis';
END $do$;

DO $do$ BEGIN
    ALTER POLICY "Service role can manage delivery queue" ON public.federation_delivery_queue
        USING ((( SELECT auth.role() AS role) = 'service_role'::text));
EXCEPTION WHEN undefined_object OR undefined_table OR undefined_column THEN
    RAISE NOTICE 'skipped (not applicable here): %', '"Service role can manage delivery queue" ON public.federation_delivery_queue';
END $do$;

DO $do$ BEGIN
    ALTER POLICY federation_endpoint_health_insert_update ON public.federation_endpoint_health
        WITH CHECK ((( SELECT auth.uid() AS uid) IS NOT NULL));
EXCEPTION WHEN undefined_object OR undefined_table OR undefined_column THEN
    RAISE NOTICE 'skipped (not applicable here): %', 'federation_endpoint_health_insert_update ON public.federation_endpoint_health';
END $do$;

DO $do$ BEGIN
    ALTER POLICY announcements_delete_admin ON public.instance_announcements
        USING ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = ( SELECT auth.uid() AS uid)) AND (profiles.is_admin = true)))));
EXCEPTION WHEN undefined_object OR undefined_table OR undefined_column THEN
    RAISE NOTICE 'skipped (not applicable here): %', 'announcements_delete_admin ON public.instance_announcements';
END $do$;

DO $do$ BEGIN
    ALTER POLICY announcements_insert_admin ON public.instance_announcements
        WITH CHECK ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = ( SELECT auth.uid() AS uid)) AND (profiles.is_admin = true)))));
EXCEPTION WHEN undefined_object OR undefined_table OR undefined_column THEN
    RAISE NOTICE 'skipped (not applicable here): %', 'announcements_insert_admin ON public.instance_announcements';
END $do$;

DO $do$ BEGIN
    ALTER POLICY announcements_update_admin ON public.instance_announcements
        USING ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = ( SELECT auth.uid() AS uid)) AND (profiles.is_admin = true)))));
EXCEPTION WHEN undefined_object OR undefined_table OR undefined_column THEN
    RAISE NOTICE 'skipped (not applicable here): %', 'announcements_update_admin ON public.instance_announcements';
END $do$;

DO $do$ BEGIN
    ALTER POLICY webrtc_settings_insert_admin_only ON public.instance_webrtc_settings
        WITH CHECK ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.auth_user_id = ( SELECT auth.uid() AS uid)) AND (profiles.is_admin = true)))));
EXCEPTION WHEN undefined_object OR undefined_table OR undefined_column THEN
    RAISE NOTICE 'skipped (not applicable here): %', 'webrtc_settings_insert_admin_only ON public.instance_webrtc_settings';
END $do$;

DO $do$ BEGIN
    ALTER POLICY webrtc_settings_select_admin_only ON public.instance_webrtc_settings
        USING ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.auth_user_id = ( SELECT auth.uid() AS uid)) AND (profiles.is_admin = true)))));
EXCEPTION WHEN undefined_object OR undefined_table OR undefined_column THEN
    RAISE NOTICE 'skipped (not applicable here): %', 'webrtc_settings_select_admin_only ON public.instance_webrtc_settings';
END $do$;

DO $do$ BEGIN
    ALTER POLICY webrtc_settings_update_admin_only ON public.instance_webrtc_settings
        USING ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.auth_user_id = ( SELECT auth.uid() AS uid)) AND (profiles.is_admin = true)))));
EXCEPTION WHEN undefined_object OR undefined_table OR undefined_column THEN
    RAISE NOTICE 'skipped (not applicable here): %', 'webrtc_settings_update_admin_only ON public.instance_webrtc_settings';
END $do$;

DO $do$ BEGIN
    ALTER POLICY invites_insert_members ON public.invites
        WITH CHECK (((( SELECT auth.role() AS role) = 'authenticated'::text) AND (EXISTS ( SELECT 1
   FROM public.user_servers us
  WHERE ((us.server_id = invites.server_id) AND (us.user_id = ( SELECT public.get_current_profile_id() AS get_current_profile_id)))))));
EXCEPTION WHEN undefined_object OR undefined_table OR undefined_column THEN
    RAISE NOTICE 'skipped (not applicable here): %', 'invites_insert_members ON public.invites';
END $do$;

DO $do$ BEGIN
    ALTER POLICY "Users can insert their own prekeys" ON public.prekeys
        WITH CHECK ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = prekeys.user_id) AND (profiles.auth_user_id = ( SELECT auth.uid() AS uid))))));
EXCEPTION WHEN undefined_object OR undefined_table OR undefined_column THEN
    RAISE NOTICE 'skipped (not applicable here): %', '"Users can insert their own prekeys" ON public.prekeys';
END $do$;

DO $do$ BEGIN
    ALTER POLICY "Users can update their own prekeys" ON public.prekeys
        USING ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = prekeys.user_id) AND (profiles.auth_user_id = ( SELECT auth.uid() AS uid))))));
EXCEPTION WHEN undefined_object OR undefined_table OR undefined_column THEN
    RAISE NOTICE 'skipped (not applicable here): %', '"Users can update their own prekeys" ON public.prekeys';
END $do$;

DO $do$ BEGIN
    ALTER POLICY profiles_delete_own ON public.profiles
        USING ((auth_user_id = ( SELECT auth.uid() AS uid)));
EXCEPTION WHEN undefined_object OR undefined_table OR undefined_column THEN
    RAISE NOTICE 'skipped (not applicable here): %', 'profiles_delete_own ON public.profiles';
END $do$;

DO $do$ BEGIN
    ALTER POLICY profiles_insert_own ON public.profiles
        WITH CHECK ((auth_user_id = ( SELECT auth.uid() AS uid)));
EXCEPTION WHEN undefined_object OR undefined_table OR undefined_column THEN
    RAISE NOTICE 'skipped (not applicable here): %', 'profiles_insert_own ON public.profiles';
END $do$;

DO $do$ BEGIN
    ALTER POLICY profiles_update_own ON public.profiles
        USING ((auth_user_id = ( SELECT auth.uid() AS uid)));
EXCEPTION WHEN undefined_object OR undefined_table OR undefined_column THEN
    RAISE NOTICE 'skipped (not applicable here): %', 'profiles_update_own ON public.profiles';
END $do$;

DO $do$ BEGIN
    ALTER POLICY "Service role can manage remote emojis" ON public.remote_emojis_cache
        USING ((( SELECT auth.role() AS role) = 'service_role'::text));
EXCEPTION WHEN undefined_object OR undefined_table OR undefined_column THEN
    RAISE NOTICE 'skipped (not applicable here): %', '"Service role can manage remote emojis" ON public.remote_emojis_cache';
END $do$;

DO $do$ BEGIN
    ALTER POLICY room_epoch_state_select ON public.room_epoch_state
        USING (((( SELECT auth.role() AS role) = 'authenticated'::text) OR (( SELECT auth.role() AS role) = 'service_role'::text)));
EXCEPTION WHEN undefined_object OR undefined_table OR undefined_column THEN
    RAISE NOTICE 'skipped (not applicable here): %', 'room_epoch_state_select ON public.room_epoch_state';
END $do$;

DO $do$ BEGIN
    ALTER POLICY "Enable insert for authenticated users only" ON public.servers
        WITH CHECK ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = servers.owner) AND (profiles.auth_user_id = ( SELECT ( SELECT auth.uid() AS uid) AS uid))))));
EXCEPTION WHEN undefined_object OR undefined_table OR undefined_column THEN
    RAISE NOTICE 'skipped (not applicable here): %', '"Enable insert for authenticated users only" ON public.servers';
END $do$;

DO $do$ BEGIN
    ALTER POLICY "Server owners can delete their servers" ON public.servers
        USING ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = servers.owner) AND (profiles.auth_user_id = ( SELECT auth.uid() AS uid))))));
EXCEPTION WHEN undefined_object OR undefined_table OR undefined_column THEN
    RAISE NOTICE 'skipped (not applicable here): %', '"Server owners can delete their servers" ON public.servers';
END $do$;

DO $do$ BEGIN
    ALTER POLICY "Server owners can update their servers" ON public.servers
        USING ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = servers.owner) AND (profiles.auth_user_id = ( SELECT auth.uid() AS uid))))))
        WITH CHECK ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = servers.owner) AND (profiles.auth_user_id = ( SELECT auth.uid() AS uid))))));
EXCEPTION WHEN undefined_object OR undefined_table OR undefined_column THEN
    RAISE NOTICE 'skipped (not applicable here): %', '"Server owners can update their servers" ON public.servers';
END $do$;

DO $do$ BEGIN
    ALTER POLICY "Users can insert their own key pairs" ON public.user_key_pairs
        WITH CHECK ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = user_key_pairs.user_id) AND (profiles.auth_user_id = ( SELECT auth.uid() AS uid))))));
EXCEPTION WHEN undefined_object OR undefined_table OR undefined_column THEN
    RAISE NOTICE 'skipped (not applicable here): %', '"Users can insert their own key pairs" ON public.user_key_pairs';
END $do$;

DO $do$ BEGIN
    ALTER POLICY "Users can update their own key pairs" ON public.user_key_pairs
        USING ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = user_key_pairs.user_id) AND (profiles.auth_user_id = ( SELECT auth.uid() AS uid))))));
EXCEPTION WHEN undefined_object OR undefined_table OR undefined_column THEN
    RAISE NOTICE 'skipped (not applicable here): %', '"Users can update their own key pairs" ON public.user_key_pairs';
END $do$;

DO $do$ BEGIN
    ALTER POLICY "Users can view own key pair (full row)" ON public.user_key_pairs
        USING ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = user_key_pairs.user_id) AND (profiles.auth_user_id = ( SELECT auth.uid() AS uid))))));
EXCEPTION WHEN undefined_object OR undefined_table OR undefined_column THEN
    RAISE NOTICE 'skipped (not applicable here): %', '"Users can view own key pair (full row)" ON public.user_key_pairs';
END $do$;

DO $do$ BEGIN
    ALTER POLICY "Service role only access" ON public.user_private_keys
        USING ((( SELECT auth.role() AS role) = 'service_role'::text));
EXCEPTION WHEN undefined_object OR undefined_table OR undefined_column THEN
    RAISE NOTICE 'skipped (not applicable here): %', '"Service role only access" ON public.user_private_keys';
END $do$;

COMMIT;
