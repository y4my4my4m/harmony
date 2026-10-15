-- FEP-044f quote authorizations (Mastodon 4.5 quote posts).
--
-- quote_authorizations holds the approval stamps this instance issues for quotes of its
-- local posts: one row per (quoted post, quote post), served as a QuoteAuthorization at
-- https://<domain>/users/<author>/quote_authorizations/<id> and named by the Accept that
-- answers a QuoteRequest. Deleting the quoted post deletes its stamps. Written and read by
-- the federation backend with the service role only.
--
-- Converges by state: rerunning changes nothing.

BEGIN;

SET LOCAL lock_timeout = '3s';

CREATE TABLE IF NOT EXISTS public.quote_authorizations (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    quoted_post_id uuid NOT NULL REFERENCES public.posts(id) ON DELETE CASCADE,
    quoting_post_uri text NOT NULL,
    quoting_actor_uri text NOT NULL,
    request_uri text,
    created_at timestamptz NOT NULL DEFAULT now(),
    CONSTRAINT quote_authorizations_uri_check CHECK (quoting_post_uri ~ '^https?://' AND quoting_actor_uri ~ '^https?://'),
    CONSTRAINT quote_authorizations_target_key UNIQUE (quoted_post_id, quoting_post_uri)
);

ALTER TABLE public.quote_authorizations ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS quote_authorizations_service_role ON public.quote_authorizations;
CREATE POLICY quote_authorizations_service_role ON public.quote_authorizations
    AS PERMISSIVE FOR ALL TO service_role USING (true) WITH CHECK (true);
REVOKE ALL ON public.quote_authorizations FROM PUBLIC, anon, authenticated;
GRANT ALL ON public.quote_authorizations TO service_role;

COMMIT;
