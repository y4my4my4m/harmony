BEGIN;

-- =============================================================================
-- Fix 1: voice_channel_participants RLS write policies
-- =============================================================================
-- The table has RLS enabled but init only ever shipped a SELECT policy, so a
-- fresh init.sql deploy can't INSERT/UPDATE/DELETE participant rows from the
-- client (PostgREST authenticated role) -> error 42501. The client manages its
-- own presence row directly (see useServerUsers.joinVoiceChannel/leave), while
-- federated participants and cleanup jobs use the service_role key which
-- bypasses RLS. So we only need self-scoped write policies here.

DROP POLICY IF EXISTS "voice_participants_insert_self" ON public.voice_channel_participants;
CREATE POLICY "voice_participants_insert_self" ON public.voice_channel_participants
    FOR INSERT WITH CHECK (user_id = public.get_current_profile_id());

DROP POLICY IF EXISTS "voice_participants_update_self" ON public.voice_channel_participants;
CREATE POLICY "voice_participants_update_self" ON public.voice_channel_participants
    FOR UPDATE USING (user_id = public.get_current_profile_id())
    WITH CHECK (user_id = public.get_current_profile_id());

DROP POLICY IF EXISTS "voice_participants_delete_self" ON public.voice_channel_participants;
CREATE POLICY "voice_participants_delete_self" ON public.voice_channel_participants
    FOR DELETE USING (user_id = public.get_current_profile_id());

-- =============================================================================
-- Fix 2: drop NOT NULL on legacy user_key_pairs columns
-- =============================================================================
-- DBs created from an older init that still had the legacy Signal columns
-- (identity_key, signed_prekey, signed_prekey_signature) keep those columns as
-- NOT NULL. The Megolm code only writes identity_public_key /
-- identity_private_key_encrypted, so an insert fails with 23502 on the legacy
-- column. The 20260320 migration copied data out of identity_key but never
-- relaxed the constraint. Make any surviving legacy columns nullable so new
-- key pairs can be created. (Fresh init.sql deploys never have these columns;
-- the guards make this a no-op there.)

DO $$
DECLARE
    legacy_col text;
BEGIN
    FOREACH legacy_col IN ARRAY ARRAY['identity_key', 'signed_prekey', 'signed_prekey_signature', 'registration_id']
    LOOP
        IF EXISTS (
            SELECT 1 FROM information_schema.columns
            WHERE table_schema = 'public'
              AND table_name = 'user_key_pairs'
              AND column_name = legacy_col
        ) THEN
            EXECUTE format('ALTER TABLE public.user_key_pairs ALTER COLUMN %I DROP NOT NULL', legacy_col);
        END IF;
    END LOOP;
END $$;

NOTIFY pgrst, 'reload schema';

COMMIT;
