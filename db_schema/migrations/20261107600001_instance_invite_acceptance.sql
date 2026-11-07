-- Instance invitations: accepted means the person chose a password or made a profile.
--
-- 20261105980001 counted an invitation accepted once its address was confirmed or its account
-- signed in. Any GET of GoTrue's /auth/v1/verify link does both: a link preview, a mail scanner
-- or a browser preload spent the invitation, the list called it accepted with no username, and
-- the admin could neither re-issue nor revoke it. A confirmed account with no chosen password and
-- no profile is still an open invitation: re-issued with a recovery token (GoTrue makes no invite
-- token for a confirmed address), revoked by deleting its auth user.
--
-- GoTrue's invite verification (signupVerify) stores a random 64-character password while the
-- user still has none (encrypted_password ''), so a hash proves nothing. A chosen password is a
-- second change: harmony_invite_password_chosen fires on an invited user's encrypted_password
-- moving from one non-empty value to another (GoTrue PUT /user, or the admin API after a
-- verification) and records accepted_at. A profile counts from its created_at.
--
-- link_sent_at follows the newest token, confirmation_sent_at or recovery_sent_at.
--
-- Records accepted under the old rule reopen when their account has no profile and nothing
-- changed it after the link was opened: updated_at within 10 s of confirmed_at and
-- last_sign_in_at, which GoTrue's verification sets in one transaction (2 ms apart measured on
-- v2.197.0). Signatures and grants of the three functions are those of 20261105980001.

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------------------------
-- admin_instance_invite_account(p_email, p_auth_user_id): the auth users with that address, or
-- that id, and what they are to an invitation. accepted: its record holds accepted_at (a chosen
-- password) or a profile exists.
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
           i.accepted_at IS NOT NULL
             OR EXISTS (SELECT 1 FROM public.profiles p WHERE p.auth_user_id = u.id),
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
-- admin_revoke_instance_invite: withdraws an invitation by deleting its auth user, which voids
-- the link (GoTrue finds no user for the token). The row lock is held from the check to the
-- delete, so a password set meanwhile either lands first (accepted, nothing deleted) or finds
-- no user. Answers:
--   revoked      the auth user is gone; the record carries revoked_at and revoked_by
--   accepted     the account chose a password or has a profile; kept
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
    v_profile_at timestamptz;
    v_id uuid;
BEGIN
    IF p_admin_id IS NULL THEN
        RAISE EXCEPTION 'ADMIN_REQUIRED: a revoke names its admin' USING ERRCODE = '22023';
    END IF;

    SELECT u.id, lower(u.email)::text AS email, u.invited_at
      INTO v_user
      FROM auth.users u
     WHERE u.id = p_auth_user_id
       FOR UPDATE;
    IF NOT FOUND THEN
        RETURN 'not_found';
    END IF;

    SELECT min(p.created_at) INTO v_profile_at FROM public.profiles p WHERE p.auth_user_id = p_auth_user_id;

    IF v_profile_at IS NOT NULL THEN
        UPDATE public.instance_invites i
           SET accepted_at = v_profile_at
         WHERE i.auth_user_id = p_auth_user_id AND i.accepted_at IS NULL AND i.revoked_at IS NULL;
        RETURN 'accepted';
    END IF;
    IF EXISTS (SELECT 1 FROM public.instance_invites i
                WHERE i.auth_user_id = p_auth_user_id AND i.accepted_at IS NOT NULL) THEN
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
-- invitations whose account made a profile since the last read; a chosen password records it
-- as it happens (on_invited_password_chosen).
--   status       pending, accepted, revoked, or removed (the auth user is gone, not by a revoke)
--   link_sent_at the newer of GoTrue's confirmation_sent_at and recovery_sent_at while the
--                invitation is open: the link expires GOTRUE_MAILER_OTP_EXP seconds after it
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
       SET accepted_at = (SELECT min(p.created_at) FROM public.profiles p WHERE p.auth_user_id = i.auth_user_id)
     WHERE i.accepted_at IS NULL
       AND i.revoked_at IS NULL
       AND EXISTS (SELECT 1 FROM public.profiles p WHERE p.auth_user_id = i.auth_user_id);

    RETURN QUERY
    SELECT x.id, x.email, x.auth_user_id, x.source, x.delivery, x.invited_by_username, x.created_at,
           x.links_issued, x.link_sent_at, x.accepted_at, x.account_username, x.revoked_at,
           x.revoked_by_username, x.status
      FROM (
        SELECT i.id, i.email, i.auth_user_id, i.source, i.delivery,
               inviter.username::text AS invited_by_username,
               i.created_at, i.links_issued,
               COALESCE(GREATEST(u.confirmation_sent_at, u.recovery_sent_at), i.link_issued_at) AS link_sent_at,
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
               COALESCE(u.invited_at, u.created_at), 1, GREATEST(u.confirmation_sent_at, u.recovery_sent_at),
               NULL::timestamptz, NULL::text, NULL::timestamptz, NULL::text, 'pending'::text
          FROM auth.users u
         WHERE u.invited_at IS NOT NULL
           AND NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.auth_user_id = u.id)
           AND NOT EXISTS (SELECT 1 FROM public.instance_invites i WHERE i.auth_user_id = u.id)
      ) x
     ORDER BY (x.status = 'pending') DESC, x.created_at DESC
     LIMIT v_limit;
