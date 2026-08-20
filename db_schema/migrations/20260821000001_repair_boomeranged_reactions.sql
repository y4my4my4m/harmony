-- Emoji reactions this instance emitted, ingested a second time when they federated back.
--
-- A remote instance qualifies a shortcode with the emoji's origin, so a reaction on our own
-- emoji returns as `:name@our.domain:` and no longer matches the `:name:` already stored.
-- The two rows fall under different partial unique indexes -- one keyed on emoji_id, one on
-- custom_emoji_content -- so neither blocked the other and the chip split.
--
-- The ingest paths now normalise the shortcode before their dedupe check. This repairs the
-- rows written before that.
--
-- Two distinct repairs, and the difference matters:
--
--   A local profile with an ap_id is a reaction that left and came back. The local row it
--   duplicates still exists, so the federated copy is deleted.
--
--   A remote profile reacting with one of our emoji is a real reaction that happens to carry
--   the qualified spelling. Its content is normalised, never deleted.
--
-- Both are scoped to shortcodes ending in this instance's own domain, read from
-- instance_config rather than hardcoded.

BEGIN;

DO $$
DECLARE
    v_domain text;
    v_suffix text;
    v_deleted bigint;
    v_normalised bigint;
BEGIN
    SELECT config_value #>> '{}' INTO v_domain
      FROM public.instance_config WHERE config_key = 'domain';

    IF v_domain IS NULL OR v_domain = '' THEN
        RAISE NOTICE 'instance_config has no domain; nothing to repair';
        RETURN;
    END IF;

    v_suffix := '@' || v_domain || ':';

    -- Ours, returned. The local row it duplicates must still be present, or this deletes the
    -- only record of the reaction.
    WITH doomed AS (
        SELECT pi.id
          FROM public.post_interactions pi
          JOIN public.profiles p ON p.id = pi.user_id
         WHERE pi.interaction_type = 'emoji_reaction'
           AND pi.ap_id IS NOT NULL
           AND p.is_local
           AND pi.custom_emoji_content LIKE '%' || v_suffix
           AND EXISTS (
               SELECT 1 FROM public.post_interactions keep
                WHERE keep.post_id = pi.post_id
                  AND keep.user_id = pi.user_id
                  AND keep.interaction_type = 'emoji_reaction'
                  AND keep.id <> pi.id
                  AND keep.ap_id IS NULL
           )
    )
    DELETE FROM public.post_interactions t USING doomed d WHERE t.id = d.id;
    GET DIAGNOSTICS v_deleted = ROW_COUNT;

    -- Theirs, spelled with our domain. Skipped where the unqualified form would collide with
    -- a row that user already holds.
    WITH renamed AS (
        SELECT pi.id,
               left(pi.custom_emoji_content, length(pi.custom_emoji_content) - length(v_suffix)) || ':' AS bare
          FROM public.post_interactions pi
         WHERE pi.interaction_type = 'emoji_reaction'
           AND pi.custom_emoji_content LIKE '%' || v_suffix
    )
    UPDATE public.post_interactions t
       SET custom_emoji_content = r.bare
      FROM renamed r
     WHERE t.id = r.id
       AND NOT EXISTS (
           SELECT 1 FROM public.post_interactions other
            WHERE other.post_id = t.post_id
              AND other.user_id = t.user_id
              AND other.interaction_type = 'emoji_reaction'
              AND other.id <> t.id
              AND other.custom_emoji_content = r.bare
              AND other.emoji_id IS NOT DISTINCT FROM t.emoji_id
       );
    GET DIAGNOSTICS v_normalised = ROW_COUNT;

    RAISE NOTICE 'domain %: % boomeranged row(s) deleted, % shortcode(s) normalised',
                 v_domain, v_deleted, v_normalised;
END
$$;

COMMIT;

NOTIFY pgrst, 'reload schema';
