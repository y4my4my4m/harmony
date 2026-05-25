BEGIN;

-- Fix add_post_emoji_reaction: auto-populate custom_emoji_content from emoji
-- table when only emoji_id is provided. This ensures consistent GROUP BY
-- in get_post_emoji_reactions (which groups by emoji_id + custom_emoji_content).
CREATE OR REPLACE FUNCTION public.add_post_emoji_reaction(
    p_user_id uuid,
    p_post_id uuid,
    p_emoji_id uuid DEFAULT NULL,
    p_custom_emoji_content text DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
DECLARE
    v_interaction_id uuid;
    v_resolved_content text;
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM profiles WHERE id = p_user_id AND auth_user_id = auth.uid()
    ) THEN
        RAISE EXCEPTION 'Unauthorized: Cannot create reactions as another user';
    END IF;

    IF p_emoji_id IS NULL AND p_custom_emoji_content IS NULL THEN
        RAISE EXCEPTION 'Must provide either emoji_id or custom_emoji_content';
    END IF;

    -- Auto-populate custom_emoji_content from the emoji table when missing
    v_resolved_content := p_custom_emoji_content;
    IF p_emoji_id IS NOT NULL AND v_resolved_content IS NULL THEN
        SELECT CASE
            WHEN e.url IS NOT NULL THEN ':' || e.name || ':'
            ELSE e.name
        END INTO v_resolved_content
        FROM emojis e WHERE e.id = p_emoji_id;
    END IF;

    INSERT INTO post_interactions (
        user_id, post_id, interaction_type,
        emoji_id, custom_emoji_content, is_local
    ) VALUES (
        p_user_id, p_post_id, 'emoji_reaction',
        p_emoji_id, v_resolved_content, true
    ) RETURNING id INTO v_interaction_id;

    RETURN v_interaction_id;
END;
$$;

-- Backfill: fix existing reactions that have emoji_id but null custom_emoji_content
UPDATE post_interactions pi
SET custom_emoji_content = CASE
    WHEN e.url IS NOT NULL THEN ':' || e.name || ':'
    ELSE e.name
END
FROM emojis e
WHERE pi.emoji_id = e.id
  AND pi.custom_emoji_content IS NULL
  AND pi.interaction_type = 'emoji_reaction';

COMMIT;
