-- The Harmony project's development fund, kept apart from the instance's own funding.
--
-- fund ('instance' | 'project', default 'instance') on instance_donation_history,
-- instance_pending_donations and instance_supporter_messages. Existing rows are 'instance'. The
-- federation backend's webhooks choose the fund (routes/webhooks/stripe.ts, kofi.ts); only the
-- project's own instance records 'project'.
--
-- A project donation has no instance_supporters row (supporter_id NULL): supporter rows carry the
-- instance's tiers and their perks (badge, ad-free GIFs), which project donations do not earn.
-- profiles -> instance_supporters stays one-to-one, so the author embed `supporter_membership`
-- stays one object and the webhook's ON CONFLICT (user_id) target stays valid. Tier, expiry and
-- the instance's totals count 'instance' donations only.
--
-- project_funding: the project fund's settings, one row (id true), present from install with
-- the fund published and no goal. Publication, goal, period, description, the two message
-- switches as on instance_funding, and its own Ko-fi verification token (no client privilege;
-- get/set_project_kofi_webhook_token). RLS as instance_funding: signed-in clients read, instance
-- admins write. The fund's payment links and Stripe Payment Link ids are constants of the
-- federation backend (services/projectFunding.ts PROJECT_LINKS, PROJECT_PAYMENT_LINK_IDS) and of
-- the client (src/services/FundingService.ts PROJECT_LINKS), not data: no row decides where a
-- Harmony development donation goes.
--
-- A donor's unattached message is per fund: set_supporter_message(body, anonymous, fund); the
-- two-argument form writes the instance's. A donation attaches the unattached message of its
-- own fund.
--
-- get_project_funding_summary(): the project fund as its public feed shows it (service_role).
-- Its total and supporter count include webhook donations no admin attributed to a profile
-- (instance_pending_donations, dismissed or not, never attributed): most project donors have no
-- account here. A pending row attributed to a profile counts once, through its history row.
--
-- Converges by state: rerunning changes nothing.

BEGIN;

SET LOCAL lock_timeout = '5s';

-- ---------------------------------------------------------------------------
-- fund columns
-- ---------------------------------------------------------------------------

ALTER TABLE public.instance_donation_history
    ADD COLUMN IF NOT EXISTS fund text NOT NULL DEFAULT 'instance'
        CONSTRAINT instance_donation_history_fund_known CHECK (fund IN ('instance', 'project'));
ALTER TABLE public.instance_pending_donations
    ADD COLUMN IF NOT EXISTS fund text NOT NULL DEFAULT 'instance'
        CONSTRAINT instance_pending_donations_fund_known CHECK (fund IN ('instance', 'project'));
ALTER TABLE public.instance_supporter_messages
    ADD COLUMN IF NOT EXISTS fund text NOT NULL DEFAULT 'instance'
        CONSTRAINT instance_supporter_messages_fund_known CHECK (fund IN ('instance', 'project'));

ALTER TABLE public.instance_donation_history ALTER COLUMN supporter_id DROP NOT NULL;
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
                    WHERE conrelid = 'public.instance_donation_history'::regclass
                      AND conname = 'instance_donation_history_fund_supporter') THEN
        ALTER TABLE public.instance_donation_history
            ADD CONSTRAINT instance_donation_history_fund_supporter
            CHECK ((supporter_id IS NULL) = (fund = 'project'));
    END IF;
END;
$$;

CREATE INDEX IF NOT EXISTS idx_donation_history_fund_date
    ON public.instance_donation_history (fund, donated_at);

-- One unattached message per profile and fund.
DROP INDEX IF EXISTS public.idx_supporter_messages_unattached;
CREATE UNIQUE INDEX IF NOT EXISTS idx_supporter_messages_unattached_fund
    ON public.instance_supporter_messages (user_id, fund)
    WHERE donation_id IS NULL;

