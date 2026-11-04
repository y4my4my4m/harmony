-- Supporter messages and the funding summary.
--
-- instance_supporter_messages: a donor writes a message (plain text, 1 to 50 code points after
-- NFC) before opening a payment link; set_supporter_message keeps one unattached message per
-- profile. A donation recorded for that profile within 24 hours of the message's last edit
-- attaches it (trigger on instance_donation_history, whatever records the donation: the Stripe
-- or Ko-fi webhook, an admin's manual entry, a resolved pending donation). One message per
-- donation. An attached message waits for an admin: review 'pending', 'approved' or 'hidden'.
-- Approved, unhidden messages show to every signed-in user (get_funding_summary) and, when
-- supporter_messages_public is on, to anyone (get_public_supporter_messages: the sign-in page,
-- and the federation backend's /funding/public feed). The author sees their own in every state.
-- An anonymous message carries no name, avatar or profile id outside the admin list.
--
-- supporter_message_problem() is the validation, used by the RPC and the table's CHECK:
-- NFC-normalized, no leading or trailing space, 1 to 50 code points, no C0 or C1 control
-- (newline and tab included), no line or paragraph separator (U+2028, U+2029), no bidi mark,
-- embedding, override or isolate (U+061C, U+200E, U+200F, U+202A-202E, U+2066-2069), and no run
-- of three or more combining marks from the generic combining blocks (U+0300-036F, U+0483-0489,
-- U+1AB0-1AFF, U+1DC0-1DFF, U+20D0-20FF, U+FE20-FE2F). federation-backend
-- services/supporterMessageText.ts applies the same rule to the project's feed.
--
-- instance_funding.supporter_messages_enabled: donors may write messages, and approved ones
-- show in the app. instance_funding.supporter_messages_public: approved messages also show
-- signed out. Both default on; nothing shows before an admin approves it.
--
-- get_funding_summary(): one read for the support pill, the Support window and the account
-- settings: the client-readable funding columns, the period's total (UTC calendar month, or
-- all time), the period's end, the count of active unexpired supporters, the tiers, the
-- approved messages, and for a signed-in caller their badge, donations and own messages.
--
-- Converges by state: rerunning changes nothing.

BEGIN;

SET LOCAL lock_timeout = '5s';

ALTER TABLE public.instance_funding
    ADD COLUMN IF NOT EXISTS supporter_messages_enabled boolean NOT NULL DEFAULT true,
    ADD COLUMN IF NOT EXISTS supporter_messages_public boolean NOT NULL DEFAULT true;

GRANT SELECT (supporter_messages_enabled, supporter_messages_public),
      INSERT (supporter_messages_enabled, supporter_messages_public),
      UPDATE (supporter_messages_enabled, supporter_messages_public)
   ON public.instance_funding TO authenticated;

-- NULL when p_body is a valid message; otherwise the rule it breaks.
CREATE OR REPLACE FUNCTION public.supporter_message_problem(p_body text)
RETURNS text
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
SET search_path = pg_catalog, pg_temp
AS $$
    SELECT CASE
        WHEN p_body IS NULL OR p_body = '' THEN 'empty'
        WHEN p_body IS NOT NFC NORMALIZED THEN 'normalization'
        WHEN char_length(p_body) > 50 THEN 'length'
        WHEN p_body <> btrim(p_body) THEN 'whitespace'
        WHEN p_body ~ '[\u0001-\u001f\u007f-\u009f\u2028\u2029]' THEN 'control'
        WHEN p_body ~ '[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]' THEN 'bidi'
        WHEN p_body ~ '[\u0300-\u036f\u0483-\u0489\u1ab0-\u1aff\u1dc0-\u1dff\u20d0-\u20ff\ufe20-\ufe2f]{3}' THEN 'marks'
    END;
$$;

REVOKE ALL ON FUNCTION public.supporter_message_problem(text) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.supporter_message_problem(text) TO authenticated, service_role;

CREATE TABLE IF NOT EXISTS public.instance_supporter_messages (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    body text NOT NULL,
    anonymous boolean NOT NULL DEFAULT false,
    donation_id uuid UNIQUE REFERENCES public.instance_donation_history(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now(),
    attached_at timestamptz,
    review text NOT NULL DEFAULT 'pending',
    reviewed_at timestamptz,
    reviewed_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
    CONSTRAINT instance_supporter_messages_body_valid
        CHECK (public.supporter_message_problem(body) IS NULL),
    CONSTRAINT instance_supporter_messages_review_known
        CHECK (review IN ('pending', 'approved', 'hidden')),
    CONSTRAINT instance_supporter_messages_attached_at
        CHECK ((donation_id IS NULL) = (attached_at IS NULL))
);

-- One unattached message per profile.
CREATE UNIQUE INDEX IF NOT EXISTS idx_supporter_messages_unattached
    ON public.instance_supporter_messages (user_id)
    WHERE donation_id IS NULL;
CREATE INDEX IF NOT EXISTS idx_supporter_messages_shown
    ON public.instance_supporter_messages (attached_at DESC)
    WHERE review = 'approved';
CREATE INDEX IF NOT EXISTS idx_supporter_messages_reviewed_by
    ON public.instance_supporter_messages (reviewed_by);

ALTER TABLE public.instance_supporter_messages ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "supporter_messages_service_role" ON public.instance_supporter_messages;
CREATE POLICY "supporter_messages_service_role" ON public.instance_supporter_messages
    FOR ALL TO service_role USING (true) WITH CHECK (true);
REVOKE ALL ON public.instance_supporter_messages FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.instance_supporter_messages TO service_role;

-- A donation attaches its donor's unattached message written in the 24 hours before.
CREATE OR REPLACE FUNCTION public.attach_supporter_message()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    UPDATE public.instance_supporter_messages
       SET donation_id = NEW.id,
           attached_at = now()
     WHERE user_id = NEW.user_id
       AND donation_id IS NULL
       AND created_at > now() - interval '24 hours';
    RETURN NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.attach_supporter_message() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.attach_supporter_message() TO service_role;

DROP TRIGGER IF EXISTS trg_attach_supporter_message ON public.instance_donation_history;
CREATE TRIGGER trg_attach_supporter_message
    AFTER INSERT ON public.instance_donation_history
    FOR EACH ROW EXECUTE FUNCTION public.attach_supporter_message();

-- Writes the caller's unattached message; a second call replaces it and restarts its 24 hours.
-- 22023 with the rule as HINT for an invalid body; 55000 when messages are off.
CREATE OR REPLACE FUNCTION public.set_supporter_message(p_body text, p_anonymous boolean DEFAULT false)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_me uuid := public.get_current_profile_id();
    v_body text := btrim(normalize(COALESCE(p_body, ''), NFC));
    v_problem text;
    v_row public.instance_supporter_messages%ROWTYPE;
BEGIN
    IF v_me IS NULL THEN
        RAISE EXCEPTION 'Sign in to leave a message' USING ERRCODE = '42501';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM public.instance_funding f
                    WHERE f.enabled IS TRUE AND f.supporter_messages_enabled) THEN
        RAISE EXCEPTION 'Supporter messages are off on this instance'
            USING ERRCODE = '55000', HINT = 'disabled';
    END IF;
    v_problem := public.supporter_message_problem(v_body);
    IF v_problem IS NOT NULL THEN
        RAISE EXCEPTION 'Not a valid supporter message (%)', v_problem
            USING ERRCODE = '22023', HINT = v_problem;
    END IF;

    INSERT INTO public.instance_supporter_messages AS m (user_id, body, anonymous)
    VALUES (v_me, v_body, COALESCE(p_anonymous, false))
    ON CONFLICT (user_id) WHERE donation_id IS NULL
    DO UPDATE SET body = EXCLUDED.body,
                  anonymous = EXCLUDED.anonymous,
                  created_at = now()
    RETURNING * INTO v_row;

    RETURN jsonb_build_object(
        'id', v_row.id,
        'body', v_row.body,
        'anonymous', v_row.anonymous,
        'created_at', v_row.created_at,
        'expires_at', v_row.created_at + interval '24 hours');
END;
$$;

-- Deletes one of the caller's messages, attached or not. False when it is not theirs.
CREATE OR REPLACE FUNCTION public.delete_supporter_message(p_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_me uuid := public.get_current_profile_id();
BEGIN
    IF v_me IS NULL THEN
        RAISE EXCEPTION 'Sign in first' USING ERRCODE = '42501';
    END IF;
    DELETE FROM public.instance_supporter_messages WHERE id = p_id AND user_id = v_me;
    RETURN FOUND;
END;
$$;

-- Approves or hides an attached message. Instance admins only.
CREATE OR REPLACE FUNCTION public.admin_review_supporter_message(p_id uuid, p_review text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF current_setting('role', true) IN ('anon', 'authenticated')
       AND NOT public.is_current_user_admin() THEN
        RAISE EXCEPTION 'Instance admins only' USING ERRCODE = '42501';
    END IF;
    IF p_review IS NULL OR p_review NOT IN ('approved', 'hidden') THEN
        RAISE EXCEPTION 'A review is approved or hidden' USING ERRCODE = '22023';
    END IF;
    UPDATE public.instance_supporter_messages
       SET review = p_review,
           reviewed_at = now(),
           reviewed_by = public.get_current_profile_id()
     WHERE id = p_id
       AND donation_id IS NOT NULL;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'No attached supporter message %', p_id USING ERRCODE = 'P0002';
    END IF;
END;
$$;

-- Attached messages for the admin queue: awaiting review first, then newest. Instance admins only.
CREATE OR REPLACE FUNCTION public.admin_list_supporter_messages()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF current_setting('role', true) IN ('anon', 'authenticated')
       AND NOT public.is_current_user_admin() THEN
        RAISE EXCEPTION 'Instance admins only' USING ERRCODE = '42501';
    END IF;

    RETURN COALESCE((
        SELECT jsonb_agg(jsonb_build_object(
                   'id', x.id,
                   'body', x.body,
                   'anonymous', x.anonymous,
                   'review', x.review,
                   'attached_at', x.attached_at,
                   'reviewed_at', x.reviewed_at,
                   'user_id', x.user_id,
                   'username', x.username,
                   'display_name', x.display_name,
                   'amount', x.amount,
                   'currency', x.currency)
                 ORDER BY (x.review = 'pending') DESC, x.attached_at DESC)
          FROM (
            SELECT m.id, m.body, m.anonymous, m.review, m.attached_at, m.reviewed_at, m.user_id,
                   p.username, p.display_name, d.amount, d.currency
              FROM public.instance_supporter_messages m
              JOIN public.instance_donation_history d ON d.id = m.donation_id
              LEFT JOIN public.profiles p ON p.id = m.user_id
             ORDER BY (m.review = 'pending') DESC, m.attached_at DESC
             LIMIT 200
          ) x), '[]'::jsonb);
END;
$$;

-- Approved messages a signed-out visitor sees: none unless funding, messages and their public
-- display are on. No profile id; an anonymous message has no name.
CREATE OR REPLACE FUNCTION public.get_public_supporter_messages(p_limit integer DEFAULT 6)
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT COALESCE((
        SELECT jsonb_agg(jsonb_build_object('id', x.id, 'body', x.body, 'name', x.name, 'at', x.attached_at)
                         ORDER BY x.attached_at DESC)
          FROM (
            SELECT m.id, m.body, m.attached_at,
                   CASE WHEN m.anonymous THEN NULL
                        ELSE COALESCE(NULLIF(btrim(p.display_name), ''), p.username) END AS name
              FROM public.instance_supporter_messages m
              LEFT JOIN public.profiles p ON p.id = m.user_id
             WHERE m.review = 'approved'
               AND m.donation_id IS NOT NULL
               AND EXISTS (SELECT 1 FROM public.instance_funding f
                            WHERE f.enabled IS TRUE
                              AND f.supporter_messages_enabled
                              AND f.supporter_messages_public)
             ORDER BY m.attached_at DESC
             LIMIT LEAST(GREATEST(COALESCE(p_limit, 6), 1), 20)
          ) x), '[]'::jsonb);
$$;

CREATE OR REPLACE FUNCTION public.get_funding_summary()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_me uuid;
    v_f record;
    v_period text;
    v_start timestamptz;
    v_end timestamptz;
    v_total numeric;
    v_count integer;
    v_tiers jsonb;
    v_messages jsonb := '[]'::jsonb;
    v_mine jsonb;
BEGIN
    IF current_setting('role', true) = 'authenticated' THEN
        v_me := public.get_current_profile_id();
    END IF;

    SELECT f.id, f.enabled, f.goal_amount, f.goal_currency, f.current_amount, f.funding_period,
           f.goal_description, f.funding_links, f.show_progress_bar, f.show_in_context_bar,
           f.context_bar_style, f.thank_you_message, f.kofi_auto_assign_tier,
           f.stripe_auto_assign_tier, f.supporter_messages_enabled, f.supporter_messages_public
      INTO v_f
      FROM public.instance_funding f
     LIMIT 1;
    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    v_period := CASE WHEN v_f.funding_period = 'all' THEN 'all' ELSE 'monthly' END;
    IF v_period = 'monthly' THEN
        v_start := date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
        v_end := (date_trunc('month', now() AT TIME ZONE 'UTC') + interval '1 month') AT TIME ZONE 'UTC';
    END IF;

    SELECT COALESCE(SUM(d.amount), 0) INTO v_total
      FROM public.instance_donation_history d
     WHERE v_start IS NULL OR d.donated_at >= v_start;

    SELECT count(*) INTO v_count
      FROM public.instance_supporters s
     WHERE s.is_active IS TRUE
       AND (s.expires_at IS NULL OR s.expires_at > now());

    SELECT COALESCE(jsonb_agg(jsonb_build_object(
               'id', t.id, 'name', t.name, 'min_amount', t.min_amount, 'badge_icon', t.badge_icon,
               'badge_color', t.badge_color, 'perks', t.perks, 'display_order', t.display_order,
               'removes_ads', t.removes_ads)
             ORDER BY t.display_order, t.min_amount), '[]'::jsonb)
      INTO v_tiers
      FROM public.instance_supporter_tiers t;

    IF v_f.enabled IS TRUE AND v_f.supporter_messages_enabled THEN
        SELECT COALESCE(jsonb_agg(jsonb_build_object(
                   'id', x.id, 'body', x.body, 'anonymous', x.anonymous, 'at', x.attached_at,
                   'user_id', x.user_id, 'name', x.name, 'avatar_url', x.avatar_url)
                 ORDER BY x.attached_at DESC), '[]'::jsonb)
          INTO v_messages
          FROM (
            SELECT m.id, m.body, m.anonymous, m.attached_at,
                   CASE WHEN m.anonymous THEN NULL ELSE m.user_id END AS user_id,
                   CASE WHEN m.anonymous THEN NULL
                        ELSE COALESCE(NULLIF(btrim(p.display_name), ''), p.username) END AS name,
                   CASE WHEN m.anonymous THEN NULL ELSE p.avatar_url END AS avatar_url
              FROM public.instance_supporter_messages m
              LEFT JOIN public.profiles p ON p.id = m.user_id
             WHERE m.review = 'approved'
               AND m.donation_id IS NOT NULL
             ORDER BY m.attached_at DESC
             LIMIT 20
          ) x;
    END IF;

    IF v_me IS NOT NULL THEN
        SELECT jsonb_build_object(
            'profile_id', v_me,
            'badge', (
                SELECT jsonb_build_object('tier_name', t.name, 'badge_icon', t.badge_icon,
                                          'badge_color', t.badge_color, 'is_active', true,
                                          'expires_at', s.expires_at)
                  FROM public.instance_supporters s
                  JOIN public.instance_supporter_tiers t ON t.id = s.tier_id
                 WHERE s.user_id = v_me
                   AND s.is_active IS TRUE
                   AND (s.expires_at IS NULL OR s.expires_at > now())
                 LIMIT 1),
            'donations', COALESCE((
                SELECT jsonb_agg(jsonb_build_object(
                           'id', d.id, 'amount', d.amount, 'currency', d.currency,
                           'platform', d.platform, 'note', d.note, 'donated_at', d.donated_at)
                         ORDER BY d.donated_at DESC)
                  FROM (SELECT * FROM public.instance_donation_history
                         WHERE user_id = v_me
                         ORDER BY donated_at DESC
                         LIMIT 20) d), '[]'::jsonb),
            'messages', COALESCE((
                SELECT jsonb_agg(jsonb_build_object(
                           'id', m.id, 'body', m.body, 'anonymous', m.anonymous,
                           'attached', m.donation_id IS NOT NULL, 'review', m.review,
                           'created_at', m.created_at, 'attached_at', m.attached_at,
                           'expires_at', CASE WHEN m.donation_id IS NULL
                                              THEN m.created_at + interval '24 hours' END)
                         ORDER BY COALESCE(m.attached_at, m.created_at) DESC)
                  FROM public.instance_supporter_messages m
                 WHERE m.user_id = v_me
                   AND (m.donation_id IS NOT NULL OR m.created_at > now() - interval '24 hours')),
                '[]'::jsonb))
          INTO v_mine;
    END IF;

    RETURN jsonb_build_object(
        'id', v_f.id,
        'enabled', COALESCE(v_f.enabled, false),
        'goal_amount', v_f.goal_amount,
        'goal_currency', COALESCE(v_f.goal_currency, 'USD'),
        'current_amount', COALESCE(v_f.current_amount, 0),
        'funding_period', v_period,
        'goal_description', v_f.goal_description,
        'funding_links', COALESCE(v_f.funding_links, '[]'::jsonb),
        'show_progress_bar', COALESCE(v_f.show_progress_bar, true),
        'show_in_context_bar', COALESCE(v_f.show_in_context_bar, false),
        'context_bar_style', v_f.context_bar_style,
        'thank_you_message', v_f.thank_you_message,
        'kofi_auto_assign_tier', COALESCE(v_f.kofi_auto_assign_tier, true),
        'stripe_auto_assign_tier', COALESCE(v_f.stripe_auto_assign_tier, true),
        'supporter_messages_enabled', v_f.supporter_messages_enabled,
        'supporter_messages_public', v_f.supporter_messages_public,
        'displayed_amount', v_total,
        'period_start', v_start,
        'period_end', v_end,
        'supporter_count', v_count,
        'tiers', v_tiers,
        'messages', v_messages,
        'me', v_mine);
END;
$$;

REVOKE ALL ON FUNCTION public.set_supporter_message(text, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.delete_supporter_message(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_review_supporter_message(uuid, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_list_supporter_messages() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_public_supporter_messages(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_funding_summary() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_supporter_message(text, boolean) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.delete_supporter_message(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_review_supporter_message(uuid, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_list_supporter_messages() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_public_supporter_messages(integer) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_funding_summary() TO authenticated, service_role;

COMMIT;
