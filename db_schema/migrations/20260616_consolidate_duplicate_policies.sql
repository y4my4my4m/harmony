-- =============================================================================
-- Consolidate duplicate permissive RLS policies (perf advisor:
-- multiple_permissive_policies) -- BATCH 1 (high-confidence, non-encryption)
-- =============================================================================
-- Each DROP below removes a redundant PERMISSIVE policy for which another
-- policy on the SAME (table, command) provides an EQUAL-OR-BROADER grant, so
-- effective access is unchanged. Verified against the prod pg_policies dump and
-- db_schema/init. Where a drop TIGHTENS access (only when the kept policy is the
-- intended canonical one), it is called out explicitly.
--
-- DELIBERATELY EXCLUDED from this batch (need per-column verification of whether
-- user_id is an auth uid or a profile id before choosing a keeper):
--   * encryption/E2EE tables (megolm_*, prekeys, user_key_pairs, recovery_*)
--   * post_interactions / reactions INSERT/UPDATE/DELETE dups
--   * notifications INSERT/DELETE, profiles UPDATE, user_blocks SELECT dups
--   * "broad ALL + specific SELECT" design overlaps (bots, bot_commands,
--     ap_activities, federation_*, hashtags, trending_*, emojis 3-way insert)
--
-- Idempotent: DROP POLICY IF EXISTS, no-op where already absent.
-- =============================================================================

BEGIN;

-- profiles SELECT: four PERMISSIVE policies all effectively USING (true).
-- Keep "Enable read access for all users" (true); drop the redundant trio.
-- No behavior change: any true policy already makes all profiles readable.
DROP POLICY IF EXISTS "Service Role Can Read"                ON public.profiles;
DROP POLICY IF EXISTS "Users can view all profiles"          ON public.profiles;
DROP POLICY IF EXISTS "Users can view non-suspended profiles" ON public.profiles;

-- conversations INSERT: keep canonical conversations_insert_authenticated
-- (created_by = self). The other two are BROADER (any authed user). Conversations
-- are created only via SECURITY DEFINER RPCs (create_or_get_direct_conversation,
-- create_group_conversation) which bypass RLS, so tightening to created_by=self
-- breaks no legitimate path. NOTE: this is a tightening (matches init).
DROP POLICY IF EXISTS "Authenticated users can create conversations" ON public.conversations;
DROP POLICY IF EXISTS "Users can create conversations"               ON public.conversations;

-- conversations UPDATE: two equivalent participant-scoped policies. Keep
-- "Conversation participants can update conversations"; drop the duplicate.
DROP POLICY IF EXISTS "Users can update conversations they participate in" ON public.conversations;

-- federated_voice_calls SELECT: "Users can view their own calls" and "View own
-- calls" are identical (caller_id/recipient_id = uid()). Drop the duplicate.
DROP POLICY IF EXISTS "View own calls" ON public.federated_voice_calls;

-- federated_voice_calls UPDATE: "Update own calls" (caller OR recipient) is a
-- superset of "Recipients can update call status" (recipient only). Drop subset.
DROP POLICY IF EXISTS "Recipients can update call status" ON public.federated_voice_calls;

-- instance_config SELECT: "Instance config admin access" (ALL) already grants
-- admins SELECT, so instance_config_select_admin is redundant for admins.
-- "Public can read instance settings" remains for the public-key path.
DROP POLICY IF EXISTS "instance_config_select_admin" ON public.instance_config;

-- notification_channels: ALL policy overlaps the four granular *_own policies,
-- which fully cover SELECT/INSERT/UPDATE/DELETE. Drop the overlapping ALL policy.
DROP POLICY IF EXISTS "Users can manage their own notification channels" ON public.notification_channels;

-- notification_preferences: same pattern -- granular *_own cover all commands.
DROP POLICY IF EXISTS "Users can manage their own notification preferences" ON public.notification_preferences;

-- post_interactions SELECT: "Users can view all interactions" (true) is the
-- canonical broad read (matches init post_interactions_select_all). The
-- post-visibility-scoped SELECT is redundant under a true policy. Drop it.
DROP POLICY IF EXISTS "Users can view post interactions on posts they can see" ON public.post_interactions;

-- reactions SELECT: reactions_select_all (true) is canonical; the message-scoped
-- SELECT is redundant under a true policy. Drop it.
DROP POLICY IF EXISTS "Users can view reactions on messages they can see" ON public.reactions;

COMMIT;
