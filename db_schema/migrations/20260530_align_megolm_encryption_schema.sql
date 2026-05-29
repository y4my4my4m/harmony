-- ---------------------------------------------------------------------------
-- Align Megolm encryption tables with what the client/triggers actually use.
--
-- Over time the runtime contract drifted away from db_schema/init:
--   * megolm_key_requests: client/trigger reference sender_user_id, user_id,
--     encrypted_key, fulfilled_at, request_signature(+fingerprint) and the
--     'fulfilled'/'expired' statuses; the init DDL had none of these, and
--     request_id / requester_device_id were NOT NULL but the client never
--     supplies them. broadcast_key_request_event() therefore errored at
--     runtime on fresh deploys, so key requests never fanned out.
--   * megolm_session_shares: client upserts on (room_id, session_id,
--     recipient_user_id) and writes sender_user_id; get_unclaimed_session_shares
--     / claim_session_share read is_claimed. init lacked sender_user_id,
--     is_claimed, the matching unique target, and recipient_device_id was
--     NOT NULL with no default.
--   * megolm_key_backups: client upserts onConflict user_id with columns
--     encrypted_data/version/session_count/backup_hash/last_updated; init had a
--     different (Matrix-style) column set with NOT NULL backup_version/auth_data.
--   * RLS: no UPDATE policy let the designated fulfiller mark a request
--     fulfilled, and the session-shares policies required a megolm_room_sessions
--     row the client never writes -> all shares blocked.
--   * get_unclaimed_session_shares declared room_id uuid while the column is
--     text -> 42804 at runtime.
--
-- This migration is idempotent and safe to run on existing deploys.
-- ---------------------------------------------------------------------------
BEGIN;

-- ===========================================================================
-- megolm_session_shares
-- ===========================================================================
ALTER TABLE public.megolm_session_shares
    ADD COLUMN IF NOT EXISTS sender_user_id uuid REFERENCES public.profiles(id) ON DELETE CASCADE;
ALTER TABLE public.megolm_session_shares
    ADD COLUMN IF NOT EXISTS is_claimed boolean DEFAULT false;

-- recipient_device_id: give it a default and stop requiring callers to pass it.
ALTER TABLE public.megolm_session_shares
    ALTER COLUMN recipient_device_id SET DEFAULT 'default'::text;
UPDATE public.megolm_session_shares
    SET recipient_device_id = 'default'
    WHERE recipient_device_id IS NULL;

-- Backfill is_claimed from claimed_at for legacy rows.
UPDATE public.megolm_session_shares
    SET is_claimed = (claimed_at IS NOT NULL)
    WHERE is_claimed IS NULL;

-- Conflict target used by the client upsert. Wrapped so dup legacy rows surface
-- a clear error (operator should dedupe) rather than a cryptic failure.
DO $$
BEGIN
    CREATE UNIQUE INDEX IF NOT EXISTS megolm_session_shares_room_session_recipient_key
        ON public.megolm_session_shares(room_id, session_id, recipient_user_id);
EXCEPTION WHEN unique_violation THEN
    RAISE EXCEPTION 'megolm_session_shares has duplicate (room_id, session_id, recipient_user_id) rows; dedupe before applying.';
END $$;

CREATE INDEX IF NOT EXISTS idx_megolm_session_shares_unclaimed
    ON public.megolm_session_shares(recipient_user_id) WHERE is_claimed = false;

-- ===========================================================================
-- megolm_key_requests
-- ===========================================================================
ALTER TABLE public.megolm_key_requests
    ADD COLUMN IF NOT EXISTS user_id uuid REFERENCES public.profiles(id) ON DELETE CASCADE;
ALTER TABLE public.megolm_key_requests
    ADD COLUMN IF NOT EXISTS sender_user_id uuid REFERENCES public.profiles(id) ON DELETE SET NULL;
ALTER TABLE public.megolm_key_requests
    ADD COLUMN IF NOT EXISTS encrypted_key text;
ALTER TABLE public.megolm_key_requests
    ADD COLUMN IF NOT EXISTS fulfilled_at timestamp with time zone;
ALTER TABLE public.megolm_key_requests
    ADD COLUMN IF NOT EXISTS request_signature text;
ALTER TABLE public.megolm_key_requests
    ADD COLUMN IF NOT EXISTS request_signing_fingerprint text;

-- request_id / requester_device_id are no longer supplied by the client.
ALTER TABLE public.megolm_key_requests ALTER COLUMN request_id DROP NOT NULL;
ALTER TABLE public.megolm_key_requests ALTER COLUMN requester_device_id SET DEFAULT 'default'::text;
ALTER TABLE public.megolm_key_requests ALTER COLUMN requester_device_id DROP NOT NULL;

-- Extend the status CHECK to include the runtime statuses.
ALTER TABLE public.megolm_key_requests DROP CONSTRAINT IF EXISTS megolm_key_requests_status_check;
ALTER TABLE public.megolm_key_requests
    ADD CONSTRAINT megolm_key_requests_status_check
    CHECK (status IN ('pending', 'sent', 'received', 'cancelled', 'ignored', 'fulfilled', 'expired'));

