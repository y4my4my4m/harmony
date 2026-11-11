-- Leaving a thread keeps it off that account's sidebar. Membership alone cannot say so: an account
-- that never joined has no row either, and active threads list for it.
--
-- thread_departures(id, thread_id, user_id, left_at)
--   Written by leave_thread, for an account that held a membership. Readable by its own account.
--   Surrogate key, as thread_members: a primary key holding both foreign keys makes it a PostgREST
--   threads-profiles junction, and threads?select=...,profiles(...) fails with PGRST201.
-- leave_thread(thread)
--   Removes the caller's membership, records the departure, recounts threads.member_count.
-- z_thread_members_joined
--   A new membership, joined or by posting (thread_message_handler), ends the departure and
--   recounts member_count, which otherwise moves only when a message is sent.
--
-- Converges by state: rerunning changes nothing.

BEGIN;

SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS public.thread_departures (
    id uuid DEFAULT gen_random_uuid() NOT NULL PRIMARY KEY,
    thread_id uuid NOT NULL REFERENCES public.threads(id) ON DELETE CASCADE,
    user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    left_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (thread_id, user_id)
);

CREATE INDEX IF NOT EXISTS thread_departures_user_idx ON public.thread_departures (user_id);

ALTER TABLE public.thread_departures ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS thread_departures_select_own ON public.thread_departures;
CREATE POLICY thread_departures_select_own ON public.thread_departures
    FOR SELECT TO authenticated
    USING (user_id = (SELECT public.get_current_profile_id()));

REVOKE ALL ON public.thread_departures FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.thread_departures TO authenticated;
GRANT ALL ON public.thread_departures TO service_role;

CREATE OR REPLACE FUNCTION public.leave_thread(p_thread_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_me uuid := public.get_current_profile_id();
BEGIN
    IF v_me IS NULL THEN
        RAISE EXCEPTION 'Not authenticated' USING ERRCODE = '42501';
    END IF;

    DELETE FROM public.thread_members WHERE thread_id = p_thread_id AND user_id = v_me;
    IF NOT FOUND THEN
        RETURN;
    END IF;

    INSERT INTO public.thread_departures (thread_id, user_id) VALUES (p_thread_id, v_me)
    ON CONFLICT (thread_id, user_id) DO UPDATE SET left_at = now();

    UPDATE public.threads
       SET member_count = (SELECT count(*) FROM public.thread_members m WHERE m.thread_id = p_thread_id)
     WHERE id = p_thread_id;
END;
$$;

CREATE OR REPLACE FUNCTION public.thread_member_joined()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    DELETE FROM public.thread_departures WHERE thread_id = NEW.thread_id AND user_id = NEW.user_id;
    UPDATE public.threads
       SET member_count = (SELECT count(*) FROM public.thread_members m WHERE m.thread_id = NEW.thread_id)
     WHERE id = NEW.thread_id;
    RETURN NULL;
END;
$$;

DROP TRIGGER IF EXISTS z_thread_members_joined ON public.thread_members;
CREATE TRIGGER z_thread_members_joined
    AFTER INSERT ON public.thread_members
    FOR EACH ROW EXECUTE FUNCTION public.thread_member_joined();

REVOKE ALL ON FUNCTION public.leave_thread(uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.leave_thread(uuid) TO authenticated, service_role;
REVOKE ALL ON FUNCTION public.thread_member_joined() FROM PUBLIC, anon, authenticated;

COMMIT;

NOTIFY pgrst, 'reload schema';
