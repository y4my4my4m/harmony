-- Applies the RLS initplan optimisation to 205 policies on a migrated database.
--
-- Supabase's advisor calls this auth_rls_initplan. A policy written
--
--   USING (user_id = auth.uid())
--
-- re-evaluates auth.uid() once per row scanned. Wrapping the call in a scalar
-- subquery
--
--   USING (user_id = (SELECT auth.uid()))
--
-- makes the planner hoist it into an InitPlan, evaluated once per query. The
-- result set is identical; only the number of evaluations changes.
--
-- init/ already carries the wrapped form on all 205; a migrated database does
-- not, so a fresh install and a migrated one differ in cost and not in access.
-- That equivalence was checked rather than assumed: unwrapping the subquery on
-- both sides makes all 205 textually identical, and no policy differs for any
-- other reason.
--
-- ALTER POLICY, not DROP + CREATE. ALTER rewrites the expression in place, so
-- the policy is never absent, and the command and role list -- which already
-- match -- are left untouched. Each statement takes a brief lock on its table.
--
-- Generated from a fresh init/ build, so the expressions are exactly the ones
-- init/ produces rather than hand-transcribed.

BEGIN;

ALTER POLICY "Admin audit log admin access" ON public.admin_audit_log
    USING (public.is_current_user_admin());

ALTER POLICY announcement_reads_insert_own ON public.announcement_reads
    WITH CHECK ((user_id = ( SELECT auth.uid() AS uid)));

ALTER POLICY announcement_reads_select_own ON public.announcement_reads
    USING ((user_id = ( SELECT auth.uid() AS uid)));

ALTER POLICY "Users can create their own activities" ON public.ap_activities
    WITH CHECK ((actor_id = public.get_current_profile_id()));

ALTER POLICY "Users can update their own activities" ON public.ap_activities
    USING ((actor_id = public.get_current_profile_id()));

ALTER POLICY "Users can view their own activities" ON public.ap_activities
    USING ((actor_id = public.get_current_profile_id()));

ALTER POLICY "Service role can manage actor cache" ON public.ap_actor_cache
    USING ((( SELECT auth.role() AS role) = 'service_role'::text));

ALTER POLICY "Service role can manage object cache" ON public.ap_object_cache
    USING ((( SELECT auth.role() AS role) = 'service_role'::text));

ALTER POLICY "Blocked instances admin access" ON public.blocked_instances
    USING (public.is_current_user_admin());

ALTER POLICY bot_audit_log_select_owner ON public.bot_audit_log
    USING (((EXISTS ( SELECT 1
   FROM public.bots b
  WHERE ((b.id = bot_audit_log.bot_id) AND (b.owner_id = public.get_current_profile_id())))) OR public.is_current_user_admin()));

ALTER POLICY bot_commands_modify_owner ON public.bot_commands
    USING ((EXISTS ( SELECT 1
   FROM public.bots b
  WHERE ((b.id = bot_commands.bot_id) AND (b.owner_id = public.get_current_profile_id())))));

ALTER POLICY bot_presence_modify_owner ON public.bot_presence
    USING ((EXISTS ( SELECT 1
   FROM public.bots b
  WHERE ((b.id = bot_presence.bot_id) AND (b.owner_id = public.get_current_profile_id())))));

ALTER POLICY bot_rate_limits_owner_only ON public.bot_rate_limits
    USING ((EXISTS ( SELECT 1
   FROM public.bots b
  WHERE ((b.id = bot_rate_limits.bot_id) AND (b.owner_id = public.get_current_profile_id())))));

ALTER POLICY "Server members can view bot permissions" ON public.bot_server_permissions
    USING ((EXISTS ( SELECT 1
   FROM (public.user_servers
     JOIN public.profiles ON ((profiles.id = user_servers.user_id)))
  WHERE ((user_servers.server_id = bot_server_permissions.server_id) AND (profiles.auth_user_id = ( SELECT auth.uid() AS uid))))));

ALTER POLICY "Server owners can manage bot permissions" ON public.bot_server_permissions
    USING ((EXISTS ( SELECT 1
   FROM (public.servers
     JOIN public.profiles ON ((profiles.id = servers.owner)))
  WHERE ((servers.id = bot_server_permissions.server_id) AND (profiles.auth_user_id = ( SELECT auth.uid() AS uid))))));

ALTER POLICY "Bot owners can manage tokens" ON public.bot_tokens
    USING ((EXISTS ( SELECT 1
   FROM (public.bots
     JOIN public.profiles ON ((profiles.id = bots.owner_id)))
  WHERE ((bots.id = bot_tokens.bot_id) AND (profiles.auth_user_id = ( SELECT auth.uid() AS uid))))));

ALTER POLICY bot_webhooks_owner_only ON public.bot_webhooks
    USING ((EXISTS ( SELECT 1
   FROM public.bots b
  WHERE ((b.id = bot_webhooks.bot_id) AND (b.owner_id = public.get_current_profile_id())))));

ALTER POLICY "Bot owners can manage bots" ON public.bots
    USING ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = bots.owner_id) AND (profiles.auth_user_id = ( SELECT auth.uid() AS uid))))))
    WITH CHECK ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = bots.owner_id) AND (profiles.auth_user_id = ( SELECT auth.uid() AS uid))))));

ALTER POLICY "Public bots are viewable by everyone" ON public.bots
    USING (((is_public = true) OR (EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = bots.owner_id) AND (profiles.auth_user_id = ( SELECT auth.uid() AS uid)))))));

