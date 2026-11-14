# API operational endpoints and metrics

## Health and readiness

- `GET /api/v1/health` is a process liveness check. It does not contact PostgreSQL or the identity provider and should be used by container/process liveness probes.
- `GET /api/v1/ready` runs the configured readiness probe. In the current composition, that probe executes `SELECT 1` against PostgreSQL. A dependency failure returns HTTP 503 with a generic `not_ready` error and request ID; the response does not expose connection details or credentials.
- Neither endpoint reports detailed dependency state. Keep database/provider diagnostics in protected operator logs and dashboards; do not add URLs, exception text, or secret values to probe responses.

Request IDs are validated or generated for response correlation. They can originate from caller headers and are not authentication credentials. Avoid using them as metric labels or logging request headers, cookies, authorization codes, invitation tokens, emails, issue content, raw IP addresses, or user/workspace IDs.

## HTTP metrics module

`src/observability/metrics.ts` provides an in-memory HTTP counter, duration histogram, in-flight gauge, client-abort counter, and protected router. It is disabled by default. Setting `METRICS_BEARER_TOKEN` to an independent random 32-byte base64url secret enables `GET /metrics`; the scraper must send it in an `Authorization: Bearer` header. Missing or incorrect credentials receive the normal 404 response. Restrict network access to approved scrapers as an additional control, and do not log the authorization header.

Metric labels are restricted to a fixed HTTP method set and status class (`1xx` through `5xx`, or `other`). There are no route, path, query, user, workspace, IP, host, request-ID, header, cookie, or body labels. Histogram boundaries are fixed at 5 ms through 10 s. This bounds cardinality and excludes request content from the exported text.

The in-memory registry resets on process restart and is local to one API process. It is not a durable event store, distributed aggregation service, trace system, or security audit trail. Scrape each instance independently and aggregate in the monitoring system. The wiring remains unverified and does not establish a successful deployment or alerting setup.

## Initial operational signals

Once mounted and scraped, useful baseline alerts include sustained `5xx` request volume, elevated duration histogram quantiles, a persistent in-flight increase, and readiness failures. Choose thresholds from staging traffic and SLOs rather than hardcoding a product-level availability claim here. Liveness should not flap during database outages; readiness should remove instances that cannot reach PostgreSQL.