-- ---------------------------------------------------------------------------
-- project_funding
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS public.project_funding (
    id boolean PRIMARY KEY DEFAULT true
        CONSTRAINT project_funding_one_row CHECK (id),
    enabled boolean NOT NULL DEFAULT true,
    goal_amount numeric(10,2)
        CONSTRAINT project_funding_goal_amount CHECK (goal_amount IS NULL OR goal_amount >= 0),
    goal_currency text NOT NULL DEFAULT 'USD'
        CONSTRAINT project_funding_goal_currency CHECK (goal_currency ~ '^[A-Z]{3}$'),
    funding_period text NOT NULL DEFAULT 'monthly'
        CONSTRAINT project_funding_period CHECK (funding_period IN ('monthly', 'all')),
    goal_description text
        CONSTRAINT project_funding_description CHECK (char_length(goal_description) <= 200),
    supporter_messages_enabled boolean NOT NULL DEFAULT true,
    supporter_messages_public boolean NOT NULL DEFAULT true,
    kofi_webhook_token text,
    updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE public.project_funding ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "project_funding_select_all" ON public.project_funding;
CREATE POLICY "project_funding_select_all" ON public.project_funding
    FOR SELECT TO authenticated USING (true);
DROP POLICY IF EXISTS "project_funding_modify_admin" ON public.project_funding;
CREATE POLICY "project_funding_modify_admin" ON public.project_funding
    FOR ALL TO authenticated
    USING (( SELECT public.is_current_user_admin() ))
    WITH CHECK (( SELECT public.is_current_user_admin() ));

-- kofi_webhook_token has no client privilege. The admin's PostgREST upsert sets every column it
-- sends, id included (ON CONFLICT (id) DO UPDATE SET id = EXCLUDED.id, ...), and reads them
-- (EXCLUDED): SELECT, INSERT and UPDATE on each. CHECK (id) keeps the one row.
REVOKE ALL ON public.project_funding FROM PUBLIC, anon, authenticated;
GRANT SELECT (id, enabled, goal_amount, goal_currency, funding_period, goal_description,
              supporter_messages_enabled, supporter_messages_public, updated_at),
      INSERT (id, enabled, goal_amount, goal_currency, funding_period, goal_description,
              supporter_messages_enabled, supporter_messages_public, updated_at),
      UPDATE (id, enabled, goal_amount, goal_currency, funding_period, goal_description,
              supporter_messages_enabled, supporter_messages_public, updated_at)
   ON public.project_funding TO authenticated;
GRANT ALL ON public.project_funding TO service_role;

INSERT INTO public.project_funding (id) VALUES (true) ON CONFLICT (id) DO NOTHING;

-- As get_kofi_webhook_token.
CREATE OR REPLACE FUNCTION public.get_project_kofi_webhook_token()
RETURNS text
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
BEGIN
    IF NOT public.is_current_user_admin() THEN
        RAISE EXCEPTION 'Instance admins only' USING ERRCODE = '42501';
    END IF;
    RETURN (SELECT f.kofi_webhook_token FROM public.project_funding f LIMIT 1);
END;
$$;

-- As set_kofi_webhook_token. An empty token sends Ko-fi donations to the instance's fund.
CREATE OR REPLACE FUNCTION public.set_project_kofi_webhook_token(p_token text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_token text := NULLIF(btrim(p_token), '');
BEGIN
    IF NOT public.is_current_user_admin() THEN
        RAISE EXCEPTION 'Instance admins only' USING ERRCODE = '42501';
    END IF;
    INSERT INTO public.project_funding AS f (id, kofi_webhook_token) VALUES (true, v_token)
    ON CONFLICT (id) DO UPDATE
       SET kofi_webhook_token = EXCLUDED.kofi_webhook_token,
           updated_at = now();
END;
$$;

-- ---------------------------------------------------------------------------
-- Supporter messages follow the fund
-- ---------------------------------------------------------------------------

-- A donation attaches its donor's unattached message of the same fund, written in the 24 hours
-- before.
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
       AND fund = NEW.fund
       AND donation_id IS NULL
       AND created_at > now() - interval '24 hours';
    RETURN NULL;
END;
$$;

-- Writes the caller's unattached message for p_fund; a second call replaces it and restarts its
-- 24 hours. 22023 with the rule as HINT for an invalid body or fund; 55000 when that fund's
-- messages are off.
CREATE OR REPLACE FUNCTION public.set_supporter_message(p_body text, p_anonymous boolean, p_fund text)
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
    IF p_fund IS NULL OR p_fund NOT IN ('instance', 'project') THEN
        RAISE EXCEPTION 'A fund is instance or project' USING ERRCODE = '22023', HINT = 'fund';
    END IF;
    IF p_fund = 'instance' AND NOT EXISTS (
           SELECT 1 FROM public.instance_funding f
            WHERE f.enabled IS TRUE AND f.supporter_messages_enabled)
       OR p_fund = 'project' AND NOT EXISTS (
           SELECT 1 FROM public.project_funding f
            WHERE f.enabled AND f.supporter_messages_enabled) THEN
        RAISE EXCEPTION 'Supporter messages are off for this fund'
            USING ERRCODE = '55000', HINT = 'disabled';
    END IF;
    v_problem := public.supporter_message_problem(v_body);
    IF v_problem IS NOT NULL THEN
        RAISE EXCEPTION 'Not a valid supporter message (%)', v_problem
            USING ERRCODE = '22023', HINT = v_problem;
    END IF;

    INSERT INTO public.instance_supporter_messages AS m (user_id, body, anonymous, fund)
    VALUES (v_me, v_body, COALESCE(p_anonymous, false), p_fund)
    ON CONFLICT (user_id, fund) WHERE donation_id IS NULL
    DO UPDATE SET body = EXCLUDED.body,
                  anonymous = EXCLUDED.anonymous,
                  created_at = now()
    RETURNING * INTO v_row;

    RETURN jsonb_build_object(
        'id', v_row.id,
        'body', v_row.body,
        'anonymous', v_row.anonymous,
        'fund', v_row.fund,
        'created_at', v_row.created_at,
        'expires_at', v_row.created_at + interval '24 hours');
END;
$$;

-- The instance's fund.
CREATE OR REPLACE FUNCTION public.set_supporter_message(p_body text, p_anonymous boolean DEFAULT false)
RETURNS jsonb
LANGUAGE sql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
    SELECT public.set_supporter_message(p_body, p_anonymous, 'instance');
$$;

-- Attached messages of both funds for the admin queues: awaiting review first, then newest.
-- Instance admins only.
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
                   'fund', x.fund,
                   'attached_at', x.attached_at,
                   'reviewed_at', x.reviewed_at,
                   'user_id', x.user_id,
                   'username', x.username,
                   'display_name', x.display_name,
                   'amount', x.amount,
                   'currency', x.currency)
                 ORDER BY (x.review = 'pending') DESC, x.attached_at DESC)
          FROM (
            SELECT m.id, m.body, m.anonymous, m.review, m.fund, m.attached_at, m.reviewed_at, m.user_id,
                   p.username, p.display_name, d.amount, d.currency
              FROM public.instance_supporter_messages m
              JOIN public.instance_donation_history d ON d.id = m.donation_id
              LEFT JOIN public.profiles p ON p.id = m.user_id
             ORDER BY (m.review = 'pending') DESC, m.attached_at DESC
             LIMIT 200
          ) x), '[]'::jsonb);