ALTER POLICY channel_categories_delete ON public.channel_categories
    USING ((EXISTS ( SELECT 1
   FROM public.servers
  WHERE ((servers.id = channel_categories.server_id) AND (servers.owner = public.get_current_profile_id())))));

ALTER POLICY channel_categories_insert ON public.channel_categories
    WITH CHECK ((EXISTS ( SELECT 1
   FROM public.servers
  WHERE ((servers.id = channel_categories.server_id) AND (servers.owner = public.get_current_profile_id())))));

ALTER POLICY channel_categories_update ON public.channel_categories
    USING ((EXISTS ( SELECT 1
   FROM public.user_servers us
  WHERE ((us.server_id = channel_categories.server_id) AND (us.user_id = public.get_current_profile_id())))));

ALTER POLICY channel_permission_overrides_modify ON public.channel_permission_overrides
    USING ((EXISTS ( SELECT 1
   FROM ((public.channels c
     JOIN public.servers s ON ((s.id = c.server_id)))
     LEFT JOIN public.profiles p ON ((p.id = public.get_current_profile_id())))
  WHERE ((c.id = channel_permission_overrides.channel_id) AND ((s.owner = public.get_current_profile_id()) OR COALESCE(p.is_admin, false) OR COALESCE(p.is_moderator, false) OR (EXISTS ( SELECT 1
           FROM (public.user_roles ur
             JOIN public.server_roles sr ON ((sr.id = ur.role_id)))
          WHERE ((ur.user_id = public.get_current_profile_id()) AND (ur.server_id = s.id) AND (((sr.permissions & ((1)::bigint << 0)) <> 0) OR ((sr.permissions & ((1)::bigint << 2)) <> 0) OR ((sr.permissions & ((1)::bigint << 3)) <> 0))))))))))
    WITH CHECK ((EXISTS ( SELECT 1
   FROM ((public.channels c
     JOIN public.servers s ON ((s.id = c.server_id)))
     LEFT JOIN public.profiles p ON ((p.id = public.get_current_profile_id())))
  WHERE ((c.id = channel_permission_overrides.channel_id) AND ((s.owner = public.get_current_profile_id()) OR COALESCE(p.is_admin, false) OR COALESCE(p.is_moderator, false) OR (EXISTS ( SELECT 1
           FROM (public.user_roles ur
             JOIN public.server_roles sr ON ((sr.id = ur.role_id)))
          WHERE ((ur.user_id = public.get_current_profile_id()) AND (ur.server_id = s.id) AND (((sr.permissions & ((1)::bigint << 0)) <> 0) OR ((sr.permissions & ((1)::bigint << 2)) <> 0) OR ((sr.permissions & ((1)::bigint << 3)) <> 0))))))))));

ALTER POLICY channel_permission_overrides_select ON public.channel_permission_overrides
    USING ((EXISTS ( SELECT 1
   FROM (public.channels c
     JOIN public.user_servers us ON ((us.server_id = c.server_id)))
  WHERE ((c.id = channel_permission_overrides.channel_id) AND (us.user_id = public.get_current_profile_id()) AND (us.status = 'accepted'::text)))));

ALTER POLICY channels_delete_owner ON public.channels
    USING ((EXISTS ( SELECT 1
   FROM public.servers
  WHERE ((servers.id = channels.server_id) AND (servers.owner = public.get_current_profile_id())))));

ALTER POLICY channels_insert_owner ON public.channels
    WITH CHECK ((EXISTS ( SELECT 1
   FROM public.servers
  WHERE ((servers.id = channels.server_id) AND (servers.owner = public.get_current_profile_id())))));

ALTER POLICY channels_select_member ON public.channels
    USING (((EXISTS ( SELECT 1
   FROM (public.user_servers us
     JOIN public.servers s ON ((s.id = us.server_id)))
  WHERE ((us.server_id = channels.server_id) AND ((us.user_id = public.get_current_profile_id()) OR (s.owner = public.get_current_profile_id())) AND (us.status = 'accepted'::text)))) OR (EXISTS ( SELECT 1
   FROM public.servers
  WHERE ((servers.id = channels.server_id) AND (servers.owner = public.get_current_profile_id()))))));

ALTER POLICY channels_update_owner ON public.channels
    USING ((EXISTS ( SELECT 1
   FROM public.servers
  WHERE ((servers.id = channels.server_id) AND (servers.owner = public.get_current_profile_id())))));

ALTER POLICY conversation_encryption_settings_modify ON public.conversation_encryption_settings
    USING ((EXISTS ( SELECT 1
   FROM public.conversation_participants cp
  WHERE ((cp.conversation_id = conversation_encryption_settings.conversation_id) AND (cp.user_id = public.get_current_profile_id()) AND (cp.left_at IS NULL)))));

ALTER POLICY conversation_encryption_settings_select ON public.conversation_encryption_settings
    USING ((EXISTS ( SELECT 1
   FROM public.conversation_participants cp
  WHERE ((cp.conversation_id = conversation_encryption_settings.conversation_id) AND (cp.user_id = public.get_current_profile_id())))));

ALTER POLICY conversation_participants_delete_policy ON public.conversation_participants
    USING ((user_id = public.get_current_profile_id()));

ALTER POLICY conversation_participants_insert_self_owned ON public.conversation_participants
    WITH CHECK (((user_id = public.get_current_profile_id()) AND (EXISTS ( SELECT 1
   FROM public.conversations c
  WHERE ((c.id = conversation_participants.conversation_id) AND (c.created_by = public.get_current_profile_id()))))));

ALTER POLICY conversation_participants_select_policy ON public.conversation_participants
    USING (public.is_conversation_participant(conversation_id, public.get_current_profile_id()));

