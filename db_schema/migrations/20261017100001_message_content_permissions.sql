-- EMBED_LINKS, USE_EXTERNAL_EMOJIS and READ_MESSAGE_HISTORY enforced for members of local
-- servers. Conversations, remote server copies and server-side writers are exempt, as for
-- ATTACH_FILES and ADD_REACTIONS (20261016100005).
--
-- EMBED_LINKS (bit 16): a client message on a local server channel with url or embed parts from
-- an author without it there is stored with metadata.suppress_embeds. An edit that adds a link
-- gets the same. set_message_embeds_suppressed refuses to lift suppression while the author
-- lacks it in the channel.
--
-- USE_EXTERNAL_EMOJIS (bit 19): without it, a member's message or reaction on a local server
-- channel uses unicode and the server's own emoji only: an emojis row with scope 'server' of
-- that server, or a Discord emoji imported into it (emojis.discord_emoji_id). Any other custom
-- emoji (another server's, instance, personal, remote) is refused. A message part names an
-- emojis row only when its url is the row's url or empty. An edit is checked for the emoji it
-- adds. Joining an existing reaction is no exemption.
--
-- READ_MESSAGE_HISTORY (bit 22), as Discord: without it in a local server channel, a member
-- reads the channel's messages created since they opened it in the current app session.
-- begin_channel_history_view records that start in channel_history_views; until it runs the
-- member reads none, and the start is never earlier than the membership. Own messages stay
-- readable, unlike Discord: they disclose nothing. Applies to messages and
-- message_search_index RLS (and through them get_message_page, pins, threads, polls,
-- postgres_changes delivery), search_messages and get_message_polls. A message event broadcast
-- for a row created before the transaction, in a channel that withholds the bit from anyone,
-- carries ids and restricted: true; subscribers re-read the row through RLS.
--
-- Converges by state: rerunning changes nothing.

BEGIN;

SET LOCAL lock_timeout = '3s';

-- ---------------------------------------------------------------------------
-- Shared helpers
-- ---------------------------------------------------------------------------

-- The helpers are plpgsql: their plans are cached per session, where a sql body called from a
-- trigger is planned on every call (channel_grants_everyone measured 320 us as sql, 30 us as
-- plpgsql).

-- True when every member holds p_bit in the channel: @everyone holds ADMINISTRATOR, or holds
-- p_bit after its channel override and no role or member override on the channel denies it.
-- Mirrors channel_is_restricted for an arbitrary bit.
CREATE OR REPLACE FUNCTION public.channel_grants_everyone(p_channel_id uuid, p_bit bigint)
RETURNS boolean
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_everyone uuid;
    v_base bigint;
    v_allow bigint;
    v_deny bigint;
BEGIN
    SELECT ev.id, COALESCE(ev.permissions, 0), COALESCE(eo.allow_permissions, 0), COALESCE(eo.deny_permissions, 0)
      INTO v_everyone, v_base, v_allow, v_deny
      FROM public.channels c
      JOIN public.server_roles ev ON ev.server_id = c.server_id AND ev.is_default = true
      LEFT JOIN public.channel_permission_overrides eo
             ON eo.channel_id = c.id AND eo.role_id = ev.id AND eo.user_id IS NULL
     WHERE c.id = p_channel_id;
    IF NOT FOUND THEN
        RETURN false;
    END IF;
    IF (v_base & 1) <> 0 THEN
        RETURN true;
    END IF;
    IF (((v_base & ~v_deny) | v_allow) & p_bit) = 0 THEN
        RETURN false;
    END IF;
    RETURN NOT EXISTS (
        SELECT 1 FROM public.channel_permission_overrides o
         WHERE o.channel_id = p_channel_id
           AND (o.role_id IS DISTINCT FROM v_everyone OR o.user_id IS NOT NULL)
           AND (COALESCE(o.deny_permissions, 0) & p_bit) <> 0);
END;
$$;

REVOKE ALL ON FUNCTION public.channel_grants_everyone(uuid, bigint) FROM PUBLIC, anon, authenticated;

-- Custom emoji named by a message's emoji parts, sorted:
--   id:<uuid>|<url>      an emojis row; url is the part's url, empty when absent
--   discord:<snowflake>  a Discord CDN emoji or a discord:[a:]<name>:<id> token
--   url:<url>            any other image
-- Parts without an id or url (unicode wrappers) name nothing.
CREATE OR REPLACE FUNCTION public.message_custom_emoji_keys(p_content jsonb)
RETURNS text[]
LANGUAGE plpgsql
IMMUTABLE
AS $$
BEGIN
    IF jsonb_typeof(p_content) IS DISTINCT FROM 'array' THEN
        RETURN '{}';
    END IF;
    RETURN ARRAY(
        SELECT DISTINCT k
          FROM (SELECT CASE
                           WHEN e #>> '{emoji,id}' ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
                               THEN 'id:' || lower(e #>> '{emoji,id}') || '|' || COALESCE(e #>> '{emoji,url}', '')
                           WHEN e #>> '{emoji,url}' ~ '^https://(cdn\.discordapp\.com|media\.discordapp\.net)/emojis/[0-9]{17,20}\.'
                               THEN 'discord:' || substring(e #>> '{emoji,url}' from '/emojis/([0-9]{17,20})\.')
                           WHEN e #>> '{emoji,id}' ~ '^discord:(a:)?[A-Za-z0-9_]{2,32}:[0-9]{17,20}$'
                               THEN 'discord:' || substring(e #>> '{emoji,id}' from '([0-9]{17,20})$')
                           WHEN COALESCE(e #>> '{emoji,url}', '') <> ''
                               THEN 'url:' || (e #>> '{emoji,url}')
                       END AS k
                  FROM jsonb_array_elements(p_content) e
                 WHERE jsonb_typeof(e) = 'object' AND e ->> 'type' = 'emoji') x
         WHERE k IS NOT NULL
         ORDER BY k);
END;
$$;

REVOKE ALL ON FUNCTION public.message_custom_emoji_keys(jsonb) FROM PUBLIC, anon, authenticated;

-- Keys of message_custom_emoji_keys that are not the server's own emoji.
CREATE OR REPLACE FUNCTION public.external_emoji_keys(p_keys text[], p_server_id uuid)
RETURNS text[]
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    RETURN ARRAY(
        SELECT k
          FROM unnest(p_keys) k
         WHERE NOT CASE
             WHEN k LIKE 'id:%' THEN EXISTS (
                 SELECT 1 FROM public.emojis e
                  WHERE e.id = split_part(substr(k, 4), '|', 1)::uuid
                    AND e.scope = 'server'
                    AND e.server_id = p_server_id
                    AND (substr(k, 41) = '' OR substr(k, 41) = e.url))
             WHEN k LIKE 'discord:%' THEN EXISTS (
                 SELECT 1 FROM public.emojis e
                  WHERE e.server_id = p_server_id
                    AND e.discord_emoji_id = substr(k, 9))
             ELSE false
         END);
END;
$$;

REVOKE ALL ON FUNCTION public.external_emoji_keys(text[], uuid) FROM PUBLIC, anon, authenticated;

-- ---------------------------------------------------------------------------
-- EMBED_LINKS and USE_EXTERNAL_EMOJIS on messages
-- ---------------------------------------------------------------------------

-- Runs after a_messages_client_write_guard, which refuses a client-set suppress_embeds.
-- Definer: as the invoker, the channels lookup pays channels RLS (about 0.5 ms).
CREATE OR REPLACE FUNCTION public.enforce_message_content_permissions()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_links boolean;
    v_emoji boolean;
    v_keys text[];
    v_server uuid;
    v_perms jsonb;
BEGIN
    IF pg_trigger_depth() > 1 OR jsonb_typeof(NEW.content) IS DISTINCT FROM 'array' THEN
        RETURN NEW;
    END IF;

    v_links := COALESCE(NEW.metadata -> 'suppress_embeds', 'false'::jsonb) <> 'true'::jsonb
               AND jsonb_path_exists(NEW.content, '$[*] ? (@.type == "url" || @.type == "embed")');
    v_emoji := jsonb_path_exists(NEW.content, '$[*] ? (@.type == "emoji")');
    IF NOT v_links AND NOT v_emoji THEN
        RETURN NEW;
    END IF;

    SELECT c.server_id INTO v_server
      FROM public.channels c
      JOIN public.servers s ON s.id = c.server_id
     WHERE c.id = NEW.channel_id
       AND s.is_local_server IS NOT FALSE;
    IF v_server IS NULL THEN
        RETURN NEW;
    END IF;

    IF v_links AND NOT public.channel_grants_everyone(NEW.channel_id, 65536) THEN
        v_perms := public.get_user_permissions(public.get_current_profile_id(), v_server, NEW.channel_id);
        IF (v_perms ->> 'EMBED_LINKS') IS DISTINCT FROM 'true' THEN
            NEW.metadata := COALESCE(CASE WHEN jsonb_typeof(NEW.metadata) = 'object' THEN NEW.metadata END, '{}'::jsonb)
                            || '{"suppress_embeds": true}'::jsonb;
        END IF;
    END IF;

    IF v_emoji AND NOT public.channel_grants_everyone(NEW.channel_id, 524288) THEN
        v_keys := public.message_custom_emoji_keys(NEW.content);
        IF TG_OP = 'UPDATE' AND cardinality(v_keys) > 0 THEN
            v_keys := ARRAY(SELECT unnest(v_keys)
                            EXCEPT
                            SELECT unnest(public.message_custom_emoji_keys(OLD.content)));
        END IF;
        IF cardinality(public.external_emoji_keys(v_keys, v_server)) > 0 THEN
            v_perms := COALESCE(v_perms,
                                public.get_user_permissions(public.get_current_profile_id(), v_server, NEW.channel_id));
            IF (v_perms ->> 'USE_EXTERNAL_EMOJIS') IS DISTINCT FROM 'true' THEN
                RAISE EXCEPTION 'Missing permission: USE_EXTERNAL_EMOJIS' USING ERRCODE = '42501';
            END IF;
        END IF;
    END IF;

    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_message_content_permissions() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS a_messages_content_permissions ON public.messages;
CREATE TRIGGER a_messages_content_permissions
    BEFORE INSERT OR UPDATE OF content ON public.messages
    FOR EACH ROW
    WHEN (CURRENT_USER = ANY (ARRAY['authenticated'::name, 'anon'::name]) AND NEW.channel_id IS NOT NULL)
    EXECUTE FUNCTION public.enforce_message_content_permissions();

-- As 20261010200001; lifting suppression needs EMBED_LINKS for the author in a local server
-- channel.
CREATE OR REPLACE FUNCTION public.set_message_embeds_suppressed(p_message_id uuid, p_suppressed boolean)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_caller uuid := public.get_current_profile_id();
    v_msg record;
    v_server uuid;
    v_local boolean;
BEGIN
    IF v_caller IS NULL THEN
        RAISE EXCEPTION 'Authentication required' USING ERRCODE = '42501';
    END IF;
    IF p_suppressed IS NULL THEN
        RAISE EXCEPTION 'p_suppressed is required' USING ERRCODE = '22004';
    END IF;

    SELECT id, user_id, channel_id, conversation_id, is_deleted, is_system
      INTO v_msg
      FROM public.messages WHERE id = p_message_id;
    IF NOT FOUND OR v_msg.is_deleted IS TRUE THEN
        RAISE EXCEPTION 'Message not found' USING ERRCODE = 'P0002';
    END IF;

    IF v_msg.channel_id IS NOT NULL THEN
        SELECT c.server_id, s.is_local_server IS NOT FALSE INTO v_server, v_local
          FROM public.channels c
          JOIN public.servers s ON s.id = c.server_id
         WHERE c.id = v_msg.channel_id;
    END IF;

    IF v_msg.user_id IS DISTINCT FROM v_caller THEN
        IF v_msg.channel_id IS NULL THEN
            RAISE EXCEPTION 'Only the author changes embeds in a direct message' USING ERRCODE = '42501';
        END IF;
        IF NOT public.has_permission(v_caller, v_server, 'MANAGE_MESSAGES', v_msg.channel_id) THEN
            RAISE EXCEPTION 'Permission denied: MANAGE_MESSAGES required' USING ERRCODE = '42501';
        END IF;
    END IF;

    IF NOT p_suppressed AND v_local AND v_msg.user_id IS NOT NULL
       AND NOT public.channel_grants_everyone(v_msg.channel_id, 65536)
       AND NOT public.has_permission(v_msg.user_id, v_server, 'EMBED_LINKS', v_msg.channel_id) THEN
        RAISE EXCEPTION 'Missing permission: EMBED_LINKS' USING ERRCODE = '42501';
    END IF;

    UPDATE public.messages
       SET metadata = CASE WHEN p_suppressed
                           THEN COALESCE(CASE WHEN jsonb_typeof(metadata) = 'object' THEN metadata END, '{}'::jsonb)
                                || jsonb_build_object('suppress_embeds', true)
                           ELSE COALESCE(CASE WHEN jsonb_typeof(metadata) = 'object' THEN metadata END, '{}'::jsonb)
                                - 'suppress_embeds'
                      END
     WHERE id = p_message_id;

    RETURN p_suppressed;
END;
$$;

REVOKE ALL ON FUNCTION public.set_message_embeds_suppressed(uuid, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_message_embeds_suppressed(uuid, boolean) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- USE_EXTERNAL_EMOJIS on reactions
-- ---------------------------------------------------------------------------

-- custom_emoji_content holds unicode, a Discord token discord:[a:]<name>:<id>, or a remote
-- shortcode :<name>:. The WHEN clause passes unicode by. Definer: as the invoker, the messages
-- lookup pays messages RLS (about 0.6 ms); reactions_insert_own still decides visibility.
CREATE OR REPLACE FUNCTION public.enforce_reaction_external_emoji()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_channel uuid;
    v_server uuid;
    v_key text;
BEGIN
    IF pg_trigger_depth() > 1 THEN
        RETURN NEW;
    END IF;

    IF NEW.emoji_id IS NOT NULL THEN
        v_key := 'id:' || NEW.emoji_id::text || '|';
    ELSIF NEW.custom_emoji_content ~ '^discord:(a:)?[A-Za-z0-9_]{2,32}:[0-9]{17,20}$' THEN
        v_key := 'discord:' || substring(NEW.custom_emoji_content from '([0-9]{17,20})$');
    ELSE
        v_key := 'url:' || NEW.custom_emoji_content;
    END IF;

    SELECT m.channel_id, c.server_id INTO v_channel, v_server
      FROM public.messages m
      JOIN public.channels c ON c.id = m.channel_id
      JOIN public.servers s ON s.id = c.server_id
     WHERE m.id = NEW.message_id
       AND s.is_local_server IS NOT FALSE;
    IF v_server IS NULL
       OR public.channel_grants_everyone(v_channel, 524288)
       OR cardinality(public.external_emoji_keys(ARRAY[v_key], v_server)) = 0
       OR public.has_permission(public.get_current_profile_id(), v_server, 'USE_EXTERNAL_EMOJIS', v_channel) THEN
        RETURN NEW;
    END IF;

    RAISE EXCEPTION 'Missing permission: USE_EXTERNAL_EMOJIS' USING ERRCODE = '42501';
END;
$$;

REVOKE ALL ON FUNCTION public.enforce_reaction_external_emoji() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS a_reactions_external_emoji ON public.reactions;
CREATE TRIGGER a_reactions_external_emoji
    BEFORE INSERT ON public.reactions
    FOR EACH ROW
    WHEN (CURRENT_USER = ANY (ARRAY['authenticated'::name, 'anon'::name])
          AND (NEW.emoji_id IS NOT NULL
               OR NEW.custom_emoji_content ~ '^discord:(a:)?[A-Za-z0-9_]{2,32}:[0-9]{17,20}$'
               OR NEW.custom_emoji_content ~ '^:[^:[:space:]]+:$'))
    EXECUTE FUNCTION public.enforce_reaction_external_emoji();

-- ---------------------------------------------------------------------------
-- READ_MESSAGE_HISTORY
-- ---------------------------------------------------------------------------

-- Both predicates are equalities: the planner's default selectivity for = picks the index, for
-- <> a sequential scan.
CREATE INDEX IF NOT EXISTS idx_channel_permission_overrides_history_deny
    ON public.channel_permission_overrides (channel_id)
    WHERE (deny_permissions & 4194304) = 4194304;
CREATE INDEX IF NOT EXISTS idx_server_roles_default_without_history
    ON public.server_roles (server_id)
    WHERE is_default = true AND (permissions & 4194305) = 0;

-- Start of a member's view of a channel that withholds READ_MESSAGE_HISTORY from them.
CREATE TABLE IF NOT EXISTS public.channel_history_views (
    user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    channel_id uuid NOT NULL REFERENCES public.channels(id) ON DELETE CASCADE,
    since timestamptz NOT NULL,
    PRIMARY KEY (user_id, channel_id)
);
CREATE INDEX IF NOT EXISTS idx_channel_history_views_channel ON public.channel_history_views (channel_id);
ALTER TABLE public.channel_history_views ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS channel_history_views_service_role ON public.channel_history_views;
CREATE POLICY channel_history_views_service_role ON public.channel_history_views
    FOR ALL TO service_role USING (true) WITH CHECK (true);
REVOKE ALL ON public.channel_history_views FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.channel_history_views TO service_role;

-- {"<channel uuid>": "<view start>"} for the local server channels where the current profile
-- lacks READ_MESSAGE_HISTORY; NULL when there are none. The start is the later of the
-- channel_history_views row and the membership, 'infinity' without a row. Only servers whose @everyone lacks the
-- bit, or that carry an override denying it, are resolved per channel, layered as
-- get_user_permissions: @everyone, then role, then member overrides.
CREATE OR REPLACE FUNCTION public.current_user_history_cutoffs()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_me uuid;
    v_map jsonb;
    v_part jsonb;
    v_mask bigint;
    v_roles uuid[];
    r record;
BEGIN
    -- No local server withholds the bit: no @everyone without it, no override denying it. Two
    -- probes of the partial indexes, about 10 us.
    PERFORM 1
       FROM public.server_roles sr
       JOIN public.servers s ON s.id = sr.server_id
      WHERE sr.is_default = true AND (sr.permissions & 4194305) = 0 AND s.is_local_server IS NOT FALSE
      LIMIT 1;
    IF NOT FOUND THEN
        PERFORM 1
           FROM public.channel_permission_overrides o
           JOIN public.channels c ON c.id = o.channel_id
           JOIN public.servers s ON s.id = c.server_id
          WHERE (o.deny_permissions & 4194304) = 4194304 AND s.is_local_server IS NOT FALSE
          LIMIT 1;
        IF NOT FOUND THEN
            RETURN NULL;
        END IF;
    END IF;

    -- get_current_profile_id inlined: its SET search_path costs as much as the lookup.
    SELECT p.id INTO v_me FROM public.profiles p WHERE p.auth_user_id = auth.uid() LIMIT 1;
    IF v_me IS NULL THEN
        RETURN NULL;
    END IF;

    -- The member's servers among the two sets above; the rest are never scanned.
    FOR r IN
        SELECT us.server_id, us.created_at AS joined_at, ev.id AS everyone_id,
               COALESCE(ev.permissions, 0) AS everyone_mask
          FROM (SELECT sr.server_id
                  FROM public.server_roles sr
                 WHERE sr.is_default = true AND (sr.permissions & 4194305) = 0
                UNION
                SELECT c.server_id
                  FROM public.channel_permission_overrides o
                  JOIN public.channels c ON c.id = o.channel_id
                 WHERE (o.deny_permissions & 4194304) = 4194304) open_to_restriction
          JOIN public.user_servers us
            ON us.server_id = open_to_restriction.server_id AND us.user_id = v_me AND us.status = 'accepted'
          JOIN public.servers s ON s.id = us.server_id
          JOIN public.server_roles ev ON ev.server_id = us.server_id AND ev.is_default = true
         WHERE s.owner IS DISTINCT FROM v_me
           AND s.is_local_server IS NOT FALSE
           AND (COALESCE(ev.permissions, 0) & 1) = 0
    LOOP
        v_roles := ARRAY(SELECT ur.role_id FROM public.user_roles ur
                          WHERE ur.user_id = v_me AND ur.server_id = r.server_id);
        SELECT r.everyone_mask | COALESCE(bit_or(sr.permissions), 0) INTO v_mask
          FROM public.server_roles sr
         WHERE sr.id = ANY (v_roles);
        CONTINUE WHEN (v_mask & 1) <> 0;

        SELECT jsonb_object_agg(c.id, GREATEST(COALESCE(v.since, 'infinity'::timestamptz), r.joined_at)) INTO v_part
          FROM public.channels c
          LEFT JOIN public.channel_history_views v ON v.user_id = v_me AND v.channel_id = c.id
          CROSS JOIN LATERAL (
              SELECT COALESCE(bit_or(COALESCE(o.allow_permissions, 0)) FILTER (WHERE o.role_id = r.everyone_id), 0) AS ea,
                     COALESCE(bit_or(COALESCE(o.deny_permissions, 0))  FILTER (WHERE o.role_id = r.everyone_id), 0) AS ed,
                     COALESCE(bit_or(COALESCE(o.allow_permissions, 0)) FILTER (WHERE o.role_id <> r.everyone_id), 0) AS ra,
                     COALESCE(bit_or(COALESCE(o.deny_permissions, 0))  FILTER (WHERE o.role_id <> r.everyone_id), 0) AS rd,
                     COALESCE(bit_or(COALESCE(o.allow_permissions, 0)) FILTER (WHERE o.user_id = v_me), 0) AS ua,
                     COALESCE(bit_or(COALESCE(o.deny_permissions, 0))  FILTER (WHERE o.user_id = v_me), 0) AS ud
                FROM public.channel_permission_overrides o
               WHERE o.channel_id = c.id
                 AND (o.role_id = r.everyone_id OR o.role_id = ANY (v_roles) OR o.user_id = v_me)
          ) l
         WHERE c.server_id = r.server_id
           AND ((((((v_mask & ~l.ed) | l.ea) & ~l.rd) | l.ra) & ~l.ud) | l.ua) & 4194304 = 0;

        IF v_part IS NOT NULL THEN
            v_map := COALESCE(v_map, '{}'::jsonb) || v_part;
        END IF;
    END LOOP;

    RETURN v_map;
END;
$$;

REVOKE ALL ON FUNCTION public.current_user_history_cutoffs() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.current_user_history_cutoffs() TO anon, authenticated, service_role;

-- Starts the caller's view of a channel that withholds READ_MESSAGE_HISTORY from them: messages
-- created from now on read, earlier ones do not. Returns the start; NULL, storing nothing, where
-- the caller reads the whole history.
CREATE OR REPLACE FUNCTION public.begin_channel_history_view(p_channel_id uuid)
RETURNS timestamptz
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_me uuid;
BEGIN
    IF p_channel_id IS NULL OR NOT COALESCE(public.current_user_history_cutoffs() ? p_channel_id::text, false) THEN
        RETURN NULL;
    END IF;
    SELECT p.id INTO v_me FROM public.profiles p WHERE p.auth_user_id = auth.uid() LIMIT 1;
    INSERT INTO public.channel_history_views (user_id, channel_id, since)
    VALUES (v_me, p_channel_id, now())
    ON CONFLICT (user_id, channel_id) DO UPDATE SET since = EXCLUDED.since;
    RETURN now();
END;
$$;

REVOKE ALL ON FUNCTION public.begin_channel_history_view(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.begin_channel_history_view(uuid) TO authenticated, service_role;

-- InitPlans run on first reference: without cutoffs the first (SELECT ...) answers NULL, the OR
-- stops there, and the second never runs. A cutoff map evaluates the function twice.
ALTER POLICY messages_select_channel_member ON public.messages
    USING (((channel_id IS NOT NULL)
            AND (channel_id IN (SELECT public.current_user_viewable_channel_ids()))
            AND (((SELECT public.current_user_history_cutoffs()) IS NULL)
                 OR (created_at >= COALESCE(((SELECT public.current_user_history_cutoffs()) ->> (channel_id)::text)::timestamptz,
                                            '-infinity'::timestamptz))
                 OR (user_id = (SELECT public.get_current_profile_id()))))
           OR ((conversation_id IS NOT NULL)
               AND (EXISTS (SELECT 1
                              FROM public.conversation_participants cp
                             WHERE cp.conversation_id = messages.conversation_id
                               AND cp.user_id = (SELECT public.get_current_profile_id())
                               AND cp.left_at IS NULL))));

ALTER POLICY message_search_index_channel_access ON public.message_search_index
    USING ((channel_id IS NOT NULL)
           AND (channel_id IN (SELECT public.current_user_viewable_channel_ids()))
           AND (((SELECT public.current_user_history_cutoffs()) IS NULL)
                OR (COALESCE(created_at, 'infinity'::timestamptz)
                    >= COALESCE(((SELECT public.current_user_history_cutoffs()) ->> (channel_id)::text)::timestamptz,
                                '-infinity'::timestamptz))
                OR (user_id = (SELECT public.get_current_profile_id()))));

-- As 20261002000001 (search_messages); restricted channels keep the rows at or after the
-- cutoff and the caller's own.
CREATE OR REPLACE FUNCTION public.search_messages(
    p_query text DEFAULT NULL::text,
    p_channel_id uuid DEFAULT NULL::uuid,
    p_channel_ids uuid[] DEFAULT NULL::uuid[],
    p_user_id uuid DEFAULT NULL::uuid,
    p_conversation_id uuid DEFAULT NULL::uuid,
    p_server_id uuid DEFAULT NULL::uuid,
    p_has_media boolean DEFAULT NULL::boolean,
    p_has_url boolean DEFAULT NULL::boolean,
    p_from_date timestamp with time zone DEFAULT NULL::timestamp with time zone,
    p_to_date timestamp with time zone DEFAULT NULL::timestamp with time zone,
    p_limit integer DEFAULT 50,
    p_offset integer DEFAULT 0,
    p_user_ids uuid[] DEFAULT NULL::uuid[],
    p_mentioned_user_ids uuid[] DEFAULT NULL::uuid[],
    p_has_image boolean DEFAULT NULL::boolean,
    p_has_video boolean DEFAULT NULL::boolean,
    p_has_audio boolean DEFAULT NULL::boolean,
    p_has_embed boolean DEFAULT NULL::boolean,
    p_pinned boolean DEFAULT NULL::boolean,
    p_sort text DEFAULT NULL::text,
    p_with_total boolean DEFAULT false)
RETURNS TABLE(message_id uuid, relevance real, content_text text, channel_id uuid, conversation_id uuid,
              user_id uuid, created_at timestamp with time zone, server_id uuid, total_count bigint)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_me uuid := get_current_user_profile_id();
    v_query text := nullif(btrim(p_query), '');
    v_tsq tsquery;
    v_pattern text;
    v_channels uuid[] := '{}';
    v_conversations uuid[] := '{}';
    v_cutoffs jsonb;
    v_users uuid[];
    v_sort text;
    v_where text;
    v_order text;
    v_rank text := '1';
    v_total bigint;
BEGIN
    IF v_me IS NULL THEN
        RETURN;
    END IF;

    -- Visible rows: the RLS rule of message_search_index, narrowed by the scope parameters.
    IF p_conversation_id IS NULL THEN
        v_channels := ARRAY(
            SELECT v.id
              FROM current_user_viewable_channel_ids() v(id)
             WHERE (p_channel_id IS NULL OR v.id = p_channel_id)
               AND (p_channel_ids IS NULL OR v.id = ANY (p_channel_ids))
               AND (p_server_id IS NULL
                    OR EXISTS (SELECT 1 FROM channels c WHERE c.id = v.id AND c.server_id = p_server_id)));
    END IF;
    IF p_server_id IS NULL AND p_channel_id IS NULL AND p_channel_ids IS NULL THEN
        v_conversations := ARRAY(
            SELECT cp.conversation_id
              FROM conversation_participants cp
             WHERE cp.user_id = v_me
               AND cp.left_at IS NULL
               AND (p_conversation_id IS NULL OR cp.conversation_id = p_conversation_id));
    END IF;

    IF cardinality(v_channels) = 0 AND cardinality(v_conversations) = 0 THEN
        RETURN;
    END IF;

    -- A single channel, server or conversation leads with its (…, created_at) index.
    IF cardinality(v_conversations) = 0 AND cardinality(v_channels) = 1
       AND (p_channel_id IS NOT NULL OR p_channel_ids IS NOT NULL) THEN
        v_where := 'i.channel_id = ($1)[1]';
    ELSIF cardinality(v_conversations) = 0 AND p_server_id IS NOT NULL THEN
        v_where := 'i.server_id = $3 AND i.channel_id = ANY ($1)';
    ELSIF cardinality(v_conversations) = 0 THEN
        v_where := 'i.channel_id = ANY ($1)';
    ELSIF cardinality(v_channels) = 0 AND p_conversation_id IS NOT NULL THEN
        v_where := 'i.conversation_id = $4';
    ELSIF cardinality(v_channels) = 0 THEN
        v_where := 'i.conversation_id = ANY ($2)';
    ELSE
        v_where := '(i.channel_id = ANY ($1) OR i.conversation_id = ANY ($2))';
    END IF;

    IF cardinality(v_channels) > 0 THEN
        v_cutoffs := public.current_user_history_cutoffs();
    END IF;
    IF v_cutoffs IS NOT NULL THEN
        v_where := v_where || ' AND (i.channel_id IS NULL OR i.user_id = $14'
                           || ' OR COALESCE(i.created_at, ''infinity'')'
                           || ' >= COALESCE(($15 ->> i.channel_id::text)::timestamptz, ''-infinity''))';
    END IF;

    IF v_query IS NOT NULL THEN
        IF v_query !~ '[぀-ヿ㐀-鿿가-힯]' THEN
            v_tsq := websearch_to_tsquery('english', v_query);
            IF numnode(v_tsq) = 0 THEN
                v_tsq := NULL;
            END IF;
        END IF;
        IF v_tsq IS NOT NULL THEN
            v_where := v_where || ' AND i.content_tsvector @@ $5';
            v_rank := 'ts_rank(i.content_tsvector, $5)';
        ELSE
            v_pattern := '%' || replace(replace(replace(v_query, '\', '\\'), '%', '\%'), '_', '\_') || '%';
            v_where := v_where || ' AND i.content_text ILIKE $6';
        END IF;
    END IF;

    v_users := CASE
        WHEN p_user_id IS NULL THEN p_user_ids
        ELSE array_append(coalesce(p_user_ids, '{}'), p_user_id)
    END;
    IF v_users IS NOT NULL THEN
        v_where := v_where || CASE WHEN cardinality(v_users) = 1
                                   THEN ' AND i.user_id = ($7)[1]'
                                   ELSE ' AND i.user_id = ANY ($7)' END;
    END IF;
    -- The second clause matches the partial GIN index's predicate.
    IF p_mentioned_user_ids IS NOT NULL THEN
        v_where := v_where || ' AND i.mentioned_user_ids && $8 AND i.mentioned_user_ids <> ''{}''';
    END IF;
    IF p_from_date IS NOT NULL THEN
        v_where := v_where || ' AND i.created_at >= $9';
    END IF;
    IF p_to_date IS NOT NULL THEN
        v_where := v_where || ' AND i.created_at <= $10';
    END IF;

    -- Flags are spelled as bare columns so the planner can match a partial index.
    v_where := v_where
        || CASE p_has_media WHEN true THEN ' AND i.has_media' WHEN false THEN ' AND NOT i.has_media' ELSE '' END
        || CASE p_has_url   WHEN true THEN ' AND i.has_url'   WHEN false THEN ' AND NOT i.has_url'   ELSE '' END
        || CASE p_has_image WHEN true THEN ' AND i.has_image' WHEN false THEN ' AND NOT i.has_image' ELSE '' END
        || CASE p_has_video WHEN true THEN ' AND i.has_video' WHEN false THEN ' AND NOT i.has_video' ELSE '' END
        || CASE p_has_audio WHEN true THEN ' AND i.has_audio' WHEN false THEN ' AND NOT i.has_audio' ELSE '' END
        || CASE p_has_embed WHEN true THEN ' AND i.has_embed' WHEN false THEN ' AND NOT i.has_embed' ELSE '' END
        || CASE p_pinned    WHEN true THEN ' AND i.is_pinned' WHEN false THEN ' AND NOT i.is_pinned' ELSE '' END;

    v_sort := coalesce(p_sort, CASE WHEN v_tsq IS NOT NULL THEN 'relevance' ELSE 'newest' END);
    v_order := CASE
        WHEN v_sort = 'oldest' THEN 'i.created_at, i.message_id'
        WHEN v_sort = 'relevance' AND v_tsq IS NOT NULL THEN v_rank || ' DESC, i.created_at DESC, i.message_id DESC'
        ELSE 'i.created_at DESC, i.message_id DESC'
    END;

    IF p_with_total THEN
        EXECUTE 'SELECT count(*) FROM (SELECT 1 FROM message_search_index i WHERE ' || v_where
                || ' LIMIT 10001) s'
           INTO v_total
          USING v_channels, v_conversations, p_server_id, p_conversation_id, v_tsq, v_pattern,
                v_users, p_mentioned_user_ids, p_from_date, p_to_date, NULL::bigint, NULL::integer,
                NULL::integer, v_me, v_cutoffs;
    END IF;

    RETURN QUERY EXECUTE
        'SELECT i.message_id, (' || v_rank || ')::real, i.content_text, i.channel_id,'
        || ' i.conversation_id, i.user_id, i.created_at, i.server_id, $11'
        || ' FROM message_search_index i WHERE ' || v_where
        || ' ORDER BY ' || v_order
        || ' LIMIT $12 OFFSET $13'
      USING v_channels, v_conversations, p_server_id, p_conversation_id, v_tsq, v_pattern,
            v_users, p_mentioned_user_ids, p_from_date, p_to_date, v_total,
            least(greatest(coalesce(p_limit, 50), 1), 201), greatest(coalesce(p_offset, 0), 0),
            v_me, v_cutoffs;
END;
$$;

-- As 20261010700001 (get_message_polls); a poll on a channel message follows that message's
-- history cutoff.
CREATE OR REPLACE FUNCTION public.get_message_polls(p_poll_ids uuid[])
RETURNS TABLE(poll_id uuid, message_id uuid, question text, allow_multiple boolean,
              expires_at timestamp with time zone, closed boolean, total_voters integer,
              options jsonb, my_option_ids uuid[], is_author boolean)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    WITH me AS (SELECT public.get_current_profile_id() AS id,
                       public.current_user_history_cutoffs() AS cutoffs)
    SELECT p.id,
           p.message_id,
           p.question,
           p.allow_multiple,
           p.expires_at,
           p.expires_at IS NOT NULL AND p.expires_at <= now(),
           (SELECT count(DISTINCT v.user_id)::integer
              FROM public.message_poll_votes v WHERE v.poll_id = p.id),
           (SELECT COALESCE(jsonb_agg(jsonb_build_object(
                       'id', o.id,
                       'position', o."position",
                       'text', o.text,
                       'votes', (SELECT count(*) FROM public.message_poll_votes v
                                  WHERE v.poll_id = p.id AND v.option_id = o.id))
                       ORDER BY o."position"), '[]'::jsonb)
              FROM public.message_poll_options o WHERE o.poll_id = p.id),
           COALESCE((SELECT array_agg(v.option_id ORDER BY v.option_id)
                       FROM public.message_poll_votes v
                      WHERE v.poll_id = p.id AND v.user_id = me.id), '{}'::uuid[]),
           m.user_id IS NOT DISTINCT FROM me.id
      FROM me
      JOIN public.message_polls p ON p.id = ANY (p_poll_ids[1:100])
      JOIN public.messages m ON m.id = p.message_id
     WHERE me.id IS NOT NULL
       AND m.is_deleted IS NOT TRUE
       AND ((m.channel_id IS NOT NULL AND public.can_view_channel(me.id, m.channel_id)
             AND (m.created_at >= COALESCE((me.cutoffs ->> m.channel_id::text)::timestamptz, '-infinity'::timestamptz)
                  OR m.user_id = me.id))
            OR (m.conversation_id IS NOT NULL AND EXISTS (
                    SELECT 1 FROM public.conversation_participants cp
                     WHERE cp.conversation_id = m.conversation_id
                       AND cp.user_id = me.id
                       AND cp.left_at IS NULL)));
$$;

REVOKE ALL ON FUNCTION public.get_message_polls(uuid[]) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_message_polls(uuid[]) TO authenticated, service_role;

-- As 20260101000000 (get_message_page). A channel page starts at the caller's history cutoff,
-- an index bound on (channel_id, created_at) instead of an RLS filter that scans to the start of
-- the channel, and reports it as history_since (null without one).
CREATE OR REPLACE FUNCTION public.get_message_page(
    p_channel_id uuid DEFAULT NULL::uuid,
    p_conversation_id uuid DEFAULT NULL::uuid,
    p_limit integer DEFAULT 20,
    p_before timestamp with time zone DEFAULT NULL::timestamp with time zone)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SET search_path = public, pg_temp
AS $$
DECLARE
    v_profile_id uuid := public.get_current_profile_id();
    v_messages jsonb;
    v_ids uuid[];
    v_reactions jsonb := '[]'::jsonb;
    v_since timestamptz;
BEGIN
    IF (p_channel_id IS NULL) = (p_conversation_id IS NULL) THEN
        RAISE EXCEPTION 'get_message_page: provide exactly one of p_channel_id / p_conversation_id';
    END IF;

    IF p_limit IS NULL OR p_limit < 1 OR p_limit > 100 THEN
        p_limit := 20;
    END IF;

    IF p_channel_id IS NOT NULL THEN
        v_since := (public.current_user_history_cutoffs() ->> p_channel_id::text)::timestamptz;
        WITH page AS (
            SELECT m.*
            FROM public.messages m
            WHERE m.channel_id = p_channel_id
              AND m.thread_id IS NULL
              AND (m.is_deleted IS NULL OR m.is_deleted = false)
              AND (p_before IS NULL OR m.created_at < p_before)
              AND m.created_at >= COALESCE(v_since, '-infinity'::timestamptz)
            ORDER BY m.created_at DESC
            LIMIT p_limit
        )
        SELECT
            COALESCE(jsonb_agg(to_jsonb(page.*) ORDER BY page.created_at ASC), '[]'::jsonb),
            array_agg(page.id)
        INTO v_messages, v_ids
        FROM page;
    ELSE
        WITH page AS (
            SELECT m.*
            FROM public.messages m
            WHERE m.conversation_id = p_conversation_id
              AND (m.is_deleted IS NULL OR m.is_deleted = false)
              AND (p_before IS NULL OR m.created_at < p_before)
            ORDER BY m.created_at DESC
            LIMIT p_limit
        )
        SELECT
            COALESCE(jsonb_agg(to_jsonb(page.*) ORDER BY page.created_at ASC), '[]'::jsonb),
            array_agg(page.id)
        INTO v_messages, v_ids
        FROM page;
    END IF;

    IF v_ids IS NOT NULL AND array_length(v_ids, 1) > 0 THEN
        SELECT COALESCE(
            jsonb_agg(to_jsonb(gr.*) ORDER BY gr.message_id, gr.first_reaction_at ASC),
            '[]'::jsonb
        )
        INTO v_reactions
        FROM (
            SELECT
                r.message_id,
                r.emoji_id,
                COALESCE(e.name, r.custom_emoji_content)::varchar AS emoji_name,
                COALESCE(e.url::text, MAX(r.metadata->>'remote_emoji_url'))::varchar AS emoji_url,
                r.custom_emoji_content,
                COUNT(r.id)::bigint AS reaction_count,
                bool_or(r.user_id = v_profile_id) AS current_user_reacted,
                jsonb_agg(
                    jsonb_build_object(
                        'user_id', r.user_id,
                        'bot_id', r.bot_id,
                        'metadata', r.metadata
                    )
                ) AS users,
                MIN(r.created_at) AS first_reaction_at
            FROM public.reactions r
            LEFT JOIN public.emojis e ON r.emoji_id = e.id
            WHERE r.message_id = ANY(v_ids)
            GROUP BY r.message_id, r.emoji_id, e.name, e.url, r.custom_emoji_content
        ) gr;
    END IF;

    RETURN jsonb_build_object(
        'messages', v_messages,
        'reactions', v_reactions,
        'history_since', v_since
    );
END;
$$;

-- As 20260101000000 (broadcast_message_event). A row created before the transaction began, in a
-- local channel that withholds READ_MESSAGE_HISTORY from anyone, broadcasts ids only: a
-- subscriber's view may start after it.
CREATE OR REPLACE FUNCTION public.broadcast_message_event()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
  v_rec      record;
  v_topic    text;
  v_row      jsonb;
  v_server   uuid;
  v_redact   boolean := false;
BEGIN
  IF TG_OP = 'DELETE' THEN
    v_rec := OLD;
  ELSE
    v_rec := NEW;
  END IF;

  IF v_rec.conversation_id IS NOT NULL THEN
    v_topic := 'dm-conversation-' || v_rec.conversation_id::text;
  ELSIF v_rec.channel_id IS NOT NULL THEN
    v_topic := 'channel-messages-' || v_rec.channel_id::text;
    -- A row created in this transaction postdates every subscriber's view start.
    IF v_rec.created_at < now() THEN
      SELECT c.server_id INTO v_server
        FROM public.channels c
        JOIN public.servers s ON s.id = c.server_id
       WHERE c.id = v_rec.channel_id
         AND s.is_local_server IS NOT FALSE;
      v_redact := v_server IS NOT NULL
                  AND NOT public.channel_grants_everyone(v_rec.channel_id, 4194304);
    END IF;
  ELSE
    RETURN COALESCE(NEW, OLD);
  END IF;

  IF v_redact THEN
    v_row := jsonb_build_object(
      'id',         v_rec.id,
      'created_at', v_rec.created_at,
      'updated_at', v_rec.updated_at,
      'channel_id', v_rec.channel_id,
      'thread_id',  v_rec.thread_id,
      'is_deleted', v_rec.is_deleted,
      'restricted', true
    );
  ELSE
    v_row := jsonb_build_object(
      'id',                  v_rec.id,
      'created_at',          v_rec.created_at,
      'updated_at',          v_rec.updated_at,
      'user_id',             v_rec.user_id,
      'bot_id',              v_rec.bot_id,
      'channel_id',          v_rec.channel_id,
      'conversation_id',     v_rec.conversation_id,
      'thread_id',           v_rec.thread_id,
      'reply_to',            v_rec.reply_to,
      'content',             v_rec.content,
      'is_deleted',          v_rec.is_deleted,
      'is_system',           v_rec.is_system,
      'is_pinned',           v_rec.is_pinned,
      'encrypted',           v_rec.encrypted,
      'encryption_metadata', v_rec.encryption_metadata,
      'megolm_session_id',   v_rec.megolm_session_id,
      'metadata',            COALESCE(v_rec.metadata, '{}'::jsonb)
    );
  END IF;

  PERFORM realtime.send(
    jsonb_build_object(
      'op',  TG_OP,
      'new', CASE WHEN TG_OP = 'DELETE' THEN NULL ELSE v_row END,
      'old', CASE WHEN TG_OP = 'DELETE' THEN v_row ELSE NULL END
    ),
    'message_event',
    v_topic,
    true
  );

  RETURN COALESCE(NEW, OLD);
EXCEPTION WHEN OTHERS THEN
  -- Delivery is best-effort; the write must not fail because realtime is
  -- unavailable. Clients reconcile against the table on reconnect.
  RAISE WARNING 'broadcast_message_event failed: %', SQLERRM;
  RETURN COALESCE(NEW, OLD);
END;
$$;

COMMIT;
