-- Newcomer alerts: a member's first message in a local server notifies that server's owner
-- and moderators with a newcomer_message notification.
--
--   server_first_messages   one row per (user, server) that has posted. The AFTER INSERT
--                           trigger on messages inserts with ON CONFLICT DO NOTHING; only the
--                           insert that creates the row continues. Rows outlive the membership,
--                           so a member who leaves and rejoins is not new again. Closed to
--                           clients.
--
-- user_servers carries no first-message column: clients hold UPDATE on their own user_servers
-- row and could clear it to re-alert the staff; every user_servers UPDATE runs
-- route_server_membership, which writes a server_membership_events row and broadcasts
-- membership:event to the whole server; and a leave deletes the row, so a returning member
-- would read as new.
--
-- A message counts when it is a channel message (thread replies included) with a user author,
-- not is_system, not is_deleted. Bot and bridge rows carry no user_id. A row AutoMod drops in
-- its BEFORE trigger never reaches the AFTER trigger and does not count.
--
-- The row-creating insert alerts when, in addition:
--   the server is local and the author is not its owner;
--   the author's accepted membership began within 30 days (a member who joined earlier and
--   never posted is not a newcomer);
--   newcomer alerts are on for the server: server_settings.newcomer_alerts, NULL meaning the
--   instance default instance_config 'newcomer_alerts_default', absent meaning on.
--
-- Recipients, at most 10: the owner, then holders of a role carrying ADMINISTRATOR,
-- MANAGE_SERVER, KICK_MEMBERS, BAN_MEMBERS or TIMEOUT_MEMBERS (mask 3713), by highest such
-- role, then membership age. When @everyone carries one of those bits every member qualifies.
-- Excluded: the author, non-local profiles, members who cannot view the channel, and members
-- with notification_preferences.newcomer_alerts = false. send_notification applies blocks,
-- mutes, membership and the desktop_notifications master switch; push follows from the
-- notification row as for every type.
--
-- Payload: sender (notification_actor_json), message {id, content_preview}, location
-- {server_id, server_name, channel_id, channel_name}, thread {id} for a thread reply, the same
-- ids and names flat, preview, joined_at. An encrypted message carries no preview;
-- redact_encrypted_notification_preview marks it encrypted.
--
-- A created row is also checked against the author's earlier non-system messages in the server
-- (deleted ones included); one found means no alert.
--
-- Backfill: every (server, user) with a non-system channel message, deleted ones included. It
-- runs before the ALTER TABLEs and CREATE TRIGGER, whose locks last until COMMIT, so the scan
-- blocks neither message inserts nor notification_preferences reads. A message committed
-- between the backfill and the trigger meets the earlier-message check instead.
--
-- Seeded local DB, supabase/postgres 15.8.1.060: 20 servers, 4,545 memberships, 527k channel
-- messages. Single-row channel inserts as authenticated, EXPLAIN ANALYZE, median of 2,500:
--   trg_newcomer_first_message, author has posted         0.014 ms   (whole insert 2.8 ms)
--   the same body as INSERT .. ON CONFLICT without probe   0.016 ms
--   first message: 10 of 82 staff alerted, 94 channels    3.1 ms, once per member and server
--   backfill                                               0.19 s
-- pgbench, committed inserts, 1 client, 3 x 2,000: 4.0-4.7 ms with the trigger and 4.1-4.3 ms
-- without; the difference is inside the run-to-run spread.

BEGIN;

SET LOCAL lock_timeout = '3s';

-- ---------------------------------------------------------------------------
-- State
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.server_first_messages (
    user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    server_id uuid NOT NULL REFERENCES public.servers(id) ON DELETE CASCADE,
    first_message_at timestamp with time zone NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, server_id)
);

CREATE INDEX IF NOT EXISTS idx_server_first_messages_server
    ON public.server_first_messages (server_id);

COMMENT ON TABLE public.server_first_messages IS
    'One row per (user, server) with a channel message there. The message insert that creates a row is the member''s first.';

ALTER TABLE public.server_first_messages ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.server_first_messages FROM PUBLIC, anon, authenticated;
GRANT ALL ON TABLE public.server_first_messages TO postgres, service_role;

