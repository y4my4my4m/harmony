-- =============================================================================
-- Drop legacy duplicate RLS policies (perf advisor: multiple_permissive_policies)
-- =============================================================================
-- PROD drifted from init: an earlier RLS consolidation introduced snake_case
-- policies (now the canonical set in db_schema/init/30_,31_) but old descriptive
-- policies were never dropped. This removes ONLY the legacy duplicates for which
-- prod ALSO has the canonical init policy covering the same command, so access
-- is unchanged (or, where noted, tightened to match init).
--
-- Scope: alphabetical range admin_audit_log .. federation_health (the portion of
-- the prod pg_policies dump provided). A follow-up will cover the remainder.
--
-- NOT touched here: "broad ALL + specific SELECT" overlaps (bots, bot_commands,
-- federation_delivery_queue DELETE/SELECT, etc.) — those overlaps also exist in
-- init by design and require a policy-body refactor, not a drop.
--
-- All statements use DROP POLICY IF EXISTS, so this is a no-op where a name is
-- already absent (e.g. staging built from init).
-- =============================================================================

BEGIN;

-- admin_audit_log: canonical "Admin audit log admin access" (ALL) covers INSERT+SELECT
DROP POLICY IF EXISTS "audit_log_insert_admin" ON public.admin_audit_log;
DROP POLICY IF EXISTS "audit_log_select_admin" ON public.admin_audit_log;

-- channel_permission_overrides: canonical channel_permission_overrides_modify (ALL) present
DROP POLICY IF EXISTS "Users with MANAGE_CHANNELS can manage overrides" ON public.channel_permission_overrides;

-- conversation_participants: canonical *_policy set present for all four commands.
-- NOTE: "Anyone can view conversation participants" is a broad grant; removing it
-- tightens SELECT to participants-only (matches init's conversation_participants_select_policy).
DROP POLICY IF EXISTS "Users can leave conversations" ON public.conversation_participants;
DROP POLICY IF EXISTS "Users can join conversations they're invited to" ON public.conversation_participants;
DROP POLICY IF EXISTS "Anyone can view conversation participants" ON public.conversation_participants;
DROP POLICY IF EXISTS "Users can view participants in their conversations" ON public.conversation_participants;
DROP POLICY IF EXISTS "Users can update their own participation" ON public.conversation_participants;
DROP POLICY IF EXISTS "Users can update their own participations" ON public.conversation_participants;

-- conversations: canonical conversations_select_participant (SELECT) present.
-- (INSERT and UPDATE legacy duplicates left alone: init has no matching canonical
--  policy present on prod for those commands — needs review before dropping.)
DROP POLICY IF EXISTS "Users can view conversations they participate in" ON public.conversations;
DROP POLICY IF EXISTS "Users can view their conversations" ON public.conversations;

-- emojis: canonical emojis_select_all + scoped insert/update/delete_{server_owner,
-- user_scope,instance_admin} present. These three are legacy broad/duplicate grants.
-- NOTE: "A" and "emoji_access_policy" are ALL policies with broad bodies; removing
-- them tightens writes to the scoped canonical policies (matches init).
DROP POLICY IF EXISTS "A" ON public.emojis;
DROP POLICY IF EXISTS "emoji_access_policy" ON public.emojis;
DROP POLICY IF EXISTS "emoji_public_access_policy" ON public.emojis;

-- federated_instances: canonical federated_instances_manage (ALL) present
DROP POLICY IF EXISTS "Only authenticated users can manage instances" ON public.federated_instances;

-- federation_delivery_queue: canonical "Service role can manage delivery queue" (ALL) present
DROP POLICY IF EXISTS "Service role can manage federation queue" ON public.federation_delivery_queue;

-- federation_endpoint_health: canonical federation_endpoint_health_manage (ALL) present
DROP POLICY IF EXISTS "Service role can manage endpoint health" ON public.federation_endpoint_health;

-- federation_health: canonical federation_health_select_all (SELECT) present
DROP POLICY IF EXISTS "Admins can read federation health" ON public.federation_health;

COMMIT;
