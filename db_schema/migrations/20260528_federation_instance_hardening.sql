BEGIN;

-- Normalize existing domains to lowercase before adding CHECK constraint.
UPDATE public.federated_instances
SET domain = lower(btrim(domain)),
    updated_at = now()
WHERE domain IS NOT NULL
  AND domain <> lower(btrim(domain));

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
    WHERE conname = 'federated_instances_domain_lowercase'
  ) THEN
    ALTER TABLE public.federated_instances
      ADD CONSTRAINT federated_instances_domain_lowercase
      CHECK (domain = lower(domain));
  END IF;
END $$;

-- Single lowercase upsert (domain column must be stored lowercase).
CREATE OR REPLACE FUNCTION public.touch_federated_instance(p_domain text)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_domain text;
BEGIN
  v_domain := lower(btrim(p_domain));

  IF v_domain IS NULL OR v_domain = '' THEN
    RETURN;
  END IF;

  INSERT INTO public.federated_instances (
    domain,
    last_seen_at,
    updated_at
  )
  VALUES (
    v_domain,
    now(),
    now()
  )
  ON CONFLICT (domain) DO UPDATE
  SET last_seen_at = now(),
      updated_at = now();
END;
$$;

CREATE OR REPLACE FUNCTION public.update_federation_health(
    p_instance_domain text,
    p_success boolean,
    p_latency_ms numeric DEFAULT NULL,
    p_error text DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_domain text;
BEGIN
    v_domain := lower(btrim(p_instance_domain));
    IF v_domain IS NULL OR v_domain = '' THEN
        RETURN;
    END IF;

    INSERT INTO public.federation_health (
        instance_domain,
        status,
        last_success_at,
        last_failure_at,
        success_count,
        failure_count,
        avg_latency_ms,
        last_error
    ) VALUES (
        v_domain,
        CASE WHEN p_success THEN 'healthy' ELSE 'unhealthy' END,
        CASE WHEN p_success THEN now() ELSE NULL END,
        CASE WHEN NOT p_success THEN now() ELSE NULL END,
        CASE WHEN p_success THEN 1 ELSE 0 END,
        CASE WHEN NOT p_success THEN 1 ELSE 0 END,
        p_latency_ms,
        p_error
    )
    ON CONFLICT (instance_domain) DO UPDATE SET
        timestamp = now(),
        status = CASE
            WHEN p_success THEN 'healthy'
            ELSE 'unhealthy'
        END,
        last_success_at = CASE WHEN p_success THEN now() ELSE federation_health.last_success_at END,
        last_failure_at = CASE WHEN NOT p_success THEN now() ELSE federation_health.last_failure_at END,
        success_count = federation_health.success_count + CASE WHEN p_success THEN 1 ELSE 0 END,
        failure_count = CASE
            WHEN p_success THEN 0
            ELSE federation_health.failure_count + 1
        END,
        avg_latency_ms = CASE
            WHEN p_latency_ms IS NOT NULL AND federation_health.avg_latency_ms IS NOT NULL
            THEN (federation_health.avg_latency_ms + p_latency_ms) / 2
            ELSE COALESCE(p_latency_ms, federation_health.avg_latency_ms)
        END,
        last_error = CASE
            WHEN p_success THEN NULL
            ELSE COALESCE(p_error, federation_health.last_error)
        END;

    IF p_success THEN
        PERFORM public.touch_federated_instance(v_domain);
    END IF;
END;
$$;

-- Known remote actors from each instance stored locally (profiles + actor cache).
CREATE OR REPLACE FUNCTION public.get_federated_instance_connection_counts(p_domains text[])
RETURNS TABLE(domain text, connection_count bigint)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = public
AS $$
  WITH normalized AS (
    SELECT lower(btrim(d)) AS domain
    FROM unnest(p_domains) AS d
    WHERE d IS NOT NULL AND btrim(d) <> ''
  ),
  profile_counts AS (
    SELECT lower(p.domain) AS domain, COUNT(*)::bigint AS cnt
    FROM public.profiles p
    INNER JOIN normalized n ON lower(p.domain) = n.domain
    WHERE p.is_local = false
      AND p.domain IS NOT NULL
      AND p.domain <> ''
    GROUP BY lower(p.domain)
  ),
  actor_counts AS (
    SELECT lower(a.domain) AS domain, COUNT(*)::bigint AS cnt
    FROM public.ap_actor_cache a
    INNER JOIN normalized n ON lower(a.domain) = n.domain
    WHERE a.domain IS NOT NULL
      AND a.domain <> ''
    GROUP BY lower(a.domain)
  )
  SELECT
    n.domain,
    GREATEST(COALESCE(pc.cnt, 0), COALESCE(ac.cnt, 0)) AS connection_count
  FROM normalized n
  LEFT JOIN profile_counts pc ON pc.domain = n.domain
  LEFT JOIN actor_counts ac ON ac.domain = n.domain;
$$;

COMMENT ON FUNCTION public.get_federated_instance_connection_counts(text[])
IS 'Count known remote actors per instance domain (max of profiles and ap_actor_cache).';

GRANT EXECUTE ON FUNCTION public.get_federated_instance_connection_counts(text[]) TO authenticated;
GRANT EXECUTE ON FUNCTION public.get_federated_instance_connection_counts(text[]) TO service_role;

-- Backfill stored connection_count from the same sources.
UPDATE public.federated_instances fi
SET connection_count = sub.cnt,
    updated_at = now()
FROM (
    SELECT domain, MAX(cnt)::integer AS cnt
    FROM (
        SELECT lower(domain) AS domain, COUNT(*)::bigint AS cnt
        FROM public.profiles
        WHERE domain IS NOT NULL
          AND domain <> ''
          AND is_local = false
        GROUP BY lower(domain)
        UNION ALL
        SELECT lower(domain) AS domain, COUNT(*)::bigint AS cnt
        FROM public.ap_actor_cache
        WHERE domain IS NOT NULL
          AND domain <> ''
        GROUP BY lower(domain)
    ) sources
    WHERE domain IS NOT NULL
      AND domain <> ''
    GROUP BY domain
) sub
WHERE lower(fi.domain) = sub.domain
  AND sub.cnt > COALESCE(fi.connection_count, 0);

COMMIT;
