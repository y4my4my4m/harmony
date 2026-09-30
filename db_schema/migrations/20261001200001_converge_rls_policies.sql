-- Converges row-level security on every table where production and a fresh install differ to
-- the policy set a fresh install produces.
--
-- Production predates the baseline and carries policies no migration creates. Permissive
-- policies OR together, so each one widens access past the canonical set. Measured against the
-- 2026-09-30 production schema dump: 98 production-only policies on 45 tables, 14 canonical
-- policies absent, 1 same-named policy with a different definition.
--
--   dup    44  covered by a canonical policy
--   wider  36  grants more than canonical; no application path depends on the difference
--   app    16  sole source of an access the application uses; replacement asserted first
--   keep    2  megolm_room_sessions: see below
--
-- Notable widenings closed:
--   messages            legacy SELECT/INSERT ignore user_servers.status (pending and banned
--                       members read and post in every channel); legacy INSERT skips the DM
--                       block check
--   message_search_index  same status gap, over indexed message text
--   storage group-icons   any role, anon included, uploads, overwrites and deletes any icon
--   reactions, post_interactions  UPDATE retargets a row past the block check
--   post_interactions     legacy INSERT skips the block check
--   threads               legacy INSERT has no created_by check
--   server_encryption_settings  readable by anon and non-members
--   conversation_encryption_settings  former participants write
--   conversations         any participant UPDATEs any column
--
-- Access production relies on that the canonical set lacked, added here and so canonical for
-- every install: follows_delete_follower (blocking removes the blocked user's follow),
-- instance-admin deletes of reported files, instance branding under server_icons/instance and
-- server_banners/instance, and server icon deletion by MANAGE_SERVER holders. Thread
-- moderation by MANAGE_CHANNELS holders moves into threads_update_authorized and
-- threads_delete_authorized in 20261001200002.
--
-- megolm_room_sessions on production has current_session_id/sender_user_id where the canonical
-- policies read session_id/creator_user_id (20260530000010 never reached it). Its three
-- canonical policies and the canonical megolm_key_requests_select_for_response are skipped
-- there, and the table's legacy policies stay. Converging it needs the column migration first.
--
-- Policies 20261001200002 redefines are recorded as canonical names and not asserted here, so
-- this file leaves them as that migration sets them.
--
-- Every assertion prints one NOTICE: create, keep, alter (with the old definition), defer,
-- drop (with its class), absent, skip or left.

BEGIN;

SET LOCAL lock_timeout = '3s';

CREATE TEMP TABLE converge_seen (tbl text, pol text) ON COMMIT DROP;

-- First 'schema.table:column' in p_requires that does not exist, or NULL.
CREATE FUNCTION pg_temp.converge_missing_column(p_requires text[])
RETURNS text
LANGUAGE plpgsql
AS $fn$
DECLARE
    v_req text;
BEGIN
    FOREACH v_req IN ARRAY p_requires LOOP
        IF NOT EXISTS (
            SELECT 1 FROM pg_catalog.pg_attribute a
             WHERE a.attrelid = to_regclass(split_part(v_req, ':', 1))
               AND a.attname = split_part(v_req, ':', 2)
               AND a.attnum > 0 AND NOT a.attisdropped
        ) THEN
            RETURN v_req;
        END IF;
    END LOOP;
    RETURN NULL;
END;
$fn$;

-- Policy shape as the catalog holds it. Expressions are deparsed in this session, so two
-- policies compare equal exactly when their stored parse trees deparse identically.
CREATE FUNCTION pg_temp.converge_shape(p_rel regclass, p_name text)
RETURNS TABLE (cmd "char", permissive boolean, roles oid[], qual text, chk text)
LANGUAGE sql
AS $fn$
    SELECT p.polcmd, p.polpermissive,
           ARRAY(SELECT r FROM unnest(p.polroles) r ORDER BY r),
           pg_catalog.pg_get_expr(p.polqual, p.polrelid),
           pg_catalog.pg_get_expr(p.polwithcheck, p.polrelid)
      FROM pg_catalog.pg_policy p
     WHERE p.polrelid = p_rel AND p.polname = p_name;
$fn$;

-- Asserts one canonical policy. p_ddl names the policy __POLICY__. It is created under a
-- probe name and compared with the policy of the target name: absent, it is renamed into
-- place; identical, the probe is dropped; different, the old policy is replaced.
CREATE PROCEDURE pg_temp.converge_policy(p_table text, p_name text, p_requires text[], p_ddl text)
LANGUAGE plpgsql
AS $fn$
DECLARE
    v_rel     regclass := p_table::regclass;
    v_probe   constant text := 'converge_probe';
    v_missing text := pg_temp.converge_missing_column(p_requires);
    v_old     record;
    v_new     record;
BEGIN
    INSERT INTO converge_seen VALUES (p_table, p_name);

    IF v_missing IS NOT NULL THEN
        RAISE NOTICE 'skip   % %: % absent, canonical policy cannot install',
            p_table, quote_ident(p_name), v_missing;
        RETURN;
    END IF;

    EXECUTE replace(p_ddl, '__POLICY__', quote_ident(v_probe));
    SELECT * INTO v_new FROM pg_temp.converge_shape(v_rel, v_probe);
    SELECT * INTO v_old FROM pg_temp.converge_shape(v_rel, p_name);

    IF v_old.cmd IS NULL THEN
        EXECUTE format('ALTER POLICY %I ON %s RENAME TO %I', v_probe, v_rel, p_name);
        RAISE NOTICE 'create % %', p_table, quote_ident(p_name);
    ELSIF (v_old.cmd, v_old.permissive, v_old.roles, v_old.qual, v_old.chk)
          IS NOT DISTINCT FROM (v_new.cmd, v_new.permissive, v_new.roles, v_new.qual, v_new.chk) THEN
        EXECUTE format('DROP POLICY %I ON %s', v_probe, v_rel);
        RAISE NOTICE 'keep   % %', p_table, quote_ident(p_name);
    ELSE
        EXECUTE format('DROP POLICY %I ON %s', p_name, v_rel);
        EXECUTE format('ALTER POLICY %I ON %s RENAME TO %I', v_probe, v_rel, p_name);
        RAISE NOTICE 'alter  % %: was cmd=% permissive=% roles=% using=% check=%',
            p_table, quote_ident(p_name), v_old.cmd, v_old.permissive, v_old.roles,
            coalesce(v_old.qual, '-'), coalesce(v_old.chk, '-');
    END IF;
END;
$fn$;

-- Records a canonical name whose definition a later migration owns.
CREATE PROCEDURE pg_temp.converge_known(p_table text, p_name text, p_owner text)
LANGUAGE plpgsql
AS $fn$
BEGIN
    INSERT INTO converge_seen VALUES (p_table, p_name);
    RAISE NOTICE 'defer  % %: defined by %', p_table, quote_ident(p_name), p_owner;
END;
$fn$;

-- Drops one production-only policy. With p_requires unmet the canonical replacement did not
-- install, and the policy stays.
CREATE PROCEDURE pg_temp.drop_legacy_policy(p_table text, p_name text, p_requires text[], p_reason text)
LANGUAGE plpgsql
AS $fn$
DECLARE
    v_rel     regclass := to_regclass(p_table);
    v_missing text := pg_temp.converge_missing_column(p_requires);
BEGIN
    INSERT INTO converge_seen VALUES (p_table, p_name);

    IF v_rel IS NULL THEN
        RAISE NOTICE 'absent % %: table absent', p_table, quote_ident(p_name);
    ELSIF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_policy WHERE polrelid = v_rel AND polname = p_name) THEN
        RAISE NOTICE 'absent % %', p_table, quote_ident(p_name);
    ELSIF v_missing IS NOT NULL THEN
        RAISE NOTICE 'left   % %: % absent, no canonical replacement (%)',
            p_table, quote_ident(p_name), v_missing, p_reason;
    ELSE
        EXECUTE format('DROP POLICY %I ON %s', p_name, v_rel);
        RAISE NOTICE 'drop   % % (%)', p_table, quote_ident(p_name), p_reason;
    END IF;
END;
$fn$;

-- Canonical policies: the deparsed definitions of a fresh install, asserted in place.

-- public.bot_audit_log
CALL pg_temp.converge_policy('public.bot_audit_log', 'bot_audit_log_select_owner', '{}', $ddl$
CREATE POLICY __POLICY__ ON public.bot_audit_log AS PERMISSIVE FOR SELECT TO public
    USING (((EXISTS ( SELECT 1 FROM public.bots b WHERE ((b.id = bot_audit_log.bot_id) AND (b.owner_id = (
        SELECT public.get_current_profile_id() AS get_current_profile_id))))) OR ( SELECT
        public.is_current_user_admin() AS is_current_user_admin)))
$ddl$);

-- public.bot_commands
CALL pg_temp.converge_policy('public.bot_commands', 'bot_commands_modify_owner', '{}', $ddl$
CREATE POLICY __POLICY__ ON public.bot_commands AS PERMISSIVE FOR ALL TO public
    USING ((EXISTS ( SELECT 1 FROM public.bots b WHERE ((b.id = bot_commands.bot_id) AND (b.owner_id = (
        SELECT public.get_current_profile_id() AS get_current_profile_id))))))
$ddl$);
CALL pg_temp.converge_policy('public.bot_commands', 'bot_commands_select_all', '{}', $ddl$
CREATE POLICY __POLICY__ ON public.bot_commands AS PERMISSIVE FOR SELECT TO public
    USING (true)
$ddl$);

-- public.bot_presence
CALL pg_temp.converge_policy('public.bot_presence', 'bot_presence_modify_owner', '{}', $ddl$
CREATE POLICY __POLICY__ ON public.bot_presence AS PERMISSIVE FOR ALL TO public
    USING ((EXISTS ( SELECT 1 FROM public.bots b WHERE ((b.id = bot_presence.bot_id) AND (b.owner_id = (
        SELECT public.get_current_profile_id() AS get_current_profile_id))))))
$ddl$);
CALL pg_temp.converge_policy('public.bot_presence', 'bot_presence_select_all', '{}', $ddl$
CREATE POLICY __POLICY__ ON public.bot_presence AS PERMISSIVE FOR SELECT TO public
    USING (true)
$ddl$);