ALTER POLICY conversation_participants_update_policy ON public.conversation_participants
    USING ((user_id = public.get_current_profile_id()));

ALTER POLICY conversations_select_participant ON public.conversations
    USING ((EXISTS ( SELECT 1
   FROM public.conversation_participants
  WHERE ((conversation_participants.conversation_id = conversations.id) AND (conversation_participants.user_id = public.get_current_profile_id())))));

ALTER POLICY device_approval_requests_insert_own ON public.device_approval_requests
    WITH CHECK ((user_id = public.get_current_profile_id()));

ALTER POLICY device_approval_requests_select_own ON public.device_approval_requests
    USING ((user_id = public.get_current_profile_id()));

ALTER POLICY "Server owners manage discord bridge pairing" ON public.discord_bridge_pairings
    USING ((EXISTS ( SELECT 1
   FROM public.servers s
  WHERE ((s.id = discord_bridge_pairings.server_id) AND ((s.owner = public.get_current_profile_id()) OR public.has_permission(public.get_current_profile_id(), s.id, 'MANAGE_SERVER'::text))))))
    WITH CHECK ((EXISTS ( SELECT 1
   FROM public.servers s
  WHERE ((s.id = discord_bridge_pairings.server_id) AND ((s.owner = public.get_current_profile_id()) OR public.has_permission(public.get_current_profile_id(), s.id, 'MANAGE_SERVER'::text))))));

ALTER POLICY "Users can delete own emoji favorites" ON public.emoji_favorites
    USING ((user_id = public.get_current_profile_id()));

ALTER POLICY "Users can insert own emoji favorites" ON public.emoji_favorites
    WITH CHECK ((user_id = public.get_current_profile_id()));

ALTER POLICY "Users can view own emoji favorites" ON public.emoji_favorites
    USING ((user_id = public.get_current_profile_id()));

ALTER POLICY emoji_usage_access_policy ON public.emoji_usage
    USING ((server_id IN ( SELECT us.server_id
   FROM public.user_servers us
  WHERE (us.user_id = public.get_current_profile_id()))));

ALTER POLICY emojis_delete_instance_admin ON public.emojis
    USING (((scope = 'instance'::text) AND ( SELECT profiles.is_admin
   FROM public.profiles
  WHERE (profiles.auth_user_id = ( SELECT auth.uid() AS uid)))));

ALTER POLICY emojis_delete_server_owner ON public.emojis
    USING ((EXISTS ( SELECT 1
   FROM public.servers
  WHERE ((servers.id = emojis.server_id) AND (servers.owner = public.get_current_profile_id())))));

ALTER POLICY emojis_delete_user_scope ON public.emojis
    USING (((scope = 'user'::text) AND (uploader = public.get_current_profile_id())));

ALTER POLICY emojis_insert_instance_admin ON public.emojis
    WITH CHECK (((scope = 'instance'::text) AND ( SELECT profiles.is_admin
   FROM public.profiles
  WHERE (profiles.auth_user_id = ( SELECT auth.uid() AS uid)))));

ALTER POLICY emojis_insert_server_owner ON public.emojis
    WITH CHECK ((EXISTS ( SELECT 1
   FROM public.servers
  WHERE ((servers.id = emojis.server_id) AND (servers.owner = public.get_current_profile_id())))));

ALTER POLICY emojis_insert_user_scope ON public.emojis
    WITH CHECK (((scope = 'user'::text) AND (uploader = public.get_current_profile_id())));

ALTER POLICY emojis_update_instance_admin ON public.emojis
    USING (((scope = 'instance'::text) AND ( SELECT profiles.is_admin
   FROM public.profiles
  WHERE (profiles.auth_user_id = ( SELECT auth.uid() AS uid)))));

ALTER POLICY emojis_update_server_owner ON public.emojis
    USING ((EXISTS ( SELECT 1
   FROM public.servers
  WHERE ((servers.id = emojis.server_id) AND (servers.owner = public.get_current_profile_id())))));

ALTER POLICY emojis_update_user_scope ON public.emojis
    USING (((scope = 'user'::text) AND (uploader = public.get_current_profile_id())));

ALTER POLICY encryption_audit_log_insert_system ON public.encryption_audit_log
    WITH CHECK ((user_id = public.get_current_profile_id()));

ALTER POLICY encryption_audit_log_own_or_admin ON public.encryption_audit_log
    USING (((user_id = public.get_current_profile_id()) OR public.is_current_user_admin()));

ALTER POLICY encryption_sessions_own_user ON public.encryption_sessions
    USING (((local_user_id = public.get_current_profile_id()) OR (remote_user_id = public.get_current_profile_id())))
    WITH CHECK ((local_user_id = public.get_current_profile_id()));

ALTER POLICY federated_instances_manage ON public.federated_instances
    USING (public.is_current_user_admin());

ALTER POLICY "Admins can delete federation deliveries" ON public.federation_delivery_queue
    USING ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = public.get_current_profile_id()) AND (profiles.is_admin = true)))));

ALTER POLICY "Service role can manage delivery queue" ON public.federation_delivery_queue
    USING ((( SELECT auth.role() AS role) = 'service_role'::text));

ALTER POLICY "Admins can delete dead endpoints" ON public.federation_endpoint_health
    USING ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = public.get_current_profile_id()) AND (profiles.is_admin = true)))));

ALTER POLICY federation_endpoint_health_insert_update ON public.federation_endpoint_health
    WITH CHECK ((( SELECT auth.uid() AS uid) IS NOT NULL));

