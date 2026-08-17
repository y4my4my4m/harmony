-- =============================================================================
-- 20260524_bot_grants_and_activity_counters
-- =============================================================================
-- Two unrelated-but-small fixes shipped together:
--
-- 1) `permission denied for table bots` when a bot owner tries to update their
--    own bot from the settings page. The RLS policies on `public.bots` are
--    correct (owner-only write) but the table never had a table-level GRANT
--    for the `authenticated` role, so Postgres rejects the UPDATE *before*
--    RLS even runs. Same goes for `bot_tokens` (regenerate-token was lucky
--    enough to work for INSERT/UPDATE via `service_role`, but interactive
--    actions hit the same wall). Add the grants.
--
-- 2) Profile-modal activity stats (`Messages`, `Voice Time`) were always 0
--    because the columns didn't exist. Add denormalized counters maintained
--    by triggers so reads are free (they ride on the same SELECT that
--    already loads the profile row). Backfill from existing data on apply.
--
--    Write cost per message INSERT/DELETE:  +1 UPDATE on profiles by PK.
--    Write cost per voice-channel-leave:    +1 UPDATE on profiles by PK.
--    Both are dwarfed by the work already happening (broadcasts, notifications,
--    RLS evaluation, federation queue, etc.).
-- =============================================================================

-- =====================================================================
-- 1) Bot table grants
-- =====================================================================
GRANT SELECT, INSERT, UPDATE, DELETE ON public.bots TO authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.bot_tokens TO authenticated;

-- =====================================================================
-- 2) Activity counters on profiles
-- =====================================================================
ALTER TABLE public.profiles
    ADD COLUMN IF NOT EXISTS message_count bigint NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS voice_minutes bigint NOT NULL DEFAULT 0;

-- ---- Messages ----------------------------------------------------------
CREATE OR REPLACE FUNCTION public.tg_profile_message_counter()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    IF TG_OP = 'INSERT' THEN
        IF NEW.user_id IS NOT NULL THEN
            UPDATE public.profiles
               SET message_count = message_count + 1
             WHERE id = NEW.user_id;
        END IF;
        RETURN NEW;
    ELSIF TG_OP = 'DELETE' THEN
        IF OLD.user_id IS NOT NULL THEN
            UPDATE public.profiles
               SET message_count = GREATEST(message_count - 1, 0)
             WHERE id = OLD.user_id;
        END IF;
        RETURN OLD;
    END IF;
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS trg_profile_message_counter_ins ON public.messages;
DROP TRIGGER IF EXISTS trg_profile_message_counter_del ON public.messages;

CREATE TRIGGER trg_profile_message_counter_ins
    AFTER INSERT ON public.messages
    FOR EACH ROW EXECUTE FUNCTION public.tg_profile_message_counter();

CREATE TRIGGER trg_profile_message_counter_del
    AFTER DELETE ON public.messages
    FOR EACH ROW EXECUTE FUNCTION public.tg_profile_message_counter();

-- ---- Voice minutes -----------------------------------------------------
-- `voice_channel_participants` only tracks ACTIVE sessions (no left_at), so
-- on DELETE we compute `now() - joined_at` and add it to the user's bucket.
-- "Orphaned" rows (browser crash, server restart that wipes the participant
-- without a clean leave) won't be counted - acceptable trade-off for not
-- having a separate session-log table.
CREATE OR REPLACE FUNCTION public.tg_profile_voice_counter()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
    minutes bigint;
BEGIN
    IF OLD.user_id IS NULL OR OLD.joined_at IS NULL THEN
        RETURN OLD;
    END IF;
    minutes := GREATEST(
        FLOOR(EXTRACT(EPOCH FROM (now() - OLD.joined_at)) / 60.0)::bigint,
        0
    );
    IF minutes > 0 THEN
        UPDATE public.profiles
           SET voice_minutes = voice_minutes + minutes
         WHERE id = OLD.user_id;
    END IF;
    RETURN OLD;
END;
$$;

DROP TRIGGER IF EXISTS trg_profile_voice_counter_del ON public.voice_channel_participants;
CREATE TRIGGER trg_profile_voice_counter_del
    AFTER DELETE ON public.voice_channel_participants
    FOR EACH ROW EXECUTE FUNCTION public.tg_profile_voice_counter();

-- ---- Backfill ----------------------------------------------------------
-- One-time hydration so existing data isn't all zeros after the migration.
UPDATE public.profiles p
   SET message_count = sub.cnt
  FROM (
        SELECT user_id, count(*)::bigint AS cnt
          FROM public.messages
         WHERE user_id IS NOT NULL
         GROUP BY user_id
  ) sub
 WHERE p.id = sub.user_id
   AND p.message_count = 0;

-- No historical voice data exists prior to this migration, so voice_minutes
-- starts at 0 for everyone. It accrues from the next clean disconnect onward.

COMMENT ON COLUMN public.profiles.message_count
    IS 'Denormalized message count, maintained by tg_profile_message_counter trigger on public.messages.';
COMMENT ON COLUMN public.profiles.voice_minutes
    IS 'Denormalized voice-channel minutes, maintained by tg_profile_voice_counter trigger on public.voice_channel_participants DELETE.';