CREATE INDEX IF NOT EXISTS idx_megolm_key_requests_sender
    ON public.megolm_key_requests(sender_user_id);

-- ===========================================================================
-- megolm_key_backups
-- ===========================================================================
ALTER TABLE public.megolm_key_backups
    ADD COLUMN IF NOT EXISTS encrypted_data text;
ALTER TABLE public.megolm_key_backups
    ADD COLUMN IF NOT EXISTS version integer DEFAULT 1;
ALTER TABLE public.megolm_key_backups
    ADD COLUMN IF NOT EXISTS session_count integer DEFAULT 0;
ALTER TABLE public.megolm_key_backups
    ADD COLUMN IF NOT EXISTS backup_hash text;
ALTER TABLE public.megolm_key_backups
    ADD COLUMN IF NOT EXISTS last_updated timestamp with time zone DEFAULT now();

-- Legacy NOT NULLs the client doesn't populate.
ALTER TABLE public.megolm_key_backups ALTER COLUMN backup_version DROP NOT NULL;
ALTER TABLE public.megolm_key_backups ALTER COLUMN auth_data DROP NOT NULL;

-- Client upserts onConflict 'user_id' which needs a plain unique constraint.
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM pg_constraint
        WHERE conrelid = 'public.megolm_key_backups'::regclass
        AND contype = 'u'
        AND conname = 'megolm_key_backups_user_id_key'
    ) THEN
        BEGIN
            ALTER TABLE public.megolm_key_backups
                ADD CONSTRAINT megolm_key_backups_user_id_key UNIQUE (user_id);
        EXCEPTION WHEN unique_violation THEN
            RAISE EXCEPTION 'megolm_key_backups has multiple rows per user_id; keep one before applying.';
        END;
    END IF;
END $$;

-- ===========================================================================
-- RLS policies
-- ===========================================================================

-- Session shares keyed off sender_user_id (the client never writes a
-- megolm_room_sessions row, so the old creator-based policies blocked shares).
DROP POLICY IF EXISTS "megolm_session_shares_select" ON public.megolm_session_shares;
CREATE POLICY "megolm_session_shares_select" ON public.megolm_session_shares
    FOR SELECT USING (
        recipient_user_id = public.get_current_profile_id()
        OR sender_user_id = public.get_current_profile_id()
    );

DROP POLICY IF EXISTS "megolm_session_shares_insert" ON public.megolm_session_shares;
CREATE POLICY "megolm_session_shares_insert" ON public.megolm_session_shares
    FOR INSERT WITH CHECK (
        sender_user_id = public.get_current_profile_id()
    );

DROP POLICY IF EXISTS "megolm_session_shares_update" ON public.megolm_session_shares;
CREATE POLICY "megolm_session_shares_update" ON public.megolm_session_shares
    FOR UPDATE USING (
        sender_user_id = public.get_current_profile_id()
        OR recipient_user_id = public.get_current_profile_id()
    );

-- Key requests: requester owns the row; the addressed fulfiller can read and
-- mark it fulfilled.
DROP POLICY IF EXISTS "megolm_key_requests_select_for_response" ON public.megolm_key_requests;
CREATE POLICY "megolm_key_requests_select_for_response" ON public.megolm_key_requests
    FOR SELECT USING (
        sender_user_id = public.get_current_profile_id()
        OR EXISTS (
            SELECT 1 FROM public.megolm_room_sessions mrs
            WHERE mrs.session_id = megolm_key_requests.session_id
            AND mrs.room_id = megolm_key_requests.room_id
            AND mrs.creator_user_id = public.get_current_profile_id()
        )
    );

DROP POLICY IF EXISTS "megolm_key_requests_fulfill" ON public.megolm_key_requests;
CREATE POLICY "megolm_key_requests_fulfill" ON public.megolm_key_requests
    FOR UPDATE USING (sender_user_id = public.get_current_profile_id())
    WITH CHECK (sender_user_id = public.get_current_profile_id());

-- ===========================================================================
-- get_unclaimed_session_shares: room_id is text, not uuid.
-- ===========================================================================
DROP FUNCTION IF EXISTS public.get_unclaimed_session_shares(uuid);
CREATE OR REPLACE FUNCTION public.get_unclaimed_session_shares(p_user_id uuid)
RETURNS TABLE(share_id uuid, room_id text, session_id text, sender_user_id uuid, encrypted_session_key text, first_known_index integer, created_at timestamp with time zone)
    LANGUAGE plpgsql
    SECURITY DEFINER
    SET search_path = public
    AS $$
BEGIN
    RETURN QUERY
    SELECT
        s.id as share_id,
        s.room_id,
        s.session_id,
        s.sender_user_id,
        s.encrypted_session_key,
        s.first_known_index,
        s.created_at
    FROM public.megolm_session_shares s
    WHERE s.recipient_user_id = p_user_id
    AND s.is_claimed = false
    ORDER BY s.created_at DESC;
END;
$$;

NOTIFY pgrst, 'reload schema';

COMMIT;
