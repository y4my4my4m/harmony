-- Federation-backend and bot-gateway findings of the security audit, after 20261005900001.
--
-- federated_voice_calls. Rows are signalling for inbound federated DM calls; LiveKitService
-- mints no token from them. A pending ring expires at expires_at (60 s); an accepted call
-- ends 4 h after acceptance, the federated LiveKit token TTL; a settled row is deleted after
-- 7 days. cleanup_expired_voice_calls runs every minute under pg_cron. It is SECURITY
-- INVOKER: its callers are pg_cron (superuser) and service_role, which hold the table.
--
-- threads.federation_status 'stub'. A thread inserted from a message that names a thread not
-- yet known here keeps 'stub'; the thread's own Create claims it and sets 'synced'
-- (ThreadActivityHandler). Any other inbound thread is 'synced', as before. No UPDATE turns
-- a thread into a stub.
--
-- Profile suspension. Memberships stay: suspension is reversible, and every inbound
-- federation path refuses a suspended profile's writes (ActivityProcessor,
-- ServerInboxHandler, channelWriteAuthz). The trigger removes follows between the profile
-- and local profiles (production's behaviour, absent from the baseline), its voice presence,
-- and its pending or accepted federated calls. SECURITY DEFINER, so the cleanup holds
-- whatever the RLS of the updating admin.
--
-- Trigger functions take no caller check: PostgreSQL runs them only as triggers, and
-- PostgREST does not expose them.
--
-- bot_server_permissions. manage_roles gates bot role writes in bot-gateway;
-- allowed_channel_ids restricts an install to the listed channels (NULL: unrestricted).
-- Production has both columns; fresh installs and staging gain them.

BEGIN;

SET LOCAL lock_timeout = '3s';

ALTER TABLE public.bot_server_permissions
    ADD COLUMN IF NOT EXISTS manage_roles boolean DEFAULT false;
ALTER TABLE public.bot_server_permissions
    ADD COLUMN IF NOT EXISTS allowed_channel_ids uuid[];

-- ---------------------------------------------------------------------------------------
-- Federated call expiry.
CREATE OR REPLACE FUNCTION public.cleanup_expired_voice_calls()
RETURNS void
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $$
BEGIN
    UPDATE public.federated_voice_calls
       SET status = 'expired'
     WHERE status = 'pending'
       AND expires_at < now();

    UPDATE public.federated_voice_calls
       SET status = 'ended', ended_at = now()
     WHERE status = 'accepted'
       AND COALESCE(accepted_at, created_at) < now() - interval '4 hours';

    DELETE FROM public.federated_voice_calls
     WHERE status IN ('expired', 'rejected', 'ended', 'missed')
       AND COALESCE(ended_at, expires_at, created_at) < now() - interval '7 days';
END;
$$;

COMMENT ON FUNCTION public.cleanup_expired_voice_calls() IS
    'Expires unanswered federated call rings, ends accepted calls after 4 h, deletes settled rows after 7 days. Scheduled every minute via pg_cron.';

-- ---------------------------------------------------------------------------------------
-- threads_federation_status_check exists on production and staging but not in the
-- baseline; it gains 'stub' and a fresh install gets the same list.
ALTER TABLE public.threads DROP CONSTRAINT IF EXISTS threads_federation_status_check;
ALTER TABLE public.threads ADD CONSTRAINT threads_federation_status_check
    CHECK (federation_status = ANY (ARRAY['pending', 'queued', 'processing', 'completed',
                                          'failed', 'skipped', 'synced', 'stub']));

-- ---------------------------------------------------------------------------------------
-- Thread stubs. Identical to the baseline apart from the 'stub' branches.
CREATE OR REPLACE FUNCTION public.trigger_queue_thread_federation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_server_id UUID;
    v_server_is_local BOOLEAN;
    v_creator_is_local BOOLEAN;
BEGIN
    IF TG_OP = 'INSERT' THEN
        -- Threads with ap_id already set came from federation (stub or ChatThread).
        IF NEW.ap_id IS NOT NULL THEN
            NEW.federation_status := CASE WHEN NEW.federation_status = 'stub' THEN 'stub' ELSE 'synced' END;
            RETURN NEW;
        END IF;

        SELECT c.server_id, s.is_local_server INTO v_server_id, v_server_is_local
        FROM public.channels c JOIN public.servers s ON c.server_id = s.id
        WHERE c.id = NEW.channel_id;

        SELECT is_local INTO v_creator_is_local FROM public.profiles WHERE id = NEW.created_by;

        IF v_creator_is_local IS NOT TRUE THEN
            NEW.federation_status := 'skipped';
            RETURN NEW;
        END IF;

        NEW.federation_status := 'queued';
        PERFORM public.queue_federation_job(
            'federate-thread',
            jsonb_build_object(
                'type', 'create', 'thread_id', NEW.id, 'channel_id', NEW.channel_id,
                'server_id', v_server_id, 'server_is_local', COALESCE(v_server_is_local, true),
                'created_by', NEW.created_by, 'created_at', NEW.created_at
            ), 5, 5, 900
        );
    ELSIF TG_OP = 'UPDATE' THEN
        IF NEW.federation_status = 'stub' AND OLD.federation_status IS DISTINCT FROM 'stub' THEN
            NEW.federation_status := OLD.federation_status;
        END IF;

        IF (OLD.name IS NOT DISTINCT FROM NEW.name AND
            OLD.archived IS NOT DISTINCT FROM NEW.archived AND
            OLD.locked IS NOT DISTINCT FROM NEW.locked) THEN
            RETURN NEW;
        END IF;

        SELECT c.server_id, s.is_local_server INTO v_server_id, v_server_is_local
        FROM public.channels c JOIN public.servers s ON c.server_id = s.id
        WHERE c.id = NEW.channel_id;

        SELECT is_local INTO v_creator_is_local FROM public.profiles WHERE id = NEW.created_by;
        IF v_creator_is_local IS NOT TRUE THEN RETURN NEW; END IF;

        IF NEW.federation_status = 'local' OR NEW.federation_status IS NULL THEN
            NEW.federation_status := 'queued';
        END IF;

        PERFORM public.queue_federation_job(
            'federate-thread',
            jsonb_build_object(
                'type', 'update', 'thread_id', NEW.id, 'channel_id', NEW.channel_id,
                'server_id', v_server_id, 'server_is_local', COALESCE(v_server_is_local, true),
                'created_by', NEW.created_by
            ), 5, 5, 900
        );
    END IF;

    RETURN NEW;
EXCEPTION
    WHEN undefined_table THEN RETURN NEW;
    WHEN OTHERS THEN
        RAISE WARNING 'trigger_queue_thread_federation error: %', SQLERRM;
        RETURN NEW;
END;
$$;

-- ---------------------------------------------------------------------------------------
-- Suspension cleanup.
CREATE OR REPLACE FUNCTION public.handle_remote_user_suspension()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NEW.is_suspended = true AND OLD.is_suspended IS DISTINCT FROM true THEN
        DELETE FROM public.follows f
         WHERE f.follower_id = NEW.id
           AND EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = f.following_id AND p.is_local = true);
        DELETE FROM public.follows f
         WHERE f.following_id = NEW.id
           AND EXISTS (SELECT 1 FROM public.profiles p WHERE p.id = f.follower_id AND p.is_local = true);

        DELETE FROM public.voice_channel_participants WHERE user_id = NEW.id;

        UPDATE public.federated_voice_calls
           SET status = 'ended', ended_at = now()
         WHERE (caller_id = NEW.id OR recipient_id = NEW.id)
           AND status IN ('pending', 'accepted');
    END IF;
    RETURN NEW;