DROP POLICY IF EXISTS "server_first_messages_service_role" ON public.server_first_messages;
CREATE POLICY "server_first_messages_service_role" ON public.server_first_messages
    AS PERMISSIVE FOR ALL TO service_role
    USING (true)
    WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- Backfill
-- ---------------------------------------------------------------------------

SET LOCAL work_mem = '64MB';

DO $$
DECLARE
    v_rows bigint;
BEGIN
    INSERT INTO public.server_first_messages (user_id, server_id, first_message_at)
    SELECT f.user_id, c.server_id, min(f.first_at)
      FROM (SELECT m.channel_id, m.user_id, min(m.created_at) AS first_at
              FROM public.messages m
             WHERE m.channel_id IS NOT NULL
               AND m.user_id IS NOT NULL
               AND m.is_system IS NOT TRUE
             GROUP BY m.channel_id, m.user_id) f
      JOIN public.channels c ON c.id = f.channel_id
     WHERE c.server_id IS NOT NULL
     GROUP BY f.user_id, c.server_id
    ON CONFLICT DO NOTHING;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    RAISE NOTICE 'server_first_messages: % row(s) backfilled', v_rows;
END;
$$;

-- ---------------------------------------------------------------------------
-- Switches
-- ---------------------------------------------------------------------------

ALTER TABLE public.server_settings
    ADD COLUMN IF NOT EXISTS newcomer_alerts boolean;

COMMENT ON COLUMN public.server_settings.newcomer_alerts IS
    'Alert owner and moderators on a newcomer''s first message. NULL follows instance_config newcomer_alerts_default.';

ALTER TABLE public.notification_preferences
    ADD COLUMN IF NOT EXISTS newcomer_alerts boolean DEFAULT true;

COMMENT ON COLUMN public.notification_preferences.newcomer_alerts IS
    'Receive newcomer_message notifications for servers the user owns or moderates.';

