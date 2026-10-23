-- Instance staff hold no power inside servers through these: they act as Trust & Safety through the
-- staff_* RPCs of 20261027250001_instance_staff_safety.sql. Each body is its latest definition with the
-- is_current_user_admin() path removed; channel webhooks also refuse copies of remote servers, as the
-- other server-authority checks of 20261027200001_server_copies_authority.sql do.
--   can_manage_channel_webhooks      20261010800001_channel_webhooks.sql
--   can_manage_server_sounds         20261011300001_soundboard.sql
--   export_server_template           20261011000001_server_templates.sql
--   set_channel_encryption           20261026100001_system_events.sql
--   guard_user_server_client_write   20261005600001_message_path_security.sql
--   import_remote_emoji              20261006700001_security_app_fixes.sql (instance emojis stay
--                                    an admin's; a server's are its owner's, servers hosted here)
--   voice_activity_may_end           20261016100001_voice_activity_end_rights.sql
--   policy user_servers_update_own_or_owner (baseline)

BEGIN;

SET LOCAL lock_timeout = '5s';

CREATE OR REPLACE FUNCTION public.can_manage_channel_webhooks(p_channel_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT EXISTS (
        SELECT 1
          FROM public.channels c
          JOIN public.servers s ON s.id = c.server_id
         WHERE c.id = p_channel_id
           AND public.get_current_profile_id() IS NOT NULL
           AND s.is_local_server IS NOT FALSE
           AND (s.owner = public.get_current_profile_id()
                OR (public.can_view_channel(public.get_current_profile_id(), c.id)
                    AND public.has_permission(public.get_current_profile_id(), c.server_id,
                                              'MANAGE_WEBHOOKS', c.id)))
    );
$$;

CREATE OR REPLACE FUNCTION public.can_manage_server_sounds(p_server_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT v.me IS NOT NULL
       AND EXISTS (
           SELECT 1 FROM public.servers s
            WHERE s.id = p_server_id
              AND s.is_local_server IS NOT FALSE
              AND (s.owner = v.me
                   OR (EXISTS (SELECT 1 FROM public.user_servers us
                                WHERE us.server_id = s.id
                                  AND us.user_id = v.me
                                  AND us.status = 'accepted')
                       AND public.has_permission(v.me, s.id, 'MANAGE_EMOJIS'))))
      FROM (SELECT public.get_current_profile_id() AS me) v;
$$;

CREATE OR REPLACE FUNCTION public.export_server_template(p_server_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_me uuid := public.get_current_profile_id();
    v_srv public.servers%ROWTYPE;
    v_mask bigint := (1::bigint << array_length(public.permission_bit_names(), 1)) - 1;
    v_admin uuid;
    v_everyone uuid;
    v_roles jsonb;
    v_categories jsonb;
    v_channels jsonb;
    v_types jsonb;
    v_order jsonb;
    v_settings jsonb;
    v_welcome jsonb;
    v_automod jsonb;
    v_rows jsonb;
BEGIN
    IF v_me IS NULL THEN
        RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
    END IF;

    SELECT * INTO v_srv
      FROM public.servers s
     WHERE s.id = p_server_id AND s.is_local_server IS NOT FALSE;
    -- has_permission reads @everyone for any profile, member or not.
    IF NOT FOUND
       OR NOT (v_srv.owner IS NOT DISTINCT FROM v_me
               OR (EXISTS (SELECT 1 FROM public.user_servers us
                            WHERE us.server_id = p_server_id AND us.user_id = v_me AND us.status = 'accepted')
                   AND public.has_permission(v_me, p_server_id, 'MANAGE_SERVER'))) THEN
        RAISE EXCEPTION 'Missing permission: MANAGE_SERVER' USING ERRCODE = '42501';
    END IF;

    SELECT sr.id INTO v_everyone
      FROM public.server_roles sr WHERE sr.server_id = p_server_id AND sr.is_default;
    SELECT sr.id INTO v_admin
      FROM public.server_roles sr
     WHERE sr.server_id = p_server_id AND sr.is_admin AND sr.is_default IS NOT TRUE
     ORDER BY sr.position DESC NULLS LAST, sr.created_at, sr.id
     LIMIT 1;

    -- Refs: r<n>, c<n>, ch<n> in export order; uuid text -> ref.
    SELECT COALESCE(jsonb_object_agg(x.id::text, 'r' || x.n), '{}'::jsonb) INTO v_rows
      FROM (SELECT sr.id, row_number() OVER (ORDER BY COALESCE(sr.position, 0), sr.created_at, sr.id) AS n
              FROM public.server_roles sr WHERE sr.server_id = p_server_id) x;
    SELECT v_rows || COALESCE(jsonb_object_agg(x.id::text, 'c' || x.n), '{}'::jsonb) INTO v_rows
      FROM (SELECT cc.id, row_number() OVER (ORDER BY COALESCE(cc."order", 0), cc.created_at, cc.id) AS n
              FROM public.channel_categories cc WHERE cc.server_id = p_server_id) x;
    SELECT v_rows || COALESCE(jsonb_object_agg(x.id::text, 'ch' || x.n), '{}'::jsonb),
           COALESCE(jsonb_object_agg(x.id::text, x.type), '{}'::jsonb),
           COALESCE(jsonb_object_agg(x.id::text, x.n), '{}'::jsonb)
      INTO v_rows, v_types, v_order
      FROM (SELECT c.id, c.type,
                   row_number() OVER (ORDER BY cc."order" NULLS FIRST, cc.created_at, COALESCE(c."order", 0),
                                               c.created_at, c.id) AS n
              FROM public.channels c
              LEFT JOIN public.channel_categories cc ON cc.id = c.category
             WHERE c.server_id = p_server_id AND c.type IN (0, 1)) x;

    SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'ref', v_rows ->> sr.id::text,
               'name', sr.name,
               'color', CASE WHEN sr.color ~ '^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$' THEN sr.color END,
               'position', COALESCE(sr.position, 0),
               'permissions', (COALESCE(sr.permissions, 0) & v_mask)::text,
               'is_default', COALESCE(sr.is_default, false),
               'is_admin', sr.id IS NOT DISTINCT FROM v_admin,
               'mentionable', COALESCE(sr.mentionable, true),
               'hoist', COALESCE(sr.hoist, false),
               'unicode_emoji', CASE WHEN char_length(sr.unicode_emoji) <= 64 THEN sr.unicode_emoji END)
           ORDER BY COALESCE(sr.position, 0), sr.created_at, sr.id), '[]'::jsonb)
      INTO v_roles
      FROM public.server_roles sr
     WHERE sr.server_id = p_server_id;

    SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'ref', v_rows ->> cc.id::text,
               'name', cc.name,
               'order', COALESCE(cc."order", 0))
           ORDER BY COALESCE(cc."order", 0), cc.created_at, cc.id), '[]'::jsonb)
      INTO v_categories
      FROM public.channel_categories cc
     WHERE cc.server_id = p_server_id;

    SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'ref', v_rows ->> c.id::text,
               'name', c.name,
               'description', c.description,
               'type', c.type,
               'order', COALESCE(c."order", 0),
               'slowmode_seconds', LEAST(GREATEST(COALESCE(c.slowmode_seconds, 0), 0), 21600),
               'category', v_rows ->> c.category::text,
               'private', EXISTS (SELECT 1 FROM public.channel_permission_overrides o
                                   WHERE o.channel_id = c.id AND o.role_id = v_everyone AND o.user_id IS NULL
                                     AND (COALESCE(o.deny_permissions, 0) & 2) <> 0
                                     AND (COALESCE(o.allow_permissions, 0) & 2) = 0),
               'overrides', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                                        'role', v_rows ->> o.role_id::text,
                                        'allow', (COALESCE(o.allow_permissions, 0) & v_mask)::text,
                                        'deny', (COALESCE(o.deny_permissions, 0) & v_mask)::text)
                                    ORDER BY COALESCE(r.position, 0), r.created_at, r.id), '[]'::jsonb)
                               FROM public.channel_permission_overrides o
                               JOIN public.server_roles r ON r.id = o.role_id AND r.server_id = p_server_id
                              WHERE o.channel_id = c.id AND o.target_type = 'role' AND o.user_id IS NULL))
           ORDER BY (v_order ->> c.id::text)::integer), '[]'::jsonb)
      INTO v_channels
      FROM public.channels c
     WHERE c.server_id = p_server_id AND c.type IN (0, 1);

    SELECT jsonb_build_object(
               'default_role', CASE WHEN ss.default_role_id IS DISTINCT FROM v_admin
                                    THEN v_rows ->> ss.default_role_id::text END,
               'system_channel', CASE WHEN v_types -> ss.system_channel_id::text = '0'::jsonb
                                      THEN v_rows ->> ss.system_channel_id::text END,
               'system_messages_enabled', COALESCE(ss.system_messages_enabled, true),
               'newcomer_alerts', ss.newcomer_alerts,
               'default_message_notifications', COALESCE(ss.default_message_notifications, 'mentions'),
               'invite_permissions', jsonb_build_object(
                   'who_can_create', CASE WHEN ip ->> 'who_can_create' IN ('everyone', 'roles', 'administrators')
                                          THEN ip ->> 'who_can_create' ELSE 'everyone' END,
                   'allowed_roles', (SELECT COALESCE(jsonb_agg(v_rows -> (x #>> '{}')), '[]'::jsonb)
                                       FROM jsonb_array_elements(CASE WHEN jsonb_typeof(ip -> 'allowed_roles') = 'array'
                                                                      THEN ip -> 'allowed_roles' ELSE '[]'::jsonb END) x
                                      WHERE jsonb_typeof(x) = 'string'
                                        AND left(v_rows ->> (x #>> '{}'), 1) = 'r'),
                   'default_expiration', public.server_template_int(ip -> 'default_expiration', '', 1440, 0, 525600, false),
                   'max_expiration', public.server_template_int(ip -> 'max_expiration', '', 0, 0, 525600, false),
                   'allow_temporary', CASE WHEN jsonb_typeof(ip -> 'allow_temporary') = 'boolean'
                                           THEN (ip ->> 'allow_temporary')::boolean ELSE true END,
                   'max_uses_limit', public.server_template_int(ip -> 'max_uses_limit', '', 0, 0, 1000000, false)))
      INTO v_settings
      FROM public.server_settings ss
      CROSS JOIN LATERAL (SELECT CASE WHEN jsonb_typeof(ss.invite_permissions) = 'object'
                                      THEN ss.invite_permissions ELSE '{}'::jsonb END AS ip) i
     WHERE ss.server_id = p_server_id;

    SELECT jsonb_build_object(
               'enabled', w.enabled,
               'message', w.message,
               'rules', w.rules,
               'require_acceptance', w.require_acceptance)
      INTO v_welcome
      FROM public.server_welcome_screens w
     WHERE w.server_id = p_server_id;

    SELECT jsonb_build_object(
               'enabled', st.enabled,
               'alert_channel', CASE WHEN v_types -> st.alert_channel_id::text = '0'::jsonb
                                     THEN v_rows ->> st.alert_channel_id::text END,
               'exempt_bots', st.exempt_bots,
               'raid_settings', st.raid_settings,
               'rules', (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                                    'name', r.name,
                                    'rule_type', r.rule_type,
                                    'enabled', r.enabled,
                                    'config', r.config,
                                    'actions', r.actions,
                                    'exempt_roles', (SELECT COALESCE(jsonb_agg(v_rows -> x::text ORDER BY o), '[]'::jsonb)
                                                       FROM unnest(r.exempt_role_ids) WITH ORDINALITY u(x, o)
                                                      WHERE left(v_rows ->> x::text, 1) = 'r'),
                                    'exempt_channels', (SELECT COALESCE(jsonb_agg(v_rows -> x::text ORDER BY o), '[]'::jsonb)
                                                          FROM unnest(r.exempt_channel_ids) WITH ORDINALITY u(x, o)
                                                         WHERE left(v_rows ->> x::text, 1) = 'c'),
                                    'position', GREATEST(r.position, 0))
                                ORDER BY r.position, r.created_at, r.id), '[]'::jsonb)
                           FROM public.server_automod_rules r
                          WHERE r.server_id = p_server_id))
      INTO v_automod
      FROM public.server_automod_settings st
     WHERE st.server_id = p_server_id;

    RETURN jsonb_build_object(
        'format', 'harmony.server-template',
        'version', 1,
        'exported_at', to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS"Z"'),
        'server', jsonb_build_object(
            'name', v_srv.name,
            'description', v_srv.description,
            'public', COALESCE(v_srv.public, false),
            'allow_cross_server_emojis', COALESCE(v_srv.allow_cross_server_emojis, true),
            'rules', (SELECT COALESCE(jsonb_agg(to_jsonb(left(e #>> '{}', 500)) ORDER BY o), '[]'::jsonb)
                        FROM jsonb_array_elements(CASE WHEN jsonb_typeof(v_srv.rules) = 'array'
                                                       THEN v_srv.rules ELSE '[]'::jsonb END) WITH ORDINALITY a(e, o)
                       WHERE jsonb_typeof(e) = 'string' AND btrim(e #>> '{}') <> ''),
            'category', v_srv.category),
        'roles', v_roles,
        'categories', v_categories,
        'channels', v_channels,
        'settings', v_settings,
        'welcome', v_welcome,
        'automod', v_automod);
END;
$$;

CREATE OR REPLACE FUNCTION public.set_channel_encryption(
    p_channel_id uuid,
    p_messages_encrypted boolean DEFAULT NULL,
    p_voice_encrypted boolean DEFAULT NULL,
    p_history_visibility text DEFAULT NULL
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_caller uuid := public.get_current_profile_id();
    v_server_id uuid;
    v_owner uuid;
    v_is_local boolean;
    v_mode text;
    v_voice_mode text;
    v_row public.channel_encryption_settings;
    v_messages_before boolean;
    v_messages_after boolean;
    v_voice_before boolean;
    v_voice_after boolean;
BEGIN
    IF v_caller IS NULL THEN
        RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
    END IF;

    SELECT c.server_id, s.owner, s.is_local_server
      INTO v_server_id, v_owner, v_is_local
      FROM public.channels c
      JOIN public.servers s ON s.id = c.server_id
     WHERE c.id = p_channel_id;

    IF v_server_id IS NULL THEN
        RAISE EXCEPTION 'Channel not found' USING ERRCODE = 'P0002';
    END IF;

    IF NOT (
        v_owner = v_caller
        OR (
            EXISTS (SELECT 1 FROM public.user_servers us
                     WHERE us.server_id = v_server_id
                       AND us.user_id = v_caller
                       AND us.status = 'accepted')
            AND public.has_permission(v_caller, v_server_id, 'MANAGE_CHANNELS', p_channel_id)
        )
    ) THEN
        RAISE EXCEPTION 'Missing MANAGE_CHANNELS permission for this channel' USING ERRCODE = '42501';
    END IF;

    IF v_is_local IS NOT TRUE THEN
        RAISE EXCEPTION 'Encryption settings apply to channels of local servers only' USING ERRCODE = '22023';
    END IF;

    IF p_history_visibility IS NOT NULL AND p_history_visibility NOT IN ('joined', 'shared') THEN
        RAISE EXCEPTION 'Unknown history visibility: %', p_history_visibility USING ERRCODE = '22023';
    END IF;

    SELECT COALESCE(ses.encryption_mode, 'disabled'), COALESCE(ses.voice_encryption_mode, 'disabled')
      INTO v_mode, v_voice_mode
      FROM (SELECT 1) one
      LEFT JOIN public.server_encryption_settings ses ON ses.server_id = v_server_id;

    IF p_messages_encrypted IS TRUE AND v_mode = 'disabled' THEN
        RAISE EXCEPTION 'End-to-end encryption is disabled for this server' USING ERRCODE = '22023';
    END IF;
    IF p_messages_encrypted IS FALSE AND v_mode IN ('required', 'required_local_only') THEN
        RAISE EXCEPTION 'This server requires end-to-end encryption in every channel' USING ERRCODE = '22023';
    END IF;
    IF p_voice_encrypted IS FALSE AND v_voice_mode = 'required' THEN
        RAISE EXCEPTION 'This server requires end-to-end encrypted voice in every channel' USING ERRCODE = '22023';
    END IF;

    PERFORM public.seed_channel_encryption_settings(ARRAY[p_channel_id]);

    SELECT * INTO v_row
      FROM public.channel_encryption_settings
     WHERE channel_id = p_channel_id
       FOR UPDATE;

    v_messages_before := public.channel_messages_encrypted(p_channel_id);
    v_voice_before := v_voice_mode = 'required' OR v_row.voice_encrypted;

    UPDATE public.channel_encryption_settings
       SET messages_encrypted = COALESCE(p_messages_encrypted, messages_encrypted),
           voice_encrypted = COALESCE(p_voice_encrypted, voice_encrypted),
           history_visibility = COALESCE(p_history_visibility, history_visibility),
           enabled_at = CASE
                          WHEN p_messages_encrypted IS TRUE AND NOT messages_encrypted THEN now()
                          WHEN p_messages_encrypted IS FALSE THEN NULL
                          ELSE enabled_at
                        END,
           enabled_by = CASE
                          WHEN p_messages_encrypted IS TRUE AND NOT messages_encrypted THEN v_caller
                          WHEN p_messages_encrypted IS FALSE THEN NULL
                          ELSE enabled_by
                        END,
           updated_at = now()
     WHERE channel_id = p_channel_id
    RETURNING * INTO v_row;

    v_messages_after := public.channel_messages_encrypted(p_channel_id);
    v_voice_after := v_voice_mode = 'required' OR v_row.voice_encrypted;

    IF v_messages_after AND NOT v_messages_before THEN
        PERFORM public.bump_room_epoch(p_channel_id::text, 'encryption_enabled');
    END IF;

    IF v_messages_after IS DISTINCT FROM v_messages_before THEN
        INSERT INTO public.messages (channel_id, content, is_system, metadata)
        VALUES (
            p_channel_id,
            jsonb_build_array(jsonb_build_object(
                'type', 'text',
                'text', CASE WHEN v_messages_after THEN 'turned on end-to-end encryption'
                             ELSE 'turned off end-to-end encryption' END)),
            true,
            jsonb_build_object('type', CASE WHEN v_messages_after THEN 'channel_encryption_enabled'
                                            ELSE 'channel_encryption_disabled' END,
                               'actor_id', v_caller)
        );
    END IF;

    IF v_voice_after IS DISTINCT FROM v_voice_before THEN
        INSERT INTO public.messages (channel_id, content, is_system, metadata)
        VALUES (
            p_channel_id,
            jsonb_build_array(jsonb_build_object(
                'type', 'text',
                'text', CASE WHEN v_voice_after THEN 'turned on end-to-end encryption for voice and video'
                             ELSE 'turned off end-to-end encryption for voice and video' END)),
            true,
            jsonb_build_object('type', CASE WHEN v_voice_after THEN 'channel_voice_encryption_enabled'
                                            ELSE 'channel_voice_encryption_disabled' END,
                               'actor_id', v_caller)
        );
    END IF;

    RETURN public.effective_channel_encryption(p_channel_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.guard_user_server_client_write()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
DECLARE
    v_caller uuid;
BEGIN
    IF current_user NOT IN ('authenticated', 'anon') OR pg_trigger_depth() > 1 THEN
        RETURN NEW;
    END IF;
    IF NEW.user_id IS DISTINCT FROM OLD.user_id OR NEW.server_id IS DISTINCT FROM OLD.server_id
       OR NEW.member_instance IS DISTINCT FROM OLD.member_instance
       OR NEW.temporary IS DISTINCT FROM OLD.temporary THEN
        RAISE EXCEPTION 'membership identity, instance and temporary flag are fixed'
            USING ERRCODE = '42501';
    END IF;
    IF NEW.status IS DISTINCT FROM OLD.status THEN
        v_caller := public.get_current_profile_id();
        IF OLD.user_id = v_caller
           AND NOT EXISTS (SELECT 1 FROM public.servers s WHERE s.id = OLD.server_id AND s.owner = v_caller) THEN
            RAISE EXCEPTION 'a member cannot change their own membership status'
                USING ERRCODE = '42501';
        END IF;
    END IF;
    RETURN NEW;
END;
$$;


CREATE OR REPLACE FUNCTION public.import_remote_emoji(
    p_remote_emoji_id uuid,
    p_new_name text DEFAULT NULL::text,
    p_server_id uuid DEFAULT NULL::uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_remote remote_emojis_cache%ROWTYPE;
  v_new_id uuid;
  v_name text;
BEGIN
  IF current_setting('role', true) IN ('anon', 'authenticated') THEN
    IF p_server_id IS NULL THEN
      IF NOT public.is_current_user_admin() THEN
        RAISE EXCEPTION 'Instance admins import instance emojis' USING ERRCODE = '42501';
      END IF;
    ELSIF NOT EXISTS (
        SELECT 1 FROM public.servers s
         WHERE s.id = p_server_id AND s.owner = public.get_current_profile_id()
           AND s.is_local_server IS NOT FALSE) THEN
      RAISE EXCEPTION 'Only the server owner imports emojis into a server' USING ERRCODE = '42501';
    END IF;
  END IF;

  SELECT * INTO v_remote FROM public.remote_emojis_cache WHERE id = p_remote_emoji_id;

  IF v_remote.id IS NULL THEN
    RAISE EXCEPTION 'Remote emoji not found';
  END IF;

  IF v_remote.imported_as IS NOT NULL THEN
    RAISE EXCEPTION 'Emoji already imported';
  END IF;

  v_name := COALESCE(p_new_name, v_remote.shortcode);

  -- domain IS NULL is a local emoji.
  IF EXISTS (SELECT 1 FROM public.emojis WHERE name = v_name AND domain IS NULL) THEN
    RAISE EXCEPTION 'Emoji name already exists locally: %', v_name;
  END IF;

  INSERT INTO public.emojis (name, url, server_id, scope, domain)
  VALUES (v_name, v_remote.url, p_server_id,
          CASE WHEN p_server_id IS NULL THEN 'instance' ELSE 'server' END, NULL)
  RETURNING id INTO v_new_id;

  UPDATE public.remote_emojis_cache
     SET imported_as = v_new_id, imported_at = now()
   WHERE id = p_remote_emoji_id;

  RETURN v_new_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.voice_activity_may_end(p_row public.voice_activities, p_profile uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT p_row.host_id = p_profile
        OR public.has_permission(p_profile, p_row.server_id, 'MOVE_MEMBERS', p_row.channel_id)
        OR NOT EXISTS (SELECT 1 FROM public.voice_channel_participants vp
                        WHERE vp.channel_id = p_row.channel_id AND vp.user_id = p_row.host_id);
$$;

-- Baseline "user_servers_update_own_or_owner" without its instance-admin arm; the owner arm is the
-- owner of a server hosted here.
DROP POLICY IF EXISTS "user_servers_update_own_or_owner" ON public.user_servers;
CREATE POLICY "user_servers_update_own_or_owner" ON public.user_servers
    FOR UPDATE TO authenticated
    USING (
        user_id = ( SELECT public.get_current_profile_id() )
        OR EXISTS (
            SELECT 1 FROM public.servers
            WHERE servers.id = user_servers.server_id
            AND servers.is_local_server IS NOT FALSE
            AND owner = ( SELECT public.get_current_profile_id() )
        )
    );

COMMIT;
