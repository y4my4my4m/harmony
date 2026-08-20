-- Converges public.federated_voice_calls onto the shape federation-backend reads.
--
-- The table init/ declared shares only id and ended_at with the one the code uses, so every
-- federated call path answers 42703 on a fresh install. Production carries the correct
-- shape and is the reference here.
--
-- Nothing can have written the old shape - no code names channel_id, participants, sfu_url
-- or room_id - but rows are checked for rather than assumed absent: when any exist the
-- table is renamed aside instead of dropped.

BEGIN;

-- ---------------------------------------------------------------------------
-- TABLE
-- ---------------------------------------------------------------------------
DO $$
DECLARE
    v_rows bigint;
BEGIN
    IF to_regclass('public.federated_voice_calls') IS NULL THEN
        RAISE NOTICE 'federated_voice_calls absent; creating';
    ELSIF EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_schema = 'public'
          AND table_name = 'federated_voice_calls'
          AND column_name = 'ap_id'
    ) THEN
        RAISE NOTICE 'federated_voice_calls already carries ap_id; table left alone';
        RETURN;
    ELSE
        -- The count decides between DROP and rename, so it has to be taken under the lock
        -- the DROP will need. Counting under ACCESS SHARE and dropping afterwards leaves a
        -- window in which a row commits and is then destroyed without a notice.
        EXECUTE 'LOCK TABLE public.federated_voice_calls IN ACCESS EXCLUSIVE MODE';
        EXECUTE 'SELECT count(*) FROM public.federated_voice_calls' INTO v_rows;
        IF v_rows > 0 THEN
            IF to_regclass('public.federated_voice_calls_legacy') IS NOT NULL THEN
                RAISE EXCEPTION
                    'public.federated_voice_calls_legacy already exists, so this migration has run before against a table with rows. Inspect both tables and drop or rename the legacy one before re-running.';
            END IF;
            -- Index names are unique per schema, so the pkey and the channel
            -- index have to move with the table.
            EXECUTE 'ALTER TABLE public.federated_voice_calls RENAME TO federated_voice_calls_legacy';
            IF to_regclass('public.federated_voice_calls_pkey') IS NOT NULL THEN
                EXECUTE 'ALTER INDEX public.federated_voice_calls_pkey RENAME TO federated_voice_calls_legacy_pkey';
            END IF;
            IF to_regclass('public.idx_federated_voice_calls_channel') IS NOT NULL THEN
                EXECUTE 'ALTER INDEX public.idx_federated_voice_calls_channel RENAME TO idx_federated_voice_calls_legacy_channel';
            END IF;
            RAISE NOTICE 'federated_voice_calls held % row(s) in the pre-federation shape; kept as federated_voice_calls_legacy', v_rows;
        ELSE
            EXECUTE 'DROP TABLE public.federated_voice_calls';
            RAISE NOTICE 'federated_voice_calls was empty in the pre-federation shape; dropped';
        END IF;
    END IF;

    EXECUTE $ddl$
        CREATE TABLE public.federated_voice_calls (
            id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
            ap_id text NOT NULL UNIQUE,

            caller_id uuid REFERENCES public.profiles(id) ON DELETE CASCADE,
            caller_federated_id text NOT NULL,
            recipient_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,

            call_type text NOT NULL,
            conversation_id text,

            livekit_url text NOT NULL,
            room_name text NOT NULL,

            status text DEFAULT 'pending'::text NOT NULL,

            created_at timestamp with time zone DEFAULT now() NOT NULL,
            accepted_at timestamp with time zone,
            ended_at timestamp with time zone,
            expires_at timestamp with time zone DEFAULT (now() + '00:01:00'::interval) NOT NULL,

            CONSTRAINT federated_voice_calls_call_type_check
                CHECK (call_type = ANY (ARRAY['voice'::text, 'video'::text])),
            CONSTRAINT federated_voice_calls_status_check
                CHECK (status = ANY (ARRAY['pending'::text, 'accepted'::text, 'rejected'::text,
                                           'ended'::text, 'expired'::text, 'missed'::text])),
            CONSTRAINT fk_recipient_local CHECK (recipient_id IS NOT NULL)
        )
    $ddl$;

    EXECUTE 'COMMENT ON TABLE public.federated_voice_calls IS ''Federated DM voice/video call invites''';
END $$;

