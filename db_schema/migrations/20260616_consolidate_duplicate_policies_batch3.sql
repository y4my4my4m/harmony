-- =============================================================================
-- Consolidate duplicate permissive RLS policies (perf advisor:
-- multiple_permissive_policies) -- BATCH 3 (legacy drift vs canonical twins)
-- =============================================================================
-- Each drop below removes a legacy (descriptively-named) policy whose canonical
-- snake_case twin -- the one db_schema/init ships -- provides an EQUAL-OR-BROADER
-- grant for the same (table, command). Verified by dumping both expressions from
-- a prod-like DB and comparing. Effective access is unchanged; where the twin is
-- a "true" SELECT the legacy narrower read was already a no-op under it.
--
-- KEY IDENTITY NOTE (recap of batch 2): every *_id/user_id/owner column here FKs
-- to profiles(id). The legacy twins compare against auth uid() (works only for
-- LOCAL users, dead for federated); the canonical twins use get_current_profile_id()
-- (correct for both). So the canonical policy is always equal-or-broader.
--
-- DELIBERATELY DEFERRED (NOT in this batch -- these are semantic differences or
-- design overlaps, not safe drops; dropping would CHANGE access):
--   * follows DELETE         legacy (follower OR following) vs canonical (follower
--                            only) -> dropping would tighten "remove a follower".
--   * posts SELECT           5-way overlap incl. block-check differences.
--   * threads / server_roles / user_roles writes
--                            legacy has_permission(MANAGE_*) vs canonical owner/
--                            admin -> different principals; needs a real decision.
--   * servers DELETE/UPDATE  AAL (MFA) requirement + uid-vs-profiles mapping differ.
--   * user_servers SELECT    legacy true vs canonical co-members -> tightening
--                            (privacy improvement, but verify member-list loads).
--   * user_lists / user_list_members SELECT
--                            own + public are complementary OR grants, not dups.
--   * emojis insert/update/delete (3 scoped paths), trending_*/hashtags/admin
--     "public SELECT + admin ALL" overlaps, encryption/E2EE tables.
--
-- These legacy names are NOT in db_schema/init (pure prod/local drift), so no init
-- edits are needed and this is a no-op on staging (built fresh from init).
-- Idempotent (DROP POLICY IF EXISTS), transactional (all-or-nothing).
-- =============================================================================

BEGIN;

-- channels: keep the get_current_profile_id() *_owner/_member set; drop the uid()
-- *_policy twins. SELECT keeper (channels_select_member: member OR owner) is
-- broader than the dropped channels_select_policy (member only).
DROP POLICY IF EXISTS "channels_delete_policy" ON public.channels;
DROP POLICY IF EXISTS "channels_insert_policy" ON public.channels;
DROP POLICY IF EXISTS "channels_select_policy" ON public.channels;
DROP POLICY IF EXISTS "channels_update_policy" ON public.channels;

-- follows: keep follows_select_all (true, broader) / follows_insert_own /
-- follows_update_involved (== legacy follower-OR-following). DELETE deferred.
DROP POLICY IF EXISTS "Users can view follows"                      ON public.follows;
DROP POLICY IF EXISTS "Users can create follow relationships"       ON public.follows;
DROP POLICY IF EXISTS "Users can update their follow relationships" ON public.follows;

-- posts: write dups are byte-identical to the snake_case twins. SELECT deferred.
DROP POLICY IF EXISTS "Users can delete their own posts" ON public.posts;
DROP POLICY IF EXISTS "Users can create their own posts" ON public.posts;
DROP POLICY IF EXISTS "Users can update their own posts" ON public.posts;

-- server_folders: legacy uid() twins; keep canonical get_current_profile_id() set.
-- (server_folders is a local-only feature; uid() == profile id for local users.)
DROP POLICY IF EXISTS "Users can delete own folders" ON public.server_folders;
DROP POLICY IF EXISTS "Users can create own folders" ON public.server_folders;
DROP POLICY IF EXISTS "Users can view own folders"   ON public.server_folders;
DROP POLICY IF EXISTS "Users can update own folders" ON public.server_folders;

-- thread_members SELECT: keep thread_members_select_all (true, broader).
DROP POLICY IF EXISTS "Users can view thread members" ON public.thread_members;

-- threads SELECT: keep threads_select_member (true, broader). Writes deferred.
DROP POLICY IF EXISTS "Users can view threads" ON public.threads;

-- timeline_entries SELECT: keep timeline_entries_select_own (no post-visibility
-- sub-filter -> broader; the filter was redundant under it anyway).
DROP POLICY IF EXISTS "Users can view their timeline entries" ON public.timeline_entries;

COMMIT;
