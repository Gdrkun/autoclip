-- Production import operations. Cancellations are separate from failed requests.
-- Do not infer finished video delivery from import acceptance.
WITH operations AS (
  SELECT properties.operation_id AS operation_id,
         max(event = 'studio_import_requested') AS requested,
         max(event = 'studio_import_accepted') AS accepted,
         max(event = 'studio_import_cancelled') AS cancelled,
         max(event = 'studio_import_request_failed') AS failed
  FROM events
  WHERE timestamp >= now() - INTERVAL 7 DAY
    AND properties.studio_schema_version = 2
    AND properties.analytics_environment = 'production'
    AND properties.operation_id IS NOT NULL AND properties.operation_id != ''
    AND event IN ('studio_import_requested', 'studio_import_accepted',
                  'studio_import_cancelled', 'studio_import_request_failed')
  GROUP BY operation_id
)
SELECT sum(requested) AS requested_operations,
       sum(cancelled) AS cancelled_operations,
       sum(accepted) AS accepted_operations,
       sum(failed) AS failed_operations,
       sum(requested AND NOT cancelled) AS effective_attempts,
       sum(accepted) / nullIf(sum(requested AND NOT cancelled), 0) AS acceptance_rate
FROM operations