END;
$$;

-- The instance's approved messages a signed-out visitor sees.
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
               AND m.fund = 'instance'
               AND m.donation_id IS NOT NULL
               AND EXISTS (SELECT 1 FROM public.instance_funding f
                            WHERE f.enabled IS TRUE
                              AND f.supporter_messages_enabled
                              AND f.supporter_messages_public)
             ORDER BY m.attached_at DESC
             LIMIT LEAST(GREATEST(COALESCE(p_limit, 6), 1), 20)
          ) x), '[]'::jsonb);
$$;

-- ---------------------------------------------------------------------------
-- Instance totals and tiers count the instance's fund
-- ---------------------------------------------------------------------------

CREATE OR REPLACE FUNCTION public.get_funding_current_total(p_period text DEFAULT 'monthly')
RETURNS numeric
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public, extensions, pg_temp
AS $$
  SELECT COALESCE(SUM(dh.amount), 0)::numeric
  FROM public.instance_donation_history dh
  WHERE dh.fund = 'instance'
    AND ((p_period = 'all')
         OR (p_period = 'monthly' AND dh.donated_at >= date_trunc('month', now())::timestamptz));
$$;

CREATE OR REPLACE FUNCTION public.get_user_cycle_donation_total(p_user_id uuid)
RETURNS numeric
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_period text;
    v_total numeric;
