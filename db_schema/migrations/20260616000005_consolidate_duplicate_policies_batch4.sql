-- =============================================================================
-- Consolidate duplicate permissive RLS policies (perf advisor:
-- multiple_permissive_policies) -- BATCH 4 (no-op / exact-duplicate drops)
-- =============================================================================
-- Every drop here is PROVABLY behavior-preserving (no access change at all):
--
--   1. TO service_role policies: service_role has rolbypassrls=true, so RLS is
--      never evaluated for it -- these policies grant nothing. Pure dead weight.
--
--   2. TO public USING (role() = 'service_role') policies: false for every
--      non-bypass role (anon/authenticated/...), and service_role bypasses RLS
--      anyway -- so they grant nothing to anyone. Dead weight.
--
--   3. USING (false) permissive policies ("Only system can modify ..."): a
--      permissive policy that never grants. Writes were already limited to
--      service_role (bypass); dropping it leaves the same (no permissive write
--      grant for normal roles == still denied). No change.
--
--   4. Exact duplicate `true` SELECT policies: a second policy identical to a
--      retained `true` read (e.g. *_select_all). Dropping one leaves the other
--      `true`, so reads are unchanged. NOT a tightening.
--
-- Idempotent (DROP POLICY IF EXISTS), transactional. Most of these names are
-- prod/local drift (absent from init -> no-op on staging); the two *_service_role
-- names ARE in init and are removed there too (30_rls_policies.sql).
--
-- This is the safe first slice; the remaining multiple_permissive_policies are
-- STRUCTURAL overlaps in the canonical policies (management FOR ALL overlapping
-- per-command policies, own+public, admin+own) and are handled by the OR-merge
-- batch, which edits init + ships its own migration.
-- =============================================================================

BEGIN;

-- 1. TO service_role (rolbypassrls -> no-op) ---------------------------------
DROP POLICY IF EXISTS "federated_instances_service_role" ON public.federated_instances;
DROP POLICY IF EXISTS "federation_health_service_role"   ON public.federation_health;
DROP POLICY IF EXISTS "Service role can read all blocks"  ON public.user_blocks;
DROP POLICY IF EXISTS "notifications_insert_system"        ON public.notifications;

-- 2. TO public USING (role() = 'service_role') (no-op for all real roles) -----
DROP POLICY IF EXISTS "Service role can manage delivery queue"    ON public.federation_delivery_queue;
DROP POLICY IF EXISTS "Service role can manage remote emojis"     ON public.remote_emojis_cache;
DROP POLICY IF EXISTS "Service role manages all background jobs"  ON public.pg_background_job;

-- 3. USING (false) permissive policies (never grant) --------------------------
DROP POLICY IF EXISTS "Only system can modify hashtags"        ON public.hashtags;
DROP POLICY IF EXISTS "Only system can modify post hashtags"   ON public.post_hashtags;
DROP POLICY IF EXISTS "Only system can modify trending posts"  ON public.trending_posts;
DROP POLICY IF EXISTS "Only system can modify trending users"  ON public.trending_users;

-- 4. Exact duplicate `true` SELECT policies (a `true` twin remains) -----------
DROP POLICY IF EXISTS "Anyone can view federated instances" ON public.federated_instances;
DROP POLICY IF EXISTS "Anyone can view hashtags"            ON public.hashtags;
DROP POLICY IF EXISTS "Anyone can view trending posts"      ON public.trending_posts;
DROP POLICY IF EXISTS "Anyone can view trending users"      ON public.trending_users;
DROP POLICY IF EXISTS "Enable read access for all users"    ON public.profiles;
DROP POLICY IF EXISTS "Users can view all interactions"     ON public.post_interactions;

COMMIT;
