-- Channel names by type, channel options at creation, and peer instance branding.
--
--   channel_name_normalized(name, type)
--        The naming rule src/utils/channelName.ts applies as the name is typed, over a name
--        sanitize_profile_string has cleaned (NFC; control, zero-width, bidi and BOM characters
--        removed; trimmed). Whitespace below is U+0020, U+00A0, U+1680, U+2000-U+200A, U+2028,
--        U+2029, U+202F, U+205F and U+3000.
--          voice (type 1)   a run of whitespace becomes one space; leading and trailing spaces
--                           go. Letter case, punctuation and emoji stay.
--          any other type   lowercase; each whitespace character becomes '-'; ASCII characters
--                           other than a-z, 0-9, '-' and '_' go; runs of '-' become one; leading
--                           and trailing '-' go. Characters outside ASCII stay, as on Discord.
--        lower() folds outside ASCII by the database's LC_CTYPE.
--   t_channels_name_rule
--        Applies the rule to a local channel's name on insert and when an update changes it:
--        create_channel, direct writes, server templates and the bot API alike. A channel from
--        another instance (is_remote) keeps its origin's name. A name the rule empties is
--        refused (23514). Stored names are not rewritten.
--   create_channel(..., p_description, p_slowmode_seconds, p_messages_encrypted,
--                  p_voice_encrypted, p_history_visibility)
--        As 20261026200001, with the options Create Channel offers set in the same transaction:
--        description, slowmode (0-21600 s), and the encryption the channel editor sets
--        (set_channel_encryption, set_channel_history_visibility; their checks apply). NULL
--        leaves the default. The six-argument signature is dropped: callers naming only its
--        arguments resolve to this one.
--   record_instance_branding(domain, icon_url, banner_url, theme_color)
--        One answered probe of a known instance (federation backend, GET /instances/probe):
--        each http(s) URL of at most 2048 characters and each #rgb[a]/#rrggbb[aa] colour
--        replaces the stored one in federated_instances.metadata (icon_url, banner_url,
--        theme_color); an absent or invalid value keeps it. metadata.branding_read_at is the
--        answer's time. No row is created. Service callers only.
--
-- Converges by state: rerunning changes nothing.

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- Naming rule
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.channel_name_normalized(p_name text, p_type integer)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = public, pg_temp
AS $$
    SELECT CASE
        WHEN p_name IS NULL THEN NULL
        WHEN COALESCE(p_type, 0) = 1 THEN
            btrim(regexp_replace(p_name, U&'[ \00A0\1680\2000-\200A\2028\2029\202F\205F\3000]+', ' ', 'g'), ' ')
        ELSE
            btrim(
                regexp_replace(
                    regexp_replace(
                        regexp_replace(lower(p_name), U&'[ \00A0\1680\2000-\200A\2028\2029\202F\205F\3000]', '-', 'g'),
                        '[!-,./:-^`{-~]', '', 'g'),
                    '-{2,}', '-', 'g'),
                '-')
    END
$$;
COMMENT ON FUNCTION public.channel_name_normalized(text, integer) IS
    'A channel name under the rule of its type: voice keeps spaces and case; other types are lowercase with ''-'' for spaces. Mirrors src/utils/channelName.ts.';

-- The name rule trigger runs as the writer.
REVOKE ALL ON FUNCTION public.channel_name_normalized(text, integer) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.channel_name_normalized(text, integer) TO authenticated, service_role;

CREATE OR REPLACE FUNCTION public.apply_channel_name_rule()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NEW.is_remote IS TRUE THEN
        RETURN NEW;
    END IF;
    IF TG_OP = 'UPDATE' AND NEW.name IS NOT DISTINCT FROM OLD.name THEN
        RETURN NEW;
    END IF;
    NEW.name := public.channel_name_normalized(NEW.name, NEW.type);
    IF COALESCE(NEW.name, '') = '' THEN
        RAISE EXCEPTION 'channel name has no characters the naming rule keeps' USING ERRCODE = 'check_violation';
    END IF;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.apply_channel_name_rule() FROM PUBLIC, anon, authenticated;

