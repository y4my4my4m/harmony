-- Federated emoji named after their image host instead of their instance.
--
-- Inbound reactions stored emojis.domain (and remote_emojis_cache.origin_domain) as the host of
-- the emoji's image URL. That host is a storage host or CDN: har.mony.lol serves its emoji from
-- db.mony.lol, Mastodon instances from media hosts. The emoji info card then read "From another
-- instance: db.mony.lol". Harmony qualifies every emoji it sends to an instance it does not
-- belong to as :name@origin: (emojiResolvers.formatEmojiForFederation), and the receiver kept
-- that whole string as the name, so the name read "eyes@har.mony.lol" beside the wrong domain.
--
-- The federation backend now takes the origin from a qualified shortcode, else the sender's
-- instance (utils/emojiOrigin.ts). repair_inbound_emoji_origins() rewrites the rows already
-- stored:
--   1. a qualified name name@host becomes name, with host as the domain;
--   2. a row whose domain is its image host and no known instance takes its uploader's
--      instance (the remote member whose reaction created it);
--   3. remote_emojis_cache follows: qualified shortcodes split, origin_domain taken from the
--      repaired emojis row of the same url, full_code rebuilt; a row that would duplicate an
--      existing (shortcode, origin_domain) folds its usage into that row.

CREATE OR REPLACE FUNCTION public.repair_inbound_emoji_origins()
RETURNS integer
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public, pg_temp
AS $$
DECLARE
    v_host constant text := '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$';
    v_count integer := 0;
    v_rows integer;
    r record;
BEGIN
    -- 1. Qualified names.
    UPDATE public.emojis e
       SET name = left(e.name, length(e.name) - strpos(reverse(e.name), '@')),
           domain = lower(right(e.name, strpos(reverse(e.name), '@') - 1))
     WHERE e.server_id IS NULL
       AND e.domain IS NOT NULL
       AND e.scope IS DISTINCT FROM 'user'
       AND strpos(e.name, '@') > 1
       AND lower(right(e.name, strpos(reverse(e.name), '@') - 1)) ~ v_host;
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    v_count := v_count + v_rows;

    -- 2. Domain derived from the image host, which is no known instance.
    UPDATE public.emojis e
       SET domain = lower(p.domain)
      FROM public.profiles p
     WHERE e.uploader = p.id
       AND p.is_local IS FALSE
       AND NULLIF(btrim(p.domain), '') IS NOT NULL
       AND e.server_id IS NULL
       AND e.domain IS NOT NULL
       AND e.scope IS DISTINCT FROM 'user'
       AND lower(e.domain) <> lower(p.domain)
       AND lower(e.domain) = lower(substring(e.url::text from '^https?://([^/:?#]+)'))
       AND NOT EXISTS (SELECT 1 FROM public.federated_instances fi WHERE fi.domain = lower(e.domain));
    GET DIAGNOSTICS v_rows = ROW_COUNT;
    v_count := v_count + v_rows;

    -- 3. The remote emoji cache.
    FOR r IN
        SELECT c.id, c.shortcode, c.origin_domain, c.usage_count, c.imported_as,
               CASE WHEN strpos(c.shortcode, '@') > 1
                         AND lower(right(c.shortcode, strpos(reverse(c.shortcode), '@') - 1)) ~ v_host
                    THEN left(c.shortcode, length(c.shortcode) - strpos(reverse(c.shortcode), '@'))
                    ELSE c.shortcode END AS new_shortcode,
               COALESCE(
                   CASE WHEN strpos(c.shortcode, '@') > 1
                             AND lower(right(c.shortcode, strpos(reverse(c.shortcode), '@') - 1)) ~ v_host
                        THEN lower(right(c.shortcode, strpos(reverse(c.shortcode), '@') - 1)) END,
                   (SELECT lower(e.domain) FROM public.emojis e
                     WHERE e.url = c.url AND e.server_id IS NULL AND e.domain IS NOT NULL
                     ORDER BY e.created_at LIMIT 1),
                   c.origin_domain) AS new_domain
          FROM public.remote_emojis_cache c
    LOOP
        CONTINUE WHEN r.new_shortcode = r.shortcode AND r.new_domain = r.origin_domain;
        IF EXISTS (SELECT 1 FROM public.remote_emojis_cache k
                    WHERE k.shortcode = r.new_shortcode AND k.origin_domain = r.new_domain AND k.id <> r.id) THEN
            UPDATE public.remote_emojis_cache k
               SET usage_count = COALESCE(k.usage_count, 0) + COALESCE(r.usage_count, 0),
                   imported_as = COALESCE(k.imported_as, r.imported_as)
             WHERE k.shortcode = r.new_shortcode AND k.origin_domain = r.new_domain;
            DELETE FROM public.remote_emojis_cache WHERE id = r.id;
        ELSE
            UPDATE public.remote_emojis_cache
               SET shortcode = r.new_shortcode,
                   origin_domain = r.new_domain,
                   full_code = ':' || r.new_shortcode || '@' || r.new_domain || ':'
             WHERE id = r.id;
        END IF;
        v_count := v_count + 1;
    END LOOP;

    RETURN v_count;
END;
$$;

REVOKE ALL ON FUNCTION public.repair_inbound_emoji_origins() FROM PUBLIC, anon, authenticated, service_role;

SELECT public.repair_inbound_emoji_origins();