ALTER POLICY federation_health_manage ON public.federation_health
    USING (public.is_current_user_admin());

ALTER POLICY federation_health_modify_admin ON public.federation_health
    USING (public.is_current_user_admin());

ALTER POLICY follows_delete_own ON public.follows
    USING ((follower_id = public.get_current_profile_id()));

ALTER POLICY follows_insert_own ON public.follows
    WITH CHECK ((follower_id = public.get_current_profile_id()));

ALTER POLICY follows_update_involved ON public.follows
    USING (((follower_id = public.get_current_profile_id()) OR (following_id = public.get_current_profile_id())));

ALTER POLICY "Users can delete own gif favorites" ON public.gif_favorites
    USING ((user_id = public.get_current_profile_id()));

ALTER POLICY "Users can insert own gif favorites" ON public.gif_favorites
    WITH CHECK ((user_id = public.get_current_profile_id()));

ALTER POLICY "Users can view own gif favorites" ON public.gif_favorites
    USING ((user_id = public.get_current_profile_id()));

ALTER POLICY announcements_delete_admin ON public.instance_announcements
    USING ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = ( SELECT auth.uid() AS uid)) AND (profiles.is_admin = true)))));

ALTER POLICY announcements_insert_admin ON public.instance_announcements
    WITH CHECK ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = ( SELECT auth.uid() AS uid)) AND (profiles.is_admin = true)))));

ALTER POLICY announcements_update_admin ON public.instance_announcements
    USING ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = ( SELECT auth.uid() AS uid)) AND (profiles.is_admin = true)))));

ALTER POLICY instance_config_select_admin ON public.instance_config
    USING (public.is_current_user_admin());

ALTER POLICY donation_history_modify_admin ON public.instance_donation_history
    USING (public.is_current_user_admin());

ALTER POLICY donation_history_select_admin ON public.instance_donation_history
    USING ((public.is_current_user_admin() OR (user_id = public.get_current_profile_id())));

ALTER POLICY funding_modify_admin ON public.instance_funding
    USING (public.is_current_user_admin());

ALTER POLICY pending_donations_admin_all ON public.instance_pending_donations
    USING (public.is_current_user_admin());

ALTER POLICY tiers_modify_admin ON public.instance_supporter_tiers
    USING (public.is_current_user_admin());

ALTER POLICY supporters_modify_admin ON public.instance_supporters
    USING (public.is_current_user_admin());

ALTER POLICY webrtc_settings_insert_admin_only ON public.instance_webrtc_settings
    WITH CHECK ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.auth_user_id = ( SELECT auth.uid() AS uid)) AND (profiles.is_admin = true)))));

ALTER POLICY webrtc_settings_select_admin_only ON public.instance_webrtc_settings
    USING ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.auth_user_id = ( SELECT auth.uid() AS uid)) AND (profiles.is_admin = true)))));

ALTER POLICY webrtc_settings_update_admin_only ON public.instance_webrtc_settings
    USING ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.auth_user_id = ( SELECT auth.uid() AS uid)) AND (profiles.is_admin = true)))));

ALTER POLICY invites_delete_creator ON public.invites
    USING ((created_by = public.get_current_profile_id()));

ALTER POLICY invites_insert_members ON public.invites
    WITH CHECK (((( SELECT auth.role() AS role) = 'authenticated'::text) AND (EXISTS ( SELECT 1
   FROM public.user_servers us
  WHERE ((us.server_id = invites.server_id) AND (us.user_id = public.get_current_profile_id()))))));

ALTER POLICY invites_select_creator ON public.invites
    USING ((created_by = public.get_current_profile_id()));

ALTER POLICY invites_select_instance_admin ON public.invites
    USING (public.is_current_user_admin());

ALTER POLICY invites_update_creator ON public.invites
    USING ((created_by = public.get_current_profile_id()));

ALTER POLICY megolm_key_backups_own_only ON public.megolm_key_backups
    USING ((user_id = public.get_current_profile_id()));

ALTER POLICY megolm_key_requests_fulfill ON public.megolm_key_requests
    USING ((sender_user_id = public.get_current_profile_id()))
    WITH CHECK ((sender_user_id = public.get_current_profile_id()));

ALTER POLICY megolm_key_requests_own ON public.megolm_key_requests
    USING ((requester_user_id = public.get_current_profile_id()));

ALTER POLICY megolm_key_requests_select_for_response ON public.megolm_key_requests
    USING (((sender_user_id = public.get_current_profile_id()) OR (EXISTS ( SELECT 1
   FROM public.megolm_room_sessions mrs
  WHERE ((mrs.session_id = megolm_key_requests.session_id) AND (mrs.room_id = megolm_key_requests.room_id) AND (mrs.creator_user_id = public.get_current_profile_id()))))));

ALTER POLICY megolm_room_sessions_insert_own ON public.megolm_room_sessions
    WITH CHECK ((creator_user_id = public.get_current_profile_id()));

ALTER POLICY megolm_room_sessions_select ON public.megolm_room_sessions
    USING (((creator_user_id = public.get_current_profile_id()) OR (EXISTS ( SELECT 1
   FROM public.megolm_session_shares
  WHERE ((megolm_session_shares.session_id = megolm_room_sessions.session_id) AND (megolm_session_shares.room_id = megolm_room_sessions.room_id) AND (megolm_session_shares.recipient_user_id = public.get_current_profile_id()))))));

ALTER POLICY megolm_room_sessions_update_own ON public.megolm_room_sessions
    USING ((creator_user_id = public.get_current_profile_id()));