END;
$$;

COMMENT ON FUNCTION public.handle_remote_user_suspension() IS
    'On suspension: removes follows with local profiles, voice presence and active federated calls. Memberships are kept; inbound writes of a suspended profile are refused by federation-backend.';

DROP TRIGGER IF EXISTS trigger_handle_remote_user_suspension ON public.profiles;
CREATE TRIGGER trigger_handle_remote_user_suspension
    AFTER UPDATE OF is_suspended ON public.profiles
    FOR EACH ROW
    WHEN (NEW.is_suspended = true)
    EXECUTE FUNCTION public.handle_remote_user_suspension();

-- ---------------------------------------------------------------------------------------
-- Privileges.
DO $$
DECLARE
    fn regprocedure;
    grantee text;
BEGIN
    FOREACH fn IN ARRAY ARRAY[
        'public.cleanup_expired_voice_calls()'::regprocedure,
        'public.trigger_queue_thread_federation()'::regprocedure,
        'public.handle_remote_user_suspension()'::regprocedure]
    LOOP
        EXECUTE format('REVOKE ALL ON FUNCTION %s FROM PUBLIC, anon, authenticated', fn);
        FOREACH grantee IN ARRAY ARRAY['postgres', 'supabase_admin', 'service_role'] LOOP
            IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = grantee) THEN
                EXECUTE format('GRANT EXECUTE ON FUNCTION %s TO %I', fn, grantee);
            END IF;
        END LOOP;
    END LOOP;
END;
$$;

-- ---------------------------------------------------------------------------------------
-- Schedule. The outer $do$ tag keeps the inner command string intact.
DO $do$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_extension WHERE extname = 'pg_cron') THEN
        BEGIN
            PERFORM cron.unschedule('expire-federated-voice-calls');
        EXCEPTION WHEN OTHERS THEN NULL;
        END;
        PERFORM cron.schedule(
            'expire-federated-voice-calls',
            '* * * * *',
            'SELECT public.cleanup_expired_voice_calls()'
        );
    ELSE
        RAISE NOTICE 'pg_cron not available: cleanup_expired_voice_calls is not scheduled';
    END IF;
END $do$;

COMMIT;

NOTIFY pgrst, 'reload schema';
