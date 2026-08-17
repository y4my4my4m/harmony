-- Fix federation DMs: add proper UNIQUE constraint on federated_id and ensure
-- get_or_create_dm_conversation function exists.
-- The partial unique index does NOT satisfy ON CONFLICT (federated_id) - a real
-- UNIQUE constraint is required.
BEGIN;

-- Drop the partial index (superseded by the constraint)
DROP INDEX IF EXISTS profiles_federated_id_key;

-- Add proper UNIQUE constraint (allows NULLs - only non-null values must be unique)
ALTER TABLE public.profiles
    DROP CONSTRAINT IF EXISTS profiles_federated_id_unique;

ALTER TABLE public.profiles
    ADD CONSTRAINT profiles_federated_id_unique UNIQUE (federated_id);

-- Ensure the federation-facing DM conversation function exists
CREATE OR REPLACE FUNCTION public.get_or_create_dm_conversation(p_user1_id uuid, p_user2_id uuid)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_conversation_id uuid;
BEGIN
    SELECT c.id INTO v_conversation_id
    FROM conversations c
    JOIN conversation_participants cp1 ON c.id = cp1.conversation_id AND cp1.user_id = p_user1_id
    JOIN conversation_participants cp2 ON c.id = cp2.conversation_id AND cp2.user_id = p_user2_id
    WHERE c.type = 'direct'
    LIMIT 1;

    IF v_conversation_id IS NULL THEN
        INSERT INTO conversations (type)
        VALUES ('direct')
        RETURNING id INTO v_conversation_id;

        INSERT INTO conversation_participants (conversation_id, user_id)
        VALUES (v_conversation_id, p_user1_id), (v_conversation_id, p_user2_id);
    END IF;

    RETURN v_conversation_id;
END;
$$;

COMMIT;