CREATE INDEX IF NOT EXISTS idx_federated_voice_calls_caller ON public.federated_voice_calls(caller_id);
CREATE INDEX IF NOT EXISTS idx_federated_voice_calls_status ON public.federated_voice_calls(status);
CREATE INDEX IF NOT EXISTS idx_federated_voice_calls_expires ON public.federated_voice_calls(expires_at)
    WHERE status = 'pending'::text;
CREATE INDEX IF NOT EXISTS idx_federated_voice_calls_recipient ON public.federated_voice_calls(recipient_id)
    WHERE status = 'pending'::text;

GRANT SELECT ON public.federated_voice_calls TO authenticated;
GRANT ALL ON public.federated_voice_calls TO service_role;

ALTER TABLE public.federated_voice_calls ENABLE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------------
-- POLICIES: federated_voice_calls
-- ---------------------------------------------------------------------------
-- Identical to production's four. The old-shape instances carried only the
-- service_role policy, because 31_rls_policies_extended.sql gated the rest on a
-- caller_id column that did not exist.
--
-- "System can insert calls" is WITH CHECK (true) and the schema-wide default
-- privileges give anon and authenticated arwdDxt on every public table, so any
-- authenticated caller can forge a row. Reproduced here as production has it;
-- 20260818000007 drops it and revokes the write privileges, which this file
-- cannot do without ceasing to be a no-op on production.
DROP POLICY IF EXISTS "System can insert calls" ON public.federated_voice_calls;
CREATE POLICY "System can insert calls" ON public.federated_voice_calls
    FOR INSERT WITH CHECK (true);

DROP POLICY IF EXISTS "Recipients can update call status" ON public.federated_voice_calls;
CREATE POLICY "Recipients can update call status" ON public.federated_voice_calls
    FOR UPDATE
    USING (( SELECT public.get_current_profile_id() ) = recipient_id)
    WITH CHECK (( SELECT public.get_current_profile_id() ) = recipient_id);

DROP POLICY IF EXISTS "Update own calls" ON public.federated_voice_calls;
CREATE POLICY "Update own calls" ON public.federated_voice_calls
    FOR UPDATE USING (
        caller_id = ( SELECT public.get_current_profile_id() )
        OR recipient_id = ( SELECT public.get_current_profile_id() )
    );

DROP POLICY IF EXISTS "Service role full access on calls" ON public.federated_voice_calls;
CREATE POLICY "Service role full access on calls" ON public.federated_voice_calls
    TO service_role USING (true) WITH CHECK (true);

-- ---------------------------------------------------------------------------
-- cleanup_expired_voice_calls
-- ---------------------------------------------------------------------------
-- Body in db_schema/init/12_functions_rpc.sql names started_at, which the table
-- does not have; the function installs and raises 42703 on the first call. This
-- is production's body verbatim. CREATE OR REPLACE resets function attributes,
-- so SECURITY DEFINER and the search_path pin are restated.
CREATE OR REPLACE FUNCTION public.cleanup_expired_voice_calls()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'extensions', 'pg_temp'
AS $$
BEGIN
  UPDATE public.federated_voice_calls
  SET status = 'expired'
  WHERE status = 'pending'
    AND expires_at < NOW();
END;
$$;

-- ---------------------------------------------------------------------------
-- POLICIES: megolm_session_shares DELETE
-- ---------------------------------------------------------------------------
-- No DELETE policy existed, so the fallback in
-- src/services/encryption/MegolmMessageEncryptionService.ts:2228 - a delete
-- filtered on sender_user_id OR recipient_user_id, taken when
-- reset_my_encryption_identity is absent - removed nothing.
--
-- Production has "Senders can delete their session shares", which covers the
-- sender half only. Both halves are the caller's own copy of a room key, and
-- reset_my_encryption_identity already deletes both as SECURITY DEFINER.
DO $$ BEGIN
    IF to_regclass('public.megolm_session_shares') IS NULL THEN
        RAISE NOTICE 'megolm_session_shares absent; DELETE policy skipped';
        RETURN;
    END IF;
    EXECUTE 'DROP POLICY IF EXISTS "megolm_session_shares_delete" ON public.megolm_session_shares';
    EXECUTE $ddl$
        CREATE POLICY "megolm_session_shares_delete" ON public.megolm_session_shares
            FOR DELETE USING (
                sender_user_id = ( SELECT public.get_current_profile_id() )
                OR recipient_user_id = ( SELECT public.get_current_profile_id() )
            )
    $ddl$;
END $$;

COMMIT;

NOTIFY pgrst, 'reload schema';
