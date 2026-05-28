BEGIN;

-- Record federation contact with a remote instance (inbound or outbound success).
-- Domain is always stored lowercase (see federated_instances_domain_lowercase CHECK).
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

COMMENT ON FUNCTION public.touch_federated_instance(text)
IS 'Bump federated_instances.last_seen_at when federation traffic is observed. Auto-registers unknown domains.';

GRANT EXECUTE ON FUNCTION public.touch_federated_instance(text) TO service_role;

-- Keep federated_instances.last_seen_at in sync with successful deliveries.
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

-- Backfill stale last_seen_at from actor cache, remote profiles, and health metrics.
UPDATE public.federated_instances fi
SET last_seen_at = sub.max_seen,
    updated_at = now()
FROM (
    SELECT domain, MAX(seen_at) AS max_seen
    FROM (
        SELECT lower(domain) AS domain, MAX(last_fetched_at) AS seen_at
        FROM public.ap_actor_cache
        WHERE domain IS NOT NULL AND domain <> ''
        GROUP BY lower(domain)
        UNION ALL
        SELECT lower(domain) AS domain, MAX(created_at) AS seen_at
        FROM public.profiles
        WHERE domain IS NOT NULL AND domain <> ''
          AND is_local = false
        GROUP BY lower(domain)
        UNION ALL
        SELECT lower(instance_domain) AS domain, MAX(last_success_at) AS seen_at
        FROM public.federation_health
        WHERE instance_domain IS NOT NULL
          AND instance_domain <> ''
          AND last_success_at IS NOT NULL
        GROUP BY lower(instance_domain)
    ) sources
    WHERE domain IS NOT NULL
      AND domain <> ''
      AND seen_at IS NOT NULL
    GROUP BY domain
) sub
WHERE lower(fi.domain) = sub.domain
  AND (
    fi.last_seen_at IS NULL
    OR sub.max_seen > fi.last_seen_at
  );

COMMIT;
