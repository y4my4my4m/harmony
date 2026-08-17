BEGIN;

-- =============================================================================
-- Fix group conversation realtime + federation mapping
--
-- 1. Trigger on conversations UPDATE → broadcast conversation:updated to all
--    active participants via realtime.  Covers both local RPCs and federation
--    backend updates (service-role).
--
-- 2. Update get_or_create_federated_group_conversation to accept and store
--    the remote instance's conversation ID in metadata, enabling the receiving
--    instance to resolve updates/removals back to the correct local row.
-- =============================================================================

-- ---------------------------------------------------------------------------
-- 1. broadcast_conversation_updated - fires on conversations UPDATE
-- ---------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION public.broadcast_conversation_updated()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
  v_participant RECORD;
  v_changes jsonb := '{}'::jsonb;
BEGIN
  IF NEW.name IS DISTINCT FROM OLD.name THEN
    v_changes := v_changes || jsonb_build_object('name', NEW.name);
  END IF;

  IF NEW.metadata IS DISTINCT FROM OLD.metadata THEN
    v_changes := v_changes || jsonb_build_object('metadata', COALESCE(NEW.metadata, '{}'::jsonb));
  END IF;

  IF v_changes = '{}'::jsonb THEN
    RETURN NEW;
  END IF;

  FOR v_participant IN
    SELECT user_id FROM conversation_participants
    WHERE conversation_id = NEW.id AND left_at IS NULL
  LOOP
    PERFORM realtime.send(
      jsonb_build_object(
        'type', 'conversation:updated',
        'conversation_id', NEW.id,
        'changes', v_changes
      ),
      'user_event',
      'user:' || v_participant.user_id::text,
      true
    );
  END LOOP;

  RETURN NEW;
EXCEPTION WHEN OTHERS THEN
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS trg_broadcast_conversation_updated ON conversations;
CREATE TRIGGER trg_broadcast_conversation_updated
  AFTER UPDATE ON conversations
  FOR EACH ROW
  EXECUTE FUNCTION broadcast_conversation_updated();

-- ---------------------------------------------------------------------------
-- 2. get_or_create_federated_group_conversation - add remote_conversation_id
-- ---------------------------------------------------------------------------
-- Drop the old 2-param overload so the new 3-param version (with DEFAULT)
-- doesn't cause ambiguous calls.
DROP FUNCTION IF EXISTS public.get_or_create_federated_group_conversation(uuid, uuid[]);

CREATE OR REPLACE FUNCTION public.get_or_create_federated_group_conversation(
  p_actor_id uuid,
  p_local_recipient_ids uuid[],
  p_remote_conversation_id text DEFAULT NULL
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

  -- Try matching by remote_conversation_id first (most reliable for federated updates)
  IF p_remote_conversation_id IS NOT NULL THEN
    SELECT c.id INTO v_conversation_id
    FROM conversations c
    WHERE c.type = 'group'
      AND c.metadata->>'remote_conversation_id' = p_remote_conversation_id
    LIMIT 1;

    IF v_conversation_id IS NOT NULL THEN
      RETURN v_conversation_id;
    END IF;
  END IF;

  -- Fallback: find existing group conversation with exactly these participants
  SELECT c.id INTO v_conversation_id
  FROM conversations c
  WHERE c.type = 'group'
    AND EXISTS (SELECT 1 FROM conversation_participants cp WHERE cp.conversation_id = c.id AND cp.user_id = p_actor_id AND cp.left_at IS NULL)
    AND (SELECT array_agg(cp.user_id ORDER BY cp.user_id) FROM conversation_participants cp WHERE cp.conversation_id = c.id AND cp.left_at IS NULL)
      = (SELECT array_agg(uid ORDER BY uid) FROM unnest(v_all_ids) uid)
  LIMIT 1;

  IF v_conversation_id IS NOT NULL THEN
    -- Backfill remote_conversation_id if we matched by participants but didn't have it
    IF p_remote_conversation_id IS NOT NULL THEN
      UPDATE conversations
      SET metadata = COALESCE(metadata, '{}'::jsonb) || jsonb_build_object('remote_conversation_id', p_remote_conversation_id)
      WHERE id = v_conversation_id
        AND (metadata IS NULL OR metadata->>'remote_conversation_id' IS NULL);
    END IF;
    RETURN v_conversation_id;
  END IF;

  -- Create new group conversation
  INSERT INTO conversations (type, name, created_by, metadata)
  VALUES (
    'group',
    NULL,
    p_actor_id,
    CASE
      WHEN p_remote_conversation_id IS NOT NULL
      THEN jsonb_build_object('federated', true, 'remote_conversation_id', p_remote_conversation_id)
      ELSE '{"federated": true}'::jsonb
    END
  )
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

COMMENT ON FUNCTION public.get_or_create_federated_group_conversation(uuid, uuid[], text) IS
  'Federation only: get or create group conversation for incoming group DMs. Stores remote_conversation_id for cross-instance ID resolution.';

COMMIT;