-- BEFORE triggers run in name order: after sanitize_channel_text_trigger, before
-- trigger_federate_channel.
DROP TRIGGER IF EXISTS t_channels_name_rule ON public.channels;
CREATE TRIGGER t_channels_name_rule
    BEFORE INSERT OR UPDATE OF name ON public.channels
    FOR EACH ROW EXECUTE FUNCTION public.apply_channel_name_rule();

-- ---------------------------------------------------------------------------
-- create_channel: as 20261026200001_private_categories.sql, plus the creation options.
-- ---------------------------------------------------------------------------

DROP FUNCTION IF EXISTS public.create_channel(uuid, text, integer, uuid, boolean, uuid[]);

CREATE OR REPLACE FUNCTION public.create_channel(
    p_server_id uuid,
    p_name text,
    p_type integer DEFAULT 0,
    p_category uuid DEFAULT NULL,
    p_private boolean DEFAULT false,
    p_allowed_role_ids uuid[] DEFAULT '{}'::uuid[],
    p_description text DEFAULT NULL,
    p_slowmode_seconds integer DEFAULT NULL,
    p_messages_encrypted boolean DEFAULT NULL,
    p_voice_encrypted boolean DEFAULT NULL,
    p_history_visibility text DEFAULT NULL)
RETURNS public.channels
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_id uuid := gen_random_uuid();
    v_channel public.channels%ROWTYPE;
    v_everyone uuid;
    v_role uuid;
BEGIN
    IF p_slowmode_seconds IS NOT NULL AND p_slowmode_seconds NOT BETWEEN 0 AND 21600 THEN
        RAISE EXCEPTION 'Slowmode must be 0 to 21600 seconds' USING ERRCODE = '22023';
    END IF;

    INSERT INTO public.channels (id, name, server_id, type, category, description, slowmode_seconds)
    VALUES (v_id, p_name, p_server_id, COALESCE(p_type, 0), p_category,
            NULLIF(btrim(p_description), ''), COALESCE(p_slowmode_seconds, 0));

    IF p_private IS TRUE THEN
        SELECT id INTO v_everyone
          FROM public.server_roles
         WHERE server_id = p_server_id AND is_default = true;
        IF v_everyone IS NULL THEN
            RAISE EXCEPTION 'Server has no @everyone role' USING ERRCODE = 'P0002';
        END IF;

        -- VIEW_CHANNEL is bit 1. The role allows go first: the grant guard requires the caller
        -- to hold VIEW_CHANNEL in the channel, which the @everyone deny takes from a manager
        -- without ADMINISTRATOR.
        FOREACH v_role IN ARRAY COALESCE(p_allowed_role_ids, '{}'::uuid[]) LOOP
            CONTINUE WHEN v_role = v_everyone;
            IF NOT EXISTS (SELECT 1 FROM public.server_roles
                            WHERE id = v_role AND server_id = p_server_id) THEN
                RAISE EXCEPTION 'Role % is not a role of this server', v_role USING ERRCODE = '22023';
            END IF;
            INSERT INTO public.channel_permission_overrides AS cpo
                   (channel_id, target_type, role_id, user_id, allow_permissions, deny_permissions)
            VALUES (v_id, 'role', v_role, NULL, 2, 0)
            ON CONFLICT (channel_id, role_id) WHERE user_id IS NULL DO UPDATE
               SET allow_permissions = COALESCE(cpo.allow_permissions, 0) | 2,
                   deny_permissions = COALESCE(cpo.deny_permissions, 0) & ~2::bigint,
                   updated_at = now();
        END LOOP;

        INSERT INTO public.channel_permission_overrides AS cpo
               (channel_id, target_type, role_id, user_id, allow_permissions, deny_permissions)
        VALUES (v_id, 'role', v_everyone, NULL, 0, 2)
        ON CONFLICT (channel_id, role_id) WHERE user_id IS NULL DO UPDATE
           SET allow_permissions = COALESCE(cpo.allow_permissions, 0) & ~2::bigint,
               deny_permissions = COALESCE(cpo.deny_permissions, 0) | 2,
               updated_at = now();
    END IF;

    IF p_messages_encrypted IS NOT NULL OR p_voice_encrypted IS NOT NULL THEN
        PERFORM public.set_channel_encryption(v_id, p_messages_encrypted, p_voice_encrypted);
    END IF;
    IF p_history_visibility IS NOT NULL THEN
        PERFORM public.set_channel_history_visibility(v_id, p_history_visibility);
    END IF;

    SELECT * INTO v_channel FROM public.channels WHERE id = v_id;
    IF NOT FOUND THEN
        v_channel.id := v_id;
        v_channel.server_id := p_server_id;
        v_channel.name := public.channel_name_normalized(p_name, COALESCE(p_type, 0));
        v_channel.type := COALESCE(p_type, 0);
        v_channel.category := p_category;
    END IF;
    RETURN v_channel;
