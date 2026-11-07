-- Voice rows of a remote server's copy expire unless their host re-announces them.
--
-- A copy's voice_channel_participants row is written by its host's VoiceChannelJoin
-- (VoiceActivityHandler.recordRemotePresence) and removed by its VoiceChannelLeave. The LiveKit
-- reconciliation skips copy rows, since the call runs on the host's LiveKit. A leave that never
-- arrives (delivery given up, host gone, federation closed mid-call) left the row forever.
--
-- voice_presence_refresh_targets(): every local caller of a federated local server's voice
-- channel, joined more than 2 minutes ago (JOIN_GRACE_MS of the reconciler), paired with each
-- instance federation_channel_recipients admits for that channel that runs Harmony 1.9.4 or
-- later (federated_instances.software/version, from NodeInfo). One call per refresh
-- (voicePresenceRefresh.ts, every 10 minutes), which sends each pair a VoiceChannelJoin marked
-- harmony:refresh. An older instance would recreate the row from it, and its reconciliation
-- delete it again 2 minutes later.
--
-- sweep_stale_voice_participants (pg_cron, every minute) also deletes a copy's row neither
-- written nor re-announced for 30 minutes: three refresh periods. A join stamps last_seen_at
-- when it writes the row; a refresh only restamps a row that exists, so one arriving after the
-- caller's leave lists nobody. A host older than this release never re-announces, so its rows
-- here last 30 minutes; the reconciliation removed them after 2. Copy rows present at this
-- migration are stamped now, so the first sweep keeps live calls.

BEGIN;

SET LOCAL lock_timeout = '3s';

CREATE OR REPLACE FUNCTION public.voice_presence_refresh_targets()
RETURNS TABLE(
    channel_id uuid,
    channel_name text,
    server_id uuid,
    server_name text,
    user_id uuid,
    username text,
    federated_id text,
    instance text,
    shared_inbox text
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    WITH callers AS (
        SELECT v.channel_id, c.name AS channel_name, v.server_id, s.name AS server_name,
               v.user_id, p.username, p.federated_id
          FROM public.voice_channel_participants v
          JOIN public.servers s ON s.id = v.server_id
                               AND s.is_local_server IS NOT FALSE
                               AND s.federation_enabled IS TRUE
          JOIN public.channels c ON c.id = v.channel_id
          JOIN public.profiles p ON p.id = v.user_id AND p.is_local IS TRUE
         WHERE v.joined_at < now() - interval '2 minutes'
    ),
    live AS (
        SELECT DISTINCT channel_id FROM callers
    ),
    recipients AS (
        SELECT l.channel_id, r.instance, r.shared_inbox
          FROM live l
          CROSS JOIN LATERAL public.federation_channel_recipients(l.channel_id) r
          JOIN public.federated_instances fi ON fi.domain = r.instance
         WHERE lower(fi.software) = 'harmony'
           AND string_to_array(substring(fi.version FROM '^[0-9]+\.[0-9]+\.[0-9]+'), '.')::int[]
               >= ARRAY[1, 9, 4]
    )
    SELECT ca.channel_id, ca.channel_name, ca.server_id, ca.server_name,
           ca.user_id, ca.username, ca.federated_id, re.instance, re.shared_inbox
      FROM callers ca
      JOIN recipients re ON re.channel_id = ca.channel_id
     ORDER BY ca.user_id, re.instance;
$$;

DO $$
DECLARE
    grantee text;
BEGIN
    REVOKE ALL ON FUNCTION public.voice_presence_refresh_targets() FROM PUBLIC, anon, authenticated;
    FOREACH grantee IN ARRAY ARRAY['postgres', 'supabase_admin', 'service_role'] LOOP
        IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = grantee) THEN
            EXECUTE format('GRANT EXECUTE ON FUNCTION public.voice_presence_refresh_targets() TO %I', grantee);
        END IF;
    END LOOP;
END;
$$;

UPDATE public.voice_channel_participants v
   SET last_seen_at = now()
 WHERE v.last_seen_at IS NULL
   AND EXISTS (SELECT 1 FROM public.servers s WHERE s.id = v.server_id AND s.is_local_server IS FALSE);

-- As 20261107300001, plus the copy-row clause.
CREATE OR REPLACE FUNCTION public.sweep_stale_voice_participants()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_count integer;
BEGIN
    IF current_setting('role', true) IN ('anon', 'authenticated') THEN
        RAISE EXCEPTION 'sweep_stale_voice_participants is internal' USING ERRCODE = '42501';
    END IF;

    PERFORM set_config('harmony.voice_left_reason', 'reconciled', true);
    DELETE FROM public.voice_channel_participants v
     WHERE (v.metadata ->> 'transport' = 'p2p'
            AND CASE WHEN v.last_seen_at IS NULL
                     THEN v.joined_at < now() - interval '12 hours'
                     ELSE GREATEST(v.last_seen_at, v.joined_at) < now() - interval '3 minutes' END)
        OR (GREATEST(v.last_seen_at, v.joined_at) < now() - interval '30 minutes'
            AND EXISTS (SELECT 1 FROM public.servers s
                         WHERE s.id = v.server_id AND s.is_local_server IS FALSE));
    GET DIAGNOSTICS v_count = ROW_COUNT;
    PERFORM set_config('harmony.voice_left_reason', '', true);
    RETURN v_count;
END;
$$;

COMMIT;

NOTIFY pgrst, 'reload schema';
