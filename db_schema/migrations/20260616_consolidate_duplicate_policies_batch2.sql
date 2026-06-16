-- =============================================================================
-- Consolidate duplicate permissive RLS policies (perf advisor:
-- multiple_permissive_policies) -- BATCH 2 (drop dead/redundant uid() twins)
-- =============================================================================
-- Context: every user_id/*_id column in these tables FKs to profiles(id), so
-- the portable identity is the PROFILE id and the canonical comparison is
-- get_current_profile_id(). A policy using auth.uid() (rendered "uid()") against
-- one of these columns is at best equal to its get_current_profile_id() twin
-- (for local users, where profiles.id coincides with the auth id) and at worst
-- dead (for federated profiles, which have no auth_user_id). Either way the
-- get_current_profile_id() policy is EQUAL-OR-BROADER, and the client already
-- writes these tables with the profile id (verified in CoreMessageService,
-- ThreadService, CoreInteractionService, useServerUsers, etc.).
--
-- So for each duplicate pair we KEEP the get_current_profile_id() policy and
-- DROP the uid() twin. Where both twins are uid()-based with no profile sibling,
-- we drop one as a pure no-op dedup (identical effect).
--
-- These dropped names are prod drift (descriptive legacy names); db_schema/init
-- already ships only the canonical snake_case policies we keep, so no init edits
-- are needed and this is a no-op on environments built fresh from init.
--
-- Idempotent (DROP POLICY IF EXISTS), transactional (all-or-nothing).
-- =============================================================================

BEGIN;

-- post_interactions ---------------------------------------------------------
-- INSERT: drop the uid() twin; keep post_interactions_insert_own +
-- "Users can create post interactions on posts they can see" (both profile-id).
DROP POLICY IF EXISTS "Users can create their own interactions" ON public.post_interactions;
-- DELETE/UPDATE: two uid() twins each, no profile sibling -> drop one (no-op dedup).
DROP POLICY IF EXISTS "Users can delete their own post interactions" ON public.post_interactions;
DROP POLICY IF EXISTS "Users can update their own post interactions" ON public.post_interactions;

-- reactions -----------------------------------------------------------------
-- Keep reactions_insert_own / reactions_delete_own (get_current_profile_id).
DROP POLICY IF EXISTS "Users can create reactions on messages they can see" ON public.reactions;
DROP POLICY IF EXISTS "Users can delete their own reactions"                 ON public.reactions;

-- user_blocks ---------------------------------------------------------------
-- Keep "Users can view own blocks" + user_blocks_check_if_blocked + the service
-- role read. Drop the profile-id duplicate and the uid() twins.
DROP POLICY IF EXISTS "Users can see their own blocks"   ON public.user_blocks; -- dup of "Users can view own blocks"
DROP POLICY IF EXISTS "Users can view their own blocks"  ON public.user_blocks; -- uid() twin
DROP POLICY IF EXISTS "Users can check if blocked"       ON public.user_blocks; -- dup of user_blocks_check_if_blocked
DROP POLICY IF EXISTS "Users can remove their own blocks" ON public.user_blocks; -- uid() twin of "Users can delete own blocks"
DROP POLICY IF EXISTS "Users can block other users"      ON public.user_blocks; -- uid() twin of "Users can create blocks"

-- thread_members ------------------------------------------------------------
-- Keep thread_members_delete_self / _insert_self / _update_self.
DROP POLICY IF EXISTS "Users can leave threads"             ON public.thread_members;
DROP POLICY IF EXISTS "Users can join threads"              ON public.thread_members;
DROP POLICY IF EXISTS "Users can update own thread membership" ON public.thread_members;

-- voice_channel_participants ------------------------------------------------
-- Keep voice_participants_delete_self / _insert_self / _update_self.
DROP POLICY IF EXISTS "Delete own voice participation" ON public.voice_channel_participants;
DROP POLICY IF EXISTS "Insert own voice participation" ON public.voice_channel_participants;
DROP POLICY IF EXISTS "Update own voice participation" ON public.voice_channel_participants;

-- unread_counts -------------------------------------------------------------
-- Keep unread_counts_select_own / _update_own.
DROP POLICY IF EXISTS "Users can view their own unread counts"   ON public.unread_counts;
DROP POLICY IF EXISTS "Users can update their own unread counts" ON public.unread_counts;

-- timeline_entries ----------------------------------------------------------
-- Keep timeline_entries_select_own (+ the post-filtered profile-id SELECT).
DROP POLICY IF EXISTS "Users can view their own timeline entries" ON public.timeline_entries;

COMMIT;