ALTER POLICY megolm_session_shares_insert ON public.megolm_session_shares
    WITH CHECK (((sender_user_id = public.get_current_profile_id()) AND public.is_room_member(room_id, sender_user_id) AND public.is_room_member(room_id, recipient_user_id)));

ALTER POLICY megolm_session_shares_select ON public.megolm_session_shares
    USING (((recipient_user_id = public.get_current_profile_id()) OR (sender_user_id = public.get_current_profile_id())));

ALTER POLICY megolm_session_shares_update ON public.megolm_session_shares
    USING (((sender_user_id = public.get_current_profile_id()) OR (recipient_user_id = public.get_current_profile_id())));

ALTER POLICY message_search_index_channel_access ON public.message_search_index
    USING (((channel_id IS NOT NULL) AND (EXISTS ( SELECT 1
   FROM (public.channels c
     JOIN public.user_servers us ON ((us.server_id = c.server_id)))
  WHERE ((c.id = message_search_index.channel_id) AND (us.user_id = public.get_current_profile_id()) AND (us.status = 'accepted'::text))))));

ALTER POLICY message_search_index_conversation_access ON public.message_search_index
    USING (((conversation_id IS NOT NULL) AND (EXISTS ( SELECT 1
   FROM public.conversation_participants cp
  WHERE ((cp.conversation_id = message_search_index.conversation_id) AND (cp.user_id = public.get_current_profile_id()) AND (cp.left_at IS NULL))))));

ALTER POLICY messages_delete_authorized ON public.messages
    USING (((user_id = public.get_current_profile_id()) OR public.is_current_user_admin() OR public.is_current_user_moderator() OR public.can_current_user_manage_messages_in_channel(channel_id)));

ALTER POLICY messages_insert_member ON public.messages
    WITH CHECK (((user_id = public.get_current_profile_id()) AND (((channel_id IS NOT NULL) AND (EXISTS ( SELECT 1
   FROM (public.channels c
     JOIN public.user_servers us ON ((us.server_id = c.server_id)))
  WHERE ((c.id = messages.channel_id) AND (us.user_id = public.get_current_profile_id()) AND (us.status = 'accepted'::text))))) OR ((conversation_id IS NOT NULL) AND (EXISTS ( SELECT 1
   FROM public.conversation_participants cp
  WHERE ((cp.conversation_id = messages.conversation_id) AND (cp.user_id = public.get_current_profile_id()) AND (cp.left_at IS NULL)))) AND (NOT (EXISTS ( SELECT 1
   FROM public.conversation_participants cp
  WHERE ((cp.conversation_id = messages.conversation_id) AND (cp.user_id <> public.get_current_profile_id()) AND (cp.left_at IS NULL) AND public.is_blocked_by(cp.user_id)))))))));

ALTER POLICY messages_select_channel_member ON public.messages
    USING ((((channel_id IS NOT NULL) AND (EXISTS ( SELECT 1
   FROM (public.channels c
     JOIN public.user_servers us ON ((us.server_id = c.server_id)))
  WHERE ((c.id = messages.channel_id) AND (us.user_id = public.get_current_profile_id()) AND (us.status = 'accepted'::text))))) OR ((conversation_id IS NOT NULL) AND (EXISTS ( SELECT 1
   FROM public.conversation_participants cp
  WHERE ((cp.conversation_id = messages.conversation_id) AND (cp.user_id = public.get_current_profile_id()) AND (cp.left_at IS NULL)))))));

ALTER POLICY messages_update_authorized ON public.messages
    USING (((user_id = public.get_current_profile_id()) OR public.is_current_user_admin() OR public.is_current_user_moderator() OR public.can_current_user_manage_messages_in_channel(channel_id)));

ALTER POLICY mfa_recovery_codes_own_only ON public.mfa_recovery_codes
    USING ((user_id = public.get_current_profile_id()));

ALTER POLICY notification_channels_delete_own ON public.notification_channels
    USING ((user_id = public.get_current_profile_id()));

ALTER POLICY notification_channels_insert_own ON public.notification_channels
    WITH CHECK ((user_id = public.get_current_profile_id()));

ALTER POLICY notification_channels_select_own ON public.notification_channels
    USING ((user_id = public.get_current_profile_id()));

ALTER POLICY notification_channels_update_own ON public.notification_channels
    USING ((user_id = public.get_current_profile_id()));

ALTER POLICY notification_preferences_delete_own ON public.notification_preferences
    USING ((user_id = public.get_current_profile_id()));

ALTER POLICY notification_preferences_insert_own ON public.notification_preferences
    WITH CHECK ((user_id = public.get_current_profile_id()));

ALTER POLICY notification_preferences_select_own ON public.notification_preferences
    USING ((user_id = public.get_current_profile_id()));

ALTER POLICY notification_preferences_update_own ON public.notification_preferences
    USING ((user_id = public.get_current_profile_id()));

ALTER POLICY notification_rate_limits_admin_only ON public.notification_rate_limits
    USING (public.is_current_user_admin())
    WITH CHECK (public.is_current_user_admin());

ALTER POLICY notifications_delete_own ON public.notifications
    USING ((user_id = public.get_current_profile_id()));

ALTER POLICY notifications_select_own ON public.notifications
    USING ((user_id = public.get_current_profile_id()));

ALTER POLICY notifications_update_own ON public.notifications
    USING ((user_id = public.get_current_profile_id()));

ALTER POLICY "Admins can read metrics" ON public.performance_metrics
    USING (public.is_current_user_admin());

ALTER POLICY performance_metrics_hourly_modify_admin ON public.performance_metrics_hourly
    USING (public.is_current_user_admin());