BEGIN
    SELECT COALESCE(funding_period, 'monthly') INTO v_period
    FROM public.instance_funding LIMIT 1;

    IF v_period = 'all' THEN
        SELECT COALESCE(SUM(amount), 0) INTO v_total
        FROM public.instance_donation_history
        WHERE user_id = p_user_id
          AND fund = 'instance';
    ELSE
        SELECT COALESCE(SUM(amount), 0) INTO v_total
        FROM public.instance_donation_history
        WHERE user_id = p_user_id
          AND fund = 'instance'
          AND donated_at >= now() - interval '30 days';
    END IF;

    RETURN v_total;
END;
$$;

CREATE OR REPLACE FUNCTION public.recompute_supporter_tier(p_user_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_period text;
    v_total numeric;
    v_tier_id uuid;
    v_currency text;
    v_expires timestamptz;
BEGIN
    IF current_setting('role', true) IN ('anon', 'authenticated')
       AND NOT public.is_current_user_admin() THEN
        RAISE EXCEPTION 'Instance admins only' USING ERRCODE = '42501';
    END IF;

    -- Manual and webhook callers create the supporter row first.
    IF NOT EXISTS (SELECT 1 FROM public.instance_supporters WHERE user_id = p_user_id) THEN
        RETURN NULL;
    END IF;

    SELECT COALESCE(funding_period, 'monthly'), COALESCE(goal_currency, 'USD')
      INTO v_period, v_currency
    FROM public.instance_funding LIMIT 1;

    v_total := public.get_user_cycle_donation_total(p_user_id);
    v_tier_id := public.compute_supporter_tier_for_amount(v_total, v_currency);

    IF v_period = 'all' THEN
        v_expires := NULL;
    ELSE
        -- Latest donation + 30 days. No donation history (a manual grant) leaves
        -- expires_at NULL, which the badge query reads as no expiry.
        SELECT MAX(donated_at) + interval '30 days'
          INTO v_expires
        FROM public.instance_donation_history
        WHERE user_id = p_user_id
          AND fund = 'instance';
    END IF;

    UPDATE public.instance_supporters
    SET tier_id = v_tier_id,
        amount = v_total,
        expires_at = v_expires
    WHERE user_id = p_user_id;

    RETURN v_tier_id;
END;
$$;

-- Attributes a webhook donation to a user. An instance donation: supporter row, history row (a
-- retry of the webhook's own insert is skipped by its unique index), the pending row resolved,
-- the tier recomputed; returns the supporter row's id. A project donation: the history row and
-- the pending row; returns the profile id. NULL when the row was already resolved.
CREATE OR REPLACE FUNCTION public.admin_resolve_pending_donation(p_pending_id uuid, p_user_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_pending public.instance_pending_donations%ROWTYPE;
    v_supporter uuid;
BEGIN
    IF current_setting('role', true) IN ('anon', 'authenticated')
       AND NOT public.is_current_user_admin() THEN
        RAISE EXCEPTION 'Instance admins only' USING ERRCODE = '42501';
    END IF;

    SELECT * INTO v_pending
      FROM public.instance_pending_donations d
     WHERE d.id = p_pending_id
       FOR UPDATE;
    IF NOT FOUND THEN
        RAISE EXCEPTION 'Pending donation not found' USING ERRCODE = 'P0002';
    END IF;
    IF v_pending.resolved_at IS NOT NULL THEN
        RETURN NULL;
    END IF;

    IF v_pending.fund = 'instance' THEN
        INSERT INTO public.instance_supporters AS s
               (user_id, amount, platform, is_active, started_at)
        VALUES (p_user_id, v_pending.amount, v_pending.platform, true, now())
        ON CONFLICT (user_id) DO UPDATE
           SET amount = EXCLUDED.amount,
               platform = EXCLUDED.platform,
               is_active = true,
               started_at = EXCLUDED.started_at
        RETURNING s.id INTO v_supporter;
    END IF;

    INSERT INTO public.instance_donation_history
           (supporter_id, user_id, amount, currency, platform, external_reference, note, fund)
    VALUES (v_supporter, p_user_id, v_pending.amount, v_pending.currency, v_pending.platform,
            v_pending.external_reference, v_pending.donor_message, v_pending.fund)
    ON CONFLICT DO NOTHING;

    UPDATE public.instance_pending_donations
       SET resolved_at = now(),
           resolved_by = public.get_current_profile_id(),
           resolved_user_id = p_user_id
     WHERE id = p_pending_id;

    IF v_pending.fund = 'instance' THEN
        PERFORM public.recompute_supporter_tier(p_user_id);
    END IF;

    RETURN COALESCE(v_supporter, p_user_id);
END;
$$;

-- As 20261009900001, with the fund in the notification data.
CREATE OR REPLACE FUNCTION public.notify_admins_on_pending_donation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_recipient_ids uuid[];
    v_data jsonb;
BEGIN
    SELECT array_agg(id) INTO v_recipient_ids
    FROM public.profiles
    WHERE is_admin = true
      AND is_suspended = false;

    IF v_recipient_ids IS NULL OR array_length(v_recipient_ids, 1) IS NULL THEN
        RETURN NEW;
    END IF;

    v_data := jsonb_build_object(
        'pending_donation_id', NEW.id,
        'platform', NEW.platform,
        'amount', NEW.amount,
        'currency', NEW.currency,
        'donor_name', NEW.donor_name,
        'donor_message', NEW.donor_message,
        'received_at', NEW.received_at,
        'fund', NEW.fund
    );

    PERFORM public.send_notification(
        'admin_pending_donation'::varchar,
        v_recipient_ids,
        v_data,
        NULL,    -- server_id
        NULL,    -- channel_id
        NULL,    -- conversation_id
        NULL,    -- from_user_id (donor isn't a profile)
        'normal'::varchar
    );

    RETURN NEW;
END;
$$;

-- As 20261106100001, the instance's fund only, plus for a signed-in caller their project fund
-- donations and messages (me.project) and whether the project fund takes messages.
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
     WHERE d.fund = 'instance'
       AND (v_start IS NULL OR d.donated_at >= v_start);

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
               AND m.fund = 'instance'
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
                           AND fund = 'instance'
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
                   AND m.fund = 'instance'
                   AND (m.donation_id IS NOT NULL OR m.created_at > now() - interval '24 hours')),
                '[]'::jsonb),
            'project', jsonb_build_object(
                'donations', COALESCE((
                    SELECT jsonb_agg(jsonb_build_object(
                               'id', d.id, 'amount', d.amount, 'currency', d.currency,
                               'platform', d.platform, 'note', d.note, 'donated_at', d.donated_at)
                             ORDER BY d.donated_at DESC)
                      FROM (SELECT * FROM public.instance_donation_history
                             WHERE user_id = v_me
                               AND fund = 'project'
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
                       AND m.fund = 'project'
                       AND (m.donation_id IS NOT NULL OR m.created_at > now() - interval '24 hours')),
                    '[]'::jsonb)))
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
        'project_messages_enabled', EXISTS (SELECT 1 FROM public.project_funding pf
                                             WHERE pf.enabled AND pf.supporter_messages_enabled),
        'displayed_amount', v_total,
        'period_start', v_start,
        'period_end', v_end,
        'supporter_count', v_count,
        'tiers', v_tiers,
        'messages', v_messages,
        'me', v_mine);
END;
$$;

-- The project fund for its public feed (federation-backend services/projectFunding.ts buildFeed):
-- settings, the period's total and distinct donors, and the approved project messages while
-- messages are on; no links. NULL without a project_funding row. Donors: a profile, or for an
-- unattributed webhook donation its email, else its external reference.
CREATE OR REPLACE FUNCTION public.get_project_funding_summary()
RETURNS jsonb
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_f public.project_funding%ROWTYPE;
    v_start timestamptz;
    v_end timestamptz;
    v_total numeric;
    v_count integer;
    v_messages jsonb := '[]'::jsonb;
BEGIN
    SELECT * INTO v_f FROM public.project_funding LIMIT 1;
    IF NOT FOUND THEN
        RETURN NULL;
    END IF;

    IF v_f.funding_period = 'monthly' THEN
        v_start := date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC';
        v_end := (date_trunc('month', now() AT TIME ZONE 'UTC') + interval '1 month') AT TIME ZONE 'UTC';
    END IF;

    WITH received AS (
        SELECT d.amount, 'u:' || d.user_id::text AS donor
          FROM public.instance_donation_history d
         WHERE d.fund = 'project'
           AND (v_start IS NULL OR d.donated_at >= v_start)
        UNION ALL
        SELECT p.amount,
               'e:' || COALESCE(lower(btrim(p.donor_email)), p.external_reference, p.id::text)
          FROM public.instance_pending_donations p
         WHERE p.fund = 'project'
           AND p.resolved_user_id IS NULL
           AND (v_start IS NULL OR p.received_at >= v_start)
    )
    SELECT COALESCE(SUM(r.amount), 0), count(DISTINCT r.donor)
      INTO v_total, v_count
      FROM received r;

    IF v_f.enabled AND v_f.supporter_messages_enabled THEN
        SELECT COALESCE(jsonb_agg(jsonb_build_object(
                   'id', x.id, 'body', x.body, 'anonymous', x.anonymous, 'at', x.attached_at,
                   'name', x.name)
                 ORDER BY x.attached_at DESC), '[]'::jsonb)
          INTO v_messages
          FROM (
            SELECT m.id, m.body, m.anonymous, m.attached_at,
                   CASE WHEN m.anonymous THEN NULL
                        ELSE COALESCE(NULLIF(btrim(p.display_name), ''), p.username) END AS name
              FROM public.instance_supporter_messages m
              LEFT JOIN public.profiles p ON p.id = m.user_id
             WHERE m.review = 'approved'
               AND m.fund = 'project'
               AND m.donation_id IS NOT NULL
             ORDER BY m.attached_at DESC
             LIMIT 20
          ) x;
    END IF;

    RETURN jsonb_build_object(
        'enabled', v_f.enabled,
        'goal_amount', v_f.goal_amount,
        'goal_currency', v_f.goal_currency,
        'funding_period', v_f.funding_period,
        'goal_description', v_f.goal_description,
        'supporter_messages_enabled', v_f.supporter_messages_enabled,
        'supporter_messages_public', v_f.supporter_messages_public,
        'displayed_amount', v_total,
        'period_start', v_start,
        'period_end', v_end,
        'supporter_count', v_count,
        'messages', v_messages);
END;
$$;

REVOKE ALL ON FUNCTION public.get_project_kofi_webhook_token() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.set_project_kofi_webhook_token(text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.set_supporter_message(text, boolean, text) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.set_supporter_message(text, boolean) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.admin_list_supporter_messages() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_public_supporter_messages(integer) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_funding_summary() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_project_funding_summary() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.get_funding_current_total(text) FROM PUBLIC;
REVOKE ALL ON FUNCTION public.get_user_cycle_donation_total(uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.recompute_supporter_tier(uuid) FROM PUBLIC, anon;
REVOKE ALL ON FUNCTION public.admin_resolve_pending_donation(uuid, uuid) FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.attach_supporter_message() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_project_kofi_webhook_token() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.set_project_kofi_webhook_token(text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.set_supporter_message(text, boolean, text) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.set_supporter_message(text, boolean) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_list_supporter_messages() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_public_supporter_messages(integer) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_funding_summary() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_project_funding_summary() TO service_role;
GRANT EXECUTE ON FUNCTION public.get_funding_current_total(text) TO anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.get_user_cycle_donation_total(uuid) TO service_role;
GRANT EXECUTE ON FUNCTION public.recompute_supporter_tier(uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.admin_resolve_pending_donation(uuid, uuid) TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.attach_supporter_message() TO service_role;

COMMIT;