-- enabled is the effective switch; server_value is NULL when the server follows the instance.
CREATE OR REPLACE FUNCTION public.server_newcomer_alerts_state(p_server_id uuid)
RETURNS jsonb
LANGUAGE sql
STABLE
SET search_path = public, pg_temp
AS $$
    SELECT jsonb_build_object(
        'enabled', COALESCE(ss.newcomer_alerts, d.instance_default),
        'server_value', ss.newcomer_alerts,
        'instance_default', d.instance_default)
      FROM (SELECT COALESCE((SELECT lower(ic.config_value #>> '{}') <> 'false'
                               FROM public.instance_config ic
                              WHERE ic.config_key = 'newcomer_alerts_default'), true)
                   AS instance_default) d
      LEFT JOIN public.server_settings ss ON ss.server_id = p_server_id;
$$;

REVOKE ALL ON FUNCTION public.server_newcomer_alerts_state(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.server_newcomer_alerts_state(uuid) TO service_role;

CREATE OR REPLACE FUNCTION public.get_server_newcomer_alerts(p_server_id uuid)
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_caller uuid := public.get_current_profile_id();
BEGIN
    IF v_caller IS NULL THEN
        RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.servers s
                    WHERE s.id = p_server_id AND s.is_local_server IS NOT FALSE)
       OR NOT public.has_permission(v_caller, p_server_id, 'MANAGE_SERVER') THEN
        RAISE EXCEPTION 'Missing permission: MANAGE_SERVER' USING ERRCODE = '42501';
    END IF;
    RETURN public.server_newcomer_alerts_state(p_server_id);
END;
$$;

REVOKE ALL ON FUNCTION public.get_server_newcomer_alerts(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.get_server_newcomer_alerts(uuid) TO authenticated, service_role;

-- p_enabled NULL returns the server to the instance default.
CREATE OR REPLACE FUNCTION public.set_server_newcomer_alerts(p_server_id uuid, p_enabled boolean)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_caller uuid := public.get_current_profile_id();
BEGIN
    IF v_caller IS NULL THEN
        RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.servers s
                    WHERE s.id = p_server_id AND s.is_local_server IS NOT FALSE)
       OR NOT public.has_permission(v_caller, p_server_id, 'MANAGE_SERVER') THEN
        RAISE EXCEPTION 'Missing permission: MANAGE_SERVER' USING ERRCODE = '42501';
    END IF;

    INSERT INTO public.server_settings (server_id, newcomer_alerts)
    VALUES (p_server_id, p_enabled)
    ON CONFLICT (server_id) DO UPDATE
    SET newcomer_alerts = EXCLUDED.newcomer_alerts,
        updated_at = now();

    RETURN public.server_newcomer_alerts_state(p_server_id);
END;
$$;

REVOKE ALL ON FUNCTION public.set_server_newcomer_alerts(uuid, boolean) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.set_server_newcomer_alerts(uuid, boolean) TO authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Trigger
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.handle_newcomer_first_message()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_server_id uuid;
    v_server_name text;
    v_owner uuid;
    v_joined_at timestamp with time zone;
    v_restricted boolean;
    v_everyone_staff boolean;
    v_candidate uuid;
    v_recipients uuid[] := '{}'::uuid[];
    v_author public.profiles%ROWTYPE;
    v_channel_name text;
    v_text text;
    v_preview text;
BEGIN
    -- A lookup is 2 µs cheaper per message than a conflicting ON CONFLICT insert (header).
    IF EXISTS (SELECT 1
                 FROM public.channels c
                 JOIN public.server_first_messages f
                   ON f.server_id = c.server_id AND f.user_id = NEW.user_id
                WHERE c.id = NEW.channel_id) THEN
        RETURN NULL;
    END IF;

    INSERT INTO public.server_first_messages (user_id, server_id, first_message_at)
    SELECT NEW.user_id, c.server_id, NEW.created_at
      FROM public.channels c
     WHERE c.id = NEW.channel_id
       AND c.server_id IS NOT NULL
    ON CONFLICT DO NOTHING
    RETURNING server_id INTO v_server_id;

    IF v_server_id IS NULL THEN
        RETURN NULL;
    END IF;

    -- A failure past this point loses the alert, never the message.
    BEGIN
        SELECT s.name, s.owner INTO v_server_name, v_owner
          FROM public.servers s
         WHERE s.id = v_server_id AND s.is_local_server IS NOT FALSE;
        IF NOT FOUND OR v_owner IS NOT DISTINCT FROM NEW.user_id THEN
            RETURN NULL;
        END IF;

        SELECT us.created_at INTO v_joined_at
          FROM public.user_servers us
         WHERE us.user_id = NEW.user_id
           AND us.server_id = v_server_id
           AND COALESCE(us.status, 'accepted') = 'accepted';
        IF v_joined_at IS NULL OR v_joined_at <= now() - interval '30 days' THEN
            RETURN NULL;
        END IF;

        IF NOT (public.server_newcomer_alerts_state(v_server_id) ->> 'enabled')::boolean THEN
            RETURN NULL;
        END IF;

        IF EXISTS (
            SELECT 1
              FROM public.channels c
              JOIN public.messages m ON m.channel_id = c.id AND m.user_id = NEW.user_id
             WHERE c.server_id = v_server_id
               AND m.id <> NEW.id
               AND m.is_system IS NOT TRUE
        ) THEN
            RETURN NULL;
        END IF;

        v_restricted := public.channel_is_restricted(NEW.channel_id);
        SELECT EXISTS (
            SELECT 1 FROM public.server_roles r
             WHERE r.server_id = v_server_id AND r.is_default
               AND (COALESCE(r.permissions, 0) & 3713) <> 0
        ) INTO v_everyone_staff;

        FOR v_candidate IN
            SELECT us.user_id
              FROM (
                  SELECT c.user_id, max(c.top_position) AS top_position
                    FROM (
                        SELECT v_owner AS user_id, NULL::integer AS top_position
                        UNION ALL
                        SELECT ur.user_id, sr.position
                          FROM public.server_roles sr
                          JOIN public.user_roles ur ON ur.role_id = sr.id
                         WHERE sr.server_id = v_server_id
                           AND NOT sr.is_default
                           AND (COALESCE(sr.permissions, 0) & 3713) <> 0
                        UNION ALL
                        SELECT m.user_id, NULL::integer
                          FROM public.user_servers m
                         WHERE v_everyone_staff AND m.server_id = v_server_id
                    ) c
                   WHERE c.user_id IS NOT NULL
                   GROUP BY c.user_id
              ) staff
              JOIN public.user_servers us
                ON us.user_id = staff.user_id AND us.server_id = v_server_id
              JOIN public.profiles p ON p.id = us.user_id
              LEFT JOIN public.notification_preferences np ON np.user_id = us.user_id
             WHERE COALESCE(us.status, 'accepted') = 'accepted'
               AND us.user_id <> NEW.user_id
               AND p.is_local IS NOT FALSE
               AND COALESCE(np.newcomer_alerts, true)
             ORDER BY (us.user_id = v_owner) DESC, staff.top_position DESC NULLS LAST,
                      us.created_at, us.user_id
        LOOP
            CONTINUE WHEN v_restricted
                AND NOT public.has_permission(v_candidate, v_server_id, 'VIEW_CHANNEL', NEW.channel_id);
            v_recipients := v_recipients || v_candidate;
            EXIT WHEN cardinality(v_recipients) >= 10;
        END LOOP;

        IF cardinality(v_recipients) = 0 THEN
            RETURN NULL;
        END IF;

        SELECT * INTO v_author FROM public.profiles WHERE id = NEW.user_id;
        SELECT c.name INTO v_channel_name FROM public.channels c WHERE c.id = NEW.channel_id;

        IF NEW.encrypted IS NOT TRUE THEN
            v_text := public.extract_message_text(NEW.content);
            v_preview := NULLIF(CASE WHEN length(v_text) > 100 THEN left(v_text, 99) || '…' ELSE v_text END, '');
        END IF;

        PERFORM public.send_notification(
            'newcomer_message',
            v_recipients,
            jsonb_strip_nulls(jsonb_build_object(
                'sender', public.notification_actor_json(v_author),
                'message', jsonb_build_object('id', NEW.id, 'content_preview', v_preview),
                'location', jsonb_build_object(
                    'server_id', v_server_id,
                    'server_name', v_server_name,
                    'channel_id', NEW.channel_id,
                    'channel_name', v_channel_name),
                'thread', CASE WHEN NEW.thread_id IS NOT NULL THEN jsonb_build_object('id', NEW.thread_id) END,
                'message_id', NEW.id,
                'server_name', v_server_name,
                'channel_id', NEW.channel_id,
                'channel_name', v_channel_name,
                'thread_id', NEW.thread_id,
                'preview', v_preview,
                'joined_at', v_joined_at)),
            v_server_id,
            NULL,
            NULL,
            NEW.user_id,
            'normal');
    EXCEPTION WHEN OTHERS THEN
        RAISE WARNING 'newcomer alert for message % failed: % (%)', NEW.id, SQLERRM, SQLSTATE;
    END;

    RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.handle_newcomer_first_message() FROM PUBLIC, anon, authenticated;

-- Owners of SECURITY DEFINER callers keep EXECUTE on the internal functions the trigger calls.
DO $$
DECLARE
    fn regprocedure;
    grantee text;
BEGIN
    FOREACH fn IN ARRAY ARRAY[
        'public.send_notification(character varying, uuid[], jsonb, uuid, uuid, uuid, uuid, character varying)',
        'public.channel_is_restricted(uuid)',
        'public.server_newcomer_alerts_state(uuid)'
    ]::regprocedure[] LOOP
        FOREACH grantee IN ARRAY ARRAY['postgres', 'supabase_admin'] LOOP
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = grantee) THEN
                EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I', fn, grantee);
            END IF;
        END LOOP;
    END LOOP;
END;
$$;

DROP TRIGGER IF EXISTS trg_newcomer_first_message ON public.messages;
CREATE TRIGGER trg_newcomer_first_message
    AFTER INSERT ON public.messages
    FOR EACH ROW
    WHEN (NEW.channel_id IS NOT NULL
          AND NEW.user_id IS NOT NULL
          AND NEW.bot_id IS NULL
          AND NEW.is_system IS NOT TRUE
          AND NEW.is_deleted IS NOT TRUE)
    EXECUTE FUNCTION public.handle_newcomer_first_message();

COMMIT;

NOTIFY pgrst, 'reload schema';
