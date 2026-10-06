-- megolm_room_sessions and megolm_key_requests in the repository's layout, on every instance.
--
-- Production carries a pre-baseline megolm_room_sessions (room_id uuid, current_session_id,
-- sender_user_id, message_count; no session key or creator columns) with its own policies, so
-- 20261001200001 skipped the canonical policies of both tables there and 20261007900001 held
-- back their anon and authenticated privileges. No function or client reads
-- megolm_room_sessions; the canonical megolm_key_requests_select_for_response policy does.
--
-- megolm_room_sessions in the pre-baseline layout is replaced: dropped when empty (production
-- has no rows), otherwise renamed to megolm_room_sessions_pre_baseline, with its constraints
-- and indexes, and closed to the API roles.
--
-- megolm_key_requests keeps its rows. Production has user_id NOT NULL and requester_user_id
-- nullable, sender_user_id ON DELETE CASCADE, expires_at and requesting_device_id, no
-- updated_at, and its own index names. Staging has request_id, responded_by_user_id,
-- responded_by_device_id and responded_at, with a unique key, a foreign key and an index on
-- them. Columns and indexes outside the repository's layout are dropped: no function, view,
-- policy or client reads them. A row without requester_user_id takes user_id, the legacy name
-- of the same profile; a row with neither names no requester and is deleted.

BEGIN;

SET LOCAL lock_timeout = '3s';

-- References megolm_room_sessions.session_id and creator_user_id; recreated below.
DROP POLICY IF EXISTS megolm_key_requests_select_for_response ON public.megolm_key_requests;

-- ---------------------------------------------------------------------------
-- megolm_room_sessions
-- ---------------------------------------------------------------------------

DO $$
DECLARE
    v_table regclass := to_regclass('public.megolm_room_sessions');
    v_rows bigint;
    r record;
BEGIN
    IF v_table IS NULL
       OR EXISTS (SELECT 1 FROM pg_attribute
                   WHERE attrelid = v_table AND attname = 'encrypted_session_key' AND NOT attisdropped) THEN
        RETURN;
    END IF;

    EXECUTE 'SELECT count(*) FROM public.megolm_room_sessions' INTO v_rows;
    IF v_rows = 0 THEN
        DROP TABLE public.megolm_room_sessions;
        RAISE NOTICE 'megolm_room_sessions: pre-baseline layout, empty, dropped';
        RETURN;
    END IF;

    IF to_regclass('public.megolm_room_sessions_pre_baseline') IS NOT NULL THEN
        RAISE EXCEPTION 'megolm_room_sessions_pre_baseline exists; megolm_room_sessions holds % pre-baseline rows', v_rows;
    END IF;
    -- Renaming a constraint renames its index.
    FOR r IN SELECT conname FROM pg_constraint WHERE conrelid = v_table LOOP
        EXECUTE format('ALTER TABLE public.megolm_room_sessions RENAME CONSTRAINT %I TO %I',
                       r.conname, left(r.conname, 50) || '_pre_baseline');
    END LOOP;
    FOR r IN SELECT c.relname
               FROM pg_index i JOIN pg_class c ON c.oid = i.indexrelid
              WHERE i.indrelid = v_table
                AND NOT EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conindid = i.indexrelid) LOOP
        EXECUTE format('ALTER INDEX public.%I RENAME TO %I', r.relname, left(r.relname, 50) || '_pre_baseline');
    END LOOP;
    ALTER TABLE public.megolm_room_sessions RENAME TO megolm_room_sessions_pre_baseline;
    REVOKE ALL ON public.megolm_room_sessions_pre_baseline FROM PUBLIC, anon, authenticated;
    RAISE NOTICE 'megolm_room_sessions: pre-baseline layout with % rows, renamed to megolm_room_sessions_pre_baseline', v_rows;
END;
$$;