-- public.channel_permission_overrides
CALL pg_temp.converge_policy('public.channel_permission_overrides', 'channel_permission_overrides_modify', '{}', $ddl$
CREATE POLICY __POLICY__ ON public.channel_permission_overrides AS PERMISSIVE FOR ALL TO public
    USING ((EXISTS ( SELECT 1 FROM ((public.channels c JOIN public.servers s ON ((s.id = c.server_id)))
        LEFT JOIN public.profiles p ON ((p.id = ( SELECT public.get_current_profile_id() AS
        get_current_profile_id)))) WHERE ((c.id = channel_permission_overrides.channel_id) AND ((s.owner
        = ( SELECT public.get_current_profile_id() AS get_current_profile_id)) OR COALESCE(p.is_admin,
        false) OR COALESCE(p.is_moderator, false) OR (EXISTS ( SELECT 1 FROM (public.user_roles ur JOIN
        public.server_roles sr ON ((sr.id = ur.role_id))) WHERE ((ur.user_id = ( SELECT
        public.get_current_profile_id() AS get_current_profile_id)) AND (ur.server_id = s.id) AND
        (((sr.permissions & ((1)::bigint << 0)) <> 0) OR ((sr.permissions & ((1)::bigint << 2)) <> 0) OR
        ((sr.permissions & ((1)::bigint << 3)) <> 0))))))))))
    WITH CHECK ((EXISTS ( SELECT 1 FROM ((public.channels c JOIN public.servers s ON ((s.id = c.server_id)))
        LEFT JOIN public.profiles p ON ((p.id = ( SELECT public.get_current_profile_id() AS
        get_current_profile_id)))) WHERE ((c.id = channel_permission_overrides.channel_id) AND ((s.owner
        = ( SELECT public.get_current_profile_id() AS get_current_profile_id)) OR COALESCE(p.is_admin,
        false) OR COALESCE(p.is_moderator, false) OR (EXISTS ( SELECT 1 FROM (public.user_roles ur JOIN
        public.server_roles sr ON ((sr.id = ur.role_id))) WHERE ((ur.user_id = ( SELECT
        public.get_current_profile_id() AS get_current_profile_id)) AND (ur.server_id = s.id) AND
        (((sr.permissions & ((1)::bigint << 0)) <> 0) OR ((sr.permissions & ((1)::bigint << 2)) <> 0) OR
        ((sr.permissions & ((1)::bigint << 3)) <> 0))))))))))
$ddl$);
CALL pg_temp.converge_policy('public.channel_permission_overrides', 'channel_permission_overrides_select', '{}', $ddl$
CREATE POLICY __POLICY__ ON public.channel_permission_overrides AS PERMISSIVE FOR SELECT TO public
    USING ((EXISTS ( SELECT 1 FROM (public.channels c JOIN public.user_servers us ON ((us.server_id =
        c.server_id))) WHERE ((c.id = channel_permission_overrides.channel_id) AND (us.user_id = (
        SELECT public.get_current_profile_id() AS get_current_profile_id)) AND (us.status =
        'accepted'::text)))))
$ddl$);

-- public.conversation_encryption_settings
CALL pg_temp.converge_policy('public.conversation_encryption_settings', 'conversation_encryption_settings_modify', '{}', $ddl$
CREATE POLICY __POLICY__ ON public.conversation_encryption_settings AS PERMISSIVE FOR ALL TO public
    USING ((EXISTS ( SELECT 1 FROM public.conversation_participants cp WHERE ((cp.conversation_id =
        conversation_encryption_settings.conversation_id) AND (cp.user_id = ( SELECT
        public.get_current_profile_id() AS get_current_profile_id)) AND (cp.left_at IS NULL)))))
$ddl$);
CALL pg_temp.converge_policy('public.conversation_encryption_settings', 'conversation_encryption_settings_select', '{}', $ddl$
CREATE POLICY __POLICY__ ON public.conversation_encryption_settings AS PERMISSIVE FOR SELECT TO public
    USING ((EXISTS ( SELECT 1 FROM public.conversation_participants cp WHERE ((cp.conversation_id =
        conversation_encryption_settings.conversation_id) AND (cp.user_id = ( SELECT
        public.get_current_profile_id() AS get_current_profile_id))))))
$ddl$);

-- public.conversations
CALL pg_temp.converge_policy('public.conversations', 'conversations_insert_authenticated', '{}', $ddl$
CREATE POLICY __POLICY__ ON public.conversations AS PERMISSIVE FOR INSERT TO public
    WITH CHECK ((created_by = ( SELECT ( SELECT public.get_current_profile_id() AS get_current_profile_id) AS
        get_current_profile_id)))
$ddl$);
CALL pg_temp.converge_policy('public.conversations', 'conversations_select_participant', '{}', $ddl$
CREATE POLICY __POLICY__ ON public.conversations AS PERMISSIVE FOR SELECT TO public
    USING ((EXISTS ( SELECT 1 FROM public.conversation_participants WHERE
        ((conversation_participants.conversation_id = conversations.id) AND
        (conversation_participants.user_id = ( SELECT public.get_current_profile_id() AS
        get_current_profile_id))))))
$ddl$);

-- public.encryption_audit_log
CALL pg_temp.converge_policy('public.encryption_audit_log', 'encryption_audit_log_insert_system', '{}', $ddl$
CREATE POLICY __POLICY__ ON public.encryption_audit_log AS PERMISSIVE FOR INSERT TO public
    WITH CHECK ((user_id = ( SELECT public.get_current_profile_id() AS get_current_profile_id)))
$ddl$);
CALL pg_temp.converge_policy('public.encryption_audit_log', 'encryption_audit_log_own_or_admin', '{}', $ddl$
CREATE POLICY __POLICY__ ON public.encryption_audit_log AS PERMISSIVE FOR SELECT TO public
    USING (((user_id = ( SELECT public.get_current_profile_id() AS get_current_profile_id)) OR ( SELECT
        public.is_current_user_admin() AS is_current_user_admin)))
$ddl$);

-- public.encryption_sessions
CALL pg_temp.converge_policy('public.encryption_sessions', 'encryption_sessions_own_user', '{}', $ddl$
CREATE POLICY __POLICY__ ON public.encryption_sessions AS PERMISSIVE FOR ALL TO public
    USING (((local_user_id = ( SELECT public.get_current_profile_id() AS get_current_profile_id)) OR
        (remote_user_id = ( SELECT public.get_current_profile_id() AS get_current_profile_id))))
    WITH CHECK ((local_user_id = ( SELECT public.get_current_profile_id() AS get_current_profile_id)))
$ddl$);

-- public.federated_instances
CALL pg_temp.converge_policy('public.federated_instances', 'federated_instances_manage', '{}', $ddl$
CREATE POLICY __POLICY__ ON public.federated_instances AS PERMISSIVE FOR ALL TO public
    USING (( SELECT public.is_current_user_admin() AS is_current_user_admin))
$ddl$);
CALL pg_temp.converge_policy('public.federated_instances', 'federated_instances_select_all', '{}', $ddl$
CREATE POLICY __POLICY__ ON public.federated_instances AS PERMISSIVE FOR SELECT TO public
    USING (true)
$ddl$);
CALL pg_temp.converge_policy('public.federated_instances', 'federated_instances_service_role', '{}', $ddl$
CREATE POLICY __POLICY__ ON public.federated_instances AS PERMISSIVE FOR ALL TO service_role
    USING (true)
$ddl$);

-- public.federated_voice_calls
CALL pg_temp.converge_policy('public.federated_voice_calls', 'Recipients can update call status', '{}', $ddl$
CREATE POLICY __POLICY__ ON public.federated_voice_calls AS PERMISSIVE FOR UPDATE TO public
    USING ((( SELECT public.get_current_profile_id() AS get_current_profile_id) = recipient_id))
    WITH CHECK ((( SELECT public.get_current_profile_id() AS get_current_profile_id) = recipient_id))
$ddl$);
CALL pg_temp.converge_policy('public.federated_voice_calls', 'Service role full access on calls', '{}', $ddl$
CREATE POLICY __POLICY__ ON public.federated_voice_calls AS PERMISSIVE FOR ALL TO service_role
    USING (true)
    WITH CHECK (true)
$ddl$);
CALL pg_temp.converge_policy('public.federated_voice_calls', 'Update own calls', '{}', $ddl$
CREATE POLICY __POLICY__ ON public.federated_voice_calls AS PERMISSIVE FOR UPDATE TO public
    USING (((caller_id = ( SELECT public.get_current_profile_id() AS get_current_profile_id)) OR
        (recipient_id = ( SELECT public.get_current_profile_id() AS get_current_profile_id))))
$ddl$);

-- public.federation_endpoint_health
CALL pg_temp.converge_policy('public.federation_endpoint_health', 'Admins can delete dead endpoints', '{}', $ddl$
CREATE POLICY __POLICY__ ON public.federation_endpoint_health AS PERMISSIVE FOR DELETE TO authenticated
    USING ((EXISTS ( SELECT 1 FROM public.profiles WHERE ((profiles.id = ( SELECT
        public.get_current_profile_id() AS get_current_profile_id)) AND (profiles.is_admin = true)))))
$ddl$);
CALL pg_temp.converge_policy('public.federation_endpoint_health', 'federation_endpoint_health_insert_update', '{}', $ddl$
CREATE POLICY __POLICY__ ON public.federation_endpoint_health AS PERMISSIVE FOR INSERT TO authenticated
    WITH CHECK ((( SELECT auth.uid() AS uid) IS NOT NULL))
$ddl$);
CALL pg_temp.converge_policy('public.federation_endpoint_health', 'federation_endpoint_health_manage', '{}', $ddl$
CREATE POLICY __POLICY__ ON public.federation_endpoint_health AS PERMISSIVE FOR ALL TO service_role
    USING (true)
$ddl$);
CALL pg_temp.converge_policy('public.federation_endpoint_health', 'federation_endpoint_health_select', '{}', $ddl$
CREATE POLICY __POLICY__ ON public.federation_endpoint_health AS PERMISSIVE FOR SELECT TO public
    USING (true)
$ddl$);

-- public.federation_health
CALL pg_temp.converge_policy('public.federation_health', 'federation_health_manage', '{}', $ddl$
CREATE POLICY __POLICY__ ON public.federation_health AS PERMISSIVE FOR ALL TO public
    USING (( SELECT public.is_current_user_admin() AS is_current_user_admin))
$ddl$);
CALL pg_temp.converge_policy('public.federation_health', 'federation_health_modify_admin', '{}', $ddl$
CREATE POLICY __POLICY__ ON public.federation_health AS PERMISSIVE FOR ALL TO public
    USING (( SELECT public.is_current_user_admin() AS is_current_user_admin))
$ddl$);
CALL pg_temp.converge_policy('public.federation_health', 'federation_health_select_all', '{}', $ddl$
CREATE POLICY __POLICY__ ON public.federation_health AS PERMISSIVE FOR SELECT TO public
    USING (true)
$ddl$);
CALL pg_temp.converge_policy('public.federation_health', 'federation_health_service_role', '{}', $ddl$
CREATE POLICY __POLICY__ ON public.federation_health AS PERMISSIVE FOR ALL TO service_role
    USING (true)
$ddl$);

