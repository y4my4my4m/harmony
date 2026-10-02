-- Instance welcome server, and per-server welcome screens with rules.
--
-- Instance. instance_config 'welcome_server_id' is a server id as a JSON string, or JSON null.
-- set_welcome_server(server) writes it: instance admins only, a public local server or null.
-- The key is one of public_instance_config_keys(). get_onboarding_servers() answers what to
-- suggest to the caller: the welcome server while it exists, is local and is public; when the
-- key is unset or names anything else, up to three featured public local servers. Servers the
-- caller holds a membership row of, or is banned from, are left out, so a member of the
-- welcome server gets nothing rather than the featured fallback.
--
-- Server. server_welcome_screens holds one row per configured server: enabled, message (plain
-- text or the client markdown subset, 2000 characters), rules (20 of {title: 100 characters,
-- description: 500}), require_acceptance. enabled_at and acceptance_required_at take now()
-- whenever their flag turns on and are null while it is off. set_server_welcome() writes the
-- row (MANAGE_SERVER on a local server) and copies the rule titles into servers.rules, which
-- the invite flow and federated invites read. Once a server has a row, a client UPDATE of
-- servers.rules keeps the old value. Without a row, the screen's rules are servers.rules.
--
-- Members. user_servers.welcome_seen_at and rules_accepted_at are the member's own
-- acknowledgements. Clients cannot write them: an INSERT clears them and an UPDATE that
-- changes them raises 42501. mark_server_welcome_seen(server) and accept_server_rules(server)
-- write the caller's accepted membership. Each write is an UPDATE of user_servers and so
-- records a membership 'update' event (route_server_membership).
--
-- Enforcement. With require_acceptance, a client INSERT of a channel or thread message raises
-- RULES_NOT_ACCEPTED:<server id> when the author's accepted membership began at or after
-- acceptance_required_at and has no rules_accepted_at. Members who joined earlier are
-- grandfathered. Exempt: the owner and ADMINISTRATOR or MANAGE_SERVER holders. Writers other
-- than clients are not checked: bot-gateway and federation-backend (service_role) and definer
-- functions writing system rows. Remote members post through federation and never see the
-- screen, which is served by the server's home instance only. "Client" is the role that
-- executed the statement, as in 20261005600001_message_path_security.sql.

BEGIN;

SET LOCAL lock_timeout = '3s';

