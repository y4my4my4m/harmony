BEGIN;

-- Federation-only: create or get a group conversation for incoming group DMs.
-- No auth check - called by federation backend (service role).
CREATE OR REPLACE FUNCTION public.get_or_create_federated_group_conversation(
  p_actor_id uuid,
  p_local_recipient_ids uuid[]
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_conversation_id uuid;
  v_participant_id uuid;
  v_all_ids uuid[];
BEGIN
  IF p_local_recipient_ids IS NULL OR array_length(p_local_recipient_ids, 1) < 1 THEN
    RAISE EXCEPTION 'At least 1 local recipient required';
  END IF;

  v_all_ids := ARRAY(SELECT DISTINCT unnest(p_local_recipient_ids || ARRAY[p_actor_id]) ORDER BY 1);

  -- Find existing group conversation with exactly these participants
  SELECT c.id INTO v_conversation_id
  FROM conversations c
  WHERE c.type = 'group'
    AND EXISTS (SELECT 1 FROM conversation_participants cp WHERE cp.conversation_id = c.id AND cp.user_id = p_actor_id AND cp.left_at IS NULL)
    AND (SELECT array_agg(cp.user_id ORDER BY cp.user_id) FROM conversation_participants cp WHERE cp.conversation_id = c.id AND cp.left_at IS NULL)
      = (SELECT array_agg(uid ORDER BY uid) FROM unnest(v_all_ids) uid)
  LIMIT 1;

  IF v_conversation_id IS NOT NULL THEN
    RETURN v_conversation_id;
  END IF;

  -- Create new group conversation
  INSERT INTO conversations (type, name, created_by, metadata)
  VALUES ('group', NULL, p_actor_id, '{"federated": true}'::jsonb)
  RETURNING id INTO v_conversation_id;

  INSERT INTO conversation_participants (conversation_id, user_id, role)
  VALUES (v_conversation_id, p_actor_id, 'admin')
  ON CONFLICT (conversation_id, user_id) DO UPDATE SET left_at = NULL, role = 'admin';

  FOREACH v_participant_id IN ARRAY p_local_recipient_ids
  LOOP
    IF v_participant_id != p_actor_id THEN
      INSERT INTO conversation_participants (conversation_id, user_id, role)
      VALUES (v_conversation_id, v_participant_id, 'member')
      ON CONFLICT (conversation_id, user_id) DO UPDATE SET left_at = NULL, role = 'member';
    END IF;
  END LOOP;

  RETURN v_conversation_id;
END;
$$;

COMMENT ON FUNCTION public.get_or_create_federated_group_conversation(uuid, uuid[]) IS
  'Federation only: get or create group conversation for incoming group DMs. Used when multiple local users are recipients.';

COMMIT;