CREATE TABLE IF NOT EXISTS public.megolm_room_sessions (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    updated_at timestamp with time zone DEFAULT now(),
    session_id text NOT NULL,
    room_id text NOT NULL,
    room_type text NOT NULL,
    creator_user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    creator_device_id text NOT NULL,
    encrypted_session_key text NOT NULL,
    message_index integer DEFAULT 0,
    max_message_index integer DEFAULT 100,
    is_active boolean DEFAULT true,
    rotated_at timestamp with time zone,
    shared_with_count integer DEFAULT 0,
    UNIQUE (session_id, room_id),
    CONSTRAINT megolm_room_sessions_type_check CHECK (room_type IN ('conversation', 'channel'))
);

ALTER TABLE public.megolm_room_sessions REPLICA IDENTITY FULL;
CREATE INDEX IF NOT EXISTS idx_megolm_room_sessions_room ON public.megolm_room_sessions (room_id, room_type);
CREATE INDEX IF NOT EXISTS idx_megolm_room_sessions_session ON public.megolm_room_sessions (session_id);
CREATE INDEX IF NOT EXISTS idx_megolm_room_sessions_creator ON public.megolm_room_sessions (creator_user_id);
COMMENT ON TABLE public.megolm_room_sessions IS 'Megolm E2E encryption sessions for rooms';
ALTER TABLE public.megolm_room_sessions ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'megolm_room_sessions'
                      AND policyname = 'megolm_room_sessions_insert_own') THEN
        CREATE POLICY megolm_room_sessions_insert_own ON public.megolm_room_sessions AS PERMISSIVE FOR INSERT TO public
            WITH CHECK ((creator_user_id = ( SELECT public.get_current_profile_id() AS get_current_profile_id)));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'megolm_room_sessions'
                      AND policyname = 'megolm_room_sessions_select') THEN
        CREATE POLICY megolm_room_sessions_select ON public.megolm_room_sessions AS PERMISSIVE FOR SELECT TO public
            USING (((creator_user_id = ( SELECT public.get_current_profile_id() AS get_current_profile_id)) OR
                (EXISTS ( SELECT 1 FROM public.megolm_session_shares WHERE ((megolm_session_shares.session_id =
                megolm_room_sessions.session_id) AND (megolm_session_shares.room_id =
                megolm_room_sessions.room_id) AND (megolm_session_shares.recipient_user_id = ( SELECT
                public.get_current_profile_id() AS get_current_profile_id)))))));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = 'megolm_room_sessions'
                      AND policyname = 'megolm_room_sessions_update_own') THEN
        CREATE POLICY megolm_room_sessions_update_own ON public.megolm_room_sessions AS PERMISSIVE FOR UPDATE TO public
            USING ((creator_user_id = ( SELECT public.get_current_profile_id() AS get_current_profile_id)));
    END IF;
END;
$$;

-- ---------------------------------------------------------------------------
-- megolm_key_requests
-- ---------------------------------------------------------------------------

ALTER TABLE public.megolm_key_requests ADD COLUMN IF NOT EXISTS updated_at timestamp with time zone DEFAULT now();

UPDATE public.megolm_key_requests SET requester_user_id = user_id
 WHERE requester_user_id IS NULL AND user_id IS NOT NULL;
DELETE FROM public.megolm_key_requests WHERE requester_user_id IS NULL;
ALTER TABLE public.megolm_key_requests ALTER COLUMN requester_user_id SET NOT NULL;
ALTER TABLE public.megolm_key_requests ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE public.megolm_key_requests ALTER COLUMN requester_device_id SET DEFAULT 'default'::text;

