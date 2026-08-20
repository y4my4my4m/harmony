-- Reconciles enable/disable_federation_triggers between init/ and migrations/.
--
-- Both functions name their triggers literally. 20260310_backfill_archives.sql
-- defined them over the 20 federation triggers that existed then, and every
-- federation trigger created afterwards was added to its table without being
-- added to the lists:
--
--   20260311  trg_conversation_participant_added
--   20260322  trg_group_participant_left
--   20260324  trigger_federate_channel, trigger_federate_channel_delete,
--             trigger_federate_category, trigger_federate_category_delete,
--             trigger_federate_server_update
--   20260704  trigger_federate_follow_response
--
-- init/ carried the 20260322 and 20260324 additions; a migrated database did
-- not. Neither carried 20260311 or 20260704. A migrated database therefore
-- disables 20 of 28 federation triggers, so a maintenance window that calls
-- disable_federation_triggers() keeps queueing channel, category, server,
-- group-membership and follow-response activity for delivery.
--
-- A federation trigger is one whose handler reaches queue_federation_job. The
-- set is 28; both lists below name all of them. Verified against the catalog
-- rather than by reading: db_schema/tests/30_reconciled_functions.sql derives
-- the set from pg_proc/pg_trigger and asserts none stays enabled after disable.
--
-- Also adds SET search_path = public. Both functions are SECURITY DEFINER and
-- the migrated definition carries no search_path.

BEGIN;

CREATE OR REPLACE FUNCTION public.enable_federation_triggers()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    ALTER TABLE public.posts ENABLE TRIGGER trigger_federate_post;
    ALTER TABLE public.post_interactions ENABLE TRIGGER trigger_federate_post_interaction;
    ALTER TABLE public.post_interactions ENABLE TRIGGER trigger_federate_post_interaction_delete;
    ALTER TABLE public.follows ENABLE TRIGGER trigger_federate_follow;
    ALTER TABLE public.follows ENABLE TRIGGER trigger_federate_follow_delete;
    ALTER TABLE public.follows ENABLE TRIGGER trigger_federate_follow_response;
    ALTER TABLE public.messages ENABLE TRIGGER trigger_federate_dm;
    ALTER TABLE public.messages ENABLE TRIGGER trigger_federate_channel_message;
    ALTER TABLE public.messages ENABLE TRIGGER trigger_federate_channel_message_edit;
    ALTER TABLE public.messages ENABLE TRIGGER trigger_federate_channel_message_delete;
    ALTER TABLE public.reactions ENABLE TRIGGER trigger_federate_message_reaction;
    ALTER TABLE public.reactions ENABLE TRIGGER trigger_federate_message_reaction_delete;
    ALTER TABLE public.reactions ENABLE TRIGGER trigger_federate_channel_reaction;
    ALTER TABLE public.reactions ENABLE TRIGGER trigger_federate_channel_reaction_delete;
    ALTER TABLE public.user_blocks ENABLE TRIGGER trigger_federate_block;
    ALTER TABLE public.user_blocks ENABLE TRIGGER trigger_federate_block_delete;
    ALTER TABLE public.reports ENABLE TRIGGER trigger_federate_report;
    ALTER TABLE public.profiles ENABLE TRIGGER trigger_federate_profile;
    ALTER TABLE public.threads ENABLE TRIGGER trigger_federate_thread;
    ALTER TABLE public.voice_channel_participants ENABLE TRIGGER trigger_federate_voice_channel_join;
    ALTER TABLE public.voice_channel_participants ENABLE TRIGGER trigger_federate_voice_channel_leave;
    ALTER TABLE public.channels ENABLE TRIGGER trigger_federate_channel;
    ALTER TABLE public.channels ENABLE TRIGGER trigger_federate_channel_delete;
    ALTER TABLE public.channel_categories ENABLE TRIGGER trigger_federate_category;
    ALTER TABLE public.channel_categories ENABLE TRIGGER trigger_federate_category_delete;
    ALTER TABLE public.servers ENABLE TRIGGER trigger_federate_server_update;
    ALTER TABLE public.conversation_participants ENABLE TRIGGER trg_group_participant_left;
    ALTER TABLE public.conversation_participants ENABLE TRIGGER trg_conversation_participant_added;
    RAISE NOTICE 'All federation triggers enabled';
END;
$$;

CREATE OR REPLACE FUNCTION public.disable_federation_triggers()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
    ALTER TABLE public.posts DISABLE TRIGGER trigger_federate_post;
    ALTER TABLE public.post_interactions DISABLE TRIGGER trigger_federate_post_interaction;
    ALTER TABLE public.post_interactions DISABLE TRIGGER trigger_federate_post_interaction_delete;
    ALTER TABLE public.follows DISABLE TRIGGER trigger_federate_follow;
    ALTER TABLE public.follows DISABLE TRIGGER trigger_federate_follow_delete;
    ALTER TABLE public.follows DISABLE TRIGGER trigger_federate_follow_response;
    ALTER TABLE public.messages DISABLE TRIGGER trigger_federate_dm;
    ALTER TABLE public.messages DISABLE TRIGGER trigger_federate_channel_message;
    ALTER TABLE public.messages DISABLE TRIGGER trigger_federate_channel_message_edit;
    ALTER TABLE public.messages DISABLE TRIGGER trigger_federate_channel_message_delete;
    ALTER TABLE public.reactions DISABLE TRIGGER trigger_federate_message_reaction;
    ALTER TABLE public.reactions DISABLE TRIGGER trigger_federate_message_reaction_delete;
    ALTER TABLE public.reactions DISABLE TRIGGER trigger_federate_channel_reaction;
    ALTER TABLE public.reactions DISABLE TRIGGER trigger_federate_channel_reaction_delete;
    ALTER TABLE public.user_blocks DISABLE TRIGGER trigger_federate_block;
    ALTER TABLE public.user_blocks DISABLE TRIGGER trigger_federate_block_delete;
    ALTER TABLE public.reports DISABLE TRIGGER trigger_federate_report;
    ALTER TABLE public.profiles DISABLE TRIGGER trigger_federate_profile;
    ALTER TABLE public.threads DISABLE TRIGGER trigger_federate_thread;
    ALTER TABLE public.voice_channel_participants DISABLE TRIGGER trigger_federate_voice_channel_join;
    ALTER TABLE public.voice_channel_participants DISABLE TRIGGER trigger_federate_voice_channel_leave;
    ALTER TABLE public.channels DISABLE TRIGGER trigger_federate_channel;
    ALTER TABLE public.channels DISABLE TRIGGER trigger_federate_channel_delete;
    ALTER TABLE public.channel_categories DISABLE TRIGGER trigger_federate_category;
    ALTER TABLE public.channel_categories DISABLE TRIGGER trigger_federate_category_delete;
    ALTER TABLE public.servers DISABLE TRIGGER trigger_federate_server_update;
    ALTER TABLE public.conversation_participants DISABLE TRIGGER trg_group_participant_left;
    ALTER TABLE public.conversation_participants DISABLE TRIGGER trg_conversation_participant_added;
    RAISE NOTICE 'All federation triggers disabled';
END;
$$;

COMMIT;