ALTER POLICY post_interactions_delete_own ON public.post_interactions
    USING ((user_id = public.get_current_profile_id()));

ALTER POLICY post_interactions_insert_own ON public.post_interactions
    WITH CHECK (((user_id = public.get_current_profile_id()) AND (NOT public.is_blocked_by(( SELECT posts.author_id
   FROM public.posts
  WHERE (posts.id = post_interactions.post_id))))));

ALTER POLICY posts_delete_own ON public.posts
    USING ((author_id = public.get_current_profile_id()));

ALTER POLICY posts_insert_own ON public.posts
    WITH CHECK ((author_id = public.get_current_profile_id()));

ALTER POLICY posts_select_public ON public.posts
    USING (((author_id = public.get_current_profile_id()) OR ((NOT public.is_blocked_by(author_id)) AND (NOT public.has_blocked(author_id)) AND ((visibility = ANY (ARRAY['public'::text, 'unlisted'::text])) OR ((visibility = 'followers'::text) AND (EXISTS ( SELECT 1
   FROM public.follows
  WHERE ((follows.follower_id = public.get_current_profile_id()) AND (follows.following_id = posts.author_id) AND (follows.status = 'accepted'::text))))) OR ((visibility = 'direct'::text) AND (EXISTS ( SELECT 1
  WHERE (posts.author_id = public.get_current_profile_id()))))))));

ALTER POLICY posts_update_own ON public.posts
    USING ((author_id = public.get_current_profile_id()));

ALTER POLICY "Users can insert their own prekeys" ON public.prekeys
    WITH CHECK ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = prekeys.user_id) AND (profiles.auth_user_id = ( SELECT auth.uid() AS uid))))));

ALTER POLICY "Users can update their own prekeys" ON public.prekeys
    USING ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = prekeys.user_id) AND (profiles.auth_user_id = ( SELECT auth.uid() AS uid))))));

ALTER POLICY profiles_delete_own ON public.profiles
    USING ((auth_user_id = ( SELECT auth.uid() AS uid)));

ALTER POLICY profiles_insert_own ON public.profiles
    WITH CHECK ((auth_user_id = ( SELECT auth.uid() AS uid)));

ALTER POLICY profiles_update_own ON public.profiles
    USING ((auth_user_id = ( SELECT auth.uid() AS uid)));

ALTER POLICY reactions_delete_own ON public.reactions
    USING ((user_id = public.get_current_profile_id()));

ALTER POLICY reactions_insert_own ON public.reactions
    WITH CHECK (((user_id = public.get_current_profile_id()) AND (NOT public.is_blocked_by(( SELECT messages.user_id
   FROM public.messages
  WHERE (messages.id = reactions.message_id))))));

ALTER POLICY recovery_key_metadata_own_only ON public.recovery_key_metadata
    USING ((user_id = public.get_current_profile_id()));

ALTER POLICY "Service role can manage remote emojis" ON public.remote_emojis_cache
    USING ((( SELECT auth.role() AS role) = 'service_role'::text));

ALTER POLICY remote_emojis_cache_admin_modify ON public.remote_emojis_cache
    USING (public.is_current_user_admin());

ALTER POLICY "Admins can update reports" ON public.reports
    USING (public.is_current_user_admin());

ALTER POLICY "Admins can view all reports" ON public.reports
    USING (public.is_current_user_admin());

ALTER POLICY "Users can create reports" ON public.reports
    WITH CHECK ((reporter_id = public.get_current_profile_id()));

ALTER POLICY "Users can view own reports" ON public.reports
    USING ((reporter_id = public.get_current_profile_id()));

ALTER POLICY room_epoch_state_select ON public.room_epoch_state
    USING (((( SELECT auth.role() AS role) = 'authenticated'::text) OR (( SELECT auth.role() AS role) = 'service_role'::text)));

ALTER POLICY server_bans_select_moderator ON public.server_bans
    USING ((public.is_current_user_admin() OR public.has_permission(public.get_current_profile_id(), server_id, 'BAN_MEMBERS'::text)));

ALTER POLICY server_encryption_settings_modify ON public.server_encryption_settings
    USING ((EXISTS ( SELECT 1
   FROM public.servers s
  WHERE ((s.id = server_encryption_settings.server_id) AND (s.owner = public.get_current_profile_id())))));

ALTER POLICY server_encryption_settings_select ON public.server_encryption_settings
    USING ((EXISTS ( SELECT 1
   FROM public.user_servers us
  WHERE ((us.server_id = server_encryption_settings.server_id) AND (us.user_id = public.get_current_profile_id()) AND (us.status = 'accepted'::text)))));

ALTER POLICY server_folders_delete_own ON public.server_folders
    USING ((user_id = public.get_current_profile_id()));

ALTER POLICY server_folders_insert_own ON public.server_folders
    WITH CHECK ((user_id = public.get_current_profile_id()));

ALTER POLICY server_folders_select_own ON public.server_folders
    USING ((user_id = public.get_current_profile_id()));

ALTER POLICY server_folders_update_own ON public.server_folders
    USING ((user_id = public.get_current_profile_id()));

ALTER POLICY "Members can view server membership events" ON public.server_membership_events
    USING ((server_id IN ( SELECT us.server_id
   FROM public.user_servers us
  WHERE (us.user_id = public.get_current_profile_id()))));

ALTER POLICY server_roles_delete ON public.server_roles
    USING (((NOT is_default) AND ((EXISTS ( SELECT 1
   FROM public.servers
  WHERE ((servers.id = server_roles.server_id) AND (servers.owner = public.get_current_profile_id())))) OR public.is_current_user_admin())));