-- public.follows
CALL pg_temp.converge_policy('public.follows', 'follows_delete_own', '{}', $ddl$
CREATE POLICY __POLICY__ ON public.follows AS PERMISSIVE FOR DELETE TO public
    USING ((follower_id = ( SELECT public.get_current_profile_id() AS get_current_profile_id)))
$ddl$);
CALL pg_temp.converge_policy('public.follows', 'follows_insert_own', '{}', $ddl$
CREATE POLICY __POLICY__ ON public.follows AS PERMISSIVE FOR INSERT TO public
    WITH CHECK ((follower_id = ( SELECT public.get_current_profile_id() AS get_current_profile_id)))
$ddl$);
CALL pg_temp.converge_policy('public.follows', 'follows_select_all', '{}', $ddl$
CREATE POLICY __POLICY__ ON public.follows AS PERMISSIVE FOR SELECT TO public
    USING (true)
$ddl$);
CALL pg_temp.converge_policy('public.follows', 'follows_update_involved', '{}', $ddl$
CREATE POLICY __POLICY__ ON public.follows AS PERMISSIVE FOR UPDATE TO public
    USING (((follower_id = ( SELECT public.get_current_profile_id() AS get_current_profile_id)) OR
        (following_id = ( SELECT public.get_current_profile_id() AS get_current_profile_id))))
$ddl$);
-- Added: the followed user removes a follower; blocking deletes both directions (CoreInteractionService).
CALL pg_temp.converge_policy('public.follows', 'follows_delete_follower', '{}', $ddl$
CREATE POLICY __POLICY__ ON public.follows AS PERMISSIVE FOR DELETE TO public
    USING ((following_id = ( SELECT public.get_current_profile_id() AS get_current_profile_id)))
$ddl$);

-- public.instance_config
CALL pg_temp.converge_policy('public.instance_config', 'Public can read instance settings', '{}', $ddl$
CREATE POLICY __POLICY__ ON public.instance_config AS PERMISSIVE FOR SELECT TO public
    USING ((config_key = ANY (public.public_instance_config_keys())))
$ddl$);
CALL pg_temp.converge_policy('public.instance_config', 'instance_config_select_admin', '{}', $ddl$
CREATE POLICY __POLICY__ ON public.instance_config AS PERMISSIVE FOR SELECT TO authenticated
    USING (( SELECT public.is_current_user_admin() AS is_current_user_admin))
$ddl$);

-- public.instance_webrtc_settings
CALL pg_temp.converge_policy('public.instance_webrtc_settings', 'webrtc_settings_insert_admin_only', '{}', $ddl$
CREATE POLICY __POLICY__ ON public.instance_webrtc_settings AS PERMISSIVE FOR INSERT TO public
    WITH CHECK ((EXISTS ( SELECT 1 FROM public.profiles WHERE ((profiles.auth_user_id = ( SELECT auth.uid() AS
        uid)) AND (profiles.is_admin = true)))))
$ddl$);
CALL pg_temp.converge_policy('public.instance_webrtc_settings', 'webrtc_settings_select_admin_only', '{}', $ddl$
CREATE POLICY __POLICY__ ON public.instance_webrtc_settings AS PERMISSIVE FOR SELECT TO public
    USING ((EXISTS ( SELECT 1 FROM public.profiles WHERE ((profiles.auth_user_id = ( SELECT auth.uid() AS
        uid)) AND (profiles.is_admin = true)))))
$ddl$);
CALL pg_temp.converge_policy('public.instance_webrtc_settings', 'webrtc_settings_update_admin_only', '{}', $ddl$
CREATE POLICY __POLICY__ ON public.instance_webrtc_settings AS PERMISSIVE FOR UPDATE TO public
    USING ((EXISTS ( SELECT 1 FROM public.profiles WHERE ((profiles.auth_user_id = ( SELECT auth.uid() AS
        uid)) AND (profiles.is_admin = true)))))
$ddl$);

-- public.megolm_key_backups
CALL pg_temp.converge_policy('public.megolm_key_backups', 'megolm_key_backups_own_only', '{}', $ddl$
CREATE POLICY __POLICY__ ON public.megolm_key_backups AS PERMISSIVE FOR ALL TO public
    USING ((user_id = ( SELECT public.get_current_profile_id() AS get_current_profile_id)))
$ddl$);

-- public.megolm_key_requests
CALL pg_temp.converge_policy('public.megolm_key_requests', 'megolm_key_requests_fulfill', '{}', $ddl$
CREATE POLICY __POLICY__ ON public.megolm_key_requests AS PERMISSIVE FOR UPDATE TO public
    USING ((sender_user_id = ( SELECT public.get_current_profile_id() AS get_current_profile_id)))
    WITH CHECK ((sender_user_id = ( SELECT public.get_current_profile_id() AS get_current_profile_id)))
$ddl$);
CALL pg_temp.converge_policy('public.megolm_key_requests', 'megolm_key_requests_own', '{}', $ddl$
CREATE POLICY __POLICY__ ON public.megolm_key_requests AS PERMISSIVE FOR ALL TO public
    USING ((requester_user_id = ( SELECT public.get_current_profile_id() AS get_current_profile_id)))
$ddl$);
CALL pg_temp.converge_policy('public.megolm_key_requests', 'megolm_key_requests_select_for_response', ARRAY['public.megolm_room_sessions:session_id', 'public.megolm_room_sessions:creator_user_id'], $ddl$
CREATE POLICY __POLICY__ ON public.megolm_key_requests AS PERMISSIVE FOR SELECT TO public
    USING (((sender_user_id = ( SELECT public.get_current_profile_id() AS get_current_profile_id)) OR
        (EXISTS ( SELECT 1 FROM public.megolm_room_sessions mrs WHERE ((mrs.session_id =
        megolm_key_requests.session_id) AND (mrs.room_id = megolm_key_requests.room_id) AND
        (mrs.creator_user_id = ( SELECT public.get_current_profile_id() AS get_current_profile_id)))))))
$ddl$);

-- public.megolm_room_sessions
CALL pg_temp.converge_policy('public.megolm_room_sessions', 'megolm_room_sessions_insert_own', ARRAY['public.megolm_room_sessions:session_id', 'public.megolm_room_sessions:creator_user_id'], $ddl$
CREATE POLICY __POLICY__ ON public.megolm_room_sessions AS PERMISSIVE FOR INSERT TO public
    WITH CHECK ((creator_user_id = ( SELECT public.get_current_profile_id() AS get_current_profile_id)))
$ddl$);
CALL pg_temp.converge_policy('public.megolm_room_sessions', 'megolm_room_sessions_select', ARRAY['public.megolm_room_sessions:session_id', 'public.megolm_room_sessions:creator_user_id'], $ddl$
CREATE POLICY __POLICY__ ON public.megolm_room_sessions AS PERMISSIVE FOR SELECT TO public
    USING (((creator_user_id = ( SELECT public.get_current_profile_id() AS get_current_profile_id)) OR
        (EXISTS ( SELECT 1 FROM public.megolm_session_shares WHERE ((megolm_session_shares.session_id =
        megolm_room_sessions.session_id) AND (megolm_session_shares.room_id =
        megolm_room_sessions.room_id) AND (megolm_session_shares.recipient_user_id = ( SELECT
        public.get_current_profile_id() AS get_current_profile_id)))))))
$ddl$);
CALL pg_temp.converge_policy('public.megolm_room_sessions', 'megolm_room_sessions_update_own', ARRAY['public.megolm_room_sessions:session_id', 'public.megolm_room_sessions:creator_user_id'], $ddl$
CREATE POLICY __POLICY__ ON public.megolm_room_sessions AS PERMISSIVE FOR UPDATE TO public
    USING ((creator_user_id = ( SELECT public.get_current_profile_id() AS get_current_profile_id)))
$ddl$);

-- public.megolm_session_shares
CALL pg_temp.converge_policy('public.megolm_session_shares', 'megolm_session_shares_delete', '{}', $ddl$
CREATE POLICY __POLICY__ ON public.megolm_session_shares AS PERMISSIVE FOR DELETE TO public
    USING (((sender_user_id = ( SELECT public.get_current_profile_id() AS get_current_profile_id)) OR
        (recipient_user_id = ( SELECT public.get_current_profile_id() AS get_current_profile_id))))
$ddl$);
CALL pg_temp.converge_policy('public.megolm_session_shares', 'megolm_session_shares_insert', '{}', $ddl$
CREATE POLICY __POLICY__ ON public.megolm_session_shares AS PERMISSIVE FOR INSERT TO public
    WITH CHECK (((sender_user_id = ( SELECT public.get_current_profile_id() AS get_current_profile_id)) AND
        public.is_room_member(room_id, sender_user_id) AND public.is_room_member(room_id,
        recipient_user_id)))
$ddl$);
CALL pg_temp.converge_policy('public.megolm_session_shares', 'megolm_session_shares_select', '{}', $ddl$
CREATE POLICY __POLICY__ ON public.megolm_session_shares AS PERMISSIVE FOR SELECT TO public
    USING (((recipient_user_id = ( SELECT public.get_current_profile_id() AS get_current_profile_id)) OR
        (sender_user_id = ( SELECT public.get_current_profile_id() AS get_current_profile_id))))
$ddl$);
CALL pg_temp.converge_policy('public.megolm_session_shares', 'megolm_session_shares_update', '{}', $ddl$
CREATE POLICY __POLICY__ ON public.megolm_session_shares AS PERMISSIVE FOR UPDATE TO public
    USING (((sender_user_id = ( SELECT public.get_current_profile_id() AS get_current_profile_id)) OR
        (recipient_user_id = ( SELECT public.get_current_profile_id() AS get_current_profile_id))))
$ddl$);

-- public.message_search_index
CALL pg_temp.converge_known('public.message_search_index', 'message_search_index_channel_access', '20261001200002');
CALL pg_temp.converge_policy('public.message_search_index', 'message_search_index_conversation_access', '{}', $ddl$
CREATE POLICY __POLICY__ ON public.message_search_index AS PERMISSIVE FOR SELECT TO public
    USING (((conversation_id IS NOT NULL) AND (EXISTS ( SELECT 1 FROM public.conversation_participants cp
        WHERE ((cp.conversation_id = message_search_index.conversation_id) AND (cp.user_id = ( SELECT
        public.get_current_profile_id() AS get_current_profile_id)) AND (cp.left_at IS NULL))))))
$ddl$);

-- public.messages
CALL pg_temp.converge_policy('public.messages', 'messages_delete_authorized', '{}', $ddl$
CREATE POLICY __POLICY__ ON public.messages AS PERMISSIVE FOR DELETE TO public
    USING (((user_id = ( SELECT public.get_current_profile_id() AS get_current_profile_id)) OR ( SELECT
        public.is_current_user_admin() AS is_current_user_admin) OR ( SELECT
        public.is_current_user_moderator() AS is_current_user_moderator) OR
        public.can_current_user_manage_messages_in_channel(channel_id)))
$ddl$);
CALL pg_temp.converge_known('public.messages', 'messages_insert_member', '20261001200002');
CALL pg_temp.converge_known('public.messages', 'messages_select_channel_member', '20261001200002');
CALL pg_temp.converge_policy('public.messages', 'messages_update_authorized', '{}', $ddl$
CREATE POLICY __POLICY__ ON public.messages AS PERMISSIVE FOR UPDATE TO public
    USING (((user_id = ( SELECT public.get_current_profile_id() AS get_current_profile_id)) OR ( SELECT
        public.is_current_user_admin() AS is_current_user_admin) OR ( SELECT
        public.is_current_user_moderator() AS is_current_user_moderator) OR
        public.can_current_user_manage_messages_in_channel(channel_id)))
$ddl$);

