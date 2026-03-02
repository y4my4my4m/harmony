ALTER TABLE auth.audit_log_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth.flow_state ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth.identities ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth.instances ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth.mfa_amr_claims ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth.mfa_challenges ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth.mfa_factors ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth.one_time_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth.refresh_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth.saml_providers ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth.saml_relay_states ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth.schema_migrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth.sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth.sso_domains ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth.sso_providers ENABLE ROW LEVEL SECURITY;
ALTER TABLE auth.users ENABLE ROW LEVEL SECURITY;
CREATE POLICY "A" ON public.emojis USING (true);
CREATE POLICY "Admin audit log admin access" ON public.admin_audit_log TO authenticated USING ((EXISTS ( SELECT 1
CREATE POLICY "Admins can delete webrtc settings" ON public.instance_webrtc_settings FOR DELETE USING ((EXISTS ( SELECT 1
CREATE POLICY "Admins can insert webrtc settings" ON public.instance_webrtc_settings FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
CREATE POLICY "Admins can read federation health" ON public.federation_health FOR SELECT USING ((EXISTS ( SELECT 1
CREATE POLICY "Admins can read hourly metrics" ON public.performance_metrics_hourly FOR SELECT USING ((EXISTS ( SELECT 1
CREATE POLICY "Admins can read metrics" ON public.performance_metrics FOR SELECT USING ((EXISTS ( SELECT 1
CREATE POLICY "Admins can read slow queries" ON public.slow_queries FOR SELECT USING ((EXISTS ( SELECT 1
CREATE POLICY "Admins can update remote emojis" ON public.remote_emojis_cache FOR UPDATE USING ((EXISTS ( SELECT 1
CREATE POLICY "Admins can update reports" ON public.reports FOR UPDATE TO authenticated USING ((EXISTS ( SELECT 1
CREATE POLICY "Admins can update webrtc settings" ON public.instance_webrtc_settings FOR UPDATE USING ((EXISTS ( SELECT 1
CREATE POLICY "Admins can view all audit logs" ON public.encryption_audit_log FOR SELECT USING ((EXISTS ( SELECT 1
CREATE POLICY "Admins can view all reports" ON public.reports FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
CREATE POLICY "Allow all" ON public.user_servers TO authenticated USING (true) WITH CHECK (true);
CREATE POLICY "Anyone can read webrtc settings" ON public.instance_webrtc_settings FOR SELECT USING (true);
CREATE POLICY "Anyone can view conversation participants" ON public.conversation_participants FOR SELECT USING (true);
CREATE POLICY "Anyone can view conversations" ON public.conversations FOR SELECT USING (true);
CREATE POLICY "Anyone can view federated instances" ON public.federated_instances FOR SELECT USING (true);
CREATE POLICY "Anyone can view hashtags" ON public.hashtags FOR SELECT USING (true);
CREATE POLICY "Anyone can view post hashtags" ON public.post_hashtags FOR SELECT USING (true);
CREATE POLICY "Anyone can view remote emojis" ON public.remote_emojis_cache FOR SELECT USING (true);
CREATE POLICY "Anyone can view trending posts" ON public.trending_posts FOR SELECT USING (true);
CREATE POLICY "Anyone can view trending users" ON public.trending_users FOR SELECT USING (true);
CREATE POLICY "Authenticated users can create conversations" ON public.conversations FOR INSERT WITH CHECK ((( SELECT auth.uid() AS uid) IS NOT NULL));
CREATE POLICY "Authenticated users can manage participants" ON public.conversation_participants FOR INSERT WITH CHECK ((auth.uid() IS NOT NULL));
CREATE POLICY "Authenticated users can read endpoint health" ON public.federation_endpoint_health FOR SELECT USING ((auth.role() = 'authenticated'::text));
CREATE POLICY "Blocked instances admin access" ON public.blocked_instances TO authenticated USING ((EXISTS ( SELECT 1
CREATE POLICY "Bot commands are public" ON public.bot_commands FOR SELECT USING (true);
CREATE POLICY "Bot owners can manage bots" ON public.bots USING ((EXISTS ( SELECT 1
CREATE POLICY "Bot owners can manage commands" ON public.bot_commands USING ((EXISTS ( SELECT 1
CREATE POLICY "Bot owners can manage tokens" ON public.bot_tokens USING ((EXISTS ( SELECT 1
CREATE POLICY "Bot owners can view audit logs" ON public.bot_audit_log FOR SELECT USING ((EXISTS ( SELECT 1
CREATE POLICY "Bot presence is public" ON public.bot_presence FOR SELECT USING (true);
CREATE POLICY "Conversation participants can insert encryption settings" ON public.conversation_encryption_settings FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
CREATE POLICY "Conversation participants can update conversations" ON public.conversations FOR UPDATE USING (((( SELECT auth.uid() AS uid) IS NOT NULL) AND (EXISTS ( SELECT 1
CREATE POLICY "Conversation participants can update encryption settings" ON public.conversation_encryption_settings FOR UPDATE USING ((EXISTS ( SELECT 1
CREATE POLICY "Conversation participants can view encryption settings" ON public.conversation_encryption_settings FOR SELECT USING ((EXISTS ( SELECT 1
CREATE POLICY "Delete own voice participation" ON public.voice_channel_participants FOR DELETE TO authenticated USING ((user_id = auth.uid()));
CREATE POLICY "Enable insert for authenticated users only" ON public.notifications FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Enable insert for authenticated users only" ON public.servers FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "Enable insert for users based on user_id" ON public.notifications FOR UPDATE USING ((( SELECT ( SELECT auth.uid() AS uid) AS uid) = user_id)) WITH CHECK ((( SELECT ( SELECT auth.uid() AS uid) AS uid) = user_id));
CREATE POLICY "Enable read access for all users" ON public.channel_categories FOR SELECT USING (true);
CREATE POLICY "Enable read access for all users" ON public.invites FOR SELECT USING (true);
CREATE POLICY "Enable read access for all users" ON public.profiles FOR SELECT USING (true);
CREATE POLICY "Enable read access for all users" ON public.servers FOR SELECT USING (true);
CREATE POLICY "Enable read access for all users" ON public.user_servers FOR SELECT USING (true);
CREATE POLICY "Enable users to view their own data only" ON public.notifications FOR SELECT TO authenticated USING (true);
CREATE POLICY "Everyone can view server encryption settings" ON public.server_encryption_settings FOR SELECT USING (true);
CREATE POLICY "FIXME: Enable insert for authenticated users only" ON public.invites FOR INSERT WITH CHECK (true);
CREATE POLICY "FIXME: Server owners can insert/update/delete" ON public.channel_categories USING (true) WITH CHECK (true);
CREATE POLICY "FIXME: update" ON public.invites FOR UPDATE USING (true) WITH CHECK (true);
CREATE POLICY "Insert own voice participation" ON public.voice_channel_participants FOR INSERT TO authenticated WITH CHECK ((user_id = auth.uid()));
CREATE POLICY "Instance config admin access" ON public.instance_config TO authenticated USING ((EXISTS ( SELECT 1
CREATE POLICY "Members can view server membership events" ON public.server_membership_events FOR SELECT TO authenticated USING ((server_id IN ( SELECT us.server_id
CREATE POLICY "Message owner or server owner can update" ON public.messages FOR UPDATE TO authenticated USING ((auth.session_meets_aal_requirement() AND ((( SELECT auth.uid() AS uid) = user_id) OR (( SELECT auth.uid() AS uid) = ( SELECT servers.owner
CREATE POLICY "Moderators can delete threads" ON public.threads FOR DELETE USING (public.has_permission(auth.uid(), ( SELECT channels.server_id
CREATE POLICY "Only authenticated users can manage instances" ON public.federated_instances USING ((( SELECT auth.uid() AS uid) IS NOT NULL));
CREATE POLICY "Only system can modify hashtags" ON public.hashtags USING (false) WITH CHECK (false);
CREATE POLICY "Only system can modify post hashtags" ON public.post_hashtags USING (false) WITH CHECK (false);
CREATE POLICY "Only system can modify trending posts" ON public.trending_posts USING (false) WITH CHECK (false);
CREATE POLICY "Only system can modify trending users" ON public.trending_users USING (false) WITH CHECK (false);
CREATE POLICY "Public bots are viewable by everyone" ON public.bots FOR SELECT USING (((is_public = true) OR (EXISTS ( SELECT 1
CREATE POLICY "Public can read federation settings" ON public.instance_config FOR SELECT USING ((config_key = ANY (ARRAY['federation_settings'::text, 'domain'::text, 'instance_name'::text, 'instance_description'::text, 'open_registration'::text, 'approval_required'::text, 'oauth_providers'::text])));
CREATE POLICY "Recipients can update call status" ON public.federated_voice_calls FOR UPDATE USING ((auth.uid() = recipient_id)) WITH CHECK ((auth.uid() = recipient_id));
CREATE POLICY "Requesters can manage their key requests" ON public.megolm_key_requests USING (((EXISTS ( SELECT 1
CREATE POLICY "Room participants can view session metadata" ON public.megolm_room_sessions FOR SELECT USING (((EXISTS ( SELECT 1
CREATE POLICY "Select voice participants" ON public.voice_channel_participants FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
CREATE POLICY "Senders can create session shares" ON public.megolm_session_shares FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
CREATE POLICY "Senders can delete their session shares" ON public.megolm_session_shares FOR DELETE USING ((EXISTS ( SELECT 1
CREATE POLICY "Senders can view and fulfill key requests" ON public.megolm_key_requests USING ((EXISTS ( SELECT 1
CREATE POLICY "Server members can view bot permissions" ON public.bot_server_permissions FOR SELECT USING ((EXISTS ( SELECT 1
CREATE POLICY "Server owners can delete their servers" ON public.servers FOR DELETE TO authenticated USING ((auth.session_meets_aal_requirement() AND (owner = ( SELECT auth.uid() AS uid))));
CREATE POLICY "Server owners can manage bot permissions" ON public.bot_server_permissions USING ((EXISTS ( SELECT 1
CREATE POLICY "Server owners can manage encryption settings" ON public.server_encryption_settings USING ((EXISTS ( SELECT 1
CREATE POLICY "Server owners can update their servers" ON public.servers FOR UPDATE TO authenticated USING ((auth.session_meets_aal_requirement() AND (owner = ( SELECT auth.uid() AS uid)))) WITH CHECK ((auth.session_meets_aal_requirement() AND (owner = ( SELECT auth.uid() AS uid))));
CREATE POLICY "Service Role Can Read" ON public.profiles FOR SELECT USING (true);
CREATE POLICY "Service role can manage actor cache" ON public.ap_actor_cache USING ((auth.role() = 'service_role'::text));
CREATE POLICY "Service role can manage all push subscriptions" ON public.push_subscriptions TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "Service role can manage all sessions" ON public.user_sessions TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "Service role can manage delivery queue" ON public.federation_delivery_queue USING ((auth.role() = 'service_role'::text));
CREATE POLICY "Service role can manage endpoint health" ON public.federation_endpoint_health USING ((auth.role() = 'service_role'::text));
CREATE POLICY "Service role can manage federation queue" ON public.federation_delivery_queue TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "Service role can manage object cache" ON public.ap_object_cache USING ((auth.role() = 'service_role'::text));
CREATE POLICY "Service role can manage remote emojis" ON public.remote_emojis_cache USING ((auth.role() = 'service_role'::text));
CREATE POLICY "Service role can read all blocks" ON public.user_blocks FOR SELECT TO service_role USING (true);
CREATE POLICY "Service role full access" ON public.voice_channel_participants TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "Service role full access on calls" ON public.federated_voice_calls TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "Service role manages all background jobs" ON public.pg_background_job USING ((auth.role() = 'service_role'::text));
CREATE POLICY "Service role only access" ON public.user_private_keys USING ((auth.role() = 'service_role'::text));
CREATE POLICY "System can insert audit logs" ON public.encryption_audit_log FOR INSERT WITH CHECK (true);
CREATE POLICY "System can insert calls" ON public.federated_voice_calls FOR INSERT WITH CHECK (true);
CREATE POLICY "System can insert membership events" ON public.server_membership_events FOR INSERT TO authenticated WITH CHECK (true);
CREATE POLICY "System can manage ActivityPub activities" ON public.ap_activities USING (true);
CREATE POLICY "System can manage all timeline entries" ON public.timeline_entries USING (true) WITH CHECK (true);
CREATE POLICY "System can manage federated profiles" ON public.profiles USING (((is_local = false) OR (auth_user_id = ( SELECT auth.uid() AS uid))));
CREATE POLICY "System can manage unread counts" ON public.unread_counts WITH CHECK (true);
CREATE POLICY "Update" ON public.servers FOR UPDATE USING ((EXISTS ( SELECT 1
CREATE POLICY "Update own calls" ON public.federated_voice_calls FOR UPDATE USING (((caller_id = auth.uid()) OR (recipient_id = auth.uid())));
CREATE POLICY "Update own voice participation" ON public.voice_channel_participants FOR UPDATE TO authenticated USING ((user_id = auth.uid())) WITH CHECK ((user_id = auth.uid()));
CREATE POLICY "Users can access own timeline cache" ON public.user_timeline_cache USING ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "Users can block other users" ON public.user_blocks FOR INSERT WITH CHECK ((blocker_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY "Users can check if blocked" ON public.user_blocks FOR SELECT USING ((blocked_user_id = public.get_current_profile_id()));
CREATE POLICY "Users can create background jobs" ON public.pg_background_job FOR INSERT WITH CHECK ((auth.role() = 'authenticated'::text));
CREATE POLICY "Users can create blocks" ON public.user_blocks FOR INSERT WITH CHECK ((blocker_id = public.get_current_profile_id()));
CREATE POLICY "Users can create conversations" ON public.conversations FOR INSERT TO authenticated WITH CHECK (auth.session_meets_aal_requirement());
CREATE POLICY "Users can create follow relationships" ON public.follows FOR INSERT WITH CHECK ((( SELECT auth.uid() AS uid) = follower_id));
CREATE POLICY "Users can create messages in conversations they participate in" ON public.messages FOR INSERT TO authenticated WITH CHECK ((auth.session_meets_aal_requirement() AND (user_id = ( SELECT auth.uid() AS uid)) AND (((conversation_id IS NOT NULL) AND (EXISTS ( SELECT 1
CREATE POLICY "Users can create own folders" ON public.server_folders FOR INSERT WITH CHECK ((auth.uid() = user_id));
CREATE POLICY "Users can create post interactions on posts they can see" ON public.post_interactions FOR INSERT WITH CHECK (((user_id = public.get_current_profile_id()) AND (post_id IN ( SELECT p.id
CREATE POLICY "Users can create reactions on messages they can see" ON public.reactions FOR INSERT WITH CHECK (((user_id = ( SELECT auth.uid() AS uid)) AND (message_id IN ( SELECT m.id
CREATE POLICY "Users can create reports" ON public.reports FOR INSERT TO authenticated WITH CHECK ((reporter_id = auth.uid()));
CREATE POLICY "Users can create their own activities" ON public.ap_activities FOR INSERT WITH CHECK ((actor_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY "Users can create their own interactions" ON public.post_interactions FOR INSERT WITH CHECK ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "Users can create their own posts" ON public.posts FOR INSERT WITH CHECK ((author_id = public.get_current_profile_id()));
CREATE POLICY "Users can create their own server events" ON public.server_federation_events FOR INSERT WITH CHECK ((user_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY "Users can create their own voice events" ON public.voice_federation_events FOR INSERT WITH CHECK ((user_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY "Users can create threads" ON public.threads FOR INSERT WITH CHECK (((EXISTS ( SELECT 1
CREATE POLICY "Users can delete own blocks" ON public.user_blocks FOR DELETE USING ((blocker_id = public.get_current_profile_id()));
CREATE POLICY "Users can delete own folders" ON public.server_folders FOR DELETE USING ((auth.uid() = user_id));
CREATE POLICY "Users can delete own gif favorites" ON public.gif_favorites FOR DELETE USING ((user_id = auth.uid()));
CREATE POLICY "Users can delete own push subscriptions" ON public.push_subscriptions FOR DELETE USING ((auth.uid() = user_id));
CREATE POLICY "Users can delete own sessions" ON public.user_sessions FOR DELETE USING ((auth.uid() = user_id));
CREATE POLICY "Users can delete their follow relationships" ON public.follows FOR DELETE USING (((( SELECT auth.uid() AS uid) = follower_id) OR (( SELECT auth.uid() AS uid) = following_id)));
CREATE POLICY "Users can delete their own interactions" ON public.post_interactions FOR DELETE USING ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "Users can delete their own post interactions" ON public.post_interactions FOR DELETE USING ((user_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY "Users can delete their own posts" ON public.posts FOR DELETE USING ((author_id = public.get_current_profile_id()));
CREATE POLICY "Users can delete their own reactions" ON public.reactions FOR DELETE USING ((user_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY "Users can delete their own recovery codes" ON public.mfa_recovery_codes FOR DELETE USING ((auth.uid() = user_id));
CREATE POLICY "Users can insert own gif favorites" ON public.gif_favorites FOR INSERT WITH CHECK ((user_id = auth.uid()));
CREATE POLICY "Users can insert own push subscriptions" ON public.push_subscriptions FOR INSERT WITH CHECK ((auth.uid() = user_id));
CREATE POLICY "Users can insert own sessions" ON public.user_sessions FOR INSERT WITH CHECK ((auth.uid() = user_id));
CREATE POLICY "Users can insert their own key pairs" ON public.user_key_pairs FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
CREATE POLICY "Users can insert their own prekeys" ON public.prekeys FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
CREATE POLICY "Users can insert their own profile." ON public.profiles FOR INSERT WITH CHECK ((( SELECT auth.uid() AS uid) = id));
CREATE POLICY "Users can insert their own recovery codes" ON public.mfa_recovery_codes FOR INSERT WITH CHECK ((auth.uid() = user_id));
CREATE POLICY "Users can insert their own timeline entries" ON public.timeline_entries FOR INSERT WITH CHECK ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "Users can insert their own view context" ON public.user_view_contexts FOR INSERT WITH CHECK ((auth.uid() = user_id));
CREATE POLICY "Users can join conversations they're invited to" ON public.conversation_participants FOR INSERT TO authenticated WITH CHECK (auth.session_meets_aal_requirement());
CREATE POLICY "Users can join threads" ON public.thread_members FOR INSERT WITH CHECK (((user_id = auth.uid()) AND (EXISTS ( SELECT 1
CREATE POLICY "Users can leave conversations" ON public.conversation_participants FOR DELETE USING (((( SELECT auth.uid() AS uid) IS NOT NULL) AND (user_id = ( SELECT auth.uid() AS uid))));
CREATE POLICY "Users can leave servers" ON public.user_servers FOR DELETE TO authenticated USING ((auth.session_meets_aal_requirement() AND ((user_id = ( SELECT auth.uid() AS uid)) OR (EXISTS ( SELECT 1
CREATE POLICY "Users can leave threads" ON public.thread_members FOR DELETE USING ((user_id = auth.uid()));
CREATE POLICY "Users can manage their own backups" ON public.megolm_key_backups USING ((EXISTS ( SELECT 1
CREATE POLICY "Users can manage their own notification channels" ON public.notification_channels USING ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "Users can manage their own notification preferences" ON public.notification_preferences USING ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "Users can manage their own recovery metadata" ON public.recovery_key_metadata USING ((EXISTS ( SELECT 1
CREATE POLICY "Users can manage their own sessions" ON public.encryption_sessions USING ((EXISTS ( SELECT 1
CREATE POLICY "Users can manage their own sessions" ON public.megolm_room_sessions USING ((EXISTS ( SELECT 1
CREATE POLICY "Users can mark their own recovery codes as used" ON public.mfa_recovery_codes FOR UPDATE USING (((auth.uid() = user_id) AND (used_at IS NULL))) WITH CHECK ((auth.uid() = user_id));
CREATE POLICY "Users can read their own view context" ON public.user_view_contexts FOR SELECT USING ((auth.uid() = user_id));
CREATE POLICY "Users can remove their own blocks" ON public.user_blocks FOR DELETE USING ((blocker_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY "Users can search messages they have access to" ON public.message_search_index FOR SELECT TO authenticated USING ((((conversation_id IS NOT NULL) AND (EXISTS ( SELECT 1
CREATE POLICY "Users can see their own blocks" ON public.user_blocks FOR SELECT USING ((blocker_id = public.get_current_profile_id()));
CREATE POLICY "Users can update conversations they participate in" ON public.conversations FOR UPDATE USING ((EXISTS ( SELECT 1
CREATE POLICY "Users can update own folders" ON public.server_folders FOR UPDATE USING ((auth.uid() = user_id)) WITH CHECK ((auth.uid() = user_id));
CREATE POLICY "Users can update own profile" ON public.profiles FOR UPDATE USING ((id = public.get_current_profile_id())) WITH CHECK ((id = public.get_current_profile_id()));
CREATE POLICY "Users can update own profile." ON public.profiles FOR UPDATE TO authenticated USING (((( SELECT auth.uid() AS uid) = id) AND auth.session_meets_aal_requirement())) WITH CHECK (((( SELECT auth.uid() AS uid) = id) AND auth.session_meets_aal_requirement()));
CREATE POLICY "Users can update own push subscriptions" ON public.push_subscriptions FOR UPDATE USING ((auth.uid() = user_id));
CREATE POLICY "Users can update own sessions" ON public.user_sessions FOR UPDATE USING ((auth.uid() = user_id));
CREATE POLICY "Users can update own thread membership" ON public.thread_members FOR UPDATE USING ((user_id = auth.uid()));
CREATE POLICY "Users can update session shares" ON public.megolm_session_shares FOR UPDATE USING ((EXISTS ( SELECT 1
CREATE POLICY "Users can update their follow relationships" ON public.follows FOR UPDATE USING (((( SELECT auth.uid() AS uid) = follower_id) OR (( SELECT auth.uid() AS uid) = following_id)));
CREATE POLICY "Users can update their own activities" ON public.ap_activities FOR UPDATE USING ((actor_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY "Users can update their own interactions" ON public.post_interactions FOR UPDATE USING ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "Users can update their own key pairs" ON public.user_key_pairs FOR UPDATE USING ((EXISTS ( SELECT 1
CREATE POLICY "Users can update their own participation" ON public.conversation_participants FOR UPDATE USING (((( SELECT auth.uid() AS uid) IS NOT NULL) AND (user_id = ( SELECT auth.uid() AS uid)))) WITH CHECK (((( SELECT auth.uid() AS uid) IS NOT NULL) AND (user_id = ( SELECT auth.uid() AS uid))));
CREATE POLICY "Users can update their own participations" ON public.conversation_participants FOR UPDATE USING ((user_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY "Users can update their own post interactions" ON public.post_interactions FOR UPDATE USING ((user_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY "Users can update their own posts" ON public.posts FOR UPDATE USING ((author_id = public.get_current_profile_id())) WITH CHECK ((author_id = public.get_current_profile_id()));
CREATE POLICY "Users can update their own prekeys" ON public.prekeys FOR UPDATE USING ((EXISTS ( SELECT 1
CREATE POLICY "Users can update their own reactions" ON public.reactions FOR UPDATE USING ((user_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY "Users can update their own unread counts" ON public.unread_counts FOR UPDATE USING ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "Users can update their own view context" ON public.user_view_contexts FOR UPDATE USING ((auth.uid() = user_id));
CREATE POLICY "Users can update threads" ON public.threads FOR UPDATE USING (((created_by = auth.uid()) OR public.has_permission(auth.uid(), ( SELECT channels.server_id
CREATE POLICY "Users can view all interactions" ON public.post_interactions FOR SELECT USING (true);
CREATE POLICY "Users can view all profiles" ON public.profiles FOR SELECT USING (true);
CREATE POLICY "Users can view channel overrides" ON public.channel_permission_overrides FOR SELECT USING ((EXISTS ( SELECT 1
CREATE POLICY "Users can view conversations they participate in" ON public.conversations FOR SELECT USING ((EXISTS ( SELECT 1
CREATE POLICY "Users can view federation delivery queue" ON public.federation_delivery_queue FOR SELECT TO authenticated USING (true);
CREATE POLICY "Users can view follows" ON public.follows FOR SELECT USING (((status = 'accepted'::text) OR (( SELECT auth.uid() AS uid) = follower_id) OR (( SELECT auth.uid() AS uid) = following_id)));
CREATE POLICY "Users can view messages in conversations they participate in" ON public.messages FOR SELECT TO authenticated USING ((auth.session_meets_aal_requirement() AND (((conversation_id IS NOT NULL) AND (EXISTS ( SELECT 1
CREATE POLICY "Users can view non-suspended profiles" ON public.profiles FOR SELECT USING (((id = public.get_current_profile_id()) OR ((is_suspended = false) OR (is_suspended IS NULL))));
CREATE POLICY "Users can view others' public keys for encryption" ON public.user_key_pairs FOR SELECT USING ((is_active = true));
CREATE POLICY "Users can view others' unused public prekeys" ON public.prekeys FOR SELECT USING ((is_used = false));
CREATE POLICY "Users can view own blocks" ON public.user_blocks FOR SELECT USING ((blocker_id = public.get_current_profile_id()));
CREATE POLICY "Users can view own folders" ON public.server_folders FOR SELECT USING ((auth.uid() = user_id));
CREATE POLICY "Users can view own gif favorites" ON public.gif_favorites FOR SELECT USING ((user_id = auth.uid()));
CREATE POLICY "Users can view own push subscriptions" ON public.push_subscriptions FOR SELECT USING ((auth.uid() = user_id));
CREATE POLICY "Users can view own reports" ON public.reports FOR SELECT TO authenticated USING ((reporter_id = auth.uid()));
CREATE POLICY "Users can view own sessions" ON public.user_sessions FOR SELECT USING ((auth.uid() = user_id));
CREATE POLICY "Users can view participants in their conversations" ON public.conversation_participants FOR SELECT TO authenticated USING ((auth.session_meets_aal_requirement() AND ((user_id = ( SELECT auth.uid() AS uid)) OR public.user_is_conversation_member(conversation_id, ( SELECT auth.uid() AS uid)))));
CREATE POLICY "Users can view post interactions on posts they can see" ON public.post_interactions FOR SELECT USING ((post_id IN ( SELECT p.id
CREATE POLICY "Users can view posts from users they follow" ON public.posts FOR SELECT USING (((visibility = 'followers'::text) AND ((is_deleted = false) OR (is_deleted IS NULL)) AND (COALESCE(public.is_author_suspended(author_id), false) = false) AND (EXISTS ( SELECT 1
CREATE POLICY "Users can view public posts" ON public.posts FOR SELECT USING (((visibility = ANY (ARRAY['public'::text, 'unlisted'::text])) AND ((is_deleted = false) OR (is_deleted IS NULL)) AND (COALESCE(public.is_author_suspended(author_id), false) = false)));
CREATE POLICY "Users can view reactions on messages they can see" ON public.reactions FOR SELECT USING ((message_id IN ( SELECT m.id
CREATE POLICY "Users can view role assignments" ON public.user_roles FOR SELECT USING ((EXISTS ( SELECT 1
CREATE POLICY "Users can view server events they're involved in" ON public.server_federation_events FOR SELECT USING ((user_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY "Users can view server roles" ON public.server_roles FOR SELECT USING (((EXISTS ( SELECT 1
CREATE POLICY "Users can view server settings" ON public.server_settings FOR SELECT USING ((EXISTS ( SELECT 1
CREATE POLICY "Users can view their conversations" ON public.conversations FOR SELECT TO authenticated USING ((auth.session_meets_aal_requirement() AND (EXISTS ( SELECT 1
CREATE POLICY "Users can view their deleted posts" ON public.posts FOR SELECT USING (((author_id = public.get_current_profile_id()) AND (is_deleted = true)));
CREATE POLICY "Users can view their own activities" ON public.ap_activities FOR SELECT USING ((actor_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY "Users can view their own audit logs" ON public.encryption_audit_log FOR SELECT USING ((EXISTS ( SELECT 1
CREATE POLICY "Users can view their own blocks" ON public.user_blocks FOR SELECT USING ((blocker_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY "Users can view their own calls" ON public.federated_voice_calls FOR SELECT USING (((auth.uid() = recipient_id) OR (auth.uid() = caller_id)));
CREATE POLICY "Users can view their own key pairs" ON public.user_key_pairs FOR SELECT USING ((EXISTS ( SELECT 1
CREATE POLICY "Users can view their own posts" ON public.posts FOR SELECT USING (((author_id = public.get_current_profile_id()) AND ((is_deleted = false) OR (is_deleted IS NULL))));
CREATE POLICY "Users can view their own prekeys" ON public.prekeys FOR SELECT USING ((EXISTS ( SELECT 1
CREATE POLICY "Users can view their own sessions" ON public.encryption_sessions FOR SELECT USING (((EXISTS ( SELECT 1
CREATE POLICY "Users can view their own timeline entries" ON public.timeline_entries FOR SELECT USING ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "Users can view their own unread counts" ON public.unread_counts FOR SELECT USING ((( SELECT auth.uid() AS uid) = user_id));
CREATE POLICY "Users can view their own unused recovery codes" ON public.mfa_recovery_codes FOR SELECT USING (((auth.uid() = user_id) AND (used_at IS NULL)));
CREATE POLICY "Users can view their session shares" ON public.megolm_session_shares FOR SELECT USING ((EXISTS ( SELECT 1
CREATE POLICY "Users can view their timeline entries" ON public.timeline_entries FOR SELECT USING (((user_id = public.get_current_profile_id()) AND (post_id IN ( SELECT p.id
CREATE POLICY "Users can view thread members" ON public.thread_members FOR SELECT USING ((EXISTS ( SELECT 1
CREATE POLICY "Users can view threads" ON public.threads FOR SELECT USING ((EXISTS ( SELECT 1
CREATE POLICY "Users can view voice events they're involved in" ON public.voice_federation_events FOR SELECT USING ((user_id = ( SELECT auth.uid() AS uid)));
CREATE POLICY "Users with MANAGE_CHANNELS can manage overrides" ON public.channel_permission_overrides USING ((EXISTS ( SELECT 1
CREATE POLICY "Users with MANAGE_ROLES can assign roles" ON public.user_roles FOR INSERT WITH CHECK (public.has_permission(auth.uid(), server_id, 'MANAGE_ROLES'::text));
CREATE POLICY "Users with MANAGE_ROLES can create roles" ON public.server_roles FOR INSERT WITH CHECK (public.has_permission(auth.uid(), server_id, 'MANAGE_ROLES'::text));
CREATE POLICY "Users with MANAGE_ROLES can delete roles" ON public.server_roles FOR DELETE USING ((public.has_permission(auth.uid(), server_id, 'MANAGE_ROLES'::text) AND (NOT is_default)));
CREATE POLICY "Users with MANAGE_ROLES can remove roles" ON public.user_roles FOR DELETE USING (public.has_permission(auth.uid(), server_id, 'MANAGE_ROLES'::text));
CREATE POLICY "Users with MANAGE_ROLES can update roles" ON public.server_roles FOR UPDATE USING ((public.has_permission(auth.uid(), server_id, 'MANAGE_ROLES'::text) AND (NOT is_default)));
CREATE POLICY "Users with MANAGE_SERVER can manage settings" ON public.server_settings USING (public.has_permission(auth.uid(), server_id, 'MANAGE_SERVER'::text));
CREATE POLICY "View own calls" ON public.federated_voice_calls FOR SELECT USING (((caller_id = auth.uid()) OR (recipient_id = auth.uid())));
ALTER TABLE public.admin_audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ap_activities ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ap_actor_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.ap_object_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.blocked_instances ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bot_audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bot_commands ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bot_presence ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bot_rate_limits ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bot_server_permissions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bot_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bot_webhooks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.bots ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.channel_categories ENABLE ROW LEVEL SECURITY;
CREATE POLICY channel_categories_update_policy ON public.channel_categories FOR UPDATE TO authenticated USING ((server_id IN ( SELECT user_servers.server_id
ALTER TABLE public.channel_permission_overrides ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.channels ENABLE ROW LEVEL SECURITY;
CREATE POLICY channels_delete_policy ON public.channels FOR DELETE TO authenticated USING ((EXISTS ( SELECT 1
CREATE POLICY channels_insert_policy ON public.channels FOR INSERT TO authenticated WITH CHECK ((EXISTS ( SELECT 1
CREATE POLICY channels_select_policy ON public.channels FOR SELECT TO authenticated USING ((server_id IN ( SELECT user_servers.server_id
CREATE POLICY channels_update_policy ON public.channels FOR UPDATE TO authenticated USING ((EXISTS ( SELECT 1
ALTER TABLE public.conversation_encryption_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.conversation_participants ENABLE ROW LEVEL SECURITY;
CREATE POLICY conversation_participants_delete_policy ON public.conversation_participants FOR DELETE TO authenticated USING ((auth.session_meets_aal_requirement() AND (user_id = ( SELECT auth.uid() AS uid))));
CREATE POLICY conversation_participants_select_policy ON public.conversation_participants FOR SELECT USING (true);
CREATE POLICY conversation_participants_update_policy ON public.conversation_participants FOR UPDATE TO authenticated USING ((auth.session_meets_aal_requirement() AND (user_id = ( SELECT auth.uid() AS uid))));
ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;
CREATE POLICY emoji_access_policy ON public.emojis TO authenticated USING ((server_id IN ( SELECT user_servers.server_id
CREATE POLICY emoji_public_access_policy ON public.emojis FOR SELECT TO authenticated USING ((server_id IN ( SELECT servers.id
ALTER TABLE public.emoji_usage ENABLE ROW LEVEL SECURITY;
CREATE POLICY emoji_usage_access_policy ON public.emoji_usage TO authenticated USING ((server_id IN ( SELECT user_servers.server_id
ALTER TABLE public.emojis ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.encryption_audit_log ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.encryption_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.federated_instances ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.federated_voice_calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.federation_delivery_queue ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.federation_endpoint_health ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.federation_health ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.files ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.follows ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.gif_favorites ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.hashtags ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.instance_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.instance_webrtc_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.invites ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.megolm_key_backups ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.megolm_key_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.megolm_room_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.megolm_session_shares ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.message_search_index ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY messages_delete_policy ON public.messages FOR DELETE TO authenticated USING ((auth.session_meets_aal_requirement() AND ((user_id = ( SELECT auth.uid() AS uid)) OR ((channel_id IS NOT NULL) AND (EXISTS ( SELECT 1
CREATE POLICY messages_insert_own ON public.messages FOR INSERT WITH CHECK (((user_id = public.get_current_profile_id()) AND ((channel_id IS NOT NULL) OR (conversation_id IS NULL) OR (NOT (EXISTS ( SELECT 1
ALTER TABLE public.mfa_recovery_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notification_channels ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notification_preferences ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.notifications ENABLE ROW LEVEL SECURITY;
CREATE POLICY notifications_realtime_delete ON public.notifications FOR DELETE USING ((( SELECT auth.uid() AS uid) = user_id));
ALTER TABLE public.performance_metrics ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.performance_metrics_hourly ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.pg_background_job ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.post_hashtags ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.post_interactions ENABLE ROW LEVEL SECURITY;
CREATE POLICY post_interactions_insert_own ON public.post_interactions FOR INSERT WITH CHECK (((user_id = public.get_current_profile_id()) AND (NOT public.is_blocked_by(( SELECT posts.author_id
ALTER TABLE public.posts ENABLE ROW LEVEL SECURITY;
CREATE POLICY posts_select_public ON public.posts FOR SELECT USING (((author_id = public.get_current_profile_id()) OR ((NOT public.is_blocked_by(author_id)) AND ((visibility = ANY (ARRAY['public'::text, 'unlisted'::text])) OR ((visibility = 'followers'::text) AND (EXISTS ( SELECT 1
ALTER TABLE public.prekeys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.push_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reactions ENABLE ROW LEVEL SECURITY;
CREATE POLICY reactions_insert_own ON public.reactions FOR INSERT WITH CHECK (((user_id = public.get_current_profile_id()) AND (NOT public.is_blocked_by(( SELECT messages.user_id
ALTER TABLE public.recovery_key_metadata ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.remote_emojis_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.reports ENABLE ROW LEVEL SECURITY;
CREATE POLICY server_delete_policy ON public.servers FOR DELETE TO authenticated USING ((EXISTS ( SELECT 1
ALTER TABLE public.server_encryption_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.server_federation_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.server_folders ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.server_membership_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.server_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.server_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.servers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.slow_queries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.thread_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.threads ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.timeline_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trending_posts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trending_users ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.unread_counts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_blocks ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_key_pairs ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_list_members ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_list_members_delete ON public.user_list_members FOR DELETE USING ((EXISTS ( SELECT 1
CREATE POLICY user_list_members_insert ON public.user_list_members FOR INSERT WITH CHECK ((EXISTS ( SELECT 1
CREATE POLICY user_list_members_own_list ON public.user_list_members FOR SELECT USING ((EXISTS ( SELECT 1
CREATE POLICY user_list_members_public_list ON public.user_list_members FOR SELECT USING ((EXISTS ( SELECT 1
ALTER TABLE public.user_lists ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_lists_delete ON public.user_lists FOR DELETE USING ((user_id = public.get_current_profile_id()));
CREATE POLICY user_lists_insert ON public.user_lists FOR INSERT WITH CHECK ((user_id = public.get_current_profile_id()));
CREATE POLICY user_lists_own_select ON public.user_lists FOR SELECT USING ((user_id = public.get_current_profile_id()));
CREATE POLICY user_lists_public_select ON public.user_lists FOR SELECT USING ((is_public = true));
CREATE POLICY user_lists_update ON public.user_lists FOR UPDATE USING ((user_id = public.get_current_profile_id())) WITH CHECK ((user_id = public.get_current_profile_id()));
ALTER TABLE public.user_mutes ENABLE ROW LEVEL SECURITY;
CREATE POLICY user_mutes_delete_own ON public.user_mutes FOR DELETE USING ((muter_id = public.get_current_profile_id()));
CREATE POLICY user_mutes_insert_own ON public.user_mutes FOR INSERT WITH CHECK ((muter_id = public.get_current_profile_id()));
CREATE POLICY user_mutes_select_own ON public.user_mutes FOR SELECT USING ((muter_id = public.get_current_profile_id()));
CREATE POLICY user_mutes_update_own ON public.user_mutes FOR UPDATE USING ((muter_id = public.get_current_profile_id()));
ALTER TABLE public.user_private_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_roles ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_servers ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_timeline_cache ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.user_view_contexts ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.voice_channel_participants ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.voice_federation_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE realtime.messages ENABLE ROW LEVEL SECURITY;
CREATE POLICY "Admins and server owners can delete emojis" ON storage.objects FOR DELETE TO authenticated USING (((bucket_id = 'emojis'::text) AND ((EXISTS ( SELECT 1
CREATE POLICY "Admins and server owners can delete server icons" ON storage.objects FOR DELETE TO authenticated USING (((bucket_id = 'server_icons'::text) AND ((EXISTS ( SELECT 1
CREATE POLICY "Admins and server owners can update emojis" ON storage.objects FOR UPDATE TO authenticated USING (((bucket_id = 'emojis'::text) AND ((EXISTS ( SELECT 1
CREATE POLICY "Admins and server owners can update server icons" ON storage.objects FOR UPDATE TO authenticated USING (((bucket_id = 'server_icons'::text) AND ((EXISTS ( SELECT 1
CREATE POLICY "Admins and server owners can upload emojis" ON storage.objects FOR INSERT TO authenticated WITH CHECK (((bucket_id = 'emojis'::text) AND ((EXISTS ( SELECT 1
CREATE POLICY "Admins and server owners can upload server icons" ON storage.objects FOR INSERT TO authenticated WITH CHECK (((bucket_id = 'server_icons'::text) AND ((EXISTS ( SELECT 1
CREATE POLICY "Anyone can view avatars" ON storage.objects FOR SELECT TO authenticated, anon USING ((bucket_id = 'avatars'::text));
CREATE POLICY "Anyone can view banners" ON storage.objects FOR SELECT TO authenticated, anon USING ((bucket_id = 'banners'::text));
CREATE POLICY "Anyone can view emojis" ON storage.objects FOR SELECT TO authenticated, anon USING ((bucket_id = 'emojis'::text));
CREATE POLICY "Anyone can view server icons" ON storage.objects FOR SELECT TO authenticated, anon USING ((bucket_id = 'server_icons'::text));
CREATE POLICY "Anyone can view user media" ON storage.objects FOR SELECT TO authenticated, anon USING ((bucket_id = 'user_media'::text));
CREATE POLICY "Application controlled group icon deletes" ON storage.objects FOR DELETE USING ((bucket_id = 'group-icons'::text));
CREATE POLICY "Application controlled group icon updates" ON storage.objects FOR UPDATE USING ((bucket_id = 'group-icons'::text));
CREATE POLICY "Application controlled group icon uploads" ON storage.objects FOR INSERT WITH CHECK ((bucket_id = 'group-icons'::text));
CREATE POLICY "Public read access for group icons" ON storage.objects FOR SELECT USING ((bucket_id = 'group-icons'::text));
CREATE POLICY "Users can delete their own avatars" ON storage.objects FOR DELETE TO authenticated USING (((bucket_id = 'avatars'::text) AND ((EXISTS ( SELECT 1
CREATE POLICY "Users can delete their own banners" ON storage.objects FOR DELETE TO authenticated USING (((bucket_id = 'banners'::text) AND ((EXISTS ( SELECT 1
CREATE POLICY "Users can delete their own media" ON storage.objects FOR DELETE TO authenticated USING (((bucket_id = 'user_media'::text) AND ((EXISTS ( SELECT 1
CREATE POLICY "Users can update their own avatars" ON storage.objects FOR UPDATE TO authenticated USING (((bucket_id = 'avatars'::text) AND ((EXISTS ( SELECT 1
CREATE POLICY "Users can update their own banners" ON storage.objects FOR UPDATE TO authenticated USING (((bucket_id = 'banners'::text) AND ((EXISTS ( SELECT 1
CREATE POLICY "Users can update their own media" ON storage.objects FOR UPDATE TO authenticated USING (((bucket_id = 'user_media'::text) AND ((EXISTS ( SELECT 1
CREATE POLICY "Users can upload their own avatars" ON storage.objects FOR INSERT TO authenticated WITH CHECK (((bucket_id = 'avatars'::text) AND ((EXISTS ( SELECT 1
CREATE POLICY "Users can upload their own banners" ON storage.objects FOR INSERT TO authenticated WITH CHECK (((bucket_id = 'banners'::text) AND ((EXISTS ( SELECT 1
CREATE POLICY "Users can upload their own media" ON storage.objects FOR INSERT TO authenticated WITH CHECK (((bucket_id = 'user_media'::text) AND ((EXISTS ( SELECT 1
ALTER TABLE storage.buckets ENABLE ROW LEVEL SECURITY;
ALTER TABLE storage.buckets_analytics ENABLE ROW LEVEL SECURITY;
ALTER TABLE storage.buckets_vectors ENABLE ROW LEVEL SECURITY;
ALTER TABLE storage.iceberg_namespaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE storage.iceberg_tables ENABLE ROW LEVEL SECURITY;
ALTER TABLE storage.migrations ENABLE ROW LEVEL SECURITY;
ALTER TABLE storage.objects ENABLE ROW LEVEL SECURITY;
ALTER TABLE storage.prefixes ENABLE ROW LEVEL SECURITY;
ALTER TABLE storage.s3_multipart_uploads ENABLE ROW LEVEL SECURITY;
ALTER TABLE storage.s3_multipart_uploads_parts ENABLE ROW LEVEL SECURITY;
ALTER TABLE storage.vector_indexes ENABLE ROW LEVEL SECURITY;
