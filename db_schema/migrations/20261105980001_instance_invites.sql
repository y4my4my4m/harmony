-- Instance invitations: accounts an instance admin invites by address.
--
-- GoTrue holds the invitation itself: an auth.users row with invited_at set, a confirmation
-- token, and confirmation_sent_at, from which the link lives GOTRUE_MAILER_OTP_EXP seconds
-- (86400 by default). Following the link confirms the address and signs in, which sets
-- confirmed_at and last_sign_in_at; sign-up being off (GOTRUE_DISABLE_SIGNUP) does not stop it.
--
--   instance_invites          one row per invited auth user
--     auth_user_id            the GoTrue user the invitation made; no foreign key, the row
--                             outlives a revoked invitation, whose user is deleted
--     invited_by              the admin's profile; null for the command line and for
--                             invitations made outside Harmony
--     source                  admin (admin panel), cli (harmony admin invite), other (a GoTrue
--                             invitation without a record, recorded when an admin acts on it)
--     delivery                how the latest link went out: link (shown to the admin) or email
--                             (sent by GoTrue); null when unknown
--     link_issued_at          the latest link; GoTrue's confirmation_sent_at is the expiry base
--     links_issued            links made for this invitation; a new one voids the one before
--     accepted_at             first confirmation or sign-in of the account
--     revoked_at, revoked_by  the admin who withdrew it; its auth user is deleted
--
-- The functions are service-role only and trust their p_admin_id; instance admins read the
-- table (RLS). The auth.users columns read here (invited_at, confirmation_sent_at, confirmed_at,
-- last_sign_in_at) are in GoTrue's first schema; later GoTrue versions make confirmed_at a
-- generated column, LEAST(email_confirmed_at, phone_confirmed_at).

BEGIN;

SET LOCAL lock_timeout = '5s';

CREATE TABLE IF NOT EXISTS public.instance_invites (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    email text NOT NULL CONSTRAINT instance_invites_email_check CHECK (
        char_length(email) <= 320 AND email = lower(email) AND email ~ '^[^@[:space:]]+@[^@[:space:]]+$'
    ),
    auth_user_id uuid NOT NULL CONSTRAINT instance_invites_auth_user_id_key UNIQUE,
    invited_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
    source text NOT NULL CONSTRAINT instance_invites_source_check CHECK (source IN ('admin', 'cli', 'other')),
    delivery text CONSTRAINT instance_invites_delivery_check CHECK (delivery IN ('link', 'email')),
    created_at timestamptz NOT NULL DEFAULT now(),
    link_issued_at timestamptz NOT NULL DEFAULT now(),
    links_issued integer NOT NULL DEFAULT 1 CONSTRAINT instance_invites_links_issued_check CHECK (links_issued >= 1),
    accepted_at timestamptz,
    revoked_at timestamptz,
    revoked_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
    CONSTRAINT instance_invites_closed_once CHECK (accepted_at IS NULL OR revoked_at IS NULL)
);
COMMENT ON TABLE public.instance_invites IS
    'Invitations to make an account on this instance: who invited which address, when, how; accepted or revoked.';

CREATE INDEX IF NOT EXISTS instance_invites_created_at_idx ON public.instance_invites (created_at DESC);
CREATE INDEX IF NOT EXISTS instance_invites_invited_by_idx ON public.instance_invites (invited_by);
CREATE INDEX IF NOT EXISTS instance_invites_revoked_by_idx ON public.instance_invites (revoked_by);

REVOKE ALL ON public.instance_invites FROM PUBLIC, anon, authenticated;
GRANT SELECT ON public.instance_invites TO authenticated;
GRANT ALL ON public.instance_invites TO service_role;

ALTER TABLE public.instance_invites ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS instance_invites_admin_read ON public.instance_invites;
CREATE POLICY instance_invites_admin_read ON public.instance_invites
    FOR SELECT TO authenticated
    USING ((SELECT public.is_current_user_admin()));