END;
$$;

REVOKE ALL ON FUNCTION public.admin_instance_invites(integer) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.admin_instance_invites(integer) TO service_role;

-- ---------------------------------------------------------------------------------------------
-- on_invited_password_chosen: records acceptance when an invited account without a profile
-- chooses a password. A GoTrue invitation without a record gets one (source other). An account
-- with a profile is accepted already; its later password changes record nothing.
CREATE OR REPLACE FUNCTION public.on_invited_password_chosen()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF EXISTS (SELECT 1 FROM public.profiles p WHERE p.auth_user_id = NEW.id) THEN
        RETURN NULL;
    END IF;
    INSERT INTO public.instance_invites (email, auth_user_id, invited_by, source, delivery, created_at, link_issued_at, accepted_at)
    VALUES (lower(NEW.email), NEW.id, NULL, 'other', NULL, NEW.invited_at, NEW.invited_at, now())
    ON CONFLICT (auth_user_id) DO UPDATE
       SET accepted_at = now()
     WHERE instance_invites.accepted_at IS NULL AND instance_invites.revoked_at IS NULL;
    RETURN NULL;
EXCEPTION WHEN OTHERS THEN
    RAISE WARNING 'on_invited_password_chosen: %', SQLERRM;
    RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.on_invited_password_chosen() FROM PUBLIC, anon, authenticated;

-- Mirrors harmony_password_changed (20261005400001): GoTrue owns auth.users.
DO $$
BEGIN
    DROP TRIGGER IF EXISTS harmony_invite_password_chosen ON auth.users;
    CREATE TRIGGER harmony_invite_password_chosen AFTER UPDATE OF encrypted_password ON auth.users
        FOR EACH ROW
        WHEN (OLD.invited_at IS NOT NULL
              AND OLD.encrypted_password IS DISTINCT FROM NEW.encrypted_password
              AND coalesce(OLD.encrypted_password, '') <> ''
              AND coalesce(NEW.encrypted_password, '') <> '')
        EXECUTE FUNCTION public.on_invited_password_chosen();
    RAISE NOTICE 'auth.users invitation password trigger installed';
EXCEPTION WHEN insufficient_privilege THEN
    RAISE NOTICE 'auth.users invitation password trigger skipped: %', SQLERRM;
END;
$$;

UPDATE public.instance_invites i
   SET accepted_at = NULL
  FROM auth.users u
 WHERE u.id = i.auth_user_id
   AND i.accepted_at IS NOT NULL
   AND i.revoked_at IS NULL
   AND NOT EXISTS (SELECT 1 FROM public.profiles p WHERE p.auth_user_id = u.id)
   AND u.updated_at < GREATEST(u.confirmed_at, u.last_sign_in_at) + interval '10 seconds';

COMMIT;

NOTIFY pgrst, 'reload schema';