END;
$$;
COMMENT ON FUNCTION public.create_channel(uuid, text, integer, uuid, boolean, uuid[], text, integer, boolean, boolean, text) IS
    'Create a channel as the caller (RLS applies); in a category it receives the category''s permissions; private: @everyone VIEW_CHANNEL denied, listed roles allowed; description, slowmode and encryption set in the same transaction.';

REVOKE ALL ON FUNCTION public.create_channel(uuid, text, integer, uuid, boolean, uuid[], text, integer, boolean, boolean, text)
    FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.create_channel(uuid, text, integer, uuid, boolean, uuid[], text, integer, boolean, boolean, text)
    TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Peer instance branding
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.record_instance_branding(
    p_domain text,
    p_icon_url text,
    p_banner_url text,
    p_theme_color text
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_domain text := lower(btrim(p_domain));
    v_icon text := CASE WHEN char_length(p_icon_url) <= 2048 AND p_icon_url ~ '^https?://[^[:space:]]+$'
                        THEN p_icon_url END;
    v_banner text := CASE WHEN char_length(p_banner_url) <= 2048 AND p_banner_url ~ '^https?://[^[:space:]]+$'
                          THEN p_banner_url END;
    v_color text := CASE WHEN p_theme_color ~ '^#([0-9A-Fa-f]{3,4}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$'
                         THEN p_theme_color END;
BEGIN
    IF current_setting('role', true) IN ('anon', 'authenticated') THEN
        RAISE EXCEPTION 'record_instance_branding is internal' USING ERRCODE = '42501';
    END IF;
    IF NULLIF(v_domain, '') IS NULL THEN
        RAISE EXCEPTION 'a domain is required' USING ERRCODE = '22023';
    END IF;

    UPDATE public.federated_instances
       SET metadata = CASE WHEN jsonb_typeof(metadata) = 'object' THEN metadata ELSE '{}'::jsonb END
                      || jsonb_strip_nulls(jsonb_build_object('icon_url', v_icon, 'banner_url', v_banner,
                                                              'theme_color', v_color))
                      || jsonb_build_object('branding_read_at', now()),
           updated_at = now()
     WHERE domain = v_domain;
    RETURN FOUND;
END;
$$;
COMMENT ON FUNCTION public.record_instance_branding(text, text, text, text) IS
    'One answered probe of a known instance: its icon, banner and theme colour where given and valid; absent values keep the stored ones.';

DO $$
DECLARE
    grantee text;
BEGIN
    REVOKE ALL ON FUNCTION public.record_instance_branding(text, text, text, text)
        FROM PUBLIC, anon, authenticated;
    FOREACH grantee IN ARRAY ARRAY['postgres', 'supabase_admin', 'service_role'] LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = grantee) THEN
            EXECUTE format('GRANT EXECUTE ON FUNCTION public.record_instance_branding(text, text, text, text) TO %I',
                           grantee);
        END IF;
    END LOOP;
END;
$$;

NOTIFY pgrst, 'reload schema';

COMMIT;
