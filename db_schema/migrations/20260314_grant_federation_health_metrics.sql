BEGIN;

-- Grant SELECT on federation_health_metrics view to authenticated users (admin dashboard)
-- The view was created in 70_views.sql but the GRANT was missing from init scripts.
GRANT SELECT ON public.federation_health_metrics TO authenticated;
GRANT SELECT ON public.federation_health_metrics TO service_role;

NOTIFY pgrst, 'reload schema';

COMMIT;
