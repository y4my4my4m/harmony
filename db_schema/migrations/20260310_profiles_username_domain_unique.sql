BEGIN;

-- Federation uses ON CONFLICT (username, domain) but the init schema only had
-- UNIQUE(username).  Replace the single-column constraint with a composite one
-- so the same username can exist on different federated domains.

-- Drop the old single-column unique constraint (may have different names depending on how it was created)
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_username_key;
DROP INDEX IF EXISTS profiles_username_key;

-- Create the composite unique constraint (idempotent: drop first)
ALTER TABLE public.profiles DROP CONSTRAINT IF EXISTS profiles_username_domain_key;
ALTER TABLE public.profiles
    ADD CONSTRAINT profiles_username_domain_key UNIQUE (username, domain);

COMMENT ON CONSTRAINT profiles_username_domain_key ON public.profiles
    IS 'Ensures username uniqueness per domain in federated system. Same username can exist on different domains.';

-- Composite index for lookups
CREATE INDEX IF NOT EXISTS idx_profiles_username_domain
    ON public.profiles(username, domain);

COMMIT;