-- public.mfa_recovery_codes
CALL pg_temp.converge_policy('public.mfa_recovery_codes', 'mfa_recovery_codes_own_only', '{}', $ddl$
CREATE POLICY __POLICY__ ON public.mfa_recovery_codes AS PERMISSIVE FOR ALL TO public
    USING ((user_id = ( SELECT public.get_current_profile_id() AS get_current_profile_id)))
$ddl$);

-- public.notifications
CALL pg_temp.converge_policy('public.notifications', 'notifications_delete_own', '{}', $ddl$
CREATE POLICY __POLICY__ ON public.notifications AS PERMISSIVE FOR DELETE TO public
    USING ((user_id = ( SELECT public.get_current_profile_id() AS get_current_profile_id)))
$ddl$);
CALL pg_temp.converge_policy('public.notifications', 'notifications_insert_system', '{}', $ddl$
CREATE POLICY __POLICY__ ON public.notifications AS PERMISSIVE FOR INSERT TO service_role
    WITH CHECK (true)
$ddl$);
CALL pg_temp.converge_policy('public.notifications', 'notifications_select_own', '{}', $ddl$
CREATE POLICY __POLICY__ ON public.notifications AS PERMISSIVE FOR SELECT TO public
    USING ((user_id = ( SELECT public.get_current_profile_id() AS get_current_profile_id)))
$ddl$);
CALL pg_temp.converge_policy('public.notifications', 'notifications_update_own', '{}', $ddl$
CREATE POLICY __POLICY__ ON public.notifications AS PERMISSIVE FOR UPDATE TO public
    USING ((user_id = ( SELECT public.get_current_profile_id() AS get_current_profile_id)))
$ddl$);

-- public.performance_metrics_hourly
CALL pg_temp.converge_policy('public.performance_metrics_hourly', 'performance_metrics_hourly_modify_admin', '{}', $ddl$
CREATE POLICY __POLICY__ ON public.performance_metrics_hourly AS PERMISSIVE FOR ALL TO public
    USING (( SELECT public.is_current_user_admin() AS is_current_user_admin))
$ddl$);
CALL pg_temp.converge_policy('public.performance_metrics_hourly', 'performance_metrics_hourly_select_all', '{}', $ddl$
CREATE POLICY __POLICY__ ON public.performance_metrics_hourly AS PERMISSIVE FOR SELECT TO public
    USING (true)
$ddl$);

-- public.post_interactions
CALL pg_temp.converge_policy('public.post_interactions', 'post_interactions_delete_own', '{}', $ddl$
CREATE POLICY __POLICY__ ON public.post_interactions AS PERMISSIVE FOR DELETE TO public
    USING ((user_id = ( SELECT public.get_current_profile_id() AS get_current_profile_id)))
$ddl$);
CALL pg_temp.converge_policy('public.post_interactions', 'post_interactions_insert_own', '{}', $ddl$
CREATE POLICY __POLICY__ ON public.post_interactions AS PERMISSIVE FOR INSERT TO public
    WITH CHECK (((user_id = ( SELECT public.get_current_profile_id() AS get_current_profile_id)) AND (NOT
        public.is_blocked_by(( SELECT posts.author_id FROM public.posts WHERE (posts.id =
        post_interactions.post_id))))))
$ddl$);
CALL pg_temp.converge_policy('public.post_interactions', 'post_interactions_select_all', '{}', $ddl$
CREATE POLICY __POLICY__ ON public.post_interactions AS PERMISSIVE FOR SELECT TO public
    USING (true)
$ddl$);

-- public.posts
CALL pg_temp.converge_policy('public.posts', 'posts_delete_own', '{}', $ddl$
CREATE POLICY __POLICY__ ON public.posts AS PERMISSIVE FOR DELETE TO public
    USING ((author_id = ( SELECT public.get_current_profile_id() AS get_current_profile_id)))
$ddl$);
CALL pg_temp.converge_policy('public.posts', 'posts_insert_own', '{}', $ddl$
CREATE POLICY __POLICY__ ON public.posts AS PERMISSIVE FOR INSERT TO public
    WITH CHECK ((author_id = ( SELECT public.get_current_profile_id() AS get_current_profile_id)))
$ddl$);
CALL pg_temp.converge_policy('public.posts', 'posts_select_public', '{}', $ddl$
CREATE POLICY __POLICY__ ON public.posts AS PERMISSIVE FOR SELECT TO public
    USING (((author_id = ( SELECT public.get_current_profile_id() AS get_current_profile_id)) OR ((NOT
        (author_id IN ( SELECT public.current_user_block_peer_ids() AS current_user_block_peer_ids)))
        AND ((visibility = ANY (ARRAY['public'::text, 'unlisted'::text])) OR ((visibility =
        'followers'::text) AND (EXISTS ( SELECT 1 FROM public.follows WHERE ((follows.follower_id = (
        SELECT public.get_current_profile_id() AS get_current_profile_id)) AND (follows.following_id =
        posts.author_id) AND (follows.status = 'accepted'::text))))) OR ((visibility = 'direct'::text)
        AND (EXISTS ( SELECT 1 WHERE (posts.author_id = ( SELECT public.get_current_profile_id() AS
        get_current_profile_id)))))))))
$ddl$);
CALL pg_temp.converge_policy('public.posts', 'posts_update_own', '{}', $ddl$
CREATE POLICY __POLICY__ ON public.posts AS PERMISSIVE FOR UPDATE TO public
    USING ((author_id = ( SELECT public.get_current_profile_id() AS get_current_profile_id)))
$ddl$);

-- public.prekeys
CALL pg_temp.converge_policy('public.prekeys', 'Users can insert their own prekeys', '{}', $ddl$
CREATE POLICY __POLICY__ ON public.prekeys AS PERMISSIVE FOR INSERT TO public
    WITH CHECK ((EXISTS ( SELECT 1 FROM public.profiles WHERE ((profiles.id = prekeys.user_id) AND
        (profiles.auth_user_id = ( SELECT auth.uid() AS uid))))))
$ddl$);
CALL pg_temp.converge_policy('public.prekeys', 'Users can update their own prekeys', '{}', $ddl$
CREATE POLICY __POLICY__ ON public.prekeys AS PERMISSIVE FOR UPDATE TO public
    USING ((EXISTS ( SELECT 1 FROM public.profiles WHERE ((profiles.id = prekeys.user_id) AND
        (profiles.auth_user_id = ( SELECT auth.uid() AS uid))))))
$ddl$);
CALL pg_temp.converge_policy('public.prekeys', $ddl$Users can view others' unused public prekeys$ddl$, '{}', $ddl$
CREATE POLICY __POLICY__ ON public.prekeys AS PERMISSIVE FOR SELECT TO public
    USING ((is_used = false))
$ddl$);

-- public.profiles
CALL pg_temp.converge_policy('public.profiles', 'profiles_delete_own', '{}', $ddl$
CREATE POLICY __POLICY__ ON public.profiles AS PERMISSIVE FOR DELETE TO public
    USING ((auth_user_id = ( SELECT auth.uid() AS uid)))
$ddl$);
CALL pg_temp.converge_policy('public.profiles', 'profiles_insert_own', '{}', $ddl$
CREATE POLICY __POLICY__ ON public.profiles AS PERMISSIVE FOR INSERT TO public
    WITH CHECK ((auth_user_id = ( SELECT auth.uid() AS uid)))
$ddl$);
CALL pg_temp.converge_policy('public.profiles', 'profiles_select_all', '{}', $ddl$
CREATE POLICY __POLICY__ ON public.profiles AS PERMISSIVE FOR SELECT TO public
    USING (true)
$ddl$);
CALL pg_temp.converge_policy('public.profiles', 'profiles_update_own', '{}', $ddl$
CREATE POLICY __POLICY__ ON public.profiles AS PERMISSIVE FOR UPDATE TO public
    USING ((auth_user_id = ( SELECT auth.uid() AS uid)))
$ddl$);

-- public.push_subscriptions
CALL pg_temp.converge_policy('public.push_subscriptions', 'Service role can manage all push subscriptions', '{}', $ddl$
CREATE POLICY __POLICY__ ON public.push_subscriptions AS PERMISSIVE FOR ALL TO service_role
    USING (true)
    WITH CHECK (true)
$ddl$);

-- public.reactions
CALL pg_temp.converge_policy('public.reactions', 'reactions_delete_own', '{}', $ddl$
CREATE POLICY __POLICY__ ON public.reactions AS PERMISSIVE FOR DELETE TO public
    USING ((user_id = ( SELECT public.get_current_profile_id() AS get_current_profile_id)))
$ddl$);
CALL pg_temp.converge_known('public.reactions', 'reactions_insert_own', '20261001200002');
CALL pg_temp.converge_known('public.reactions', 'reactions_select_all', '20261001200002');
CALL pg_temp.converge_known('public.reactions', 'reactions_select_visible', '20261001200002');

-- public.recovery_key_metadata
CALL pg_temp.converge_policy('public.recovery_key_metadata', 'recovery_key_metadata_own_only', '{}', $ddl$
CREATE POLICY __POLICY__ ON public.recovery_key_metadata AS PERMISSIVE FOR ALL TO public
    USING ((user_id = ( SELECT public.get_current_profile_id() AS get_current_profile_id)))
$ddl$);

-- public.remote_emojis_cache
CALL pg_temp.converge_policy('public.remote_emojis_cache', 'Service role can manage remote emojis', '{}', $ddl$
CREATE POLICY __POLICY__ ON public.remote_emojis_cache AS PERMISSIVE FOR ALL TO public
    USING ((( SELECT auth.role() AS role) = 'service_role'::text))
$ddl$);
CALL pg_temp.converge_policy('public.remote_emojis_cache', 'remote_emojis_cache_admin_modify', '{}', $ddl$
CREATE POLICY __POLICY__ ON public.remote_emojis_cache AS PERMISSIVE FOR ALL TO public
    USING (( SELECT public.is_current_user_admin() AS is_current_user_admin))
$ddl$);
CALL pg_temp.converge_policy('public.remote_emojis_cache', 'remote_emojis_cache_select_all', '{}', $ddl$
CREATE POLICY __POLICY__ ON public.remote_emojis_cache AS PERMISSIVE FOR SELECT TO public
    USING (true)
$ddl$);

-- public.server_encryption_settings
CALL pg_temp.converge_policy('public.server_encryption_settings', 'server_encryption_settings_modify', '{}', $ddl$
CREATE POLICY __POLICY__ ON public.server_encryption_settings AS PERMISSIVE FOR ALL TO public
    USING ((EXISTS ( SELECT 1 FROM public.servers s WHERE ((s.id = server_encryption_settings.server_id)
        AND (s.owner = ( SELECT public.get_current_profile_id() AS get_current_profile_id))))))
$ddl$);
CALL pg_temp.converge_policy('public.server_encryption_settings', 'server_encryption_settings_select', '{}', $ddl$
CREATE POLICY __POLICY__ ON public.server_encryption_settings AS PERMISSIVE FOR SELECT TO public
    USING ((EXISTS ( SELECT 1 FROM public.user_servers us WHERE ((us.server_id =
        server_encryption_settings.server_id) AND (us.user_id = ( SELECT public.get_current_profile_id()
        AS get_current_profile_id)) AND (us.status = 'accepted'::text)))))
$ddl$);