-- Dropping a column drops the indexes and constraints that include it.
ALTER TABLE public.megolm_key_requests
    DROP COLUMN IF EXISTS expires_at,
    DROP COLUMN IF EXISTS requesting_device_id,
    DROP COLUMN IF EXISTS request_id,
    DROP COLUMN IF EXISTS responded_by_user_id,
    DROP COLUMN IF EXISTS responded_by_device_id,
    DROP COLUMN IF EXISTS responded_at;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conrelid = 'public.megolm_key_requests'::regclass
                      AND conname = 'megolm_key_requests_sender_user_id_fkey' AND confdeltype = 'n') THEN
        ALTER TABLE public.megolm_key_requests DROP CONSTRAINT IF EXISTS megolm_key_requests_sender_user_id_fkey;
        ALTER TABLE public.megolm_key_requests ADD CONSTRAINT megolm_key_requests_sender_user_id_fkey
            FOREIGN KEY (sender_user_id) REFERENCES public.profiles(id) ON DELETE SET NULL;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conrelid = 'public.megolm_key_requests'::regclass
                      AND conname = 'megolm_key_requests_requester_user_id_fkey') THEN
        ALTER TABLE public.megolm_key_requests ADD CONSTRAINT megolm_key_requests_requester_user_id_fkey
            FOREIGN KEY (requester_user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conrelid = 'public.megolm_key_requests'::regclass
                      AND conname = 'megolm_key_requests_user_id_fkey') THEN
        ALTER TABLE public.megolm_key_requests ADD CONSTRAINT megolm_key_requests_user_id_fkey
            FOREIGN KEY (user_id) REFERENCES public.profiles(id) ON DELETE CASCADE;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conrelid = 'public.megolm_key_requests'::regclass
                      AND conname = 'megolm_key_requests_status_check') THEN
        ALTER TABLE public.megolm_key_requests ADD CONSTRAINT megolm_key_requests_status_check
            CHECK (status = ANY (ARRAY['pending'::text, 'sent'::text, 'received'::text, 'cancelled'::text,
                                       'ignored'::text, 'fulfilled'::text, 'expired'::text])) NOT VALID;
    END IF;
END;
$$;

DROP INDEX IF EXISTS public.idx_megolm_requests_requester_status;
DROP INDEX IF EXISTS public.idx_megolm_requests_room;
DROP INDEX IF EXISTS public.idx_megolm_requests_sender;
DROP INDEX IF EXISTS public.idx_megolm_requests_status;
CREATE INDEX IF NOT EXISTS idx_megolm_key_requests_requester ON public.megolm_key_requests (requester_user_id);
CREATE INDEX IF NOT EXISTS idx_megolm_key_requests_sender ON public.megolm_key_requests (sender_user_id);
CREATE INDEX IF NOT EXISTS idx_megolm_key_requests_session ON public.megolm_key_requests (session_id, room_id);
CREATE INDEX IF NOT EXISTS idx_megolm_key_requests_status ON public.megolm_key_requests (status) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_megolm_key_requests_user_id ON public.megolm_key_requests (user_id);

COMMENT ON TABLE public.megolm_key_requests IS 'Requests for missing Megolm session keys';
COMMENT ON COLUMN public.megolm_key_requests.encrypted_key IS NULL;
COMMENT ON COLUMN public.megolm_key_requests.requester_user_id IS NULL;
COMMENT ON COLUMN public.megolm_key_requests.sender_user_id IS NULL;

CREATE POLICY megolm_key_requests_select_for_response ON public.megolm_key_requests AS PERMISSIVE FOR SELECT TO public
    USING (((sender_user_id = ( SELECT public.get_current_profile_id() AS get_current_profile_id)) OR
        (EXISTS ( SELECT 1 FROM public.megolm_room_sessions mrs WHERE ((mrs.session_id =
        megolm_key_requests.session_id) AND (mrs.room_id = megolm_key_requests.room_id) AND
        (mrs.creator_user_id = ( SELECT public.get_current_profile_id() AS get_current_profile_id)))))));

-- Privileges of a fresh install (20261007900001 held these back).
GRANT ALL ON public.megolm_room_sessions, public.megolm_key_requests TO anon, authenticated, service_role;

COMMIT;
