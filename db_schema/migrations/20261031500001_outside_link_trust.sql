-- Outside links: per-account choices for the "Leaving Harmony" dialog.
--
--   outside_link_settings   one row per account, absent until first changed
--     ask_every_link        true: every outside link asks before opening, not only masked ones
--   trusted_link_hosts      hosts that open without asking, 500 per account (54000
--                           TRUSTED_LINK_HOSTS_LIMIT past that)
--     host                  URL host, normalised as utils/outsideLinks.ts trustHostOf: lower
--                           case, punycode, no trailing dot, no leading "www.", ":port" kept
--                           when not the scheme's default, IPv6 literals in brackets.
--
-- Keyed by auth.users, not profiles: profiles stay readable by everyone and survive account
-- deletion as a tombstone, while delete_my_account deletes the auth user and the cascade takes
-- these rows. Readable and writable only by their own account; anon holds nothing.

BEGIN;

SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS public.outside_link_settings (
    user_id uuid PRIMARY KEY DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
    ask_every_link boolean NOT NULL DEFAULT false,
    updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE public.outside_link_settings IS
    'Per-account outside-link choices; ask_every_link asks before every outside link.';

CREATE TABLE IF NOT EXISTS public.trusted_link_hosts (
    user_id uuid NOT NULL DEFAULT auth.uid() REFERENCES auth.users(id) ON DELETE CASCADE,
    host text NOT NULL CONSTRAINT trusted_link_hosts_host_check CHECK (
        char_length(host) <= 261
        AND host ~ '^(\[[0-9a-f:.]+\]|[a-z0-9_-]+(\.[a-z0-9_-]+)*)(:[0-9]{1,5})?$'
        AND host !~ '^www\.'
    ),
    created_at timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (user_id, host)
);
COMMENT ON TABLE public.trusted_link_hosts IS
    'Hosts an account opens without the outside-link dialog.';

REVOKE ALL ON public.outside_link_settings, public.trusted_link_hosts FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.outside_link_settings TO authenticated;
GRANT SELECT, INSERT, DELETE ON public.trusted_link_hosts TO authenticated;
GRANT ALL ON public.outside_link_settings, public.trusted_link_hosts TO service_role;

ALTER TABLE public.outside_link_settings ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.trusted_link_hosts ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS outside_link_settings_own ON public.outside_link_settings;
CREATE POLICY outside_link_settings_own ON public.outside_link_settings
    FOR ALL TO authenticated
    USING (user_id = (SELECT auth.uid()))
    WITH CHECK (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS trusted_link_hosts_select_own ON public.trusted_link_hosts;
CREATE POLICY trusted_link_hosts_select_own ON public.trusted_link_hosts
    FOR SELECT TO authenticated
    USING (user_id = (SELECT auth.uid()));

DROP POLICY IF EXISTS trusted_link_hosts_insert_own ON public.trusted_link_hosts;
CREATE POLICY trusted_link_hosts_insert_own ON public.trusted_link_hosts
    FOR INSERT TO authenticated
    WITH CHECK (user_id = (SELECT auth.uid()));

-- A policy reading its own table recurses; the cap is a trigger. The advisory lock serialises
-- one account's inserts so concurrent ones cannot pass at 499 together.
CREATE OR REPLACE FUNCTION public.trusted_link_hosts_cap()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = public, pg_temp
AS $$
BEGIN
    PERFORM pg_advisory_xact_lock(hashtextextended('trusted_link_hosts:' || NEW.user_id::text, 0));
    IF (SELECT count(*) FROM public.trusted_link_hosts t WHERE t.user_id = NEW.user_id) >= 500 THEN
        RAISE EXCEPTION 'TRUSTED_LINK_HOSTS_LIMIT: 500 trusted hosts per account' USING ERRCODE = '54000';
    END IF;
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.trusted_link_hosts_cap() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS t_trusted_link_hosts_cap ON public.trusted_link_hosts;
CREATE TRIGGER t_trusted_link_hosts_cap
    BEFORE INSERT ON public.trusted_link_hosts
    FOR EACH ROW EXECUTE FUNCTION public.trusted_link_hosts_cap();

DROP POLICY IF EXISTS trusted_link_hosts_delete_own ON public.trusted_link_hosts;
CREATE POLICY trusted_link_hosts_delete_own ON public.trusted_link_hosts
    FOR DELETE TO authenticated
    USING (user_id = (SELECT auth.uid()));

COMMIT;