-- public.server_federation_events
CALL pg_temp.converge_policy('public.server_federation_events', 'Service role can manage server events', '{}', $ddl$
CREATE POLICY __POLICY__ ON public.server_federation_events AS PERMISSIVE FOR ALL TO service_role
    USING (true)
    WITH CHECK (true)
$ddl$);

-- public.server_settings
CALL pg_temp.converge_policy('public.server_settings', 'server_settings_modify_owner', '{}', $ddl$
CREATE POLICY __POLICY__ ON public.server_settings AS PERMISSIVE FOR ALL TO public
    USING ((EXISTS ( SELECT 1 FROM public.servers s WHERE ((s.id = server_settings.server_id) AND (s.owner
        = ( SELECT public.get_current_profile_id() AS get_current_profile_id))))))
$ddl$);
CALL pg_temp.converge_policy('public.server_settings', 'server_settings_select_member', '{}', $ddl$
CREATE POLICY __POLICY__ ON public.server_settings AS PERMISSIVE FOR SELECT TO public
    USING ((EXISTS ( SELECT 1 FROM public.user_servers us WHERE ((us.server_id =
        server_settings.server_id) AND (us.user_id = ( SELECT public.get_current_profile_id() AS
        get_current_profile_id)) AND (us.status = 'accepted'::text)))))
$ddl$);

-- public.servers
CALL pg_temp.converge_policy('public.servers', 'Enable insert for authenticated users only', '{}', $ddl$
CREATE POLICY __POLICY__ ON public.servers AS PERMISSIVE FOR INSERT TO authenticated
    WITH CHECK ((EXISTS ( SELECT 1 FROM public.profiles WHERE ((profiles.id = servers.owner) AND
        (profiles.auth_user_id = ( SELECT ( SELECT auth.uid() AS uid) AS uid))))))
$ddl$);
CALL pg_temp.converge_policy('public.servers', 'Enable read access for all users', '{}', $ddl$
CREATE POLICY __POLICY__ ON public.servers AS PERMISSIVE FOR SELECT TO public
    USING (true)
$ddl$);
CALL pg_temp.converge_policy('public.servers', 'Server owners can delete their servers', '{}', $ddl$
CREATE POLICY __POLICY__ ON public.servers AS PERMISSIVE FOR DELETE TO authenticated
    USING ((EXISTS ( SELECT 1 FROM public.profiles WHERE ((profiles.id = servers.owner) AND
        (profiles.auth_user_id = ( SELECT auth.uid() AS uid))))))
$ddl$);
CALL pg_temp.converge_policy('public.servers', 'Server owners can update their servers', '{}', $ddl$
CREATE POLICY __POLICY__ ON public.servers AS PERMISSIVE FOR UPDATE TO authenticated
    USING ((EXISTS ( SELECT 1 FROM public.profiles WHERE ((profiles.id = servers.owner) AND
        (profiles.auth_user_id = ( SELECT auth.uid() AS uid))))))
    WITH CHECK ((EXISTS ( SELECT 1 FROM public.profiles WHERE ((profiles.id = servers.owner) AND
        (profiles.auth_user_id = ( SELECT auth.uid() AS uid))))))
$ddl$);

-- public.slow_queries
CALL pg_temp.converge_policy('public.slow_queries', 'slow_queries_admin_only', '{}', $ddl$
CREATE POLICY __POLICY__ ON public.slow_queries AS PERMISSIVE FOR ALL TO public
    USING (( SELECT public.is_current_user_admin() AS is_current_user_admin))
$ddl$);

-- public.threads
CALL pg_temp.converge_known('public.threads', 'threads_delete_authorized', '20261001200002');
CALL pg_temp.converge_known('public.threads', 'threads_insert_member', '20261001200002');
CALL pg_temp.converge_known('public.threads', 'threads_select_member', '20261001200002');
CALL pg_temp.converge_policy('public.threads', 'threads_service_role', '{}', $ddl$
CREATE POLICY __POLICY__ ON public.threads AS PERMISSIVE FOR ALL TO service_role
    USING (true)
$ddl$);
CALL pg_temp.converge_known('public.threads', 'threads_update_authorized', '20261001200002');

-- public.timeline_entries
CALL pg_temp.converge_policy('public.timeline_entries', 'timeline_entries_select_own', '{}', $ddl$
CREATE POLICY __POLICY__ ON public.timeline_entries AS PERMISSIVE FOR SELECT TO public
    USING ((user_id = ( SELECT public.get_current_profile_id() AS get_current_profile_id)))
$ddl$);
CALL pg_temp.converge_policy('public.timeline_entries', 'timeline_entries_service_write', '{}', $ddl$
CREATE POLICY __POLICY__ ON public.timeline_entries AS PERMISSIVE FOR ALL TO service_role
    USING (true)
    WITH CHECK (true)
$ddl$);

-- public.user_blocks
CALL pg_temp.converge_policy('public.user_blocks', 'user_blocks_check_if_blocked', '{}', $ddl$
CREATE POLICY __POLICY__ ON public.user_blocks AS PERMISSIVE FOR SELECT TO public
    USING ((blocked_user_id = ( SELECT public.get_current_profile_id() AS get_current_profile_id)))
$ddl$);
CALL pg_temp.converge_policy('public.user_blocks', 'user_blocks_delete_own', '{}', $ddl$
CREATE POLICY __POLICY__ ON public.user_blocks AS PERMISSIVE FOR DELETE TO public
    USING ((blocker_id = ( SELECT public.get_current_profile_id() AS get_current_profile_id)))
$ddl$);
CALL pg_temp.converge_policy('public.user_blocks', 'user_blocks_insert_own', '{}', $ddl$
CREATE POLICY __POLICY__ ON public.user_blocks AS PERMISSIVE FOR INSERT TO public
    WITH CHECK ((blocker_id = ( SELECT public.get_current_profile_id() AS get_current_profile_id)))
$ddl$);
CALL pg_temp.converge_policy('public.user_blocks', 'user_blocks_select_own', '{}', $ddl$
CREATE POLICY __POLICY__ ON public.user_blocks AS PERMISSIVE FOR SELECT TO public
    USING ((blocker_id = ( SELECT public.get_current_profile_id() AS get_current_profile_id)))
$ddl$);

-- public.user_key_pairs
CALL pg_temp.converge_policy('public.user_key_pairs', 'Users can insert their own key pairs', '{}', $ddl$
CREATE POLICY __POLICY__ ON public.user_key_pairs AS PERMISSIVE FOR INSERT TO public
    WITH CHECK ((EXISTS ( SELECT 1 FROM public.profiles WHERE ((profiles.id = user_key_pairs.user_id) AND
        (profiles.auth_user_id = ( SELECT auth.uid() AS uid))))))
$ddl$);
CALL pg_temp.converge_policy('public.user_key_pairs', 'Users can update their own key pairs', '{}', $ddl$
CREATE POLICY __POLICY__ ON public.user_key_pairs AS PERMISSIVE FOR UPDATE TO public
    USING ((EXISTS ( SELECT 1 FROM public.profiles WHERE ((profiles.id = user_key_pairs.user_id) AND
        (profiles.auth_user_id = ( SELECT auth.uid() AS uid))))))
$ddl$);
CALL pg_temp.converge_policy('public.user_key_pairs', 'Users can view active public key columns', '{}', $ddl$
CREATE POLICY __POLICY__ ON public.user_key_pairs AS PERMISSIVE FOR SELECT TO public
    USING ((is_active = true))
$ddl$);
CALL pg_temp.converge_policy('public.user_key_pairs', 'Users can view own key pair (full row)', '{}', $ddl$
CREATE POLICY __POLICY__ ON public.user_key_pairs AS PERMISSIVE FOR SELECT TO public
    USING ((EXISTS ( SELECT 1 FROM public.profiles WHERE ((profiles.id = user_key_pairs.user_id) AND
        (profiles.auth_user_id = ( SELECT auth.uid() AS uid))))))
$ddl$);

-- public.user_view_contexts
CALL pg_temp.converge_policy('public.user_view_contexts', 'user_view_contexts_own_user', '{}', $ddl$
CREATE POLICY __POLICY__ ON public.user_view_contexts AS PERMISSIVE FOR ALL TO public
    USING ((user_id = ( SELECT public.get_current_profile_id() AS get_current_profile_id)))
    WITH CHECK ((user_id = ( SELECT public.get_current_profile_id() AS get_current_profile_id)))
$ddl$);

-- public.voice_channel_participants
CALL pg_temp.converge_policy('public.voice_channel_participants', 'voice_participants_delete_self', '{}', $ddl$
CREATE POLICY __POLICY__ ON public.voice_channel_participants AS PERMISSIVE FOR DELETE TO public
    USING ((user_id = ( SELECT public.get_current_profile_id() AS get_current_profile_id)))
$ddl$);
CALL pg_temp.converge_policy('public.voice_channel_participants', 'voice_participants_insert_self', '{}', $ddl$
CREATE POLICY __POLICY__ ON public.voice_channel_participants AS PERMISSIVE FOR INSERT TO public
    WITH CHECK ((user_id = ( SELECT public.get_current_profile_id() AS get_current_profile_id)))
$ddl$);
CALL pg_temp.converge_policy('public.voice_channel_participants', 'voice_participants_select_all', '{}', $ddl$
CREATE POLICY __POLICY__ ON public.voice_channel_participants AS PERMISSIVE FOR SELECT TO public
    USING (true)
$ddl$);
CALL pg_temp.converge_policy('public.voice_channel_participants', 'voice_participants_update_self', '{}', $ddl$
CREATE POLICY __POLICY__ ON public.voice_channel_participants AS PERMISSIVE FOR UPDATE TO public
    USING ((user_id = ( SELECT public.get_current_profile_id() AS get_current_profile_id)))
    WITH CHECK ((user_id = ( SELECT public.get_current_profile_id() AS get_current_profile_id)))
$ddl$);

