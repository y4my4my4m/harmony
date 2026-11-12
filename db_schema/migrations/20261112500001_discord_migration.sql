-- Migrate from Discord: a Discord server's members claim their Harmony accounts, and their Discord
-- roles, profiles and standing sync to Harmony while the migration is open.
--
-- This file holds the schema and the configuration RPCs. Claims, sync and readiness append to it.
--
-- discord_migrations      one row per server. state is draft, open or finished. link_token (48 hex)
--                         is the public part of the invitation link members open; regenerating it
--                         ends old links. credential_source picks where the Discord application and
--                         bot token come from: instance_bot (the instance's application), bridge
--                         (the server's hosted bridge bot, plus its own OAuth client) or own.
-- discord_migration_secrets  client id and Vault ids of the OAuth client secret and bot token for
--                         the own and bridge sources. service_role only. Deleting the row deletes
--                         the Vault secrets.
-- discord_migration_discord_roles  the gateway's snapshot of the guild's roles. harmony_permissions
--                         is the Discord role's permissions translated to Harmony bits (ADMINISTRATOR
--                         included). Managed roles and @everyone are never stored.
-- discord_migration_role_map  Discord role to Harmony role.
-- discord_migration_links member to Discord account. sync_fields names the profile fields the member
--                         lets the migration copy; discord_role_ids are the roles last seen.
-- discord_migration_claims, discord_migration_link_states  short-lived rows of the claim flow.
--                         service_role only.
--
-- Instance configuration
--   discord_migration_account_creation  boolean, default true, public: Discord members without a
--                                       Harmony account may create one while claiming.
--
-- Clients reach the tables only through the RPCs, which are gated by can_manage_discord_bridge
-- (owner or MANAGE_SERVER). Errors: 42501 caller lacks MANAGE_SERVER or authentication; P0002 server
-- or migration absent; 22023 invalid argument; 23514 check violation; 55000 guild_locked (only a
-- draft can change its guild) and state changes the current state does not allow; 0A000 Vault absent;
-- P0001 MIGRATION_CREDENTIALS_MISSING, MIGRATION_NOT_READY, ADMIN_ROLE_NEEDS_CONFIRM; 42501 also
-- ADMIN_ROLE_OWNER_ONLY.
BEGIN;

SET LOCAL lock_timeout = '3s';

-- ---------------------------------------------------------------------------
-- Tables
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS public.discord_migrations (
    server_id uuid PRIMARY KEY REFERENCES public.servers(id) ON DELETE CASCADE,
    discord_guild_id text,
    credential_source text,
    state text NOT NULL DEFAULT 'draft',
    link_token text NOT NULL DEFAULT encode(extensions.gen_random_bytes(24), 'hex'),
    opened_at timestamptz,
    finished_at timestamptz,
    last_sync_at timestamptz,
    last_sync_result jsonb,
    sync_requested_at timestamptz,
    sync_cursor timestamptz,
    sync_paused_reason text,
    removal_brake_pct integer NOT NULL DEFAULT 10,
    bot_can_ban boolean,
    readiness_warnings jsonb,
    created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT discord_migrations_guild_check
        CHECK (discord_guild_id IS NULL OR discord_guild_id ~ '^[0-9]{1,20}$'),
    CONSTRAINT discord_migrations_source_check
        CHECK (credential_source IS NULL OR credential_source IN ('instance_bot', 'bridge', 'own')),
    CONSTRAINT discord_migrations_state_check CHECK (state IN ('draft', 'open', 'finished')),
    CONSTRAINT discord_migrations_brake_check CHECK (removal_brake_pct BETWEEN 1 AND 100),
    CONSTRAINT discord_migrations_token_key UNIQUE (link_token)
);

-- Set when a manager resumes a removal_brake pause: the one pass after it applies those removals without
-- the brake. apply_removals and a completed record_sync spend it; a new pause resets it.
ALTER TABLE public.discord_migrations ADD COLUMN IF NOT EXISTS brake_override boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS public.discord_migration_secrets (
    server_id uuid PRIMARY KEY REFERENCES public.discord_migrations(server_id) ON DELETE CASCADE,
    client_id text,
    client_secret_secret uuid,
    bot_token_secret uuid,
    updated_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT discord_migration_secrets_client_check
        CHECK (client_id IS NULL OR client_id ~ '^[0-9]{1,20}$')
);

CREATE TABLE IF NOT EXISTS public.discord_migration_discord_roles (
    server_id uuid NOT NULL REFERENCES public.discord_migrations(server_id) ON DELETE CASCADE,
    discord_role_id text NOT NULL,
    name text NOT NULL,
    color integer NOT NULL DEFAULT 0,
    position integer NOT NULL DEFAULT 0,
    harmony_permissions bigint NOT NULL DEFAULT 0,
    fetched_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (server_id, discord_role_id),
    CONSTRAINT discord_migration_discord_roles_id_check CHECK (discord_role_id ~ '^[0-9]{1,20}$'),
    CONSTRAINT discord_migration_discord_roles_name_check CHECK (char_length(name) <= 100)
);

CREATE TABLE IF NOT EXISTS public.discord_migration_role_map (
    server_id uuid NOT NULL REFERENCES public.discord_migrations(server_id) ON DELETE CASCADE,
    discord_role_id text NOT NULL,
    harmony_role_id uuid NOT NULL REFERENCES public.server_roles(id) ON DELETE CASCADE,
    PRIMARY KEY (server_id, discord_role_id),
    CONSTRAINT discord_migration_role_map_id_check CHECK (discord_role_id ~ '^[0-9]{1,20}$')
);

CREATE INDEX IF NOT EXISTS discord_migration_role_map_harmony_idx
    ON public.discord_migration_role_map (harmony_role_id);

CREATE TABLE IF NOT EXISTS public.discord_migration_links (
    server_id uuid NOT NULL REFERENCES public.discord_migrations(server_id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    discord_user_id text NOT NULL,
    status text NOT NULL DEFAULT 'active',
    sync_fields text[] NOT NULL DEFAULT '{}',
    discord_role_ids text[] NOT NULL DEFAULT '{}',
    applied_roles jsonb NOT NULL DEFAULT '{}',   -- {discord role id: Harmony role id} last granted; a remap takes the old role back
    discord_joined_at timestamptz,
    linked_at timestamptz NOT NULL DEFAULT now(),
    last_synced_at timestamptz,
    PRIMARY KEY (server_id, user_id),
    CONSTRAINT discord_migration_links_discord_user_key UNIQUE (server_id, discord_user_id),
    CONSTRAINT discord_migration_links_discord_user_check CHECK (discord_user_id ~ '^[0-9]{1,20}$'),
    CONSTRAINT discord_migration_links_status_check
        CHECK (status IN ('active', 'left', 'banned', 'kicked_on_harmony')),
    CONSTRAINT discord_migration_links_sync_fields_check
        CHECK (sync_fields <@ ARRAY['avatar', 'display_name', 'banner', 'accent_color',
                                    'server_nickname', 'server_avatar', 'server_banner']::text[])
);

CREATE TABLE IF NOT EXISTS public.discord_migration_claims (
    ticket text PRIMARY KEY,
    server_id uuid NOT NULL REFERENCES public.discord_migrations(server_id) ON DELETE CASCADE,
    discord_user_id text NOT NULL,
    discord_username text,
    discord_global_name text,
    discord_avatar_url text,
    discord_role_ids text[] NOT NULL DEFAULT '{}',
    discord_joined_at timestamptz,
    auth_user_id uuid,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    CONSTRAINT discord_migration_claims_ticket_check CHECK (ticket ~ '^[0-9a-f]{64}$'),
    CONSTRAINT discord_migration_claims_discord_user_check CHECK (discord_user_id ~ '^[0-9]{1,20}$')
);

CREATE INDEX IF NOT EXISTS discord_migration_claims_server_idx ON public.discord_migration_claims (server_id);
CREATE INDEX IF NOT EXISTS discord_migration_claims_expires_idx ON public.discord_migration_claims (expires_at);

CREATE TABLE IF NOT EXISTS public.discord_migration_link_states (
    state text PRIMARY KEY,
    server_id uuid NOT NULL REFERENCES public.discord_migrations(server_id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    expires_at timestamptz NOT NULL,
    CONSTRAINT discord_migration_link_states_state_check CHECK (state ~ '^[0-9a-f]{64}$')
);

CREATE INDEX IF NOT EXISTS discord_migration_link_states_server_idx
    ON public.discord_migration_link_states (server_id);
CREATE INDEX IF NOT EXISTS discord_migration_link_states_expires_idx
    ON public.discord_migration_link_states (expires_at);

COMMENT ON TABLE public.discord_migrations IS
    'Per-server Migrate from Discord configuration and state; reached by clients through discord_migration_* RPCs only.';
COMMENT ON TABLE public.discord_migration_secrets IS
    'Client id and Vault secret ids of a migration''s own Discord application; service_role only.';

-- ---------------------------------------------------------------------------
-- Grants and RLS: service_role only. Clients use the RPCs.
-- ---------------------------------------------------------------------------
REVOKE ALL ON public.discord_migrations, public.discord_migration_secrets,
              public.discord_migration_discord_roles, public.discord_migration_role_map,
              public.discord_migration_links, public.discord_migration_claims,
              public.discord_migration_link_states
    FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.discord_migrations, public.discord_migration_secrets,
             public.discord_migration_discord_roles, public.discord_migration_role_map,
             public.discord_migration_links, public.discord_migration_claims,
             public.discord_migration_link_states
    TO service_role;

DO $$
DECLARE
    t text;
BEGIN
    FOREACH t IN ARRAY ARRAY['discord_migrations', 'discord_migration_secrets',
                             'discord_migration_discord_roles', 'discord_migration_role_map',
                             'discord_migration_links', 'discord_migration_claims',
                             'discord_migration_link_states'] LOOP
        EXECUTE format('ALTER TABLE public.%I ENABLE ROW LEVEL SECURITY', t);
        EXECUTE format('DROP POLICY IF EXISTS %I ON public.%I', t || '_service_role', t);
        EXECUTE format('CREATE POLICY %I ON public.%I AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true)',
                       t || '_service_role', t);
    END LOOP;
END;
$$;

-- ---------------------------------------------------------------------------
-- Instance configuration
-- ---------------------------------------------------------------------------
INSERT INTO public.instance_config (config_key, config_value, description)
VALUES ('discord_migration_account_creation', 'true'::jsonb,
        'Discord members may create a Harmony account while claiming it in Migrate from Discord.')
ON CONFLICT (config_key) DO NOTHING;

DO $do$
DECLARE
    v_keys text[] := public.public_instance_config_keys();
BEGIN
    IF NOT ('discord_migration_account_creation' = ANY (v_keys)) THEN
        EXECUTE format(
            'CREATE OR REPLACE FUNCTION public.public_instance_config_keys() RETURNS text[] '
            'LANGUAGE sql IMMUTABLE SET search_path = public, pg_temp AS %L',
            format('SELECT %L::text[]', v_keys || 'discord_migration_account_creation'::text));
    END IF;
END;
$do$;

-- ---------------------------------------------------------------------------
-- Triggers
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.discord_migration_secrets_purge()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
BEGIN
    IF to_regclass('vault.secrets') IS NOT NULL THEN
        DELETE FROM vault.secrets
         WHERE id IN (OLD.bot_token_secret, OLD.client_secret_secret);
    END IF;
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS discord_migration_secrets_purge ON public.discord_migration_secrets;
CREATE TRIGGER discord_migration_secrets_purge
    AFTER DELETE ON public.discord_migration_secrets
    FOR EACH ROW EXECUTE FUNCTION public.discord_migration_secrets_purge();

-- ---------------------------------------------------------------------------
-- Helpers (not callable by clients)
-- ---------------------------------------------------------------------------

-- The caller's profile id; raises 42501 unless the caller manages the Discord bridge of the local
-- server, P0002 when the server is absent or remote.
CREATE OR REPLACE FUNCTION public.discord_migration_assert_manager(p_server_id uuid)
RETURNS uuid
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_me uuid := public.get_current_profile_id();
BEGIN
    IF v_me IS NULL THEN
        RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
    END IF;
    IF NOT public.can_manage_discord_bridge(p_server_id) THEN
        RAISE EXCEPTION 'Missing permission: MANAGE_SERVER' USING ERRCODE = '42501';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.servers s
                    WHERE s.id = p_server_id AND s.is_local_server IS NOT FALSE) THEN
        RAISE EXCEPTION 'Server not found' USING ERRCODE = 'P0002';
    END IF;
    RETURN v_me;
END;
$$;

-- ---------------------------------------------------------------------------
-- Client RPCs
-- ---------------------------------------------------------------------------

-- The configuration row without secrets, plus has_own_credentials, bridge_available (the server has
-- a hosted bridge that also holds its token), instance_bot_available, caller_is_owner, discord_roles
-- (the snapshot), role_map, link_counts by status, readiness (discord_migration_readiness) and
-- permission_gaps (discord_migration_permission_gaps). A server without a migration yields state null.
CREATE OR REPLACE FUNCTION public.discord_migration_get(p_server_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_me uuid := public.discord_migration_assert_manager(p_server_id);
    v_row public.discord_migrations;
BEGIN
    SELECT * INTO v_row FROM public.discord_migrations WHERE server_id = p_server_id;

    RETURN COALESCE(to_jsonb(v_row), jsonb_build_object('server_id', p_server_id, 'state', NULL))
        || jsonb_build_object(
            'has_own_credentials', EXISTS (SELECT 1 FROM public.discord_migration_secrets s
                                            WHERE s.server_id = p_server_id
                                              AND s.client_id IS NOT NULL
                                              AND s.client_secret_secret IS NOT NULL
                                              AND s.bot_token_secret IS NOT NULL),
            'bridge_available', EXISTS (SELECT 1 FROM public.discord_bridges b
                                          JOIN public.discord_bridge_secrets bs ON bs.bridge_id = b.id
                                         WHERE b.server_id = p_server_id AND b.mode = 'hosted'),
            'instance_bot_available', public.discord_bridge_instance_bot_enabled()
                                      AND public.discord_bridge_instance_bot_configured(),
            'caller_is_owner', EXISTS (SELECT 1 FROM public.servers s
                                        WHERE s.id = p_server_id AND s.owner = v_me),
            'discord_roles', COALESCE((
                SELECT jsonb_agg(jsonb_build_object(
                           'discord_role_id', r.discord_role_id, 'name', r.name, 'color', r.color,
                           'position', r.position, 'harmony_permissions', r.harmony_permissions::text,
                           'fetched_at', r.fetched_at)
                           ORDER BY r.position DESC, r.discord_role_id)
                  FROM public.discord_migration_discord_roles r
                 WHERE r.server_id = p_server_id), '[]'::jsonb),
            'role_map', COALESCE((
                SELECT jsonb_agg(jsonb_build_object(
                           'discord_role_id', m.discord_role_id, 'harmony_role_id', m.harmony_role_id)
                           ORDER BY m.discord_role_id)
                  FROM public.discord_migration_role_map m
                 WHERE m.server_id = p_server_id), '[]'::jsonb),
            'link_counts', (
                SELECT jsonb_build_object(
                           'active', count(*) FILTER (WHERE l.status = 'active'),
                           'left', count(*) FILTER (WHERE l.status = 'left'),
                           'banned', count(*) FILTER (WHERE l.status = 'banned'),
                           'kicked_on_harmony', count(*) FILTER (WHERE l.status = 'kicked_on_harmony'))
                  FROM public.discord_migration_links l
                 WHERE l.server_id = p_server_id),
            'readiness', public.discord_migration_readiness(p_server_id),
            'permission_gaps', public.discord_migration_permission_gaps(p_server_id));
END;
$$;

-- Upsert. A null guild id keeps the stored one, else takes the server's bridge's. A null source keeps
-- the stored one. Only a draft can change its guild (55000 guild_locked; an open or finished migration
-- keeps it, since a finished one can be reopened); a draft that moves to another guild drops the role
-- snapshot, the map and the readiness warnings. Returns discord_migration_get().
CREATE OR REPLACE FUNCTION public.discord_migration_save(
    p_server_id uuid,
    p_discord_guild_id text,
    p_credential_source text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_me uuid := public.discord_migration_assert_manager(p_server_id);
    v_cur public.discord_migrations;
    v_guild text;
    v_source text;
BEGIN
    SELECT * INTO v_cur FROM public.discord_migrations WHERE server_id = p_server_id FOR UPDATE;

    v_guild := COALESCE(NULLIF(btrim(p_discord_guild_id), ''),
                        v_cur.discord_guild_id,
                        (SELECT b.discord_guild_id FROM public.discord_bridges b WHERE b.server_id = p_server_id));
    v_source := COALESCE(NULLIF(btrim(p_credential_source), ''), v_cur.credential_source);

    IF v_cur.server_id IS NOT NULL THEN
        IF v_cur.state <> 'draft' AND v_guild IS DISTINCT FROM v_cur.discord_guild_id THEN
            RAISE EXCEPTION 'guild_locked' USING ERRCODE = '55000',
                DETAIL = 'The Discord server of an open migration cannot change.';
        END IF;
        IF v_guild IS DISTINCT FROM v_cur.discord_guild_id THEN
            DELETE FROM public.discord_migration_discord_roles WHERE server_id = p_server_id;
            DELETE FROM public.discord_migration_role_map WHERE server_id = p_server_id;
        END IF;
        UPDATE public.discord_migrations
           SET discord_guild_id = v_guild,
               credential_source = v_source,
               readiness_warnings = CASE WHEN v_guild IS DISTINCT FROM v_cur.discord_guild_id
                                         THEN NULL ELSE readiness_warnings END,
               bot_can_ban = CASE WHEN v_guild IS DISTINCT FROM v_cur.discord_guild_id
                                  THEN NULL ELSE bot_can_ban END,
               updated_at = now()
         WHERE server_id = p_server_id;
    ELSE
        INSERT INTO public.discord_migrations (server_id, discord_guild_id, credential_source, created_by)
        VALUES (p_server_id, v_guild, v_source, v_me);
    END IF;

    RETURN public.discord_migration_get(p_server_id);
END;
$$;

-- Stores the server's own Discord application: client id, OAuth client secret and bot token. NULL or
-- '' keeps the stored value; a new secret replaces the stored Vault secret. The migration must be saved
-- first (P0002).
CREATE OR REPLACE FUNCTION public.discord_migration_set_own_credentials(
    p_server_id uuid,
    p_client_id text,
    p_client_secret text,
    p_bot_token text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_client_id text := NULLIF(btrim(COALESCE(p_client_id, '')), '');
    v_client_secret text := NULLIF(btrim(COALESCE(p_client_secret, '')), '');
    v_token text := NULLIF(regexp_replace(btrim(COALESCE(p_bot_token, '')), '^Bot\s+', '', 'i'), '');
    v_old public.discord_migration_secrets;
    v_client_secret_id uuid;
    v_token_id uuid;
BEGIN
    PERFORM public.discord_migration_assert_manager(p_server_id);
    IF v_client_id IS NOT NULL AND v_client_id !~ '^[0-9]{1,20}$' THEN
        RAISE EXCEPTION 'Not a Discord application id' USING ERRCODE = '22023';
    END IF;
    IF v_client_secret IS NOT NULL AND v_client_secret !~ '^[A-Za-z0-9_-]{16,128}$' THEN
        RAISE EXCEPTION 'Not a Discord client secret' USING ERRCODE = '22023';
    END IF;
    IF v_token IS NOT NULL
       AND (char_length(v_token) > 256
            OR v_token !~ '^[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{10,}$') THEN
        RAISE EXCEPTION 'Not a Discord bot token' USING ERRCODE = '22023';
    END IF;
    PERFORM public.discord_bridge_assert_vault();

    PERFORM 1 FROM public.discord_migrations WHERE server_id = p_server_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'migration_not_configured' USING ERRCODE = 'P0002';
    END IF;
    SELECT * INTO v_old FROM public.discord_migration_secrets WHERE server_id = p_server_id FOR UPDATE;

    IF v_client_secret IS NOT NULL THEN
        v_client_secret_id := vault.create_secret(v_client_secret, NULL,
            'Discord migration ' || p_server_id || ': OAuth2 client secret');
    END IF;
    IF v_token IS NOT NULL THEN
        v_token_id := vault.create_secret(v_token, NULL,
            'Discord migration ' || p_server_id || ': bot token');
    END IF;

    INSERT INTO public.discord_migration_secrets
        (server_id, client_id, client_secret_secret, bot_token_secret, updated_at)
    VALUES (p_server_id, v_client_id, v_client_secret_id, v_token_id, now())
    ON CONFLICT (server_id) DO UPDATE
       SET client_id = COALESCE(EXCLUDED.client_id, discord_migration_secrets.client_id),
           client_secret_secret = COALESCE(EXCLUDED.client_secret_secret,
                                           discord_migration_secrets.client_secret_secret),
           bot_token_secret = COALESCE(EXCLUDED.bot_token_secret, discord_migration_secrets.bot_token_secret),
           updated_at = now();

    DELETE FROM vault.secrets
     WHERE id IN (CASE WHEN v_client_secret_id IS NOT NULL THEN v_old.client_secret_secret END,
                  CASE WHEN v_token_id IS NOT NULL THEN v_old.bot_token_secret END);

    UPDATE public.discord_migrations SET updated_at = now() WHERE server_id = p_server_id;
END;
$$;

-- A new 48 hex link token; links made with the old one stop working.
CREATE OR REPLACE FUNCTION public.discord_migration_regenerate_token(p_server_id uuid)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_token text;
BEGIN
    PERFORM public.discord_migration_assert_manager(p_server_id);
    UPDATE public.discord_migrations
       SET link_token = encode(extensions.gen_random_bytes(24), 'hex'), updated_at = now()
     WHERE server_id = p_server_id
    RETURNING link_token INTO v_token;
    IF v_token IS NULL THEN
        RAISE EXCEPTION 'migration_not_configured' USING ERRCODE = 'P0002';
    END IF;
    RETURN v_token;
END;
$$;

-- ---------------------------------------------------------------------------
-- Role map, permission gaps, lifecycle
-- ---------------------------------------------------------------------------

-- True when mapping the Discord role to the Harmony role gives Administrator: the snapshot's
-- harmony_permissions has bit 0, the Harmony role's permissions has bit 0, or the Harmony role is_admin.
CREATE OR REPLACE FUNCTION public.discord_migration_admin_bearing(
    p_server_id uuid, p_discord_role_id text, p_harmony_role_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
    SELECT COALESCE((SELECT (r.harmony_permissions & 1) <> 0
                       FROM public.discord_migration_discord_roles r
                      WHERE r.server_id = p_server_id AND r.discord_role_id = p_discord_role_id), false)
        OR COALESCE((SELECT (COALESCE(sr.permissions, 0) & 1) <> 0 OR sr.is_admin
                       FROM public.server_roles sr
                      WHERE sr.id = p_harmony_role_id), false)
$$;

-- {ready, unmapped_roles: [{discord_role_id, name}], has_credentials, has_guild, roles_fetched}.
-- has_credentials mirrors what discord_migration_credentials needs, without reading Vault. ready =
-- credentials + guild + a role snapshot + no unmapped role. Permission gaps are warnings, never part
-- of ready.
CREATE OR REPLACE FUNCTION public.discord_migration_readiness(p_server_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_m public.discord_migrations;
    v_creds boolean := false;
    v_guild boolean;
    v_fetched boolean;
    v_unmapped jsonb;
BEGIN
    PERFORM public.discord_migration_assert_manager(p_server_id);
    SELECT * INTO v_m FROM public.discord_migrations WHERE server_id = p_server_id;

    IF v_m.server_id IS NOT NULL THEN
        IF v_m.credential_source = 'instance_bot' THEN
            v_creds := public.discord_bridge_instance_bot_enabled()
                AND EXISTS (SELECT 1 FROM public.discord_bridge_instance_bot ib
                             WHERE ib.id AND ib.application_id IS NOT NULL
                               AND ib.client_secret_secret IS NOT NULL AND ib.bot_token_secret IS NOT NULL);
        ELSIF v_m.credential_source = 'bridge' THEN
            v_creds := EXISTS (SELECT 1 FROM public.discord_migration_secrets s
                                 JOIN public.discord_bridges b ON b.server_id = s.server_id AND b.mode = 'hosted'
                                 JOIN public.discord_bridge_secrets bs ON bs.bridge_id = b.id
                                WHERE s.server_id = p_server_id AND s.client_id IS NOT NULL
                                  AND s.client_secret_secret IS NOT NULL);
        ELSIF v_m.credential_source = 'own' THEN
            v_creds := EXISTS (SELECT 1 FROM public.discord_migration_secrets s
                                WHERE s.server_id = p_server_id AND s.client_id IS NOT NULL
                                  AND s.client_secret_secret IS NOT NULL AND s.bot_token_secret IS NOT NULL);
        END IF;
    END IF;

    v_guild := v_m.discord_guild_id IS NOT NULL;
    v_fetched := EXISTS (SELECT 1 FROM public.discord_migration_discord_roles r WHERE r.server_id = p_server_id);
    SELECT COALESCE(jsonb_agg(jsonb_build_object('discord_role_id', r.discord_role_id, 'name', r.name)
                              ORDER BY r.position DESC, r.discord_role_id), '[]'::jsonb)
      INTO v_unmapped
      FROM public.discord_migration_discord_roles r
     WHERE r.server_id = p_server_id
       AND NOT EXISTS (SELECT 1 FROM public.discord_migration_role_map m
                        WHERE m.server_id = r.server_id AND m.discord_role_id = r.discord_role_id);

    RETURN jsonb_build_object(
        'ready', v_creds AND v_guild AND v_fetched AND v_unmapped = '[]'::jsonb,
        'unmapped_roles', v_unmapped,
        'has_credentials', v_creds,
        'has_guild', v_guild,
        'roles_fetched', v_fetched);
END;
$$;

-- [{discord_role_id, harmony_role_id, missing: text[]}]: for each mapped role, the permission names
-- (bit order) in the Discord role's snapshot that the Harmony role lacks. Rows with nothing missing
-- are omitted.
CREATE OR REPLACE FUNCTION public.discord_migration_permission_gaps(p_server_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_names text[] := public.permission_bit_names();
BEGIN
    PERFORM public.discord_migration_assert_manager(p_server_id);
    RETURN COALESCE((
        SELECT jsonb_agg(jsonb_build_object('discord_role_id', g.discord_role_id,
                                            'harmony_role_id', g.harmony_role_id,
                                            'missing', to_jsonb(g.missing))
                         ORDER BY g.position DESC, g.discord_role_id)
          FROM (SELECT r.discord_role_id, m.harmony_role_id, r.position,
                       ARRAY(SELECT v_names[i]
                               FROM generate_series(1, array_length(v_names, 1)) i
                              WHERE (r.harmony_permissions & ~COALESCE(sr.permissions, 0) & (1::bigint << (i - 1))) <> 0
                              ORDER BY i) AS missing
                  FROM public.discord_migration_role_map m
                  JOIN public.discord_migration_discord_roles r
                    ON r.server_id = m.server_id AND r.discord_role_id = m.discord_role_id
                  JOIN public.server_roles sr ON sr.id = m.harmony_role_id
                 WHERE m.server_id = p_server_id) g
         WHERE cardinality(g.missing) > 0), '[]'::jsonb);
END;
$$;

-- Replaces the Discord role to Harmony role map. p_map is [{discord_role_id, harmony_role_id}]. Each
-- Discord role must be in the snapshot; each Harmony role must belong to the server and not be its
-- @everyone role (22023). A caller who is not the owner may not add, change or remove a row whose
-- Harmony role ranks at or above their top role (42501). A new or changed row that is
-- Administrator-bearing is owner-only (42501 ADMIN_ROLE_OWNER_ONLY) and needs p_confirm_admin
-- (P0001 ADMIN_ROLE_NEEDS_CONFIRM). Nothing is written when a row is refused. Returns readiness.
CREATE OR REPLACE FUNCTION public.discord_migration_save_role_map(
    p_server_id uuid,
    p_map jsonb,
    p_confirm_admin boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_me uuid := public.discord_migration_assert_manager(p_server_id);
    v_owner boolean;
    v_rank integer;
    v_item jsonb;
    v_did text;
    v_hid uuid;
    v_role public.server_roles;
    v_old uuid;
    v_dids text[] := '{}';
    v_hids uuid[] := '{}';
    v_gone record;
BEGIN
    PERFORM 1 FROM public.discord_migrations WHERE server_id = p_server_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'migration_not_configured' USING ERRCODE = 'P0002';
    END IF;
    IF p_map IS NULL OR jsonb_typeof(p_map) <> 'array' THEN
        RAISE EXCEPTION 'map must be an array' USING ERRCODE = '22023';
    END IF;

    v_owner := EXISTS (SELECT 1 FROM public.servers s WHERE s.id = p_server_id AND s.owner = v_me);
    v_rank := public.get_user_highest_role_position(v_me, p_server_id);

    FOR v_item IN SELECT e FROM jsonb_array_elements(p_map) e LOOP
        IF jsonb_typeof(v_item) <> 'object'
           OR v_item ->> 'discord_role_id' !~ '^[0-9]{1,20}$'
           OR v_item ->> 'harmony_role_id' !~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' THEN
            RAISE EXCEPTION 'invalid map row' USING ERRCODE = '22023';
        END IF;
        v_did := v_item ->> 'discord_role_id';
        v_hid := (v_item ->> 'harmony_role_id')::uuid;
        IF v_did = ANY (v_dids) THEN
            RAISE EXCEPTION 'duplicate Discord role in the map' USING ERRCODE = '22023';
        END IF;
        IF NOT EXISTS (SELECT 1 FROM public.discord_migration_discord_roles r
                        WHERE r.server_id = p_server_id AND r.discord_role_id = v_did) THEN
            RAISE EXCEPTION 'unknown Discord role' USING ERRCODE = '22023';
        END IF;
        SELECT * INTO v_role FROM public.server_roles sr WHERE sr.id = v_hid;
        IF NOT FOUND OR v_role.server_id <> p_server_id THEN
            RAISE EXCEPTION 'Harmony role not in this server' USING ERRCODE = '22023';
        END IF;
        IF v_role.is_default THEN
            RAISE EXCEPTION 'the default role cannot be mapped' USING ERRCODE = '22023';
        END IF;
        v_dids := v_dids || v_did;
        v_hids := v_hids || v_hid;

        SELECT m.harmony_role_id INTO v_old FROM public.discord_migration_role_map m
         WHERE m.server_id = p_server_id AND m.discord_role_id = v_did;
        IF v_old IS NOT DISTINCT FROM v_hid THEN
            CONTINUE;
        END IF;

        IF public.discord_migration_admin_bearing(p_server_id, v_did, v_hid) THEN
            IF NOT v_owner THEN
                RAISE EXCEPTION 'ADMIN_ROLE_OWNER_ONLY' USING ERRCODE = '42501';
            END IF;
            IF NOT COALESCE(p_confirm_admin, false) THEN
                RAISE EXCEPTION 'ADMIN_ROLE_NEEDS_CONFIRM';
            END IF;
        END IF;
        IF NOT v_owner AND v_role.position >= v_rank THEN
            RAISE EXCEPTION 'Cannot map a role ranked at or above your highest role' USING ERRCODE = '42501';
        END IF;
    END LOOP;

    -- Removing a row changes who holds the Harmony role, so it follows the same rank rule.
    IF NOT v_owner THEN
        FOR v_gone IN
            SELECT m.discord_role_id, sr.position
              FROM public.discord_migration_role_map m
              JOIN public.server_roles sr ON sr.id = m.harmony_role_id
             WHERE m.server_id = p_server_id AND NOT (m.discord_role_id = ANY (v_dids))
        LOOP
            IF v_gone.position >= v_rank THEN
                RAISE EXCEPTION 'Cannot unmap a role ranked at or above your highest role' USING ERRCODE = '42501';
            END IF;
        END LOOP;
    END IF;

    DELETE FROM public.discord_migration_role_map m
     WHERE m.server_id = p_server_id AND NOT (m.discord_role_id = ANY (v_dids));
    INSERT INTO public.discord_migration_role_map (server_id, discord_role_id, harmony_role_id)
    SELECT p_server_id, t.d, t.h FROM unnest(v_dids, v_hids) AS t(d, h)
    ON CONFLICT (server_id, discord_role_id) DO UPDATE SET harmony_role_id = EXCLUDED.harmony_role_id;

    RETURN public.discord_migration_readiness(p_server_id);
END;
$$;

-- {holders: [{user_id, username, display_name}]}: the active links that hold the Discord role, for the
-- confirm dialog of an Administrator mapping.
CREATE OR REPLACE FUNCTION public.discord_migration_admin_impact(p_server_id uuid, p_discord_role_id text)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
BEGIN
    PERFORM public.discord_migration_assert_manager(p_server_id);
    RETURN jsonb_build_object('holders', COALESCE((
        SELECT jsonb_agg(jsonb_build_object('user_id', l.user_id, 'username', p.username,
                                            'display_name', p.display_name)
                         ORDER BY p.username, l.user_id)
          FROM public.discord_migration_links l
          JOIN public.profiles p ON p.id = l.user_id
         WHERE l.server_id = p_server_id AND l.status = 'active'
           AND p_discord_role_id = ANY (l.discord_role_ids)), '[]'::jsonb));
END;
$$;

-- Adds the missing bits of the mapped roles (p_discord_role_ids, null for all) to their Harmony roles:
-- {updated: [{harmony_role_id, added: text[]}]}. SECURITY INVOKER on purpose: the role UPDATE runs as
-- the caller, so RLS (MANAGE_ROLES) and the server_roles write guard (rank, and only bits the caller
-- holds) decide what is allowed. The gaps come from the definer discord_migration_permission_gaps,
-- which also requires MANAGE_SERVER. Add-only; never clears a bit. A gap with ADMINISTRATOR is
-- owner-only (42501 ADMIN_ROLE_OWNER_ONLY) and needs p_confirm_admin (P0001 ADMIN_ROLE_NEEDS_CONFIRM).
CREATE OR REPLACE FUNCTION public.discord_migration_apply_permissions(
    p_server_id uuid,
    p_discord_role_ids text[],
    p_confirm_admin boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_names text[] := public.permission_bit_names();
    v_gaps jsonb := public.discord_migration_permission_gaps(p_server_id);
    v_sel jsonb;
    v_gap jsonb;
    v_hid uuid;
    v_bits bigint;
    v_rows integer;
    v_updated jsonb := '[]'::jsonb;
BEGIN
    SELECT COALESCE(jsonb_agg(e), '[]'::jsonb) INTO v_sel
      FROM jsonb_array_elements(v_gaps) e
     WHERE p_discord_role_ids IS NULL OR (e ->> 'discord_role_id') = ANY (p_discord_role_ids);

    IF EXISTS (SELECT 1 FROM jsonb_array_elements(v_sel) e WHERE e -> 'missing' ? 'ADMINISTRATOR') THEN
        IF NOT EXISTS (SELECT 1 FROM public.servers s
                        WHERE s.id = p_server_id AND s.owner = public.get_current_profile_id()) THEN
            RAISE EXCEPTION 'ADMIN_ROLE_OWNER_ONLY' USING ERRCODE = '42501';
        END IF;
        IF NOT COALESCE(p_confirm_admin, false) THEN
            RAISE EXCEPTION 'ADMIN_ROLE_NEEDS_CONFIRM';
        END IF;
    END IF;

    FOR v_gap IN SELECT e FROM jsonb_array_elements(v_sel) e LOOP
        v_hid := (v_gap ->> 'harmony_role_id')::uuid;
        SELECT COALESCE(bit_or(1::bigint << (array_position(v_names, n) - 1)), 0) INTO v_bits
          FROM jsonb_array_elements_text(v_gap -> 'missing') n;

        UPDATE public.server_roles sr
           SET permissions = COALESCE(sr.permissions, 0) | v_bits
         WHERE sr.id = v_hid AND sr.server_id = p_server_id;
        GET DIAGNOSTICS v_rows = ROW_COUNT;
        IF v_rows = 0 THEN
            -- RLS hides the role from a caller without MANAGE_ROLES.
            RAISE EXCEPTION 'Missing permission: MANAGE_ROLES' USING ERRCODE = '42501';
        END IF;
        v_updated := v_updated || jsonb_build_object('harmony_role_id', v_hid, 'added', v_gap -> 'missing');
    END LOOP;

    RETURN jsonb_build_object('updated', v_updated);
END;
$$;

-- A paused open migration set to open resumes. draft|finished to open needs readiness (P0001 MIGRATION_NOT_READY) and asks for a sync; open to
-- finished stamps finished_at. Any other change raises: 22023 for a state that cannot be set, 55000 for
-- a change the current state does not allow. Returns discord_migration_get().
CREATE OR REPLACE FUNCTION public.discord_migration_set_state(p_server_id uuid, p_state text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_cur text;
    v_reason text;
BEGIN
    PERFORM public.discord_migration_assert_manager(p_server_id);
    SELECT m.state, m.sync_paused_reason INTO v_cur, v_reason
      FROM public.discord_migrations m WHERE m.server_id = p_server_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'migration_not_configured' USING ERRCODE = 'P0002';
    END IF;

    IF p_state = 'open' THEN
        -- An open migration that sync paused resumes: the pause is cleared and a sync asked for.
        -- Resuming from a removal_brake pause is the manager's approval of the removals that tripped it: the
        -- next pass applies them once without the brake (brake_override).
        IF v_cur = 'open' AND v_reason IS NOT NULL THEN
            UPDATE public.discord_migrations
               SET sync_paused_reason = NULL, sync_requested_at = now(), updated_at = now(),
                   brake_override = (v_reason = 'removal_brake')
             WHERE server_id = p_server_id;
            RETURN public.discord_migration_get(p_server_id);
        END IF;
        IF v_cur NOT IN ('draft', 'finished') THEN
            RAISE EXCEPTION 'invalid_state_change' USING ERRCODE = '55000';
        END IF;
        IF NOT (public.discord_migration_readiness(p_server_id) ->> 'ready')::boolean THEN
            RAISE EXCEPTION 'MIGRATION_NOT_READY';
        END IF;
        UPDATE public.discord_migrations
           SET state = 'open', opened_at = now(), finished_at = NULL, sync_paused_reason = NULL,
               sync_requested_at = now(), updated_at = now()
         WHERE server_id = p_server_id;
    ELSIF p_state = 'finished' THEN
        IF v_cur <> 'open' THEN
            RAISE EXCEPTION 'invalid_state_change' USING ERRCODE = '55000';
        END IF;
        UPDATE public.discord_migrations
           SET state = 'finished', finished_at = now(), updated_at = now()
         WHERE server_id = p_server_id;
    ELSE
        RAISE EXCEPTION 'invalid_state' USING ERRCODE = '22023';
    END IF;

    RETURN public.discord_migration_get(p_server_id);
END;
$$;

-- Asks the gateway for a sync now. Only while the migration is open (55000).
CREATE OR REPLACE FUNCTION public.discord_migration_request_sync(p_server_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_cur text;
BEGIN
    PERFORM public.discord_migration_assert_manager(p_server_id);
    SELECT m.state INTO v_cur FROM public.discord_migrations m WHERE m.server_id = p_server_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'migration_not_configured' USING ERRCODE = 'P0002';
    END IF;
    IF v_cur <> 'open' THEN
        RAISE EXCEPTION 'migration_not_open' USING ERRCODE = '55000';
    END IF;
    UPDATE public.discord_migrations SET sync_requested_at = now() WHERE server_id = p_server_id;
END;
$$;

-- [{discord_role_id, harmony_role_id | null}] for every role in the snapshot: the Harmony role with the
-- same name, ignoring case and surrounding spaces. No match, several matches and the @everyone role
-- give null. Writes nothing.
CREATE OR REPLACE FUNCTION public.discord_migration_auto_match(p_server_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
BEGIN
    PERFORM public.discord_migration_assert_manager(p_server_id);
    RETURN COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
                   'discord_role_id', r.discord_role_id,
                   'harmony_role_id', (SELECT CASE WHEN count(*) = 1 THEN (array_agg(sr.id))[1] END
                                         FROM public.server_roles sr
                                        WHERE sr.server_id = p_server_id AND NOT sr.is_default
                                          AND lower(btrim(sr.name)) = lower(btrim(r.name))))
                   ORDER BY r.position DESC, r.discord_role_id)
          FROM public.discord_migration_discord_roles r
         WHERE r.server_id = p_server_id), '[]'::jsonb);
END;
$$;

-- ---------------------------------------------------------------------------
-- Gateway functions (service_role)
-- ---------------------------------------------------------------------------

-- {client_id, client_secret, bot_token} by credential source. instance_bot reads the instance bot;
-- bridge takes the bot token from the server's hosted bridge and the client id and secret from the
-- migration's own credentials; own reads the migration's own credentials. Raises
-- MIGRATION_CREDENTIALS_MISSING when any part is missing, or when the instance bot is turned off.
CREATE OR REPLACE FUNCTION public.discord_migration_credentials(p_server_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_source text;
    v_result jsonb;
BEGIN
    SELECT m.credential_source INTO v_source FROM public.discord_migrations m WHERE m.server_id = p_server_id;
    IF v_source IS NOT NULL THEN
        PERFORM public.discord_bridge_assert_vault();
    END IF;

    IF v_source = 'instance_bot' THEN
        SELECT jsonb_build_object('client_id', ib.application_id,
                                  'client_secret', c.decrypted_secret,
                                  'bot_token', t.decrypted_secret)
          INTO v_result
          FROM public.discord_bridge_instance_bot ib
          JOIN vault.decrypted_secrets c ON c.id = ib.client_secret_secret
          JOIN vault.decrypted_secrets t ON t.id = ib.bot_token_secret
         WHERE ib.id AND ib.application_id IS NOT NULL
           AND public.discord_bridge_instance_bot_enabled();
    ELSIF v_source = 'bridge' THEN
        SELECT jsonb_build_object('client_id', s.client_id,
                                  'client_secret', c.decrypted_secret,
                                  'bot_token', t.decrypted_secret)
          INTO v_result
          FROM public.discord_migration_secrets s
          JOIN vault.decrypted_secrets c ON c.id = s.client_secret_secret
          JOIN public.discord_bridges b ON b.server_id = s.server_id AND b.mode = 'hosted'
          JOIN public.discord_bridge_secrets bs ON bs.bridge_id = b.id
          JOIN vault.decrypted_secrets t ON t.id = bs.discord_token_secret
         WHERE s.server_id = p_server_id AND s.client_id IS NOT NULL;
    ELSIF v_source = 'own' THEN
        SELECT jsonb_build_object('client_id', s.client_id,
                                  'client_secret', c.decrypted_secret,
                                  'bot_token', t.decrypted_secret)
          INTO v_result
          FROM public.discord_migration_secrets s
          JOIN vault.decrypted_secrets c ON c.id = s.client_secret_secret
          JOIN vault.decrypted_secrets t ON t.id = s.bot_token_secret
         WHERE s.server_id = p_server_id AND s.client_id IS NOT NULL;
    END IF;

    IF v_result IS NULL THEN
        RAISE EXCEPTION 'MIGRATION_CREDENTIALS_MISSING';
    END IF;
    RETURN v_result;
END;
$$;

-- Replaces the guild's role snapshot with p_roles, [{id, name, color, position, harmony_permissions}]
-- (harmony_permissions a decimal string), and deletes map rows whose Discord role is gone. The
-- @everyone role (id = the guild id) is skipped. P0002 when the migration is absent.
CREATE OR REPLACE FUNCTION public.discord_migration_store_discord_roles(p_server_id uuid, p_roles jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_guild text;
    v_ids text[];
BEGIN
    IF p_roles IS NULL OR jsonb_typeof(p_roles) <> 'array' THEN
        RAISE EXCEPTION 'roles must be an array' USING ERRCODE = '22023';
    END IF;
    SELECT m.discord_guild_id INTO v_guild FROM public.discord_migrations m
     WHERE m.server_id = p_server_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'migration_not_configured' USING ERRCODE = 'P0002';
    END IF;

    -- One row per valid role id; @everyone (the guild id) is never stored.
    SELECT COALESCE(array_agg(DISTINCT r ->> 'id'), '{}') INTO v_ids
      FROM jsonb_array_elements(p_roles) r
     WHERE jsonb_typeof(r) = 'object'
       AND r ->> 'id' ~ '^[0-9]{1,20}$'
       AND r ->> 'id' IS DISTINCT FROM v_guild;

    DELETE FROM public.discord_migration_discord_roles r
     WHERE r.server_id = p_server_id AND NOT (r.discord_role_id = ANY (v_ids));
    DELETE FROM public.discord_migration_role_map m
     WHERE m.server_id = p_server_id AND NOT (m.discord_role_id = ANY (v_ids));

    INSERT INTO public.discord_migration_discord_roles
        (server_id, discord_role_id, name, color, position, harmony_permissions, fetched_at)
    SELECT DISTINCT ON (r ->> 'id')
           p_server_id,
           r ->> 'id',
           left(COALESCE(NULLIF(btrim(r ->> 'name'), ''), r ->> 'id'), 100),
           COALESCE((r ->> 'color')::integer, 0),
           COALESCE((r ->> 'position')::integer, 0),
           COALESCE((r ->> 'harmony_permissions')::bigint, 0),
           now()
      FROM jsonb_array_elements(p_roles) r
     WHERE jsonb_typeof(r) = 'object'
       AND r ->> 'id' = ANY (v_ids)
     ORDER BY r ->> 'id'
    ON CONFLICT (server_id, discord_role_id) DO UPDATE
       SET name = EXCLUDED.name, color = EXCLUDED.color, position = EXCLUDED.position,
           harmony_permissions = EXCLUDED.harmony_permissions, fetched_at = EXCLUDED.fetched_at;
END;
$$;

-- Stores the readiness warnings the gateway found (any jsonb; null clears them).
CREATE OR REPLACE FUNCTION public.discord_migration_store_warnings(p_server_id uuid, p_warnings jsonb)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
BEGIN
    UPDATE public.discord_migrations
       SET readiness_warnings = p_warnings, updated_at = now()
     WHERE server_id = p_server_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'migration_not_configured' USING ERRCODE = 'P0002';
    END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- Function grants
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    fn regprocedure;
BEGIN
    FOREACH fn IN ARRAY ARRAY[
        'public.discord_migration_get(uuid)',
        'public.discord_migration_save(uuid, text, text)',
        'public.discord_migration_set_own_credentials(uuid, text, text, text)',
        'public.discord_migration_regenerate_token(uuid)',
        'public.discord_migration_readiness(uuid)',
        'public.discord_migration_permission_gaps(uuid)',
        'public.discord_migration_save_role_map(uuid, jsonb, boolean)',
        'public.discord_migration_admin_impact(uuid, text)',
        'public.discord_migration_apply_permissions(uuid, text[], boolean)',
        'public.discord_migration_set_state(uuid, text)',
        'public.discord_migration_request_sync(uuid)',
        'public.discord_migration_auto_match(uuid)'
    ]::regprocedure[] LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role', fn);
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', fn);
    END LOOP;

    FOREACH fn IN ARRAY ARRAY[
        'public.discord_migration_credentials(uuid)',
        'public.discord_migration_store_discord_roles(uuid, jsonb)',
        'public.discord_migration_store_warnings(uuid, jsonb)'
    ]::regprocedure[] LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn);
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn);
    END LOOP;

    -- Reached only from the definers above and from triggers, which run as the owner.
    FOREACH fn IN ARRAY ARRAY[
        'public.discord_migration_assert_manager(uuid)',
        'public.discord_migration_admin_bearing(uuid, text, uuid)',
        'public.discord_migration_secrets_purge()'
    ]::regprocedure[] LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role', fn);
    END LOOP;
END;
$$;

-- ---------------------------------------------------------------------------
-- Claims, joining and Harmony moderation precedence
-- ---------------------------------------------------------------------------
-- A Discord member signs in with Discord (gateway), gets a one-time ticket, and claims it with their
-- Harmony account. A Harmony ban or kick is never undone by a claim. Errors (P0001 unless noted):
-- HARMONY_BANNED, KICKED_ON_HARMONY, DISCORD_ACCOUNT_TAKEN, ALREADY_LINKED_OTHER_DISCORD,
-- DISCORD_BANNED_HERE, MIGRATION_CLOSED, TICKET_EXPIRED; 42501 for a ticket bound to another user.

-- A role change the migration makes writes its own audit row (source system, via discord_migration);
-- the generic trigger stays quiet while harmony.via is set.
CREATE OR REPLACE FUNCTION public.server_audit_user_roles()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_row public.user_roles := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
    v_role text;
BEGIN
    IF pg_trigger_depth() > 1 THEN
        RETURN NULL;
    END IF;
    IF current_setting('harmony.via', true) = 'discord_migration' THEN
        RETURN NULL;
    END IF;
    IF TG_OP = 'DELETE' AND NOT EXISTS (
        SELECT 1 FROM public.user_servers us
         WHERE us.server_id = v_row.server_id AND us.user_id = v_row.user_id) THEN
        RETURN NULL;
    END IF;

    SELECT sr.name INTO v_role FROM public.server_roles sr WHERE sr.id = v_row.role_id;
    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    PERFORM public.server_audit_write(
        v_row.server_id,
        CASE WHEN TG_OP = 'DELETE' THEN 'member.role_remove' ELSE 'member.role_add' END,
        'user', v_row.user_id::text,
        (SELECT p.username FROM public.profiles p WHERE p.id = v_row.user_id),
        NULL,
        jsonb_build_object('role_id', v_row.role_id, 'role_name', v_role));
    RETURN NULL;
END;
$$;

-- Makes the member's mapped Harmony roles match the Discord roles: adds the missing target roles and
-- removes every mapped Harmony role not in the target, hand-granted ones included. Unmapped roles, the
-- server owner and anyone who is not an accepted member are never touched. Returns {added: [role ids], removed: [role ids]}. An
-- Administrator-bearing change is flagged in the audit row and notifies the owner.
CREATE OR REPLACE FUNCTION public.discord_migration_apply_roles(
    p_server_id uuid, p_user_id uuid, p_discord_role_ids text[])
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_owner uuid;
    v_server_name text;
    v_username text;
    v_prev_via text := current_setting('harmony.via', true);
    v_target uuid[];
    v_held uuid[];
    v_stale uuid[];
    v_stale_held uuid[];
    v_add uuid[];
    v_remove uuid[];
    v_role uuid;
    v_role_name text;
    v_admin boolean;
BEGIN
    SELECT s.owner, s.name INTO v_owner, v_server_name FROM public.servers s WHERE s.id = p_server_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Server not found' USING ERRCODE = 'P0002';
    END IF;
    IF v_owner IS NOT DISTINCT FROM p_user_id THEN
        RETURN jsonb_build_object('added', '[]'::jsonb, 'removed', '[]'::jsonb);
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.user_servers us
                    WHERE us.server_id = p_server_id AND us.user_id = p_user_id AND us.status = 'accepted') THEN
        RETURN jsonb_build_object('added', '[]'::jsonb, 'removed', '[]'::jsonb);
    END IF;
    SELECT p.username INTO v_username FROM public.profiles p WHERE p.id = p_user_id;

    SELECT COALESCE(array_agg(DISTINCT m.harmony_role_id), '{}') INTO v_target
      FROM public.discord_migration_role_map m
     WHERE m.server_id = p_server_id AND m.discord_role_id = ANY (COALESCE(p_discord_role_ids, '{}'));
    SELECT COALESCE(array_agg(ur.role_id), '{}') INTO v_held
      FROM public.user_roles ur
     WHERE ur.server_id = p_server_id AND ur.user_id = p_user_id
       AND ur.role_id IN (SELECT m.harmony_role_id FROM public.discord_migration_role_map m
                           WHERE m.server_id = p_server_id);
    -- A role this function granted for a Discord role that is now mapped to a different Harmony role
    -- is taken back too (a remap moves the role). Dropping a mapping leaves the role alone.
    SELECT COALESCE(array_agg(DISTINCT (a.value #>> '{}')::uuid), '{}') INTO v_stale
      FROM public.discord_migration_links l
      CROSS JOIN LATERAL jsonb_each(l.applied_roles) a
      JOIN public.discord_migration_role_map m
        ON m.server_id = l.server_id AND m.discord_role_id = a.key
       AND m.harmony_role_id <> (a.value #>> '{}')::uuid
     WHERE l.server_id = p_server_id AND l.user_id = p_user_id;
    SELECT COALESCE(array_agg(ur.role_id), '{}') INTO v_stale_held
      FROM public.user_roles ur
     WHERE ur.server_id = p_server_id AND ur.user_id = p_user_id AND ur.role_id = ANY (v_stale);
    SELECT COALESCE(array_agg(t), '{}') INTO v_add FROM unnest(v_target) t WHERE NOT (t = ANY (v_held));
    SELECT COALESCE(array_agg(DISTINCT h), '{}') INTO v_remove
      FROM unnest(v_held || v_stale_held) h WHERE NOT (h = ANY (v_target));

    PERFORM set_config('harmony.via', 'discord_migration', true);

    FOREACH v_role IN ARRAY v_add LOOP
        INSERT INTO public.user_roles (user_id, role_id, server_id)
        VALUES (p_user_id, v_role, p_server_id)
        ON CONFLICT (user_id, role_id) DO NOTHING;
        SELECT sr.name INTO v_role_name FROM public.server_roles sr WHERE sr.id = v_role;
        SELECT COALESCE(bool_or(public.discord_migration_admin_bearing(p_server_id, m.discord_role_id, m.harmony_role_id)), false)
               OR public.discord_migration_admin_bearing(p_server_id, '', v_role)
          INTO v_admin
          FROM public.discord_migration_role_map m
         WHERE m.server_id = p_server_id AND m.harmony_role_id = v_role;
        PERFORM public.server_audit_write(p_server_id, 'member.role_add', 'user', p_user_id::text, v_username, NULL,
            jsonb_build_object('role_id', v_role, 'role_name', v_role_name, 'via', 'discord_migration',
                               'administrator', CASE WHEN v_admin THEN true END),
            NULL, NULL, 'system');
        IF v_admin AND v_owner IS NOT NULL THEN
            INSERT INTO public.notifications (user_id, type, data)
            VALUES (v_owner, 'discord_migration_admin_change', jsonb_build_object(
                'server', jsonb_build_object('id', p_server_id, 'name', v_server_name),
                'user', jsonb_build_object('id', p_user_id, 'username', v_username),
                'role', jsonb_build_object('id', v_role, 'name', v_role_name),
                'change', 'granted'));
        END IF;
    END LOOP;

    FOREACH v_role IN ARRAY v_remove LOOP
        DELETE FROM public.user_roles ur
         WHERE ur.server_id = p_server_id AND ur.user_id = p_user_id AND ur.role_id = v_role;
        SELECT sr.name INTO v_role_name FROM public.server_roles sr WHERE sr.id = v_role;
        SELECT COALESCE(bool_or(public.discord_migration_admin_bearing(p_server_id, m.discord_role_id, m.harmony_role_id)), false)
               OR public.discord_migration_admin_bearing(p_server_id, '', v_role)
          INTO v_admin
          FROM public.discord_migration_role_map m
         WHERE m.server_id = p_server_id AND m.harmony_role_id = v_role;
        PERFORM public.server_audit_write(p_server_id, 'member.role_remove', 'user', p_user_id::text, v_username, NULL,
            jsonb_build_object('role_id', v_role, 'role_name', v_role_name, 'via', 'discord_migration',
                               'administrator', CASE WHEN v_admin THEN true END),
            NULL, NULL, 'system');
        IF v_admin AND v_owner IS NOT NULL THEN
            INSERT INTO public.notifications (user_id, type, data)
            VALUES (v_owner, 'discord_migration_admin_change', jsonb_build_object(
                'server', jsonb_build_object('id', p_server_id, 'name', v_server_name),
                'user', jsonb_build_object('id', p_user_id, 'username', v_username),
                'role', jsonb_build_object('id', v_role, 'name', v_role_name),
                'change', 'removed'));
        END IF;
    END LOOP;

    UPDATE public.discord_migration_links l
       SET applied_roles = COALESCE((SELECT jsonb_object_agg(m.discord_role_id, m.harmony_role_id)
                                       FROM public.discord_migration_role_map m
                                      WHERE m.server_id = p_server_id
                                        AND m.discord_role_id = ANY (COALESCE(p_discord_role_ids, '{}'))), '{}'::jsonb)
     WHERE l.server_id = p_server_id AND l.user_id = p_user_id;

    PERFORM set_config('harmony.via', COALESCE(v_prev_via, ''), true);
    RETURN jsonb_build_object('added', to_jsonb(v_add), 'removed', to_jsonb(v_remove));
END;
$$;

-- Gateway: a ticket for a Discord member who signed in. p_discord_user is {id, username, global_name,
-- avatar_url}; an optional harmony_user_id says which Harmony account is already signed in, so a Discord
-- account linked to another member is refused up front (claim checks again). Returns {ticket} or
-- {error}: MIGRATION_CLOSED, DISCORD_BANNED_HERE, ALREADY_LINKED_ELSEWHERE. Purges expired rows.
CREATE OR REPLACE FUNCTION public.discord_migration_create_claim(
    p_server_id uuid, p_discord_user jsonb, p_discord_role_ids text[], p_discord_joined_at timestamptz)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_discord text := p_discord_user ->> 'id';
    v_harmony text := p_discord_user ->> 'harmony_user_id';
    v_state text;
    v_link record;
    v_ticket text;
BEGIN
    DELETE FROM public.discord_migration_claims WHERE expires_at < now();
    DELETE FROM public.discord_migration_link_states WHERE expires_at < now();

    IF v_discord IS NULL OR v_discord !~ '^[0-9]{1,20}$' THEN
        RAISE EXCEPTION 'invalid_discord_user' USING ERRCODE = '22023';
    END IF;
    IF EXISTS (SELECT 1 FROM unnest(COALESCE(p_discord_role_ids, '{}')) r WHERE r !~ '^[0-9]{1,20}$') THEN
        RAISE EXCEPTION 'invalid_discord_role_ids' USING ERRCODE = '22023';
    END IF;

    SELECT m.state INTO v_state FROM public.discord_migrations m WHERE m.server_id = p_server_id;
    IF v_state IS DISTINCT FROM 'open' THEN
        RETURN jsonb_build_object('error', 'MIGRATION_CLOSED');
    END IF;

    SELECT l.user_id, l.status INTO v_link
      FROM public.discord_migration_links l
     WHERE l.server_id = p_server_id AND l.discord_user_id = v_discord;
    IF FOUND THEN
        IF v_link.status = 'banned' THEN
            RETURN jsonb_build_object('error', 'DISCORD_BANNED_HERE');
        END IF;
        IF v_link.status = 'active' AND v_harmony IS NOT NULL AND v_link.user_id::text <> v_harmony THEN
            RETURN jsonb_build_object('error', 'ALREADY_LINKED_ELSEWHERE');
        END IF;
    END IF;

    v_ticket := encode(extensions.gen_random_bytes(32), 'hex');
    INSERT INTO public.discord_migration_claims
        (ticket, server_id, discord_user_id, discord_username, discord_global_name, discord_avatar_url,
         discord_role_ids, discord_joined_at, expires_at)
    VALUES (v_ticket, p_server_id, v_discord, left(p_discord_user ->> 'username', 100),
            left(p_discord_user ->> 'global_name', 100), left(p_discord_user ->> 'avatar_url', 500),
            COALESCE(p_discord_role_ids, '{}'), p_discord_joined_at, now() + interval '7 days');
    RETURN jsonb_build_object('ticket', v_ticket);
END;
$$;

-- Gateway: binds a ticket to the GoTrue user it just created. A ticket bound to another user stays so.
CREATE OR REPLACE FUNCTION public.discord_migration_bind_claim(p_ticket text, p_auth_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
BEGIN
    UPDATE public.discord_migration_claims c
       SET auth_user_id = p_auth_user_id
     WHERE c.ticket = p_ticket AND c.expires_at > now()
       AND (c.auth_user_id IS NULL OR c.auth_user_id = p_auth_user_id);
    IF NOT FOUND THEN
        RAISE EXCEPTION 'TICKET_EXPIRED';
    END IF;
END;
$$;

-- The caller claims a ticket: links their account to the Discord member, joins the server (accepted, no
-- invite needed) and applies the mapped roles. Returns {server_id, roles_granted: [role names]}.
CREATE OR REPLACE FUNCTION public.discord_migration_claim(p_ticket text)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_uid uuid := auth.uid();
    v_me uuid := public.get_current_profile_id();
    v_claim public.discord_migration_claims;
    v_state text;
    v_mine record;
    v_status text;
    v_names text[];
BEGIN
    IF v_uid IS NULL OR v_me IS NULL THEN
        RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = v_me AND p.is_local IS TRUE) THEN
        RAISE EXCEPTION 'Only local accounts can claim' USING ERRCODE = '42501';
    END IF;

    SELECT c.* INTO v_claim FROM public.discord_migration_claims c WHERE c.ticket = p_ticket FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'TICKET_EXPIRED';
    END IF;
    IF v_claim.auth_user_id IS NOT NULL AND v_claim.auth_user_id <> v_uid THEN
        RAISE EXCEPTION 'This ticket belongs to another account' USING ERRCODE = '42501';
    END IF;
    IF v_claim.expires_at < now() THEN
        RAISE EXCEPTION 'TICKET_EXPIRED';
    END IF;

    SELECT m.state INTO v_state FROM public.discord_migrations m WHERE m.server_id = v_claim.server_id FOR SHARE;
    IF v_state IS DISTINCT FROM 'open' THEN
        RAISE EXCEPTION 'MIGRATION_CLOSED';
    END IF;

    -- Harmony moderation first: nothing below undoes a ban or a kick.
    IF EXISTS (SELECT 1 FROM public.server_bans b WHERE b.server_id = v_claim.server_id AND b.user_id = v_me)
       OR EXISTS (SELECT 1 FROM public.user_servers us
                   WHERE us.server_id = v_claim.server_id AND us.user_id = v_me AND us.status = 'banned') THEN
        RAISE EXCEPTION 'HARMONY_BANNED';
    END IF;

    SELECT l.discord_user_id, l.status INTO v_mine
      FROM public.discord_migration_links l
     WHERE l.server_id = v_claim.server_id AND l.user_id = v_me;
    IF FOUND THEN
        IF v_mine.status = 'kicked_on_harmony' THEN
            RAISE EXCEPTION 'KICKED_ON_HARMONY';
        END IF;
        IF v_mine.discord_user_id <> v_claim.discord_user_id THEN
            RAISE EXCEPTION 'ALREADY_LINKED_OTHER_DISCORD';
        END IF;
    END IF;

    IF EXISTS (SELECT 1 FROM public.discord_migration_links l
                WHERE l.server_id = v_claim.server_id AND l.discord_user_id = v_claim.discord_user_id
                  AND l.user_id <> v_me) THEN
        RAISE EXCEPTION 'DISCORD_ACCOUNT_TAKEN';
    END IF;
    IF v_mine.status = 'banned' THEN
        RAISE EXCEPTION 'DISCORD_BANNED_HERE';
    END IF;

    BEGIN
        -- last_synced_at = NULL puts the link first in the next sync batch: the roles recorded at sign-in may be
        -- stale, and a fresh Discord read corrects them.
        INSERT INTO public.discord_migration_links
            (server_id, user_id, discord_user_id, status, discord_role_ids, discord_joined_at, last_synced_at)
        VALUES (v_claim.server_id, v_me, v_claim.discord_user_id, 'active',
                v_claim.discord_role_ids, v_claim.discord_joined_at, NULL)
        ON CONFLICT (server_id, user_id) DO UPDATE
           SET status = 'active', discord_role_ids = EXCLUDED.discord_role_ids,
               discord_joined_at = COALESCE(EXCLUDED.discord_joined_at, discord_migration_links.discord_joined_at),
               last_synced_at = NULL;
    EXCEPTION WHEN unique_violation THEN
        RAISE EXCEPTION 'DISCORD_ACCOUNT_TAKEN';
    END;

    -- Joins as an accepted member, as redeem_invite does; the join triggers (membership event, rate
    -- limit) run for the caller.
    SELECT us.status INTO v_status
      FROM public.user_servers us WHERE us.server_id = v_claim.server_id AND us.user_id = v_me;
    IF NOT FOUND THEN
        INSERT INTO public.user_servers (server_id, user_id, status)
        VALUES (v_claim.server_id, v_me, 'accepted');
    ELSIF v_status <> 'accepted' THEN
        UPDATE public.user_servers SET status = 'accepted'
         WHERE server_id = v_claim.server_id AND user_id = v_me;
    END IF;

    PERFORM public.discord_migration_apply_roles(v_claim.server_id, v_me, v_claim.discord_role_ids);

    -- A ticket that sat for more than 15 minutes asks for a sync now.
    IF v_claim.created_at < now() - interval '15 minutes' THEN
        UPDATE public.discord_migrations SET sync_requested_at = now() WHERE server_id = v_claim.server_id;
    END IF;

    SELECT COALESCE(array_agg(DISTINCT sr.name), '{}') INTO v_names
      FROM public.discord_migration_role_map m
      JOIN public.server_roles sr ON sr.id = m.harmony_role_id
     WHERE m.server_id = v_claim.server_id AND m.discord_role_id = ANY (v_claim.discord_role_ids)
       AND NOT EXISTS (SELECT 1 FROM public.servers s WHERE s.id = v_claim.server_id AND s.owner = v_me);

    DELETE FROM public.discord_migration_claims WHERE ticket = p_ticket;
    RETURN jsonb_build_object('server_id', v_claim.server_id, 'roles_granted', to_jsonb(v_names));
END;
$$;

-- The caller's unexpired tickets: [{ticket, server_id, server_name, discord_username, discord_global_name,
-- discord_avatar_url, expires_at}].
CREATE OR REPLACE FUNCTION public.discord_migration_my_pending_claims()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
    SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'ticket', c.ticket, 'server_id', c.server_id, 'server_name', s.name,
               'discord_username', c.discord_username, 'discord_global_name', c.discord_global_name,
               'discord_avatar_url', c.discord_avatar_url, 'expires_at', c.expires_at)
           ORDER BY c.created_at), '[]'::jsonb)
      FROM public.discord_migration_claims c
      JOIN public.servers s ON s.id = c.server_id
     WHERE auth.uid() IS NOT NULL AND c.auth_user_id = auth.uid() AND c.expires_at > now()
$$;

-- The caller sets which profile fields their link lets the migration copy. Clearing last_synced_at puts
-- the link first in the next batch. 22023 for a field outside the seven; P0002 without a link.
CREATE OR REPLACE FUNCTION public.discord_migration_set_my_sync(p_server_id uuid, p_fields text[])
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_me uuid := public.get_current_profile_id();
    v_fields text[];
BEGIN
    IF v_me IS NULL THEN
        RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
    END IF;
    v_fields := COALESCE((SELECT array_agg(DISTINCT f ORDER BY f) FROM unnest(COALESCE(p_fields, '{}')) f), '{}');
    IF NOT (v_fields <@ ARRAY['avatar', 'display_name', 'banner', 'accent_color',
                              'server_nickname', 'server_avatar', 'server_banner']::text[]) THEN
        RAISE EXCEPTION 'invalid_sync_field' USING ERRCODE = '22023';
    END IF;
    UPDATE public.discord_migration_links l
       SET sync_fields = v_fields, last_synced_at = NULL
     WHERE l.server_id = p_server_id AND l.user_id = v_me;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'link_not_found' USING ERRCODE = 'P0002';
    END IF;
END;
$$;

-- The caller's own link {status, sync_fields, discord_joined_at}, or null.
CREATE OR REPLACE FUNCTION public.discord_migration_my_link(p_server_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
    SELECT jsonb_build_object('status', l.status, 'sync_fields', to_jsonb(l.sync_fields),
                              'discord_joined_at', l.discord_joined_at)
      FROM public.discord_migration_links l
     WHERE l.server_id = p_server_id AND l.user_id = public.get_current_profile_id()
$$;

-- A member's Discord join date, shown to other members of the server; null for a non-member caller.
CREATE OR REPLACE FUNCTION public.discord_migration_member_joined_at(p_server_id uuid, p_user_id uuid)
RETURNS timestamptz
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
    SELECT l.discord_joined_at
      FROM public.discord_migration_links l
     WHERE l.server_id = p_server_id AND l.user_id = p_user_id
       AND EXISTS (SELECT 1 FROM public.user_servers us
                    WHERE us.server_id = p_server_id AND us.status = 'accepted'
                      AND us.user_id = public.get_current_profile_id())
       AND EXISTS (SELECT 1 FROM public.user_servers us
                    WHERE us.server_id = p_server_id AND us.status = 'accepted' AND us.user_id = p_user_id)
$$;

-- The public landing page of /migrate/<token>: {server_id, server_name, icon_url} while the migration is open, else null.
-- Reachable signed out; it reveals nothing the link holder could not see by opening the migration.
CREATE OR REPLACE FUNCTION public.discord_migration_preview(p_token text)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
    SELECT jsonb_build_object('server_id', s.id, 'server_name', s.name, 'icon_url', s.icon)
      FROM public.discord_migrations m
      JOIN public.servers s ON s.id = m.server_id
     WHERE m.link_token = p_token AND m.state = 'open'
$$;

-- A manager lets a member kicked on Harmony claim again: kicked_on_harmony becomes left.
CREATE OR REPLACE FUNCTION public.discord_migration_allow_back(p_server_id uuid, p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
BEGIN
    PERFORM public.discord_migration_assert_manager(p_server_id);
    UPDATE public.discord_migration_links l
       SET status = 'left'
     WHERE l.server_id = p_server_id AND l.user_id = p_user_id AND l.status = 'kicked_on_harmony';
END;
$$;

-- [{user_id, username, display_name, discord_user_id, status, last_synced_at}]: the migration's links,
-- for the member list of the settings panel. Newest link first.
CREATE OR REPLACE FUNCTION public.discord_migration_members(p_server_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
BEGIN
    PERFORM public.discord_migration_assert_manager(p_server_id);
    RETURN COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
                   'user_id', l.user_id, 'username', p.username, 'display_name', p.display_name,
                   'discord_user_id', l.discord_user_id, 'status', l.status,
                   'last_synced_at', l.last_synced_at)
                   ORDER BY l.linked_at DESC, l.user_id)
          FROM public.discord_migration_links l
          JOIN public.profiles p ON p.id = l.user_id
         WHERE l.server_id = p_server_id), '[]'::jsonb);
END;
$$;

-- A kick on Harmony marks the member's link kicked_on_harmony, so neither claim nor sync brings them
-- back. Kicks the migration itself makes (harmony.via = discord_migration) leave the link alone.
CREATE OR REPLACE FUNCTION public.discord_migration_note_kick()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
BEGIN
    IF current_setting('harmony.via', true) = 'discord_migration' THEN
        RETURN NULL;
    END IF;
    UPDATE public.discord_migration_links l
       SET status = 'kicked_on_harmony'
     WHERE l.server_id = NEW.server_id AND l.user_id = NEW.user_id AND l.status <> 'banned';
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS z_membership_events_discord_migration ON public.server_membership_events;
CREATE TRIGGER z_membership_events_discord_migration
    AFTER INSERT ON public.server_membership_events
    FOR EACH ROW WHEN (NEW.event_type = 'kick')
    EXECUTE FUNCTION public.discord_migration_note_kick();

-- ---------------------------------------------------------------------------
-- Sync: roles, profile fields, timeouts, removals and the removal brake
-- ---------------------------------------------------------------------------
-- The gateway reads the guild on a schedule and calls these with service_role. Sync never adds members
-- and never touches the server owner; it never removes a holder of an ADMINISTRATOR role. Every write
-- the migration makes sets harmony.via = discord_migration, which silences the generic audit triggers,
-- and writes its own audit row (source system, details.via = discord_migration).

ALTER TABLE public.server_member_timeouts DROP CONSTRAINT IF EXISTS server_member_timeouts_source_check;
ALTER TABLE public.server_member_timeouts ADD CONSTRAINT server_member_timeouts_source_check
    CHECK (source IN ('moderator', 'automod', 'discord_migration'));

-- As 20261010600001, quiet while the migration writes its own row.
CREATE OR REPLACE FUNCTION public.server_audit_membership_events()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_payload jsonb := COALESCE(NEW.payload, '{}'::jsonb);
    v_by text;
    v_actor uuid;
    v_deleted integer;
BEGIN
    IF current_setting('harmony.via', true) = 'discord_migration' THEN
        RETURN NULL;
    END IF;
    v_by := COALESCE(v_payload ->> 'kicked_by', v_payload ->> 'banned_by', v_payload ->> 'unbanned_by');
    IF v_by ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
        v_actor := v_by::uuid;
    END IF;
    IF v_payload ->> 'messages_deleted' ~ '^[0-9]+$' THEN
        v_deleted := NULLIF((v_payload ->> 'messages_deleted')::integer, 0);
    END IF;

    PERFORM public.server_audit_write(
        NEW.server_id, 'member.' || NEW.event_type, 'user', NEW.user_id::text,
        (SELECT p.username FROM public.profiles p WHERE p.id = NEW.user_id),
        NULL,
        jsonb_build_object('messages_deleted', v_deleted),
        v_payload ->> 'reason',
        COALESCE(v_actor, NEW.initiated_by));
    RETURN NULL;
END;
$$;

-- As 20261010600001, quiet while the migration writes its own row.
CREATE OR REPLACE FUNCTION public.server_audit_timeouts()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_row public.server_member_timeouts := CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
    v_action text;
    v_automod boolean := v_row.source = 'automod';
BEGIN
    IF current_setting('harmony.via', true) = 'discord_migration' THEN
        RETURN NULL;
    END IF;
    IF TG_OP <> 'DELETE' AND NEW.until > now()
       AND (TG_OP = 'INSERT' OR NEW.until IS DISTINCT FROM OLD.until OR OLD.until <= now()) THEN
        v_action := 'member.timeout';
    ELSIF TG_OP <> 'INSERT' AND OLD.until > now() AND (TG_OP = 'DELETE' OR NEW.until <= now()) THEN
        v_action := 'member.timeout_remove';
        v_automod := false;
    ELSE
        RETURN NULL;
    END IF;

    PERFORM public.server_audit_write(
        v_row.server_id, v_action, 'user', v_row.user_id::text,
        (SELECT p.username FROM public.profiles p WHERE p.id = v_row.user_id),
        NULL,
        CASE WHEN v_action = 'member.timeout'
             THEN jsonb_build_object('until', NEW.until, 'automod', CASE WHEN v_automod THEN true END) END,
        CASE WHEN v_action = 'member.timeout' THEN NEW.reason END,
        CASE WHEN v_automod THEN NULL WHEN TG_OP <> 'DELETE' AND v_action = 'member.timeout' THEN NEW.created_by END,
        CASE WHEN v_automod THEN 'system' END);
    RETURN NULL;
END;
$$;

-- The kick and ban bodies without the caller's checks, so the migration can remove members with no
-- signed-in user. p_actor is the moderator (null for the migration). Not granted to any role.
CREATE OR REPLACE FUNCTION public._kick_server_member_internal(
    p_server_id uuid,
    p_user_id uuid,
    p_reason text DEFAULT NULL,
    p_actor uuid DEFAULT NULL,
    p_delete_message_seconds integer DEFAULT 0
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_deleted_count integer := 0;
    v_system_channel_id uuid;
    v_system_messages_enabled boolean;
BEGIN
    IF p_delete_message_seconds > 0 THEN
        UPDATE public.messages
        SET is_deleted = true, content = '[{"type":"text","content":"[message deleted]"}]'::jsonb
        WHERE user_id = p_user_id
          AND channel_id IN (SELECT id FROM public.channels WHERE server_id = p_server_id)
          AND created_at > now() - (p_delete_message_seconds || ' seconds')::interval
          AND is_deleted = false;
        GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
    END IF;

    -- Suppresses the "has left the server" trigger; "was kicked" is posted below.
    PERFORM set_config('harmony.skip_leave_message', '1', true);

    DELETE FROM public.user_servers
    WHERE user_id = p_user_id AND server_id = p_server_id;

    INSERT INTO public.server_membership_events (server_id, user_id, event_type, payload)
    VALUES (p_server_id, p_user_id, 'kick', jsonb_build_object(
        'kicked_by', p_actor,
        'reason', COALESCE(p_reason, ''),
        'messages_deleted', v_deleted_count
    ));

    SELECT system_channel_id, system_messages_enabled
      INTO v_system_channel_id, v_system_messages_enabled
    FROM public.server_settings WHERE server_id = p_server_id;
    IF v_system_messages_enabled IS NOT FALSE THEN
        IF v_system_channel_id IS NULL THEN
            v_system_channel_id := public.get_default_channel(p_server_id);
        END IF;
        IF v_system_channel_id IS NOT NULL THEN
            INSERT INTO public.messages (channel_id, content, is_system, metadata)
            VALUES (
                v_system_channel_id,
                jsonb_build_array(jsonb_build_object('type', 'text', 'text', 'was kicked from the server')),
                true,
                jsonb_build_object('type', 'member_kick', 'subject_id', p_user_id, 'actor_id', p_actor,
                                   'reason', COALESCE(p_reason, ''))
            );
        END IF;
    END IF;

    RETURN jsonb_build_object(
        'success', true,
        'messages_deleted', v_deleted_count
    );
END;
$$;

CREATE OR REPLACE FUNCTION public._ban_server_member_internal(
    p_server_id uuid,
    p_user_id uuid,
    p_reason text DEFAULT NULL,
    p_actor uuid DEFAULT NULL,
    p_delete_message_seconds integer DEFAULT 0
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_deleted_count integer := 0;
    v_already_banned boolean;
    v_system_channel_id uuid;
    v_system_messages_enabled boolean;
BEGIN
    SELECT EXISTS(
        SELECT 1 FROM public.server_bans
        WHERE server_id = p_server_id AND user_id = p_user_id
    ) INTO v_already_banned;

    IF v_already_banned THEN
        RETURN jsonb_build_object('success', true, 'already_banned', true, 'messages_deleted', 0);
    END IF;

    IF p_delete_message_seconds > 0 THEN
        UPDATE public.messages
        SET is_deleted = true, content = '[{"type":"text","content":"[message deleted]"}]'::jsonb
        WHERE user_id = p_user_id
          AND channel_id IN (SELECT id FROM public.channels WHERE server_id = p_server_id)
          AND created_at > now() - (p_delete_message_seconds || ' seconds')::interval
          AND is_deleted = false;
        GET DIAGNOSTICS v_deleted_count = ROW_COUNT;
    END IF;

    INSERT INTO public.server_bans (server_id, user_id, banned_by, reason, delete_message_seconds)
    VALUES (p_server_id, p_user_id, p_actor, p_reason, p_delete_message_seconds);

    -- Suppresses the "has left the server" trigger; "was banned" is posted below.
    PERFORM set_config('harmony.skip_leave_message', '1', true);

    DELETE FROM public.user_servers
    WHERE user_id = p_user_id AND server_id = p_server_id;

    DELETE FROM public.user_roles
    WHERE user_id = p_user_id AND server_id = p_server_id;

    INSERT INTO public.server_membership_events (server_id, user_id, event_type, payload)
    VALUES (p_server_id, p_user_id, 'ban', jsonb_build_object(
        'banned_by', p_actor,
        'reason', COALESCE(p_reason, ''),
        'messages_deleted', v_deleted_count
    ));

    SELECT system_channel_id, system_messages_enabled
      INTO v_system_channel_id, v_system_messages_enabled
    FROM public.server_settings WHERE server_id = p_server_id;
    IF v_system_messages_enabled IS NOT FALSE THEN
        IF v_system_channel_id IS NULL THEN
            v_system_channel_id := public.get_default_channel(p_server_id);
        END IF;
        IF v_system_channel_id IS NOT NULL THEN
            INSERT INTO public.messages (channel_id, content, is_system, metadata)
            VALUES (
                v_system_channel_id,
                jsonb_build_array(jsonb_build_object('type', 'text', 'text', 'was banned from the server')),
                true,
                jsonb_build_object('type', 'member_ban', 'subject_id', p_user_id, 'actor_id', p_actor,
                                   'reason', COALESCE(p_reason, ''))
            );
        END IF;
    END IF;

    RETURN jsonb_build_object(
        'success', true,
        'messages_deleted', v_deleted_count
    );
END;
$$;

REVOKE ALL ON FUNCTION public._kick_server_member_internal(uuid, uuid, text, uuid, integer)
    FROM PUBLIC, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION public._ban_server_member_internal(uuid, uuid, text, uuid, integer)
    FROM PUBLIC, anon, authenticated, service_role;

-- As 20261027200001; the work after the checks is _kick_server_member_internal.
CREATE OR REPLACE FUNCTION public.kick_server_member(
    p_server_id uuid,
    p_user_id uuid,
    p_reason text DEFAULT NULL,
    p_delete_message_seconds integer DEFAULT 0
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_caller_id uuid;
    v_is_owner boolean;
    v_has_permission boolean;
    v_caller_position integer;
    v_target_position integer;
    v_target_is_owner boolean;
BEGIN
    v_caller_id := public.get_current_profile_id();
    IF v_caller_id IS NULL THEN
        RAISE EXCEPTION 'Not authenticated';
    END IF;

    IF EXISTS (SELECT 1 FROM public.servers s WHERE s.id = p_server_id AND NOT s.is_local_server) THEN
        RAISE EXCEPTION 'Members of this server are moderated on its home instance' USING ERRCODE = '42501';
    END IF;

    IF v_caller_id = p_user_id THEN
        RAISE EXCEPTION 'Cannot kick yourself';
    END IF;

    SELECT (owner = p_user_id) INTO v_target_is_owner
    FROM public.servers WHERE id = p_server_id;
    IF v_target_is_owner THEN
        RAISE EXCEPTION 'Cannot kick the server owner';
    END IF;

    SELECT (owner = v_caller_id) INTO v_is_owner
    FROM public.servers WHERE id = p_server_id;
    -- A server without an owner has no owner path: NOT NULL would skip the permission check.
    v_is_owner := COALESCE(v_is_owner, false);

    IF NOT v_is_owner THEN
        SELECT COALESCE((public.get_user_permissions(v_caller_id, p_server_id)->>'KICK_MEMBERS')::boolean, false)
        INTO v_has_permission;
        IF NOT v_has_permission THEN
            RAISE EXCEPTION 'Missing KICK_MEMBERS permission';
        END IF;
    END IF;

    IF NOT v_is_owner THEN
        v_caller_position := public.get_user_highest_role_position(v_caller_id, p_server_id);
        v_target_position := public.get_user_highest_role_position(p_user_id, p_server_id);
        IF v_caller_position <= v_target_position THEN
            RAISE EXCEPTION 'Cannot kick a member with an equal or higher role';
        END IF;
    END IF;

    RETURN public._kick_server_member_internal(p_server_id, p_user_id, p_reason, v_caller_id,
                                               p_delete_message_seconds);
END;
$$;

-- As 20261027200001; the work after the checks is _ban_server_member_internal.
CREATE OR REPLACE FUNCTION public.ban_server_member(
    p_server_id uuid,
    p_user_id uuid,
    p_reason text DEFAULT NULL,
    p_delete_message_seconds integer DEFAULT 0
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_caller_id uuid;
    v_is_owner boolean;
    v_has_permission boolean;
    v_caller_position integer;
    v_target_position integer;
    v_target_is_owner boolean;
BEGIN
    v_caller_id := public.get_current_profile_id();
    IF v_caller_id IS NULL THEN
        RAISE EXCEPTION 'Not authenticated';
    END IF;

    IF EXISTS (SELECT 1 FROM public.servers s WHERE s.id = p_server_id AND NOT s.is_local_server) THEN
        RAISE EXCEPTION 'Members of this server are moderated on its home instance' USING ERRCODE = '42501';
    END IF;

    IF v_caller_id = p_user_id THEN
        RAISE EXCEPTION 'Cannot ban yourself';
    END IF;

    SELECT (owner = p_user_id) INTO v_target_is_owner
    FROM public.servers WHERE id = p_server_id;
    IF v_target_is_owner THEN
        RAISE EXCEPTION 'Cannot ban the server owner';
    END IF;

    SELECT (owner = v_caller_id) INTO v_is_owner
    FROM public.servers WHERE id = p_server_id;
    -- A server without an owner has no owner path: NOT NULL would skip the permission check.
    v_is_owner := COALESCE(v_is_owner, false);

    IF NOT v_is_owner THEN
        SELECT COALESCE((public.get_user_permissions(v_caller_id, p_server_id)->>'BAN_MEMBERS')::boolean, false)
        INTO v_has_permission;
        IF NOT v_has_permission THEN
            RAISE EXCEPTION 'Missing BAN_MEMBERS permission';
        END IF;
    END IF;

    IF NOT v_is_owner THEN
        v_caller_position := public.get_user_highest_role_position(v_caller_id, p_server_id);
        v_target_position := public.get_user_highest_role_position(p_user_id, p_server_id);
        IF v_caller_position <= v_target_position THEN
            RAISE EXCEPTION 'Cannot ban a member with an equal or higher role';
        END IF;
    END IF;

    RETURN public._ban_server_member_internal(p_server_id, p_user_id, p_reason, v_caller_id,
                                              p_delete_message_seconds);
END;
$$;

-- Open, unpaused migrations the gateway should sync now: a sync was asked for, or the last one is older
-- than p_interval (or there was none). Oldest first.
CREATE OR REPLACE FUNCTION public.discord_migration_due(
    p_limit integer DEFAULT 20, p_interval interval DEFAULT interval '6 hours')
RETURNS SETOF jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
    SELECT jsonb_build_object('server_id', m.server_id, 'discord_guild_id', m.discord_guild_id,
                              'credential_source', m.credential_source,
                              'sync_requested_at', m.sync_requested_at, 'last_sync_at', m.last_sync_at,
                              'sync_cursor', m.sync_cursor)
      FROM public.discord_migrations m
     WHERE m.state = 'open' AND m.sync_paused_reason IS NULL
       AND (m.sync_requested_at IS NOT NULL OR m.last_sync_at IS NULL OR m.last_sync_at < now() - p_interval)
     ORDER BY COALESCE(m.sync_requested_at, m.last_sync_at) NULLS FIRST, m.server_id
     LIMIT GREATEST(COALESCE(p_limit, 20), 0)
$$;

-- Active links, least recently synced first.
CREATE OR REPLACE FUNCTION public.discord_migration_links_batch(p_server_id uuid, p_limit integer)
RETURNS SETOF jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
    SELECT jsonb_build_object('user_id', l.user_id, 'discord_user_id', l.discord_user_id,
                              'sync_fields', to_jsonb(l.sync_fields))
      FROM public.discord_migration_links l
     WHERE l.server_id = p_server_id AND l.status = 'active'
     ORDER BY l.last_synced_at NULLS FIRST, l.user_id
     LIMIT GREATEST(COALESCE(p_limit, 0), 0)
$$;

-- Stops syncing the server until a manager resumes it, says so in the audit log and notifies the owner and
-- every accepted member who holds MANAGE_SERVER (discord_migration_paused: {server: {id, name}, reason}).
CREATE OR REPLACE FUNCTION public.discord_migration_pause(p_server_id uuid, p_reason text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_name text;
BEGIN
    UPDATE public.discord_migrations SET sync_paused_reason = p_reason, brake_override = false, updated_at = now()
     WHERE server_id = p_server_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'migration_not_configured' USING ERRCODE = 'P0002';
    END IF;
    SELECT s.name INTO v_name FROM public.servers s WHERE s.id = p_server_id;
    INSERT INTO public.notifications (user_id, type, data)
    SELECT r.user_id, 'discord_migration_paused',
           jsonb_build_object('server', jsonb_build_object('id', p_server_id, 'name', v_name), 'reason', p_reason)
      FROM (SELECT s.owner AS user_id FROM public.servers s WHERE s.id = p_server_id AND s.owner IS NOT NULL
            UNION
            SELECT us.user_id FROM public.user_servers us
             WHERE us.server_id = p_server_id AND us.status = 'accepted'
               AND public.has_permission(us.user_id, p_server_id, 'MANAGE_SERVER')) r;
    PERFORM public.server_audit_write(p_server_id, 'discord_migration.paused', 'server', p_server_id::text, NULL, NULL,
        jsonb_build_object('reason', p_reason, 'via', 'discord_migration'), NULL, NULL, 'system');
END;
$$;

-- Ends a sync pass: when it ran, what it found, where the next one starts. p_started_at is when the pass
-- began: a "Sync now" asked for after that moment stays pending (sync_requested_at is cleared only when it
-- is not later than p_started_at; a null p_started_at clears it). p_complete = false records a pass the
-- gateway stopped on its time budget with members left: the result and cursor are stored, last_sync_at does
-- not advance, and the migration stays due (sync_requested_at = now()) so the next run continues.
DROP FUNCTION IF EXISTS public.discord_migration_record_sync(uuid, jsonb, timestamptz);
DROP FUNCTION IF EXISTS public.discord_migration_record_sync(uuid, jsonb, timestamptz, timestamptz);
CREATE OR REPLACE FUNCTION public.discord_migration_record_sync(
    p_server_id uuid, p_result jsonb, p_cursor timestamptz, p_started_at timestamptz DEFAULT NULL,
    p_complete boolean DEFAULT true)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
BEGIN
    UPDATE public.discord_migrations
       SET last_sync_at = CASE WHEN COALESCE(p_complete, true) THEN now() ELSE last_sync_at END,
           last_sync_result = p_result, sync_cursor = p_cursor,
           brake_override = CASE WHEN COALESCE(p_complete, true) THEN false ELSE brake_override END,
           sync_requested_at = CASE WHEN NOT COALESCE(p_complete, true) THEN now()
                                    WHEN p_started_at IS NULL OR sync_requested_at <= p_started_at
                                    THEN NULL ELSE sync_requested_at END,
           updated_at = now()
     WHERE server_id = p_server_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'migration_not_configured' USING ERRCODE = 'P0002';
    END IF;
END;
$$;

-- Syncs one member from what the gateway read. Returns {skipped: 'not_member'|'no_link'} for anyone who is
-- not an accepted member with an active link (nothing changes), {candidate: 'left'|'banned'} when the member
-- is gone from Discord (nothing is removed here), otherwise {present: true, roles: {added, removed}}, plus
-- profile_error: true when the profile writes failed (the roles and the timeout are still applied) and
-- timeout_changed: true only when a discord_migration timeout row was written or deleted.
-- A key missing from p_member (role_ids, joined_at, timed_out_until, a profile field) was not fetched and
-- leaves that part alone.
CREATE OR REPLACE FUNCTION public.discord_migration_sync_member(
    p_server_id uuid, p_user_id uuid, p_member jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_link public.discord_migration_links;
    v_owner uuid;
    v_prev_via text;
    v_profile jsonb := COALESCE(p_member -> 'profile', '{}'::jsonb);
    v_fields text[];
    v_roles text[];
    v_role_result jsonb := jsonb_build_object('added', '[]'::jsonb, 'removed', '[]'::jsonb);
    v_server jsonb := '{}'::jsonb;
    v_color integer;
    v_until timestamptz;
    v_timeout public.server_member_timeouts;
    v_username text;
    v_profile_error boolean := false;
    v_timeout_changed boolean := false;
BEGIN
    IF p_member IS NULL OR jsonb_typeof(p_member) <> 'object' THEN
        RAISE EXCEPTION 'p_member must be a JSON object' USING ERRCODE = '22023';
    END IF;
    IF jsonb_typeof(v_profile) <> 'object' THEN
        v_profile := '{}'::jsonb;
    END IF;

    SELECT s.owner INTO v_owner FROM public.servers s WHERE s.id = p_server_id;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Server not found' USING ERRCODE = 'P0002';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.user_servers us
                    WHERE us.server_id = p_server_id AND us.user_id = p_user_id AND us.status = 'accepted') THEN
        RETURN jsonb_build_object('skipped', 'not_member');
    END IF;
    SELECT * INTO v_link FROM public.discord_migration_links l
     WHERE l.server_id = p_server_id AND l.user_id = p_user_id AND l.status = 'active';
    IF NOT FOUND THEN
        RETURN jsonb_build_object('skipped', 'no_link');
    END IF;

    IF NOT COALESCE((p_member ->> 'present')::boolean, false) THEN
        RETURN jsonb_build_object('candidate',
            CASE WHEN COALESCE((p_member ->> 'banned')::boolean, false) THEN 'banned' ELSE 'left' END);
    END IF;

    v_fields := v_link.sync_fields;
    SELECT p.username INTO v_username FROM public.profiles p WHERE p.id = p_user_id;

    -- Roles
    IF p_member ? 'role_ids' AND jsonb_typeof(p_member -> 'role_ids') = 'array' THEN
        SELECT COALESCE(array_agg(DISTINCT e), '{}') INTO v_roles
          FROM jsonb_array_elements_text(p_member -> 'role_ids') e WHERE e ~ '^[0-9]{1,20}$';
        v_role_result := public.discord_migration_apply_roles(p_server_id, p_user_id, v_roles);
        UPDATE public.discord_migration_links SET discord_role_ids = v_roles
         WHERE server_id = p_server_id AND user_id = p_user_id;
    END IF;
    IF p_member ? 'joined_at' AND jsonb_typeof(p_member -> 'joined_at') = 'string' THEN
        UPDATE public.discord_migration_links SET discord_joined_at = (p_member ->> 'joined_at')::timestamptz
         WHERE server_id = p_server_id AND user_id = p_user_id;
    END IF;

    -- Profile: only what the member opted into. A global value that is null leaves the profile alone.
    -- A write that fails (a value over its limit, say) skips the profile part and nothing else: the roles
    -- above stay applied. The result carries profile_error.
    BEGIN
        IF 'avatar' = ANY (v_fields) AND jsonb_typeof(v_profile -> 'avatar_url') = 'string' THEN
            UPDATE public.profiles SET avatar_url = v_profile ->> 'avatar_url' WHERE id = p_user_id;
        END IF;
        IF 'display_name' = ANY (v_fields) AND jsonb_typeof(v_profile -> 'display_name') = 'string' THEN
            UPDATE public.profiles SET display_name = v_profile ->> 'display_name' WHERE id = p_user_id;
        END IF;
        IF 'banner' = ANY (v_fields) AND jsonb_typeof(v_profile -> 'banner_url') = 'string' THEN
            UPDATE public.profiles SET banner_url = v_profile ->> 'banner_url' WHERE id = p_user_id;
        END IF;
        IF 'accent_color' = ANY (v_fields) AND jsonb_typeof(v_profile -> 'accent_color') = 'number'
           AND (v_profile ->> 'accent_color') ~ '^[0-9]{1,8}$' AND (v_profile ->> 'accent_color')::bigint <= 16777215 THEN
            v_color := (v_profile ->> 'accent_color')::integer;
            UPDATE public.profiles SET color = '#' || lpad(to_hex(v_color & 16777215), 6, '0') WHERE id = p_user_id;
        END IF;
        IF 'server_nickname' = ANY (v_fields) AND v_profile ? 'server_nickname' THEN
            v_server := v_server || jsonb_build_object('nickname', v_profile -> 'server_nickname');
        END IF;
        IF 'server_avatar' = ANY (v_fields) AND v_profile ? 'server_avatar_url' THEN
            v_server := v_server || jsonb_build_object('avatar_url', v_profile -> 'server_avatar_url');
        END IF;
        IF 'server_banner' = ANY (v_fields) AND v_profile ? 'server_banner_url' THEN
            v_server := v_server || jsonb_build_object('banner_url', v_profile -> 'server_banner_url');
        END IF;
        IF v_server <> '{}'::jsonb THEN
            PERFORM public.service_set_member_server_profile(p_server_id, p_user_id, v_server);
        END IF;
    EXCEPTION WHEN OTHERS THEN
        v_profile_error := true;
    END;

    -- Timeouts: Harmony's own (moderator, automod) are never replaced or lifted. The owner and
    -- Administrator holders cannot be timed out.
    IF p_member ? 'timed_out_until' THEN
        v_prev_via := current_setting('harmony.via', true);
        PERFORM set_config('harmony.via', 'discord_migration', true);
        v_until := CASE WHEN jsonb_typeof(p_member -> 'timed_out_until') = 'string'
                        THEN (p_member ->> 'timed_out_until')::timestamptz END;
        IF v_until IS NOT NULL AND v_until > now() THEN
            IF v_owner IS DISTINCT FROM p_user_id AND NOT public.has_permission(p_user_id, p_server_id, 'ADMINISTRATOR') THEN
                SELECT * INTO v_timeout FROM public.server_member_timeouts t
                 WHERE t.server_id = p_server_id AND t.user_id = p_user_id;
                IF NOT FOUND OR v_timeout.until <= now() OR v_timeout.source = 'discord_migration' THEN
                    INSERT INTO public.server_member_timeouts (server_id, user_id, until, reason, source)
                    VALUES (p_server_id, p_user_id, v_until, 'Timed out on Discord', 'discord_migration')
                    ON CONFLICT (server_id, user_id) DO UPDATE
                       SET until = EXCLUDED.until, reason = EXCLUDED.reason, source = EXCLUDED.source,
                           created_by = NULL, created_at = now();
                    IF v_timeout.user_id IS NULL OR v_timeout.until <= now() OR v_timeout.until IS DISTINCT FROM v_until THEN
                        v_timeout_changed := true;
                        PERFORM public.server_audit_write(p_server_id, 'member.timeout', 'user', p_user_id::text,
                            v_username, NULL,
                            jsonb_build_object('until', v_until, 'via', 'discord_migration'),
                            'Timed out on Discord', NULL, 'system');
                    END IF;
                END IF;
            END IF;
        ELSE
            DELETE FROM public.server_member_timeouts t
             WHERE t.server_id = p_server_id AND t.user_id = p_user_id AND t.source = 'discord_migration'
            RETURNING * INTO v_timeout;
            IF FOUND THEN
                v_timeout_changed := true;
            END IF;
            IF FOUND AND v_timeout.until > now() THEN
                PERFORM public.server_audit_write(p_server_id, 'member.timeout_remove', 'user', p_user_id::text,
                    v_username, NULL, jsonb_build_object('via', 'discord_migration'), NULL, NULL, 'system');
            END IF;
        END IF;
        PERFORM set_config('harmony.via', COALESCE(v_prev_via, ''), true);
    END IF;

    UPDATE public.discord_migration_links SET last_synced_at = now()
     WHERE server_id = p_server_id AND user_id = p_user_id;
    RETURN jsonb_build_object('present', true, 'roles', v_role_result, 'timeout_changed', v_timeout_changed)
        || CASE WHEN v_profile_error THEN jsonb_build_object('profile_error', true) ELSE '{}'::jsonb END;
END;
$$;

-- Removes members the gateway saw leave or get banned on Discord. p_candidates is [{user_id, kind}] with
-- kind left or banned. The removal brake pauses the whole batch instead when it would remove at least 3
-- members and more than removal_brake_pct of the active links, unless brake_override is set (a manager
-- resumed a removal_brake pause): then this call applies the batch and spends the override. The owner and Administrator holders are
-- skipped. Returns {paused: true} or {applied, skipped: [{user_id, reason}]}.
CREATE OR REPLACE FUNCTION public.discord_migration_apply_removals(p_server_id uuid, p_candidates jsonb)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
DECLARE
    v_mig public.discord_migrations;
    v_owner uuid;
    v_count integer;
    v_active integer;
    v_prev_via text := current_setting('harmony.via', true);
    v_cand jsonb;
    v_user uuid;
    v_kind text;
    v_link public.discord_migration_links;
    v_username text;
    v_applied integer := 0;
    v_res jsonb;
    v_skipped jsonb := '[]'::jsonb;
BEGIN
    IF p_candidates IS NULL OR jsonb_typeof(p_candidates) <> 'array' THEN
        RAISE EXCEPTION 'p_candidates must be a JSON array' USING ERRCODE = '22023';
    END IF;
    SELECT * INTO v_mig FROM public.discord_migrations m WHERE m.server_id = p_server_id FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'migration_not_configured' USING ERRCODE = 'P0002';
    END IF;
    IF v_mig.state <> 'open' THEN
        RETURN jsonb_build_object('applied', 0, 'skipped', '[]'::jsonb, 'closed', true);
    END IF;
    IF v_mig.sync_paused_reason IS NOT NULL THEN
        RETURN jsonb_build_object('paused', true);
    END IF;

    v_count := jsonb_array_length(p_candidates);
    SELECT count(*)::integer INTO v_active FROM public.discord_migration_links l
     WHERE l.server_id = p_server_id AND l.status = 'active';
    IF NOT v_mig.brake_override AND v_count >= 3 AND v_count * 100 > v_mig.removal_brake_pct * v_active THEN
        PERFORM public.discord_migration_pause(p_server_id, 'removal_brake');
        RETURN jsonb_build_object('paused', true);
    END IF;

    SELECT s.owner INTO v_owner FROM public.servers s WHERE s.id = p_server_id;
    PERFORM set_config('harmony.via', 'discord_migration', true);

    FOR v_cand IN SELECT * FROM jsonb_array_elements(p_candidates) LOOP
      v_user := NULL;
      BEGIN
        v_user := NULLIF(v_cand ->> 'user_id', '')::uuid;
        v_kind := v_cand ->> 'kind';
        IF v_user IS NULL OR v_kind IS NULL OR v_kind NOT IN ('left', 'banned') THEN
            v_skipped := v_skipped || jsonb_build_object('user_id', v_user, 'reason', 'invalid');
            CONTINUE;
        END IF;
        SELECT * INTO v_link FROM public.discord_migration_links l
         WHERE l.server_id = p_server_id AND l.user_id = v_user AND l.status = 'active';
        IF NOT FOUND THEN
            v_skipped := v_skipped || jsonb_build_object('user_id', v_user, 'reason', 'no_active_link');
            CONTINUE;
        END IF;
        IF v_owner IS NOT DISTINCT FROM v_user THEN
            v_skipped := v_skipped || jsonb_build_object('user_id', v_user, 'reason', 'owner');
            CONTINUE;
        END IF;
        IF public.has_permission(v_user, p_server_id, 'ADMINISTRATOR') THEN
            v_skipped := v_skipped || jsonb_build_object('user_id', v_user, 'reason', 'administrator');
            CONTINUE;
        END IF;

        SELECT p.username INTO v_username FROM public.profiles p WHERE p.id = v_user;
        IF v_kind = 'banned' THEN
            v_res := public._ban_server_member_internal(p_server_id, v_user, 'Banned on the Discord server');
            -- A ban row that already existed returns early; the user must still end up not a member.
            IF EXISTS (SELECT 1 FROM public.user_servers us WHERE us.server_id = p_server_id AND us.user_id = v_user) THEN
                PERFORM set_config('harmony.skip_leave_message', '1', true);
                DELETE FROM public.user_servers WHERE server_id = p_server_id AND user_id = v_user;
                DELETE FROM public.user_roles WHERE server_id = p_server_id AND user_id = v_user;
                v_res := v_res - 'already_banned';
            END IF;
            IF v_res ->> 'already_banned' IS DISTINCT FROM 'true' THEN
                PERFORM public.server_audit_write(p_server_id, 'member.ban', 'user', v_user::text, v_username, NULL,
                    jsonb_build_object('via', 'discord_migration'), 'Banned on the Discord server', NULL, 'system');
            END IF;
            UPDATE public.discord_migration_links SET status = 'banned'
             WHERE server_id = p_server_id AND user_id = v_user;
        ELSE
            IF EXISTS (SELECT 1 FROM public.user_servers us
                        WHERE us.server_id = p_server_id AND us.user_id = v_user) THEN
                PERFORM public._kick_server_member_internal(p_server_id, v_user, 'Left the Discord server');
                PERFORM public.server_audit_write(p_server_id, 'member.kick', 'user', v_user::text, v_username, NULL,
                    jsonb_build_object('via', 'discord_migration'), 'Left the Discord server', NULL, 'system');
            END IF;
            UPDATE public.discord_migration_links SET status = 'left'
             WHERE server_id = p_server_id AND user_id = v_user;
        END IF;
        v_applied := v_applied + 1;
      EXCEPTION WHEN OTHERS THEN
        v_skipped := v_skipped || jsonb_build_object('user_id', v_user, 'reason', 'error');
      END;
    END LOOP;

    PERFORM set_config('harmony.via', COALESCE(v_prev_via, ''), true);
    IF v_mig.brake_override THEN
        UPDATE public.discord_migrations SET brake_override = false WHERE server_id = p_server_id;
    END IF;
    RETURN jsonb_build_object('applied', v_applied, 'skipped', v_skipped);
END;
$$;

DO $$
DECLARE
    fn regprocedure;
BEGIN
    FOREACH fn IN ARRAY ARRAY[
        'public.discord_migration_claim(text)',
        'public.discord_migration_my_pending_claims()',
        'public.discord_migration_set_my_sync(uuid, text[])',
        'public.discord_migration_my_link(uuid)',
        'public.discord_migration_member_joined_at(uuid, uuid)',
        'public.discord_migration_allow_back(uuid, uuid)',
        'public.discord_migration_members(uuid)'
    ]::regprocedure[] LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated, service_role', fn);
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO authenticated', fn);
    END LOOP;

    REVOKE ALL ON FUNCTION public.discord_migration_preview(text) FROM PUBLIC, anon, authenticated, service_role;
    GRANT EXECUTE ON FUNCTION public.discord_migration_preview(text) TO anon, authenticated;

    FOREACH fn IN ARRAY ARRAY[
        'public.discord_migration_create_claim(uuid, jsonb, text[], timestamptz)',
        'public.discord_migration_bind_claim(text, uuid)',
        'public.discord_migration_apply_roles(uuid, uuid, text[])',
        'public.discord_migration_due(integer, interval)',
        'public.discord_migration_links_batch(uuid, integer)',
        'public.discord_migration_sync_member(uuid, uuid, jsonb)',
        'public.discord_migration_apply_removals(uuid, jsonb)',
        'public.discord_migration_pause(uuid, text)',
        'public.discord_migration_record_sync(uuid, jsonb, timestamptz, timestamptz, boolean)'
    ]::regprocedure[] LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn);
        EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO service_role', fn);
    END LOOP;

    REVOKE ALL ON FUNCTION public.discord_migration_note_kick() FROM PUBLIC, anon, authenticated, service_role;
END;
$$;

COMMIT;

NOTIFY pgrst, 'reload schema';