-- ---------------------------------------------------------------------------
-- Tables and columns
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.server_welcome_screens (
    server_id uuid PRIMARY KEY REFERENCES public.servers(id) ON DELETE CASCADE,
    enabled boolean NOT NULL DEFAULT false,
    message text NOT NULL DEFAULT '',
    rules jsonb NOT NULL DEFAULT '[]'::jsonb,
    require_acceptance boolean NOT NULL DEFAULT false,
    enabled_at timestamptz,
    acceptance_required_at timestamptz,
    updated_at timestamptz NOT NULL DEFAULT now(),
    updated_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
    CONSTRAINT server_welcome_screens_message_length CHECK (char_length(message) <= 2000),
    CONSTRAINT server_welcome_screens_rules_shape
        CHECK (jsonb_typeof(rules) = 'array' AND jsonb_array_length(rules) <= 20),
    CONSTRAINT server_welcome_screens_enabled_at CHECK (NOT enabled OR enabled_at IS NOT NULL),
    CONSTRAINT server_welcome_screens_acceptance_at
        CHECK (NOT require_acceptance OR acceptance_required_at IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_server_welcome_screens_updated_by
    ON public.server_welcome_screens (updated_by) WHERE updated_by IS NOT NULL;

ALTER TABLE public.server_welcome_screens ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS server_welcome_screens_service_role ON public.server_welcome_screens;
CREATE POLICY server_welcome_screens_service_role ON public.server_welcome_screens
    AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);

-- Clients reach the table through the functions below. Default privileges grant anon and
-- authenticated ALL on new tables.
REVOKE ALL ON public.server_welcome_screens FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.server_welcome_screens TO service_role;

ALTER TABLE public.user_servers ADD COLUMN IF NOT EXISTS welcome_seen_at timestamptz;
ALTER TABLE public.user_servers ADD COLUMN IF NOT EXISTS rules_accepted_at timestamptz;

-- ---------------------------------------------------------------------------
-- Instance welcome server
-- ---------------------------------------------------------------------------

-- The key is appended to whatever list the instance carries.
DO $do$
DECLARE
    v_keys text[] := public.public_instance_config_keys();
BEGIN
    IF NOT ('welcome_server_id' = ANY (v_keys)) THEN
        EXECUTE format(
            'CREATE OR REPLACE FUNCTION public.public_instance_config_keys() RETURNS text[] '
            'LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS %L',
            format('SELECT %L::text[]', v_keys || 'welcome_server_id'::text));
    END IF;
END;
$do$;

CREATE OR REPLACE FUNCTION public.set_welcome_server(p_server_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_me uuid := public.get_current_profile_id();
BEGIN
    IF v_me IS NULL OR NOT public.is_current_user_admin() THEN
        RAISE EXCEPTION 'Admin role required' USING ERRCODE = '42501';
    END IF;
    IF p_server_id IS NOT NULL AND NOT EXISTS (
            SELECT 1 FROM public.servers s
             WHERE s.id = p_server_id AND s.public IS TRUE AND s.is_local_server IS NOT FALSE) THEN
        RAISE EXCEPTION 'WELCOME_SERVER_INVALID: the welcome server is a public server on this instance'
            USING ERRCODE = '22023';
    END IF;

    INSERT INTO public.instance_config (config_key, config_value, description, updated_at, updated_by)
    VALUES ('welcome_server_id', COALESCE(to_jsonb(p_server_id::text), 'null'::jsonb),
            'Server suggested to new users. Null suggests featured servers.', now(), v_me)
    ON CONFLICT (config_key) DO UPDATE
       SET config_value = EXCLUDED.config_value, updated_at = now(), updated_by = EXCLUDED.updated_by;

    PERFORM public.log_admin_action(v_me, 'set_welcome_server', 'instance_config', 'welcome_server_id',
                                    jsonb_build_object('server_id', p_server_id), NULL, NULL);
    RETURN jsonb_build_object('welcome_server_id', p_server_id);
END;
$$;

-- source: welcome, featured or none. member_count counts accepted memberships.
CREATE OR REPLACE FUNCTION public.get_onboarding_servers()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_me uuid := public.get_current_profile_id();
    v_raw text;
    v_welcome uuid;
    v_ids uuid[];
    v_source text := 'none';
BEGIN
    SELECT c.config_value #>> '{}' INTO v_raw
      FROM public.instance_config c
     WHERE c.config_key = 'welcome_server_id';

    IF v_raw ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        SELECT s.id INTO v_welcome
          FROM public.servers s
         WHERE s.id = v_raw::uuid AND s.public IS TRUE AND s.is_local_server IS NOT FALSE;
    END IF;

    IF v_welcome IS NOT NULL THEN
        v_source := 'welcome';
        IF v_me IS NULL OR NOT (
                EXISTS (SELECT 1 FROM public.user_servers us
                         WHERE us.server_id = v_welcome AND us.user_id = v_me)
                OR EXISTS (SELECT 1 FROM public.server_bans b
                            WHERE b.server_id = v_welcome AND b.user_id = v_me)) THEN
            v_ids := ARRAY[v_welcome];
        END IF;
    ELSE
        SELECT array_agg(f.id ORDER BY f.ord) INTO v_ids
          FROM (SELECT s.id,
                       row_number() OVER (ORDER BY s.featured_order NULLS LAST, s.created_at) AS ord
                  FROM public.servers s
                 WHERE s.is_featured IS TRUE AND s.public IS TRUE AND s.is_local_server IS NOT FALSE
                   AND (v_me IS NULL OR (
                        NOT EXISTS (SELECT 1 FROM public.user_servers us
                                     WHERE us.server_id = s.id AND us.user_id = v_me)
                        AND NOT EXISTS (SELECT 1 FROM public.server_bans b
                                         WHERE b.server_id = s.id AND b.user_id = v_me)))
                 ORDER BY s.featured_order NULLS LAST, s.created_at
                 LIMIT 3) f;
        IF v_ids IS NOT NULL THEN
            v_source := 'featured';
        END IF;
    END IF;

    RETURN jsonb_build_object(
        'source', v_source,
        'servers', COALESCE((
            SELECT jsonb_agg(jsonb_build_object(
                       'id', s.id,
                       'name', s.name,
                       'description', s.description,
                       'icon', s.icon,
                       'banner', s.banner,
                       'member_count', (SELECT count(*) FROM public.user_servers us
                                         WHERE us.server_id = s.id AND us.status = 'accepted'))
                   ORDER BY o.ord)
              FROM unnest(v_ids) WITH ORDINALITY AS o(id, ord)
              JOIN public.servers s ON s.id = o.id), '[]'::jsonb));
END;
$$;

-- ---------------------------------------------------------------------------
-- Server welcome screen
-- ---------------------------------------------------------------------------

-- Members and managers only. message is empty for members while the screen is disabled.
CREATE OR REPLACE FUNCTION public.get_server_welcome(p_server_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_me uuid := public.get_current_profile_id();
    v_srv public.servers%ROWTYPE;
    v_scr public.server_welcome_screens%ROWTYPE;
    v_has_screen boolean;
    v_is_member boolean;
    v_joined timestamptz;
    v_seen timestamptz;
    v_accepted timestamptz;
    v_manager boolean;
    v_enabled boolean;
    v_require boolean;
    v_must_accept boolean;
    v_rules jsonb;
BEGIN
    IF v_me IS NULL THEN
        RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
    END IF;

    SELECT * INTO v_srv FROM public.servers s WHERE s.id = p_server_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'SERVER_NOT_FOUND: no such server' USING ERRCODE = 'P0002';
    END IF;

    SELECT us.created_at, us.welcome_seen_at, us.rules_accepted_at
      INTO v_joined, v_seen, v_accepted
      FROM public.user_servers us
     WHERE us.server_id = p_server_id AND us.user_id = v_me AND us.status = 'accepted';
    v_is_member := FOUND;

    -- has_permission grants the owner every permission.
    v_manager := v_srv.owner = v_me
                 OR (v_is_member AND public.has_permission(v_me, p_server_id, 'MANAGE_SERVER'));
    IF NOT v_is_member AND NOT v_manager THEN
        RAISE EXCEPTION 'Not a member of this server' USING ERRCODE = '42501';
    END IF;

    SELECT * INTO v_scr FROM public.server_welcome_screens w WHERE w.server_id = p_server_id;
    v_has_screen := FOUND;
    v_enabled := v_has_screen AND v_scr.enabled;
    v_require := v_has_screen AND v_scr.require_acceptance;

    IF v_has_screen THEN
        v_rules := v_scr.rules;
    ELSE
        SELECT COALESCE(jsonb_agg(jsonb_build_object('title', e.value #>> '{}', 'description', '')
                                  ORDER BY e.ordinality), '[]'::jsonb)
          INTO v_rules
          FROM jsonb_array_elements(COALESCE(v_srv.rules, '[]'::jsonb)) WITH ORDINALITY AS e(value, ordinality)
         WHERE jsonb_typeof(e.value) = 'string' AND btrim(e.value #>> '{}') <> '';
    END IF;

    v_must_accept := v_is_member AND v_require AND v_accepted IS NULL
                     AND v_joined >= v_scr.acceptance_required_at AND NOT v_manager;

    RETURN jsonb_build_object(
        'server_id', v_srv.id,
        'name', v_srv.name,
        'description', v_srv.description,
        'icon', v_srv.icon,
        'banner', v_srv.banner,
        'is_local', v_srv.is_local_server IS NOT FALSE,
        'configured', v_has_screen,
        'enabled', v_enabled,
        'message', CASE WHEN v_enabled OR v_manager THEN COALESCE(v_scr.message, '') ELSE '' END,
        'rules', v_rules,
        'require_acceptance', v_require,
        'can_manage', v_manager,
        'is_member', v_is_member,
        'joined_at', v_joined,
        'welcome_seen_at', v_seen,
        'rules_accepted_at', v_accepted,
        'must_accept', v_must_accept,
        'should_show', v_is_member AND v_seen IS NULL AND v_srv.owner IS DISTINCT FROM v_me
                       AND (v_must_accept OR (v_enabled AND v_joined >= v_scr.enabled_at)));
END;
$$;

-- p_rules: array of {title, description} objects or plain strings (title only).
CREATE OR REPLACE FUNCTION public.set_server_welcome(
    p_server_id uuid,
    p_enabled boolean,
    p_message text,
    p_rules jsonb,
    p_require_acceptance boolean)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_me uuid := public.get_current_profile_id();
    v_enabled boolean := COALESCE(p_enabled, false);
    v_require boolean := COALESCE(p_require_acceptance, false);
    v_message text := btrim(COALESCE(p_message, ''));
    v_input jsonb := COALESCE(p_rules, '[]'::jsonb);
    v_rules jsonb := '[]'::jsonb;
    v_rule jsonb;
    v_title text;
    v_desc text;
    v_titles jsonb;
BEGIN
    IF v_me IS NULL THEN
        RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.servers s
                    WHERE s.id = p_server_id AND s.is_local_server IS NOT FALSE) THEN
        RAISE EXCEPTION 'The welcome screen is configured on the server''s home instance'
            USING ERRCODE = '42501';
    END IF;
    IF NOT public.has_permission(v_me, p_server_id, 'MANAGE_SERVER') THEN
        RAISE EXCEPTION 'Missing permission: MANAGE_SERVER' USING ERRCODE = '42501';
    END IF;

    IF char_length(v_message) > 2000 THEN
        RAISE EXCEPTION 'WELCOME_INVALID: the message is limited to 2000 characters' USING ERRCODE = '22023';
    END IF;
    IF jsonb_typeof(v_input) <> 'array' THEN
        RAISE EXCEPTION 'WELCOME_INVALID: rules is an array' USING ERRCODE = '22023';
    END IF;
    IF jsonb_array_length(v_input) > 20 THEN
        RAISE EXCEPTION 'WELCOME_INVALID: at most 20 rules' USING ERRCODE = '22023';
    END IF;

    FOR v_rule IN SELECT e FROM jsonb_array_elements(v_input) AS e LOOP
        IF jsonb_typeof(v_rule) = 'string' THEN
            v_title := btrim(v_rule #>> '{}');
            v_desc := '';
        ELSIF jsonb_typeof(v_rule) = 'object' THEN
            v_title := btrim(COALESCE(v_rule ->> 'title', ''));
            v_desc := btrim(COALESCE(v_rule ->> 'description', ''));
        ELSE
            RAISE EXCEPTION 'WELCOME_INVALID: a rule is an object with a title' USING ERRCODE = '22023';
        END IF;
        IF v_title = '' THEN
            RAISE EXCEPTION 'WELCOME_INVALID: every rule has a title' USING ERRCODE = '22023';
        END IF;
        IF char_length(v_title) > 100 OR char_length(v_desc) > 500 THEN
            RAISE EXCEPTION 'WELCOME_INVALID: rule titles are limited to 100 characters, descriptions to 500'
                USING ERRCODE = '22023';
        END IF;
        v_rules := v_rules || jsonb_build_array(jsonb_build_object('title', v_title, 'description', v_desc));
    END LOOP;

    IF v_require AND jsonb_array_length(v_rules) = 0 THEN
        RAISE EXCEPTION 'WELCOME_INVALID: requiring acceptance needs at least one rule' USING ERRCODE = '22023';
    END IF;

    INSERT INTO public.server_welcome_screens AS w
           (server_id, enabled, message, rules, require_acceptance,
            enabled_at, acceptance_required_at, updated_at, updated_by)
    VALUES (p_server_id, v_enabled, v_message, v_rules, v_require,
            CASE WHEN v_enabled THEN now() END, CASE WHEN v_require THEN now() END, now(), v_me)
    ON CONFLICT (server_id) DO UPDATE
       SET enabled = EXCLUDED.enabled,
           message = EXCLUDED.message,
           rules = EXCLUDED.rules,
           require_acceptance = EXCLUDED.require_acceptance,
           enabled_at = CASE WHEN NOT EXCLUDED.enabled THEN NULL
                             WHEN w.enabled THEN COALESCE(w.enabled_at, now())
                             ELSE now() END,
           acceptance_required_at = CASE WHEN NOT EXCLUDED.require_acceptance THEN NULL
                                         WHEN w.require_acceptance THEN COALESCE(w.acceptance_required_at, now())
                                         ELSE now() END,
           updated_at = now(),
           updated_by = EXCLUDED.updated_by;

    SELECT COALESCE(jsonb_agg(r.value -> 'title' ORDER BY r.ordinality), '[]'::jsonb) INTO v_titles
      FROM jsonb_array_elements(v_rules) WITH ORDINALITY AS r(value, ordinality);
    UPDATE public.servers s SET rules = v_titles
     WHERE s.id = p_server_id AND s.rules IS DISTINCT FROM v_titles;

    RETURN public.get_server_welcome(p_server_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.mark_server_welcome_seen(p_server_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_me uuid := public.get_current_profile_id();
BEGIN
    IF v_me IS NULL THEN
        RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.user_servers us
                    WHERE us.server_id = p_server_id AND us.user_id = v_me AND us.status = 'accepted') THEN
        RAISE EXCEPTION 'Not a member of this server' USING ERRCODE = '42501';
    END IF;

    UPDATE public.user_servers us SET welcome_seen_at = now()
     WHERE us.server_id = p_server_id AND us.user_id = v_me AND us.welcome_seen_at IS NULL;

    RETURN public.get_server_welcome(p_server_id);
END;
$$;

CREATE OR REPLACE FUNCTION public.accept_server_rules(p_server_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_me uuid := public.get_current_profile_id();
BEGIN
    IF v_me IS NULL THEN
        RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.user_servers us
                    WHERE us.server_id = p_server_id AND us.user_id = v_me AND us.status = 'accepted') THEN
        RAISE EXCEPTION 'Not a member of this server' USING ERRCODE = '42501';
    END IF;

    UPDATE public.user_servers us
       SET rules_accepted_at = COALESCE(us.rules_accepted_at, now()),
           welcome_seen_at = COALESCE(us.welcome_seen_at, now())
     WHERE us.server_id = p_server_id AND us.user_id = v_me
       AND (us.rules_accepted_at IS NULL OR us.welcome_seen_at IS NULL);

    RETURN public.get_server_welcome(p_server_id);
END;
$$;

-- ---------------------------------------------------------------------------
-- Guards
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.guard_user_server_welcome_columns()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    IF current_user NOT IN ('authenticated', 'anon') OR pg_trigger_depth() > 1 THEN
        RETURN NEW;
    END IF;
    IF TG_OP = 'INSERT' THEN
        NEW.welcome_seen_at := NULL;
        NEW.rules_accepted_at := NULL;
    ELSIF NEW.welcome_seen_at IS DISTINCT FROM OLD.welcome_seen_at
          OR NEW.rules_accepted_at IS DISTINCT FROM OLD.rules_accepted_at THEN
        RAISE EXCEPTION 'welcome_seen_at and rules_accepted_at are written by mark_server_welcome_seen and accept_server_rules'
            USING ERRCODE = '42501';
    END IF;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS a_user_servers_welcome_guard ON public.user_servers;
CREATE TRIGGER a_user_servers_welcome_guard
    BEFORE INSERT OR UPDATE ON public.user_servers
    FOR EACH ROW EXECUTE FUNCTION public.guard_user_server_welcome_columns();

CREATE OR REPLACE FUNCTION public.keep_welcome_managed_server_rules()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF pg_trigger_depth() = 1
       AND EXISTS (SELECT 1 FROM public.server_welcome_screens w WHERE w.server_id = OLD.id) THEN
        NEW.rules := OLD.rules;
    END IF;
    RETURN NEW;
END;
$$;

-- ServerSettings saves the whole fetched row; a stale rules value is ignored, not refused.
DROP TRIGGER IF EXISTS a_servers_welcome_rules_guard ON public.servers;
CREATE TRIGGER a_servers_welcome_rules_guard
    BEFORE UPDATE OF rules ON public.servers
    FOR EACH ROW
    WHEN (current_user IN ('authenticated', 'anon') AND NEW.rules IS DISTINCT FROM OLD.rules)
    EXECUTE FUNCTION public.keep_welcome_managed_server_rules();

-- ---------------------------------------------------------------------------
-- Enforcement
-- ---------------------------------------------------------------------------

-- Common case: one channels row joined to no server_welcome_screens row.
CREATE OR REPLACE FUNCTION public.enforce_server_rules_acceptance()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_channel uuid := NEW.channel_id;
    v_server uuid;
    v_since timestamptz;
    v_joined timestamptz;
    v_accepted timestamptz;
BEGIN
    IF v_channel IS NULL THEN
        IF NEW.thread_id IS NULL THEN
            RETURN NEW;
        END IF;
        SELECT t.channel_id INTO v_channel FROM public.threads t WHERE t.id = NEW.thread_id;
    END IF;

    SELECT w.server_id, w.acceptance_required_at INTO v_server, v_since
      FROM public.channels c
      JOIN public.server_welcome_screens w ON w.server_id = c.server_id
     WHERE c.id = v_channel AND w.require_acceptance;
    IF v_server IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT us.created_at, us.rules_accepted_at INTO v_joined, v_accepted
      FROM public.user_servers us
     WHERE us.server_id = v_server AND us.user_id = NEW.user_id AND us.status = 'accepted';
    IF NOT FOUND OR v_accepted IS NOT NULL OR v_joined < v_since
       OR public.has_permission(NEW.user_id, v_server, 'MANAGE_SERVER') THEN
        RETURN NEW;
    END IF;

    RAISE EXCEPTION 'RULES_NOT_ACCEPTED:%', v_server
        USING ERRCODE = 'P0001',
              HINT = 'Accept the server rules to send messages in this server.';
END;
$$;

-- Fires after a_messages_client_write_guard and a_messages_reply_scope, before AutoMod.
DROP TRIGGER IF EXISTS a_messages_rules_acceptance ON public.messages;
CREATE TRIGGER a_messages_rules_acceptance
    BEFORE INSERT ON public.messages
    FOR EACH ROW
    WHEN (current_user IN ('authenticated', 'anon')
          AND NEW.user_id IS NOT NULL
          AND NEW.conversation_id IS NULL
          AND NEW.is_system IS NOT TRUE)
    EXECUTE FUNCTION public.enforce_server_rules_acceptance();

-- ---------------------------------------------------------------------------
-- Privileges
-- ---------------------------------------------------------------------------

DO $$
DECLARE
    fn regprocedure;
    grantee text;
BEGIN
    FOR fn IN
        SELECT p.oid::regprocedure FROM pg_proc p
         WHERE p.pronamespace = 'public'::regnamespace
           AND p.proname IN ('guard_user_server_welcome_columns', 'keep_welcome_managed_server_rules',
                             'enforce_server_rules_acceptance')
    LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn);
        FOREACH grantee IN ARRAY ARRAY['postgres', 'supabase_admin', 'service_role'] LOOP
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = grantee) THEN
                EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I', fn, grantee);
            END IF;
        END LOOP;
    END LOOP;

    -- Each checks the caller itself.
    FOR fn IN
        SELECT p.oid::regprocedure FROM pg_proc p
         WHERE p.pronamespace = 'public'::regnamespace
           AND p.proname IN ('set_welcome_server', 'get_onboarding_servers', 'get_server_welcome',
                             'set_server_welcome', 'mark_server_welcome_seen', 'accept_server_rules')
    LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn);
        FOREACH grantee IN ARRAY ARRAY['authenticated', 'postgres', 'supabase_admin', 'service_role'] LOOP
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = grantee) THEN
                EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I', fn, grantee);
            END IF;
        END LOOP;
    END LOOP;
END;
$$;

GRANT EXECUTE ON FUNCTION public.get_onboarding_servers() TO anon;

COMMIT;

NOTIFY pgrst, 'reload schema';
