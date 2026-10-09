-- Stripe donations.
--
-- A Stripe Payment Link opened from Harmony carries the donor's profile id as
-- client_reference_id; the federation backend's POST /webhooks/stripe verifies the event
-- with the endpoint's signing secret and credits that profile.
--
-- instance_funding.stripe_webhook_secret: the endpoint's signing secret (whsec_...). As
-- kofi_webhook_token: clients hold no privilege on it; instance admins use
-- get_stripe_webhook_secret() and set_stripe_webhook_secret(); the webhook reads it as
-- service_role.
-- instance_funding.stripe_auto_assign_tier: as kofi_auto_assign_tier, for Stripe donations.
-- instance_stripe_customers: Stripe customer -> profile, written at the first payment of a
-- subscription; renewals (invoice.paid) carry only the customer.
--
-- Converges by state: rerunning changes nothing.

BEGIN;

SET LOCAL lock_timeout = '3s';

ALTER TABLE public.instance_funding
    ADD COLUMN IF NOT EXISTS stripe_webhook_secret text,
    ADD COLUMN IF NOT EXISTS stripe_auto_assign_tier boolean NOT NULL DEFAULT true;

GRANT SELECT (stripe_auto_assign_tier), INSERT (stripe_auto_assign_tier),
      UPDATE (stripe_auto_assign_tier)
   ON public.instance_funding TO authenticated;
GRANT SELECT ON public.instance_funding TO service_role;

CREATE TABLE IF NOT EXISTS public.instance_stripe_customers (
    customer_id text PRIMARY KEY,
    user_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_stripe_customers_user ON public.instance_stripe_customers (user_id);

-- Only the webhook (service_role) reads or writes it.
ALTER TABLE public.instance_stripe_customers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "stripe_customers_service_role" ON public.instance_stripe_customers;
CREATE POLICY "stripe_customers_service_role" ON public.instance_stripe_customers
    FOR ALL TO service_role USING (true) WITH CHECK (true);
REVOKE ALL ON public.instance_stripe_customers FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE ON public.instance_stripe_customers TO service_role;

-- As get_kofi_webhook_token.
CREATE OR REPLACE FUNCTION public.get_stripe_webhook_secret()
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
    RETURN (SELECT f.stripe_webhook_secret FROM public.instance_funding f LIMIT 1);
END;
$$;

-- As set_kofi_webhook_token. An empty secret disables the webhook.
CREATE OR REPLACE FUNCTION public.set_stripe_webhook_secret(p_secret text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_secret text := NULLIF(btrim(p_secret), '');
BEGIN
    IF NOT public.is_current_user_admin() THEN
        RAISE EXCEPTION 'Instance admins only' USING ERRCODE = '42501';
    END IF;
    IF v_secret IS NOT NULL AND v_secret NOT LIKE 'whsec\_%' THEN
        RAISE EXCEPTION 'A Stripe webhook signing secret starts with whsec_' USING ERRCODE = '22023';
    END IF;

    -- pg-safeupdate refuses an UPDATE without WHERE on PostgREST connections.
    UPDATE public.instance_funding
       SET stripe_webhook_secret = v_secret,
           updated_at = now()
     WHERE true;
    IF NOT FOUND THEN
        INSERT INTO public.instance_funding (stripe_webhook_secret) VALUES (v_secret);
    END IF;
END;
$$;

REVOKE ALL ON FUNCTION public.get_stripe_webhook_secret() FROM PUBLIC, anon, authenticated;
REVOKE ALL ON FUNCTION public.set_stripe_webhook_secret(text) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_stripe_webhook_secret() TO authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.set_stripe_webhook_secret(text) TO authenticated, service_role;

COMMIT;