-- storage.objects
CALL pg_temp.converge_policy('storage.objects', 'Authenticated users can upload user_media', '{}', $ddl$
CREATE POLICY __POLICY__ ON storage.objects AS PERMISSIVE FOR INSERT TO public
    WITH CHECK (((bucket_id = 'user_media'::text) AND (auth.role() = 'authenticated'::text) AND
        (((storage.foldername(name))[1] = (auth.uid())::text) OR ((public.get_current_profile_id() IS
        NOT NULL) AND ((storage.foldername(name))[1] = (public.get_current_profile_id())::text)))))
$ddl$);
CALL pg_temp.converge_policy('storage.objects', 'Group participants can delete group icons', '{}', $ddl$
CREATE POLICY __POLICY__ ON storage.objects AS PERMISSIVE FOR DELETE TO public
    USING (((bucket_id = 'group-icons'::text) AND (auth.role() = 'authenticated'::text) AND (EXISTS (
        SELECT 1 FROM public.conversation_participants cp WHERE ((cp.conversation_id =
        ((storage.foldername(objects.name))[1])::uuid) AND (cp.user_id =
        public.get_current_profile_id()) AND (cp.left_at IS NULL))))))
$ddl$);
CALL pg_temp.converge_policy('storage.objects', 'Group participants can update group icons', '{}', $ddl$
CREATE POLICY __POLICY__ ON storage.objects AS PERMISSIVE FOR UPDATE TO public
    USING (((bucket_id = 'group-icons'::text) AND (auth.role() = 'authenticated'::text) AND (EXISTS (
        SELECT 1 FROM public.conversation_participants cp WHERE ((cp.conversation_id =
        ((storage.foldername(objects.name))[1])::uuid) AND (cp.user_id =
        public.get_current_profile_id()) AND (cp.left_at IS NULL))))))
$ddl$);
CALL pg_temp.converge_policy('storage.objects', 'Group participants can upload group icons', '{}', $ddl$
CREATE POLICY __POLICY__ ON storage.objects AS PERMISSIVE FOR INSERT TO public
    WITH CHECK (((bucket_id = 'group-icons'::text) AND (auth.role() = 'authenticated'::text) AND (EXISTS (
        SELECT 1 FROM public.conversation_participants cp WHERE ((cp.conversation_id =
        ((storage.foldername(objects.name))[1])::uuid) AND (cp.user_id =
        public.get_current_profile_id()) AND (cp.left_at IS NULL))))))
$ddl$);
CALL pg_temp.converge_policy('storage.objects', 'Public read access for avatars', '{}', $ddl$
CREATE POLICY __POLICY__ ON storage.objects AS PERMISSIVE FOR SELECT TO public
    USING ((bucket_id = 'avatars'::text))
$ddl$);
CALL pg_temp.converge_policy('storage.objects', 'Public read access for banners', '{}', $ddl$
CREATE POLICY __POLICY__ ON storage.objects AS PERMISSIVE FOR SELECT TO public
    USING ((bucket_id = 'banners'::text))
$ddl$);
CALL pg_temp.converge_policy('storage.objects', 'Public read access for emojis', '{}', $ddl$
CREATE POLICY __POLICY__ ON storage.objects AS PERMISSIVE FOR SELECT TO public
    USING ((bucket_id = 'emojis'::text))
$ddl$);
CALL pg_temp.converge_policy('storage.objects', 'Public read access for group-icons', '{}', $ddl$
CREATE POLICY __POLICY__ ON storage.objects AS PERMISSIVE FOR SELECT TO public
    USING ((bucket_id = 'group-icons'::text))
$ddl$);
CALL pg_temp.converge_policy('storage.objects', 'Public read access for server_banners', '{}', $ddl$
CREATE POLICY __POLICY__ ON storage.objects AS PERMISSIVE FOR SELECT TO public
    USING ((bucket_id = 'server_banners'::text))
$ddl$);
CALL pg_temp.converge_policy('storage.objects', 'Public read access for server_icons', '{}', $ddl$
CREATE POLICY __POLICY__ ON storage.objects AS PERMISSIVE FOR SELECT TO public
    USING ((bucket_id = 'server_icons'::text))
$ddl$);
CALL pg_temp.converge_policy('storage.objects', 'Public read access for user_media', '{}', $ddl$
CREATE POLICY __POLICY__ ON storage.objects AS PERMISSIVE FOR SELECT TO public
    USING ((bucket_id = 'user_media'::text))
$ddl$);
CALL pg_temp.converge_policy('storage.objects', 'Server owners can update server banners', '{}', $ddl$
CREATE POLICY __POLICY__ ON storage.objects AS PERMISSIVE FOR UPDATE TO public
    USING (((bucket_id = 'server_banners'::text) AND
        public.has_permission(public.get_current_profile_id(), ((storage.foldername(name))[1])::uuid,
        'MANAGE_SERVER'::text)))
$ddl$);
CALL pg_temp.converge_policy('storage.objects', 'Server owners can update server icons', '{}', $ddl$
CREATE POLICY __POLICY__ ON storage.objects AS PERMISSIVE FOR UPDATE TO public
    USING (((bucket_id = 'server_icons'::text) AND public.has_permission(public.get_current_profile_id(),
        ((storage.foldername(name))[1])::uuid, 'MANAGE_SERVER'::text)))
$ddl$);
CALL pg_temp.converge_policy('storage.objects', 'Server owners can upload server banners', '{}', $ddl$
CREATE POLICY __POLICY__ ON storage.objects AS PERMISSIVE FOR INSERT TO public
    WITH CHECK (((bucket_id = 'server_banners'::text) AND
        public.has_permission(public.get_current_profile_id(), ((storage.foldername(name))[1])::uuid,
        'MANAGE_SERVER'::text)))
$ddl$);
CALL pg_temp.converge_policy('storage.objects', 'Server owners can upload server icons', '{}', $ddl$
CREATE POLICY __POLICY__ ON storage.objects AS PERMISSIVE FOR INSERT TO public
    WITH CHECK (((bucket_id = 'server_icons'::text) AND public.has_permission(public.get_current_profile_id(),
        ((storage.foldername(name))[1])::uuid, 'MANAGE_SERVER'::text)))
$ddl$);
CALL pg_temp.converge_policy('storage.objects', 'Users can delete emojis', '{}', $ddl$
CREATE POLICY __POLICY__ ON storage.objects AS PERMISSIVE FOR DELETE TO public
    USING (((bucket_id = 'emojis'::text) AND public.has_permission(public.get_current_profile_id(),
        ((storage.foldername(name))[1])::uuid, 'MANAGE_EMOJIS'::text)))
$ddl$);
CALL pg_temp.converge_policy('storage.objects', 'Users can delete their own avatar', '{}', $ddl$
CREATE POLICY __POLICY__ ON storage.objects AS PERMISSIVE FOR DELETE TO public
    USING (((bucket_id = 'avatars'::text) AND (auth.role() = 'authenticated'::text) AND
        (((storage.foldername(name))[1] = (auth.uid())::text) OR ((public.get_current_profile_id() IS
        NOT NULL) AND ((storage.foldername(name))[1] = (public.get_current_profile_id())::text)))))
$ddl$);
CALL pg_temp.converge_policy('storage.objects', 'Users can delete their own banner', '{}', $ddl$
CREATE POLICY __POLICY__ ON storage.objects AS PERMISSIVE FOR DELETE TO public
    USING (((bucket_id = 'banners'::text) AND (auth.role() = 'authenticated'::text) AND
        (((storage.foldername(name))[1] = (auth.uid())::text) OR ((public.get_current_profile_id() IS
        NOT NULL) AND ((storage.foldername(name))[1] = (public.get_current_profile_id())::text)))))
$ddl$);
CALL pg_temp.converge_policy('storage.objects', 'Users can delete their own user_media', '{}', $ddl$
CREATE POLICY __POLICY__ ON storage.objects AS PERMISSIVE FOR DELETE TO public
    USING (((bucket_id = 'user_media'::text) AND (auth.role() = 'authenticated'::text) AND
        (((storage.foldername(name))[1] = (auth.uid())::text) OR ((public.get_current_profile_id() IS
        NOT NULL) AND ((storage.foldername(name))[1] = (public.get_current_profile_id())::text)))))
$ddl$);
CALL pg_temp.converge_policy('storage.objects', 'Users can update their own avatar', '{}', $ddl$
CREATE POLICY __POLICY__ ON storage.objects AS PERMISSIVE FOR UPDATE TO public
    USING (((bucket_id = 'avatars'::text) AND (auth.role() = 'authenticated'::text) AND
        (((storage.foldername(name))[1] = (auth.uid())::text) OR ((public.get_current_profile_id() IS
        NOT NULL) AND ((storage.foldername(name))[1] = (public.get_current_profile_id())::text)))))
$ddl$);
CALL pg_temp.converge_policy('storage.objects', 'Users can update their own banner', '{}', $ddl$
CREATE POLICY __POLICY__ ON storage.objects AS PERMISSIVE FOR UPDATE TO public
    USING (((bucket_id = 'banners'::text) AND (auth.role() = 'authenticated'::text) AND
        (((storage.foldername(name))[1] = (auth.uid())::text) OR ((public.get_current_profile_id() IS
        NOT NULL) AND ((storage.foldername(name))[1] = (public.get_current_profile_id())::text)))))
$ddl$);
CALL pg_temp.converge_policy('storage.objects', 'Users can update their own user_media', '{}', $ddl$
CREATE POLICY __POLICY__ ON storage.objects AS PERMISSIVE FOR UPDATE TO public
    USING (((bucket_id = 'user_media'::text) AND (auth.role() = 'authenticated'::text) AND
        (((storage.foldername(name))[1] = (auth.uid())::text) OR ((public.get_current_profile_id() IS
        NOT NULL) AND ((storage.foldername(name))[1] = (public.get_current_profile_id())::text)))))
$ddl$);
CALL pg_temp.converge_policy('storage.objects', 'Users can upload emojis', '{}', $ddl$
CREATE POLICY __POLICY__ ON storage.objects AS PERMISSIVE FOR INSERT TO public
    WITH CHECK (((bucket_id = 'emojis'::text) AND public.has_permission(public.get_current_profile_id(),
        ((storage.foldername(name))[1])::uuid, 'MANAGE_EMOJIS'::text)))
$ddl$);
CALL pg_temp.converge_policy('storage.objects', 'Users can upload their own avatar', '{}', $ddl$
CREATE POLICY __POLICY__ ON storage.objects AS PERMISSIVE FOR INSERT TO public
    WITH CHECK (((bucket_id = 'avatars'::text) AND (auth.role() = 'authenticated'::text) AND
        (((storage.foldername(name))[1] = (auth.uid())::text) OR ((public.get_current_profile_id() IS
        NOT NULL) AND ((storage.foldername(name))[1] = (public.get_current_profile_id())::text)))))
$ddl$);
CALL pg_temp.converge_policy('storage.objects', 'Users can upload their own banner', '{}', $ddl$
CREATE POLICY __POLICY__ ON storage.objects AS PERMISSIVE FOR INSERT TO public
    WITH CHECK (((bucket_id = 'banners'::text) AND (auth.role() = 'authenticated'::text) AND
        (((storage.foldername(name))[1] = (auth.uid())::text) OR ((public.get_current_profile_id() IS
        NOT NULL) AND ((storage.foldername(name))[1] = (public.get_current_profile_id())::text)))))
$ddl$);
-- Added: report moderation deletes reported files (ReportsModeration.vue).
CALL pg_temp.converge_policy('storage.objects', 'Instance admins can delete moderated media', '{}', $ddl$
CREATE POLICY __POLICY__ ON storage.objects AS PERMISSIVE FOR DELETE TO authenticated
    USING (((bucket_id = ANY (ARRAY['avatars'::text, 'banners'::text, 'emojis'::text,
        'server_icons'::text, 'user_media'::text])) AND ( SELECT public.is_current_user_admin() AS
        is_current_user_admin)))
$ddl$);
-- Added: instance icon and banner upserts under instance/ (InstanceConfig.vue).
CALL pg_temp.converge_policy('storage.objects', 'Instance admins can update instance branding', '{}', $ddl$
CREATE POLICY __POLICY__ ON storage.objects AS PERMISSIVE FOR UPDATE TO authenticated
    USING (((bucket_id = ANY (ARRAY['server_banners'::text, 'server_icons'::text])) AND
        ((storage.foldername(name))[1] = 'instance'::text) AND ( SELECT public.is_current_user_admin()
        AS is_current_user_admin)))
    WITH CHECK (((bucket_id = ANY (ARRAY['server_banners'::text, 'server_icons'::text])) AND
        ((storage.foldername(name))[1] = 'instance'::text) AND ( SELECT public.is_current_user_admin()
        AS is_current_user_admin)))
$ddl$);
-- Added: instance icon and banner uploads under instance/ (InstanceConfig.vue).
CALL pg_temp.converge_policy('storage.objects', 'Instance admins can upload instance branding', '{}', $ddl$
CREATE POLICY __POLICY__ ON storage.objects AS PERMISSIVE FOR INSERT TO authenticated
    WITH CHECK (((bucket_id = ANY (ARRAY['server_banners'::text, 'server_icons'::text])) AND
        ((storage.foldername(name))[1] = 'instance'::text) AND ( SELECT public.is_current_user_admin()
        AS is_current_user_admin)))
$ddl$);
-- Added: replacing a server icon removes the old file (stores/server.ts).
CALL pg_temp.converge_policy('storage.objects', 'Server owners can delete server icons', '{}', $ddl$
CREATE POLICY __POLICY__ ON storage.objects AS PERMISSIVE FOR DELETE TO public
    USING (((bucket_id = 'server_icons'::text) AND public.has_permission(public.get_current_profile_id(),
        ((storage.foldername(name))[1])::uuid, 'MANAGE_SERVER'::text)))
$ddl$);

