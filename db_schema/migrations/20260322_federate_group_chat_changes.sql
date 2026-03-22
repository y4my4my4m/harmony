BEGIN;

-- =============================================================================
-- Federate group chat changes: name, icon, participant leave/remove
--
-- Adds queue_federation_job calls to existing group management RPCs
-- and a new trigger for participant leave/remove events.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. update_group_name: queue federation job after name update
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.update_group_name(conversation_uuid uuid, user_profile_id uuid, new_name text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
  is_participant BOOLEAN := false;
  conversation_exists BOOLEAN := false;
BEGIN
  SELECT can_manage_group_icon(conversation_uuid, user_profile_id) INTO is_participant;

  IF NOT is_participant THEN
    RETURN jsonb_build_object('success', false, 'error', 'User is not a participant in this conversation');
  END IF;

  SELECT EXISTS(
    SELECT 1 FROM conversations WHERE id = conversation_uuid AND type = 'group'
  ) INTO conversation_exists;

  IF NOT conversation_exists THEN
    RETURN jsonb_build_object('success', false, 'error', 'Group conversation not found');
  END IF;

  UPDATE conversations
  SET name = new_name, updated_at = CURRENT_TIMESTAMP
  WHERE id = conversation_uuid AND type = 'group';

  -- Queue federation of the name change to remote participants
  PERFORM public.queue_federation_job(
    'federate-group-update',
    jsonb_build_object(
      'conversation_id', conversation_uuid,
      'updater_id', user_profile_id,
      'update_type', 'name',
      'new_value', COALESCE(new_name, '')
    ),
    5, 5, 3600
  );

  RETURN jsonb_build_object('success', true, 'message', 'Group name updated successfully');
END;
$$;

-- ---------------------------------------------------------------------------
-- 2. update_group_icon: queue federation job after icon update
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.update_group_icon(conversation_uuid uuid, user_profile_id uuid, icon_path text) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
  is_participant BOOLEAN := false;
  conversation_exists BOOLEAN := false;
BEGIN
  SELECT can_manage_group_icon(conversation_uuid, user_profile_id) INTO is_participant;

  IF NOT is_participant THEN
    RETURN jsonb_build_object('success', false, 'error', 'User is not a participant in this conversation');
  END IF;

  SELECT EXISTS(
    SELECT 1 FROM conversations WHERE id = conversation_uuid AND type = 'group'
  ) INTO conversation_exists;

  IF NOT conversation_exists THEN
    RETURN jsonb_build_object('success', false, 'error', 'Group conversation not found');
  END IF;

  UPDATE conversations
  SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('icon_url', icon_path),
      updated_at = CURRENT_TIMESTAMP
  WHERE id = conversation_uuid AND type = 'group';

  PERFORM public.queue_federation_job(
    'federate-group-update',
    jsonb_build_object(
      'conversation_id', conversation_uuid,
      'updater_id', user_profile_id,
      'update_type', 'icon',
      'new_value', icon_path
    ),
    5, 5, 3600
  );

  RETURN jsonb_build_object('success', true, 'message', 'Group icon updated successfully');
END;
$$;

-- ---------------------------------------------------------------------------
-- 3. remove_group_icon: queue federation job after icon removal
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.remove_group_icon(conversation_uuid uuid, user_profile_id uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    AS $$
DECLARE
  is_participant BOOLEAN := false;
  conversation_exists BOOLEAN := false;
BEGIN
  SELECT can_manage_group_icon(conversation_uuid, user_profile_id) INTO is_participant;

  IF NOT is_participant THEN
    RETURN jsonb_build_object('success', false, 'error', 'User is not a participant in this conversation');
  END IF;

  SELECT EXISTS(
    SELECT 1 FROM conversations WHERE id = conversation_uuid AND type = 'group'
  ) INTO conversation_exists;

  IF NOT conversation_exists THEN
    RETURN jsonb_build_object('success', false, 'error', 'Group conversation not found');
  END IF;

  UPDATE conversations
  SET metadata = COALESCE(metadata, '{}'::jsonb) - 'icon_url',
      updated_at = CURRENT_TIMESTAMP
  WHERE id = conversation_uuid AND type = 'group';

  PERFORM public.queue_federation_job(
    'federate-group-update',
    jsonb_build_object(
      'conversation_id', conversation_uuid,
      'updater_id', user_profile_id,
      'update_type', 'icon_removed'
    ),
    5, 5, 3600
  );

  RETURN jsonb_build_object('success', true, 'message', 'Group icon removed successfully');
END;
$$;

-- ---------------------------------------------------------------------------
-- 4. Trigger for participant leave/remove (UPDATE setting left_at)
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.handle_group_participant_left()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_conversation conversations%ROWTYPE;
  v_leaving_profile profiles%ROWTYPE;
BEGIN
  -- Only fire when left_at transitions from NULL to a value
  IF OLD.left_at IS NOT NULL OR NEW.left_at IS NULL THEN
    RETURN NEW;
  END IF;

  SELECT * INTO v_conversation FROM conversations WHERE id = NEW.conversation_id;

  -- Only for group conversations
  IF v_conversation.type != 'group' THEN
    RETURN NEW;
  END IF;

  SELECT * INTO v_leaving_profile FROM profiles WHERE id = NEW.user_id;

  -- Queue federation of participant leave/remove to remote participants
  PERFORM public.queue_federation_job(
    'federate-group-participant-change',
    jsonb_build_object(
      'conversation_id', NEW.conversation_id,
      'user_id', NEW.user_id,
      'change_type', 'left'
    ),
    5, 5, 3600
  );

  RETURN NEW;
EXCEPTION
  WHEN OTHERS THEN
    RAISE WARNING 'Group participant left federation failed: %', SQLERRM;
    RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_group_participant_left ON conversation_participants;
CREATE TRIGGER trg_group_participant_left
  AFTER UPDATE ON conversation_participants
  FOR EACH ROW
  EXECUTE FUNCTION handle_group_participant_left();

COMMIT;