-- ---------------------------------------------------------------------------------------------
-- admin_instance_invite_account(p_email, p_auth_user_id): the auth users with that address, or
-- that id, and what they are to an invitation. accepted: the address is confirmed or the
-- account has signed in.
CREATE OR REPLACE FUNCTION public.admin_instance_invite_account(
    p_email text DEFAULT NULL,
    p_auth_user_id uuid DEFAULT NULL
)
RETURNS TABLE (
    auth_user_id uuid,
    email text,
    invited boolean,
    accepted boolean,
    has_profile boolean,
    invite_id uuid,
    revoked boolean
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_email text := lower(btrim(p_email));
BEGIN
    RETURN QUERY
    SELECT u.id,
           lower(u.email)::text,
           u.invited_at IS NOT NULL,
           u.confirmed_at IS NOT NULL OR u.last_sign_in_at IS NOT NULL,
           EXISTS (SELECT 1 FROM public.profiles p WHERE p.auth_user_id = u.id),
           i.id,
           i.revoked_at IS NOT NULL
      FROM auth.users u
      LEFT JOIN public.instance_invites i ON i.auth_user_id = u.id
     WHERE (v_email IS NOT NULL AND lower(u.email) = v_email)
        OR (p_auth_user_id IS NOT NULL AND u.id = p_auth_user_id);
END;
$$;

REVOKE ALL ON FUNCTION public.admin_instance_invite_account(text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_instance_invite_account(text, uuid) TO service_role;

-- ---------------------------------------------------------------------------------------------
-- admin_record_instance_invite: records a link GoTrue has just made for p_auth_user_id.
--   p_action create   a new invitation by p_admin_id (null: the command line, source cli); an
--                     open record for the same user counts the link as a re-issue
--   p_action reissue  a new link for an open invitation; a GoTrue invitation without a record
--                     gets one (source other) first
-- Writes admin_audit_log as p_admin_id: instance_invite_created or instance_invite_reissued.
-- Raises P0002 INVITE_ACCOUNT_NOT_FOUND unless the user exists with that address and an
-- invitation, 55000 INVITE_CLOSED when its invitation was accepted or revoked.
CREATE OR REPLACE FUNCTION public.admin_record_instance_invite(
    p_auth_user_id uuid,
    p_email text,
    p_delivery text,
    p_action text,
    p_admin_id uuid DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_email text := lower(btrim(p_email));
    v_invited_at timestamptz;
    v_id uuid;
    v_created boolean := false;
BEGIN
    IF p_delivery IS NULL OR p_delivery NOT IN ('link', 'email') THEN
        RAISE EXCEPTION 'INVALID_DELIVERY: link or email' USING ERRCODE = '22023';
    END IF;
    IF p_action IS NULL OR p_action NOT IN ('create', 'reissue') THEN
        RAISE EXCEPTION 'INVALID_ACTION: create or reissue' USING ERRCODE = '22023';
    END IF;
    IF p_action = 'reissue' AND p_admin_id IS NULL THEN
        RAISE EXCEPTION 'ADMIN_REQUIRED: a re-issue names its admin' USING ERRCODE = '22023';
    END IF;

    SELECT u.invited_at INTO v_invited_at
      FROM auth.users u
     WHERE u.id = p_auth_user_id AND lower(u.email) = v_email AND u.invited_at IS NOT NULL;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'INVITE_ACCOUNT_NOT_FOUND: no invited account % with that address', p_auth_user_id
            USING ERRCODE = 'P0002';
    END IF;

    IF p_action = 'create' THEN
        INSERT INTO public.instance_invites (email, auth_user_id, invited_by, source, delivery)
        VALUES (v_email, p_auth_user_id, p_admin_id, CASE WHEN p_admin_id IS NULL THEN 'cli' ELSE 'admin' END, p_delivery)
        ON CONFLICT (auth_user_id) DO NOTHING
        RETURNING id INTO v_id;
        v_created := v_id IS NOT NULL;
    ELSE
        INSERT INTO public.instance_invites (email, auth_user_id, invited_by, source, delivery, created_at, link_issued_at)
        VALUES (v_email, p_auth_user_id, NULL, 'other', NULL, v_invited_at, v_invited_at)
        ON CONFLICT (auth_user_id) DO NOTHING;
    END IF;

    IF NOT v_created THEN
        UPDATE public.instance_invites i
           SET links_issued = i.links_issued + 1,
               link_issued_at = now(),
               delivery = p_delivery
         WHERE i.auth_user_id = p_auth_user_id
           AND i.accepted_at IS NULL
           AND i.revoked_at IS NULL
        RETURNING i.id INTO v_id;
        IF v_id IS NULL THEN
            RAISE EXCEPTION 'INVITE_CLOSED: the invitation was accepted or revoked' USING ERRCODE = '55000';
        END IF;
    END IF;

    IF p_admin_id IS NOT NULL THEN
        PERFORM public.log_admin_action(
            p_admin_id,
            CASE WHEN v_created THEN 'instance_invite_created' ELSE 'instance_invite_reissued' END,
            'invite',
            v_id::text,
            jsonb_build_object('email', v_email, 'delivery', p_delivery)
        );
    END IF;

    RETURN v_id;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_record_instance_invite(uuid, text, text, text, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_record_instance_invite(uuid, text, text, text, uuid) TO service_role;

-- ---------------------------------------------------------------------------------------------
-- admin_revoke_instance_invite: withdraws an invitation by deleting its auth user, which voids
-- the link (GoTrue finds no user for the token). The row lock is held from the check to the
-- delete, so a link followed meanwhile either confirms first (accepted, nothing deleted) or
-- finds no user. Answers:
--   revoked      the auth user is gone; the record carries revoked_at and revoked_by
--   accepted     the address is confirmed, the account signed in or made a profile; kept
--   not_invited  the account was not made by an invitation; kept
--   not_found    no such auth user
CREATE OR REPLACE FUNCTION public.admin_revoke_instance_invite(
    p_auth_user_id uuid,
    p_admin_id uuid
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_user record;
    v_id uuid;
BEGIN
    IF p_admin_id IS NULL THEN
        RAISE EXCEPTION 'ADMIN_REQUIRED: a revoke names its admin' USING ERRCODE = '22023';
    END IF;

    SELECT u.id, lower(u.email)::text AS email, u.invited_at, u.confirmed_at, u.last_sign_in_at
      INTO v_user
      FROM auth.users u
     WHERE u.id = p_auth_user_id
       FOR UPDATE;
    IF NOT FOUND THEN
        RETURN 'not_found';
    END IF;

    IF v_user.confirmed_at IS NOT NULL OR v_user.last_sign_in_at IS NOT NULL
       OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.auth_user_id = p_auth_user_id) THEN
        UPDATE public.instance_invites i
           SET accepted_at = COALESCE(LEAST(v_user.confirmed_at, v_user.last_sign_in_at), now())
         WHERE i.auth_user_id = p_auth_user_id AND i.accepted_at IS NULL AND i.revoked_at IS NULL;
        RETURN 'accepted';
    END IF;

    IF v_user.invited_at IS NULL THEN
        RETURN 'not_invited';
    END IF;

    INSERT INTO public.instance_invites (email, auth_user_id, invited_by, source, delivery, created_at, link_issued_at)
    VALUES (v_user.email, p_auth_user_id, NULL, 'other', NULL, v_user.invited_at, v_user.invited_at)
    ON CONFLICT (auth_user_id) DO NOTHING;

    UPDATE public.instance_invites i
       SET revoked_at = now(), revoked_by = p_admin_id
     WHERE i.auth_user_id = p_auth_user_id AND i.revoked_at IS NULL AND i.accepted_at IS NULL
    RETURNING i.id INTO v_id;

    -- Cascades the user's identities and one-time tokens through GoTrue's foreign keys.
    DELETE FROM auth.users WHERE id = p_auth_user_id;

    PERFORM public.log_admin_action(
        p_admin_id, 'instance_invite_revoked', 'invite', v_id::text,
        jsonb_build_object('email', v_user.email)
    );
    RETURN 'revoked';
END;
$$;

REVOKE ALL ON FUNCTION public.admin_revoke_instance_invite(uuid, uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_revoke_instance_invite(uuid, uuid) TO service_role;

-- ---------------------------------------------------------------------------------------------
-- admin_instance_invites(p_limit): open invitations first, then the rest newest first, with
-- GoTrue invitations no record names (status pending, source other). Records accepted_at for
-- invitations whose account has confirmed or signed in since the last read.
--   status       pending, accepted, revoked, or removed (the auth user is gone, not by a revoke)
--   link_sent_at GoTrue's confirmation_sent_at while the invitation is open: the link expires
--                GOTRUE_MAILER_OTP_EXP seconds after it
CREATE OR REPLACE FUNCTION public.admin_instance_invites(p_limit integer DEFAULT 200)
RETURNS TABLE (
    id uuid,
    email text,
    auth_user_id uuid,
    source text,
    delivery text,
    invited_by_username text,
    created_at timestamptz,
    links_issued integer,
    link_sent_at timestamptz,
    accepted_at timestamptz,
    account_username text,
    revoked_at timestamptz,
    revoked_by_username text,
    status text
)
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_limit integer := LEAST(GREATEST(COALESCE(p_limit, 200), 1), 500);
BEGIN
    UPDATE public.instance_invites i
       SET accepted_at = LEAST(u.confirmed_at, u.last_sign_in_at)
      FROM auth.users u
     WHERE u.id = i.auth_user_id
       AND i.accepted_at IS NULL
       AND i.revoked_at IS NULL
       AND (u.confirmed_at IS NOT NULL OR u.last_sign_in_at IS NOT NULL);

    RETURN QUERY
    SELECT x.id, x.email, x.auth_user_id, x.source, x.delivery, x.invited_by_username, x.created_at,
           x.links_issued, x.link_sent_at, x.accepted_at, x.account_username, x.revoked_at,
           x.revoked_by_username, x.status
      FROM (
        SELECT i.id, i.email, i.auth_user_id, i.source, i.delivery,
               inviter.username::text AS invited_by_username,
               i.created_at, i.links_issued,
               COALESCE(u.confirmation_sent_at, i.link_issued_at) AS link_sent_at,
               i.accepted_at,
               (SELECT p.username::text FROM public.profiles p WHERE p.auth_user_id = i.auth_user_id LIMIT 1) AS account_username,
               i.revoked_at,
               revoker.username::text AS revoked_by_username,
               CASE WHEN i.revoked_at IS NOT NULL THEN 'revoked'
                    WHEN i.accepted_at IS NOT NULL THEN 'accepted'
                    WHEN u.id IS NULL THEN 'removed'
                    ELSE 'pending' END AS status
          FROM public.instance_invites i
          LEFT JOIN auth.users u ON u.id = i.auth_user_id
          LEFT JOIN public.profiles inviter ON inviter.id = i.invited_by
          LEFT JOIN public.profiles revoker ON revoker.id = i.revoked_by
        UNION ALL
        SELECT NULL::uuid, lower(u.email)::text, u.id, 'other'::text, NULL::text, NULL::text,
               COALESCE(u.invited_at, u.created_at), 1, u.confirmation_sent_at, NULL::timestamptz,
               NULL::text, NULL::timestamptz, NULL::text, 'pending'::text
          FROM auth.users u
         WHERE u.invited_at IS NOT NULL
           AND u.confirmed_at IS NULL
           AND u.last_sign_in_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM public.instance_invites i WHERE i.auth_user_id = u.id)
      ) x
     ORDER BY (x.status = 'pending') DESC, x.created_at DESC
     LIMIT v_limit;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_instance_invites(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_instance_invites(integer) TO service_role;

COMMIT;

NOTIFY pgrst, 'reload schema';