-- Production-only policies. dup: covered by a canonical policy. wider: grants more than
-- canonical, no application path depends on the difference. app: sole source of an access
-- the application uses; the canonical replacement is asserted above. keep: left in place,
-- the canonical set cannot install.

-- public.bot_audit_log
CALL pg_temp.drop_legacy_policy('public.bot_audit_log', 'Bot owners can view audit logs', '{}',
    'dup: bot_audit_log_select_owner');

-- public.bot_commands
CALL pg_temp.drop_legacy_policy('public.bot_commands', 'Bot commands are public', '{}',
    'dup: bot_commands_select_all');
CALL pg_temp.drop_legacy_policy('public.bot_commands', 'Bot owners can manage commands', '{}',
    'dup: bot_commands_modify_owner');

-- public.bot_presence
CALL pg_temp.drop_legacy_policy('public.bot_presence', 'Bot presence is public', '{}',
    'dup: bot_presence_select_all');

-- public.channel_permission_overrides
CALL pg_temp.drop_legacy_policy('public.channel_permission_overrides', 'Users can view channel overrides', '{}',
    'dup: channel_permission_overrides_select');

-- public.conversation_encryption_settings
CALL pg_temp.drop_legacy_policy('public.conversation_encryption_settings', 'Conversation participants can insert encryption settings', '{}',
    'wider: no left_at filter: former participants write settings');
CALL pg_temp.drop_legacy_policy('public.conversation_encryption_settings', 'Conversation participants can update encryption settings', '{}',
    'wider: no left_at filter: former participants write settings');
CALL pg_temp.drop_legacy_policy('public.conversation_encryption_settings', 'Conversation participants can view encryption settings', '{}',
    'dup: conversation_encryption_settings_select');

-- public.conversations
CALL pg_temp.drop_legacy_policy('public.conversations', 'Conversation participants can update conversations', '{}',
    'wider: no canonical UPDATE; any participant rewrites any column; group edits use SECURITY DEFINER RPCs');

-- public.encryption_audit_log
CALL pg_temp.drop_legacy_policy('public.encryption_audit_log', 'Admins can view all audit logs', '{}',
    'dup: encryption_audit_log_own_or_admin');
CALL pg_temp.drop_legacy_policy('public.encryption_audit_log', 'Users can view their own audit logs', '{}',
    'dup: encryption_audit_log_own_or_admin');

-- public.encryption_sessions
CALL pg_temp.drop_legacy_policy('public.encryption_sessions', 'Users can manage their own sessions', '{}',
    'dup: encryption_sessions_own_user');
CALL pg_temp.drop_legacy_policy('public.encryption_sessions', 'Users can view their own sessions', '{}',
    'dup: encryption_sessions_own_user');

-- public.federated_voice_calls
CALL pg_temp.drop_legacy_policy('public.federated_voice_calls', 'Users can view their own calls', '{}',
    'wider: no canonical client SELECT; only federation-backend reads, as service_role');

-- public.federation_endpoint_health
CALL pg_temp.drop_legacy_policy('public.federation_endpoint_health', 'Authenticated users can read endpoint health', '{}',
    'dup: federation_endpoint_health_select');

