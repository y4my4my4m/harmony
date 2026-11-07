-- Photos of a local post federate fitted inside instance_config.federate_image_max_px pixels
-- (federation-backend utils/federatedImages.ts): 0 sends originals, absent or invalid is 1920.
-- The cap in force when a post's media is first attached stays on the post as
-- metadata.federate_image_max_px, so an Update or refetch after the setting changes names the
-- same attachment URLs.
--
-- stamp_post_federate_image_cap(), BEFORE INSERT OR UPDATE OF media_attachments, metadata on
-- posts: a local post with media and no cap gets the current one; a cap once set survives
-- every later write; a cap on a post without media is dropped. Remote posts are left alone.
-- SECURITY DEFINER: the instance_config RLS limits clients to the public keys.

BEGIN;

SET LOCAL lock_timeout = '3s';

CREATE OR REPLACE FUNCTION public.stamp_post_federate_image_cap()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_key CONSTANT text := 'federate_image_max_px';
    v_meta jsonb := CASE WHEN jsonb_typeof(NEW.metadata) = 'object' THEN NEW.metadata ELSE '{}'::jsonb END;
    v_raw jsonb;
    v_num numeric;
    v_cap integer := 1920;
BEGIN
    IF NEW.is_local IS FALSE THEN
        RETURN NEW;
    END IF;

    IF TG_OP = 'UPDATE' AND jsonb_typeof(OLD.metadata) = 'object' AND OLD.metadata ? v_key THEN
        NEW.metadata := v_meta || jsonb_build_object(v_key, OLD.metadata -> v_key);
        RETURN NEW;
    END IF;

    IF jsonb_typeof(NEW.media_attachments) IS DISTINCT FROM 'array'
       OR jsonb_array_length(NEW.media_attachments) = 0 THEN
        IF v_meta ? v_key THEN
            NEW.metadata := v_meta - v_key;
        END IF;
        RETURN NEW;
    END IF;

    SELECT ic.config_value INTO v_raw FROM public.instance_config ic WHERE ic.config_key = v_key;
    BEGIN
        v_num := CASE jsonb_typeof(v_raw)
                     WHEN 'number' THEN (v_raw #>> '{}')::numeric
                     WHEN 'string' THEN NULLIF(btrim(v_raw #>> '{}'), '')::numeric
                 END;
    EXCEPTION WHEN invalid_text_representation THEN
        v_num := NULL;
    END;
    -- NaN fails the upper bound.
    IF v_num >= 0 AND v_num <= 1000000 THEN
        v_cap := round(v_num)::integer;
    END IF;

    NEW.metadata := v_meta || jsonb_build_object(v_key, v_cap);
    RETURN NEW;
END;
$$;

REVOKE ALL ON FUNCTION public.stamp_post_federate_image_cap() FROM PUBLIC, anon, authenticated;

DROP TRIGGER IF EXISTS posts_federate_image_cap ON public.posts;
CREATE TRIGGER posts_federate_image_cap
    BEFORE INSERT OR UPDATE OF media_attachments, metadata ON public.posts
    FOR EACH ROW EXECUTE FUNCTION public.stamp_post_federate_image_cap();

COMMIT;