ALTER POLICY server_roles_insert ON public.server_roles
    WITH CHECK (((EXISTS ( SELECT 1
   FROM public.servers
  WHERE ((servers.id = server_roles.server_id) AND (servers.owner = public.get_current_profile_id())))) OR public.is_current_user_admin()));

ALTER POLICY server_roles_update ON public.server_roles
    USING (((NOT is_default) AND ((EXISTS ( SELECT 1
   FROM public.servers
  WHERE ((servers.id = server_roles.server_id) AND (servers.owner = public.get_current_profile_id())))) OR public.is_current_user_admin())));

ALTER POLICY server_settings_modify_owner ON public.server_settings
    USING ((EXISTS ( SELECT 1
   FROM public.servers s
  WHERE ((s.id = server_settings.server_id) AND (s.owner = public.get_current_profile_id())))));

ALTER POLICY server_settings_select_member ON public.server_settings
    USING ((EXISTS ( SELECT 1
   FROM public.user_servers us
  WHERE ((us.server_id = server_settings.server_id) AND (us.user_id = public.get_current_profile_id()) AND (us.status = 'accepted'::text)))));

ALTER POLICY "Server owners can delete their servers" ON public.servers
    USING ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = servers.owner) AND (profiles.auth_user_id = ( SELECT auth.uid() AS uid))))));

ALTER POLICY "Server owners can update their servers" ON public.servers
    USING ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = servers.owner) AND (profiles.auth_user_id = ( SELECT auth.uid() AS uid))))))
    WITH CHECK ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = servers.owner) AND (profiles.auth_user_id = ( SELECT auth.uid() AS uid))))));

ALTER POLICY slow_queries_admin_only ON public.slow_queries
    USING (public.is_current_user_admin());

ALTER POLICY thread_members_delete_self ON public.thread_members
    USING ((user_id = public.get_current_profile_id()));

ALTER POLICY thread_members_insert_self ON public.thread_members
    WITH CHECK ((user_id = public.get_current_profile_id()));

ALTER POLICY thread_members_update_self ON public.thread_members
    USING ((user_id = public.get_current_profile_id()));

ALTER POLICY threads_delete_authorized ON public.threads
    USING (((created_by = public.get_current_profile_id()) OR (EXISTS ( SELECT 1
   FROM (public.channels c
     JOIN public.servers s ON ((s.id = c.server_id)))
  WHERE ((c.id = threads.channel_id) AND (s.owner = public.get_current_profile_id())))) OR public.is_current_user_admin()));

ALTER POLICY threads_insert_member ON public.threads
    WITH CHECK (((created_by = public.get_current_profile_id()) AND (EXISTS ( SELECT 1
   FROM (public.channels c
     JOIN public.user_servers us ON ((us.server_id = c.server_id)))
  WHERE ((c.id = threads.channel_id) AND (us.user_id = public.get_current_profile_id()) AND (us.status = 'accepted'::text))))));

ALTER POLICY threads_update_authorized ON public.threads
    USING (((created_by = public.get_current_profile_id()) OR (EXISTS ( SELECT 1
   FROM (public.channels c
     JOIN public.servers s ON ((s.id = c.server_id)))
  WHERE ((c.id = threads.channel_id) AND (s.owner = public.get_current_profile_id())))) OR public.is_current_user_admin()));

ALTER POLICY timeline_entries_select_own ON public.timeline_entries
    USING ((user_id = public.get_current_profile_id()));

ALTER POLICY trending_posts_admin_modify ON public.trending_posts
    USING (public.is_current_user_admin());

ALTER POLICY trending_refresh_queue_admin_only ON public.trending_refresh_queue
    USING (public.is_current_user_admin());

ALTER POLICY trending_users_admin_modify ON public.trending_users
    USING (public.is_current_user_admin());

ALTER POLICY unread_counts_select_own ON public.unread_counts
    USING ((user_id = public.get_current_profile_id()));

ALTER POLICY unread_counts_update_own ON public.unread_counts
    USING ((user_id = public.get_current_profile_id()))
    WITH CHECK ((user_id = public.get_current_profile_id()));

ALTER POLICY user_blocks_check_if_blocked ON public.user_blocks
    USING ((blocked_user_id = public.get_current_profile_id()));

ALTER POLICY user_blocks_delete_own ON public.user_blocks
    USING ((blocker_id = public.get_current_profile_id()));

ALTER POLICY user_blocks_insert_own ON public.user_blocks
    WITH CHECK ((blocker_id = public.get_current_profile_id()));

ALTER POLICY user_blocks_select_own ON public.user_blocks
    USING ((blocker_id = public.get_current_profile_id()));

ALTER POLICY user_devices_delete_own ON public.user_devices
    USING ((user_id = public.get_current_profile_id()));

ALTER POLICY user_devices_insert_own ON public.user_devices
    WITH CHECK ((user_id = public.get_current_profile_id()));

ALTER POLICY user_devices_select_own ON public.user_devices
    USING ((user_id = public.get_current_profile_id()));

ALTER POLICY user_devices_update_own ON public.user_devices
    USING ((user_id = public.get_current_profile_id()));

ALTER POLICY "Users can insert their own key pairs" ON public.user_key_pairs
    WITH CHECK ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = user_key_pairs.user_id) AND (profiles.auth_user_id = ( SELECT auth.uid() AS uid))))));

ALTER POLICY "Users can update their own key pairs" ON public.user_key_pairs
    USING ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = user_key_pairs.user_id) AND (profiles.auth_user_id = ( SELECT auth.uid() AS uid))))));