-- public.follows
CALL pg_temp.drop_legacy_policy('public.follows', 'Users can delete their follow relationships', '{}',
    $ddl$app: blocking deletes the blocked user's follow of the blocker; follows_delete_follower$ddl$);

-- public.instance_config
CALL pg_temp.drop_legacy_policy('public.instance_config', 'Instance config admin access', '{}',
    'wider: admin writes through PostgREST; the app writes through set_instance_config');

-- public.instance_webrtc_settings
CALL pg_temp.drop_legacy_policy('public.instance_webrtc_settings', 'Admins can delete webrtc settings', '{}',
    'wider: no canonical DELETE; unused');
CALL pg_temp.drop_legacy_policy('public.instance_webrtc_settings', 'Admins can insert webrtc settings', '{}',
    'dup: webrtc_settings_insert_admin_only');
CALL pg_temp.drop_legacy_policy('public.instance_webrtc_settings', 'Admins can update webrtc settings', '{}',
    'dup: webrtc_settings_update_admin_only');

-- public.megolm_key_backups
CALL pg_temp.drop_legacy_policy('public.megolm_key_backups', 'Users can manage their own backups', '{}',
    'dup: megolm_key_backups_own_only');

-- public.megolm_key_requests
CALL pg_temp.drop_legacy_policy('public.megolm_key_requests', 'Requesters can manage their key requests', '{}',
    'dup: megolm_key_requests_own; the client writes user_id = requester_user_id');
CALL pg_temp.drop_legacy_policy('public.megolm_key_requests', 'Senders can view and fulfill key requests', '{}',
    'wider: senders INSERT and DELETE requests; canonical allows SELECT and UPDATE');

-- public.megolm_room_sessions
CALL pg_temp.drop_legacy_policy('public.megolm_room_sessions', 'Room participants can view session metadata', ARRAY['public.megolm_room_sessions:session_id', 'public.megolm_room_sessions:creator_user_id'],
    'keep: canonical needs megolm_room_sessions.session_id, creator_user_id');
CALL pg_temp.drop_legacy_policy('public.megolm_room_sessions', 'Users can manage their own sessions', ARRAY['public.megolm_room_sessions:session_id', 'public.megolm_room_sessions:creator_user_id'],
    'keep: canonical needs megolm_room_sessions.session_id, creator_user_id');

-- public.megolm_session_shares
CALL pg_temp.drop_legacy_policy('public.megolm_session_shares', 'Senders can delete their session shares', '{}',
    'dup: megolm_session_shares_delete');
CALL pg_temp.drop_legacy_policy('public.megolm_session_shares', 'Users can update session shares', '{}',
    'dup: megolm_session_shares_update');
CALL pg_temp.drop_legacy_policy('public.megolm_session_shares', 'Users can view their session shares', '{}',
    'dup: megolm_session_shares_select');

-- public.message_search_index
CALL pg_temp.drop_legacy_policy('public.message_search_index', 'Users can search messages they have access to', '{}',
    'wider: no status filter: pending and banned members search channel content');

-- public.messages
CALL pg_temp.drop_legacy_policy('public.messages', 'Users can create messages in conversations they participate in', '{}',
    'wider: no status filter: pending members post; skips the DM block check');
CALL pg_temp.drop_legacy_policy('public.messages', 'Users can view messages in conversations they participate in', '{}',
    'wider: no status filter: pending and banned members read every channel');

-- public.mfa_recovery_codes
CALL pg_temp.drop_legacy_policy('public.mfa_recovery_codes', 'Users can delete their own recovery codes', '{}',
    'dup: mfa_recovery_codes_own_only');
CALL pg_temp.drop_legacy_policy('public.mfa_recovery_codes', 'Users can insert their own recovery codes', '{}',
    'dup: mfa_recovery_codes_own_only');
CALL pg_temp.drop_legacy_policy('public.mfa_recovery_codes', 'Users can mark their own recovery codes as used', '{}',
    'dup: mfa_recovery_codes_own_only');
CALL pg_temp.drop_legacy_policy('public.mfa_recovery_codes', 'Users can view their own unused recovery codes', '{}',
    'dup: mfa_recovery_codes_own_only');

-- public.notifications
CALL pg_temp.drop_legacy_policy('public.notifications', 'notifications_realtime_delete', '{}',
    'dup: notifications_delete_own');

-- public.performance_metrics_hourly
CALL pg_temp.drop_legacy_policy('public.performance_metrics_hourly', 'Admins can read hourly metrics', '{}',
    'dup: performance_metrics_hourly_select_all');

-- public.pg_background_job
CALL pg_temp.drop_legacy_policy('public.pg_background_job', 'Users can create background jobs', '{}',
    'wider: authenticated INSERT into a table outside the repo that no function reads');

-- public.post_interactions
CALL pg_temp.drop_legacy_policy('public.post_interactions', 'Users can create post interactions on posts they can see', '{}',
    $ddl$wider: skips the block check: blocked users favourite and reblog the blocker's posts$ddl$);
CALL pg_temp.drop_legacy_policy('public.post_interactions', 'Users can delete their own interactions', '{}',
    'dup: post_interactions_delete_own');
CALL pg_temp.drop_legacy_policy('public.post_interactions', 'Users can update their own interactions', '{}',
    'wider: no canonical UPDATE; retargets an interaction past the block check');

-- public.posts
CALL pg_temp.drop_legacy_policy('public.posts', 'Users can view their deleted posts', '{}',
    'dup: posts_select_public');

-- public.prekeys
CALL pg_temp.drop_legacy_policy('public.prekeys', 'Users can view their own prekeys', '{}',
    'wider: owner reads own consumed prekeys; no client path');

-- public.profiles
CALL pg_temp.drop_legacy_policy('public.profiles', 'Users can update own profile.', '{}',
    'dup: profiles_update_own; its AAL gate was OR-ed away by that policy');

-- public.push_subscriptions
CALL pg_temp.drop_legacy_policy('public.push_subscriptions', 'Users can delete own push subscriptions', '{}',
    'wider: canonical is service_role only; federation-backend owns the table');
CALL pg_temp.drop_legacy_policy('public.push_subscriptions', 'Users can insert own push subscriptions', '{}',
    'wider: canonical is service_role only; federation-backend owns the table');
CALL pg_temp.drop_legacy_policy('public.push_subscriptions', 'Users can update own push subscriptions', '{}',
    'wider: canonical is service_role only; federation-backend owns the table');
CALL pg_temp.drop_legacy_policy('public.push_subscriptions', 'Users can view own push subscriptions', '{}',
    'wider: canonical is service_role only; federation-backend owns the table');

-- public.reactions
CALL pg_temp.drop_legacy_policy('public.reactions', 'Users can update their own reactions', '{}',
    'wider: no canonical UPDATE; retargets a reaction to any message past the block check');

-- public.recovery_key_metadata
CALL pg_temp.drop_legacy_policy('public.recovery_key_metadata', 'Users can manage their own recovery metadata', '{}',
    'dup: recovery_key_metadata_own_only');

-- public.remote_emojis_cache
CALL pg_temp.drop_legacy_policy('public.remote_emojis_cache', 'Admins can update remote emojis', '{}',
    'dup: remote_emojis_cache_admin_modify');
CALL pg_temp.drop_legacy_policy('public.remote_emojis_cache', 'Anyone can view remote emojis', '{}',
    'dup: remote_emojis_cache_select_all');

-- public.server_encryption_settings
CALL pg_temp.drop_legacy_policy('public.server_encryption_settings', 'Everyone can view server encryption settings', '{}',
    $ddl$wider: anon and non-members read every server's settings$ddl$);
CALL pg_temp.drop_legacy_policy('public.server_encryption_settings', 'Server owners can manage encryption settings', '{}',
    'dup: server_encryption_settings_modify');

-- public.server_federation_events
CALL pg_temp.drop_legacy_policy('public.server_federation_events', 'Users can create their own server events', '{}',
    'wider: canonical is service_role only; no client path');
CALL pg_temp.drop_legacy_policy('public.server_federation_events', $ddl$Users can view server events they're involved in$ddl$, '{}',
    'wider: canonical is service_role only; no client path');

-- public.server_settings
CALL pg_temp.drop_legacy_policy('public.server_settings', 'Users can view server settings', '{}',
    'dup: server_settings_select_member');
CALL pg_temp.drop_legacy_policy('public.server_settings', 'Users with MANAGE_SERVER can manage settings', '{}',
    'wider: canonical is owner only; the one client writer (InviteSettings.vue) is not mounted');

-- public.servers
CALL pg_temp.drop_legacy_policy('public.servers', 'Update', '{}',
    'dup: Server owners can update their servers');
CALL pg_temp.drop_legacy_policy('public.servers', 'server_delete_policy', '{}',
    'dup: Server owners can delete their servers');

-- public.slow_queries
CALL pg_temp.drop_legacy_policy('public.slow_queries', 'Admins can read slow queries', '{}',
    'dup: slow_queries_admin_only');

-- public.threads
CALL pg_temp.drop_legacy_policy('public.threads', 'Moderators can delete threads', '{}',
    'app: MANAGE_CHANNELS holders delete threads (ThreadFullView); threads_delete_authorized, 20261001200002');
CALL pg_temp.drop_legacy_policy('public.threads', 'Users can create threads', '{}',
    'wider: no created_by check: a member creates threads as someone else');
CALL pg_temp.drop_legacy_policy('public.threads', 'Users can update threads', '{}',
    'app: MANAGE_CHANNELS holders lock and archive threads (ThreadFullView); threads_update_authorized, 20261001200002');

-- public.timeline_entries
CALL pg_temp.drop_legacy_policy('public.timeline_entries', 'Users can insert their own timeline entries', '{}',
    'wider: canonical writes are service_role only; no client path');

-- public.user_blocks
CALL pg_temp.drop_legacy_policy('public.user_blocks', 'Users can create blocks', '{}',
    'dup: user_blocks_insert_own');
CALL pg_temp.drop_legacy_policy('public.user_blocks', 'Users can delete own blocks', '{}',
    'dup: user_blocks_delete_own');
CALL pg_temp.drop_legacy_policy('public.user_blocks', 'Users can view own blocks', '{}',
    'dup: user_blocks_select_own');

-- public.user_key_pairs
CALL pg_temp.drop_legacy_policy('public.user_key_pairs', 'Users can view their own key pairs', '{}',
    'dup: Users can view own key pair (full row)');

-- public.user_view_contexts
CALL pg_temp.drop_legacy_policy('public.user_view_contexts', 'Users can insert their own view context', '{}',
    'dup: user_view_contexts_own_user');
CALL pg_temp.drop_legacy_policy('public.user_view_contexts', 'Users can read their own view context', '{}',
    'dup: user_view_contexts_own_user');
CALL pg_temp.drop_legacy_policy('public.user_view_contexts', 'Users can update their own view context', '{}',
    'dup: user_view_contexts_own_user');

-- public.voice_channel_participants
CALL pg_temp.drop_legacy_policy('public.voice_channel_participants', 'Select voice participants', '{}',
    'dup: voice_participants_select_all');
CALL pg_temp.drop_legacy_policy('public.voice_channel_participants', 'Service role full access', '{}',
    'dup: service_role bypasses RLS');

-- storage.objects
CALL pg_temp.drop_legacy_policy('storage.objects', 'Admins and server owners can delete emojis', '{}',
    'app: owners: Users can delete emojis; admins: Instance admins can delete moderated media');
CALL pg_temp.drop_legacy_policy('storage.objects', 'Admins and server owners can delete server icons', '{}',
    'app: owners: Server owners can delete server icons (stores/server.ts); admins: Instance admins can delete moderated media');
CALL pg_temp.drop_legacy_policy('storage.objects', 'Admins and server owners can update emojis', '{}',
    'wider: no emoji upsert path; owners and admins overwrite any emoji');
CALL pg_temp.drop_legacy_policy('storage.objects', 'Admins and server owners can update server icons', '{}',
    'app: owners: Server owners can update server icons; admins: Instance admins can update instance branding');
CALL pg_temp.drop_legacy_policy('storage.objects', 'Admins and server owners can upload emojis', '{}',
    'wider: owners: Users can upload emojis; admin branch writes into any server folder');
CALL pg_temp.drop_legacy_policy('storage.objects', 'Admins and server owners can upload server icons', '{}',
    'app: owners: Server owners can upload server icons; admins: Instance admins can upload instance branding');
CALL pg_temp.drop_legacy_policy('storage.objects', 'Anyone can view avatars', '{}',
    'app: sole read policy; Public read access for avatars');
CALL pg_temp.drop_legacy_policy('storage.objects', 'Anyone can view banners', '{}',
    'app: sole read policy; Public read access for banners');
CALL pg_temp.drop_legacy_policy('storage.objects', 'Anyone can view emojis', '{}',
    'app: sole read policy; Public read access for emojis');
CALL pg_temp.drop_legacy_policy('storage.objects', 'Anyone can view server icons', '{}',
    'app: sole read policy; Public read access for server_icons');
CALL pg_temp.drop_legacy_policy('storage.objects', 'Anyone can view user media', '{}',
    'app: sole read policy; Public read access for user_media');
CALL pg_temp.drop_legacy_policy('storage.objects', 'Application controlled group icon deletes', '{}',
    'wider: any role, anon included, deletes any group icon');
CALL pg_temp.drop_legacy_policy('storage.objects', 'Application controlled group icon updates', '{}',
    'wider: any role, anon included, overwrites any group icon');
CALL pg_temp.drop_legacy_policy('storage.objects', 'Application controlled group icon uploads', '{}',
    'wider: any role, anon included, uploads into any group folder');
CALL pg_temp.drop_legacy_policy('storage.objects', 'Public read access for group icons', '{}',
    'app: sole read policy; Public read access for group-icons');
CALL pg_temp.drop_legacy_policy('storage.objects', 'Users can delete their own avatars', '{}',
    'app: owner: Users can delete their own avatar; admins: Instance admins can delete moderated media');
CALL pg_temp.drop_legacy_policy('storage.objects', 'Users can delete their own banners', '{}',
    'app: owner: Users can delete their own banner; admins: Instance admins can delete moderated media');
CALL pg_temp.drop_legacy_policy('storage.objects', 'Users can delete their own media', '{}',
    'app: owner: Users can delete their own user_media; admins: Instance admins can delete moderated media');
CALL pg_temp.drop_legacy_policy('storage.objects', 'Users can update their own avatars', '{}',
    $ddl$wider: owner: Users can update their own avatar; admin branch overwrites any user's files$ddl$);
CALL pg_temp.drop_legacy_policy('storage.objects', 'Users can update their own banners', '{}',
    $ddl$wider: owner: Users can update their own banner; admin branch overwrites any user's files$ddl$);
CALL pg_temp.drop_legacy_policy('storage.objects', 'Users can update their own media', '{}',
    $ddl$wider: owner: Users can update their own user_media; admin branch overwrites any user's files$ddl$);
CALL pg_temp.drop_legacy_policy('storage.objects', 'Users can upload their own avatars', '{}',
    $ddl$wider: owner: canonical upload policy; admin branch writes into any user's folder$ddl$);
CALL pg_temp.drop_legacy_policy('storage.objects', 'Users can upload their own banners', '{}',
    $ddl$wider: owner: canonical upload policy; admin branch writes into any user's folder$ddl$);
CALL pg_temp.drop_legacy_policy('storage.objects', 'Users can upload their own media', '{}',
    $ddl$wider: owner: canonical upload policy; admin branch writes into any user's folder$ddl$);

-- Any other policy on a converged table is drift no migration names. On public tables it is
-- dropped; on storage.objects it is reported and kept, since buckets outside the application
-- may share the table.
DO $$
DECLARE
    r record;
BEGIN
    FOR r IN
        SELECT n.nspname || '.' || c.relname AS tbl, p.polname, c.oid AS rel
          FROM pg_catalog.pg_policy p
          JOIN pg_catalog.pg_class c ON c.oid = p.polrelid
          JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname || '.' || c.relname IN (SELECT tbl FROM converge_seen)
           AND (n.nspname || '.' || c.relname, p.polname) NOT IN (SELECT tbl, pol FROM converge_seen)
         ORDER BY 1, 2
    LOOP
        IF r.tbl LIKE 'public.%' THEN
            EXECUTE format('DROP POLICY %I ON %s', r.polname, r.rel::regclass);
            RAISE NOTICE 'drop   % %: not canonical', r.tbl, quote_ident(r.polname);
        ELSE
            RAISE NOTICE 'left   % %: not canonical, outside public', r.tbl, quote_ident(r.polname);
        END IF;
    END LOOP;
END;
$$;

DROP PROCEDURE pg_temp.drop_legacy_policy(text, text, text[], text);
DROP PROCEDURE pg_temp.converge_policy(text, text, text[], text);
DROP PROCEDURE pg_temp.converge_known(text, text, text);
DROP FUNCTION pg_temp.converge_shape(regclass, text);
DROP FUNCTION pg_temp.converge_missing_column(text[]);

COMMIT;

NOTIFY pgrst, 'reload schema';