ALTER POLICY "Users can view own key pair (full row)" ON public.user_key_pairs
    USING ((EXISTS ( SELECT 1
   FROM public.profiles
  WHERE ((profiles.id = user_key_pairs.user_id) AND (profiles.auth_user_id = ( SELECT auth.uid() AS uid))))));

ALTER POLICY user_list_members_delete ON public.user_list_members
    USING ((EXISTS ( SELECT 1
   FROM public.user_lists ul
  WHERE ((ul.id = user_list_members.list_id) AND (ul.user_id = public.get_current_profile_id())))));

ALTER POLICY user_list_members_insert ON public.user_list_members
    WITH CHECK ((EXISTS ( SELECT 1
   FROM public.user_lists ul
  WHERE ((ul.id = user_list_members.list_id) AND (ul.user_id = public.get_current_profile_id())))));

ALTER POLICY user_list_members_own_list ON public.user_list_members
    USING ((EXISTS ( SELECT 1
   FROM public.user_lists ul
  WHERE ((ul.id = user_list_members.list_id) AND (ul.user_id = public.get_current_profile_id())))));

ALTER POLICY user_lists_delete ON public.user_lists
    USING ((user_id = public.get_current_profile_id()));

ALTER POLICY user_lists_insert ON public.user_lists
    WITH CHECK ((user_id = public.get_current_profile_id()));

ALTER POLICY user_lists_own_select ON public.user_lists
    USING ((user_id = public.get_current_profile_id()));

ALTER POLICY user_lists_update ON public.user_lists
    USING ((user_id = public.get_current_profile_id()))
    WITH CHECK ((user_id = public.get_current_profile_id()));

ALTER POLICY user_mutes_delete_own ON public.user_mutes
    USING ((muter_id = public.get_current_profile_id()));

ALTER POLICY user_mutes_insert_own ON public.user_mutes
    WITH CHECK ((muter_id = public.get_current_profile_id()));

ALTER POLICY user_mutes_select_own ON public.user_mutes
    USING ((muter_id = public.get_current_profile_id()));

ALTER POLICY user_mutes_update_own ON public.user_mutes
    USING ((muter_id = public.get_current_profile_id()));

ALTER POLICY "Service role only access" ON public.user_private_keys
    USING ((( SELECT auth.role() AS role) = 'service_role'::text));

ALTER POLICY user_roles_delete ON public.user_roles
    USING (((EXISTS ( SELECT 1
   FROM public.servers
  WHERE ((servers.id = user_roles.server_id) AND (servers.owner = public.get_current_profile_id())))) OR public.is_current_user_admin()));

ALTER POLICY user_roles_insert ON public.user_roles
    WITH CHECK (((EXISTS ( SELECT 1
   FROM public.servers
  WHERE ((servers.id = user_roles.server_id) AND (servers.owner = public.get_current_profile_id())))) OR public.is_current_user_admin()));

ALTER POLICY "Users can leave servers" ON public.user_servers
    USING (((user_id = public.get_current_profile_id()) OR (EXISTS ( SELECT 1
   FROM public.servers
  WHERE ((servers.id = user_servers.server_id) AND (servers.owner = public.get_current_profile_id()))))));

ALTER POLICY user_servers_insert_self ON public.user_servers
    WITH CHECK ((user_id = public.get_current_profile_id()));

ALTER POLICY user_servers_select_co_members ON public.user_servers
    USING (((user_id = public.get_current_profile_id()) OR public.current_user_is_member_of_server(server_id) OR public.is_current_user_admin()));

ALTER POLICY user_servers_update_own_or_owner ON public.user_servers
    USING (((user_id = public.get_current_profile_id()) OR (EXISTS ( SELECT 1
   FROM public.servers
  WHERE ((servers.id = user_servers.server_id) AND (servers.owner = public.get_current_profile_id())))) OR public.is_current_user_admin()));

ALTER POLICY "Users can delete own sessions" ON public.user_sessions
    USING ((public.get_current_profile_id() = user_id));

ALTER POLICY "Users can insert own sessions" ON public.user_sessions
    WITH CHECK ((public.get_current_profile_id() = user_id));

ALTER POLICY "Users can update own sessions" ON public.user_sessions
    USING ((public.get_current_profile_id() = user_id));

ALTER POLICY "Users can view own sessions" ON public.user_sessions
    USING ((public.get_current_profile_id() = user_id));

ALTER POLICY "Users can access own timeline cache" ON public.user_timeline_cache
    USING ((public.get_current_profile_id() = user_id));

ALTER POLICY user_view_contexts_own_user ON public.user_view_contexts
    USING ((user_id = public.get_current_profile_id()))
    WITH CHECK ((user_id = public.get_current_profile_id()));

ALTER POLICY voice_participants_delete_self ON public.voice_channel_participants
    USING ((user_id = public.get_current_profile_id()));

ALTER POLICY voice_participants_insert_self ON public.voice_channel_participants
    WITH CHECK ((user_id = public.get_current_profile_id()));

ALTER POLICY voice_participants_update_self ON public.voice_channel_participants
    USING ((user_id = public.get_current_profile_id()))
    WITH CHECK ((user_id = public.get_current_profile_id()));

ALTER POLICY "Users can create their own voice events" ON public.voice_federation_events
    WITH CHECK ((user_id = public.get_current_profile_id()));

ALTER POLICY "Users can view voice events they're involved in" ON public.voice_federation_events
    USING ((user_id = public.get_current_profile_id()));

COMMIT;
