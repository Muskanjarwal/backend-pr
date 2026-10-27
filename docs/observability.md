# Observability

Three signals, correlated by ids: **metrics** (Prometheus), **logs** (structured JSON), **traces** (OpenTelemetry). Everything below runs locally with `docker compose up` — Grafana on :3001, Prometheus on :9090, Jaeger on :16686.

## SLOs

| SLI | Objective | Measured by |
|---|---|---|
| Availability | 99.95 % of requests non-5xx (≈ 22 min/month budget) | `http_request_duration_seconds_count{status=~"5.."}` ratio |
| Read latency | p95 < 200 ms | histogram quantile over `method="GET"` |
| Write latency | p95 < 500 ms | histogram quantile over `POST|PATCH|DELETE` |
| Saga health | 0 dead jobs; queue drains | `jobs_processed_total{outcome="dead"}`, `job_queue_depth` |

Histogram buckets are dense around 150–500 ms so the p95s are accurate where the SLOs sit.

## Metrics (`src/observability/metrics.ts`)

Scraped from `:9464/metrics` (API) and `:9465/metrics` (worker) — internal ports, not routed by the ingress.

| Metric | Labels | Why |
|---|---|---|
| `http_request_duration_seconds` | method, **route template**, status | RED metrics. Route *template* (`/v1/consultations/:id`), never the URL, to bound cardinality |
| `bookings_total` | outcome (`held`, `slot_unavailable`) | contention / conversion |
| `consultation_transitions_total` | to | lifecycle throughput, expiry and cancellation rates |
| `payment_events_total` | type, outcome | webhook health (`confirmed`, `refund_scheduled`, `duplicate`…) |
| `jobs_processed_total`, `job_duration_seconds`, `job_queue_depth` | type, outcome | saga/worker health |
| `cache_lookups_total` | cache, result | hit ratio |
| `auth_events_total` | event | abuse detection (`login_failed`, `login_locked`, `refresh_reuse`) |
| `db_pool_connections` | state | saturation (`waiting > 0` ⇒ queueing) |
| `nodejs_*`, `process_*` | — | event-loop lag, heap, GC, CPU |

No user ids, emails or any PHI are used as label values.

## Logs

* Pino JSON to stdout (`level`, `time`, `service`, `req.id`, `trace_id`, `span_id`). Ship with the cluster log agent (Fluent Bit / Vector) to Loki/ELK/CloudWatch.
* **Correlation:** every request gets/propagates `x-request-id` (returned to the client and echoed in error bodies and audit rows). When tracing is on, `trace_id`/`span_id` are injected in every line — click from a log line to its trace.
* **Redaction:** `Authorization`, cookies, signature headers, `password`/`token` fields. Bodies are never logged.
* Job failures log `jobId`, `type`, `attempt` and the error message (warn on retry, error on dead-letter).

## Traces

`src/observability/tracing.ts` (opt-in via `OTEL_EXPORTER_OTLP_ENDPOINT`, loaded with `node --import` so instrumentation patches modules before use) instruments inbound HTTP (spans renamed to the route template, e.g. `POST /v1/consultations/:id/cancel`, with `request.id`) and **every pg query** — so a slow booking shows exactly which statement was slow. The collector (`deploy/observability/otel-collector.yaml`) strips auth headers, **keeps 100 % of error and > 400 ms traces** and samples 10 % of the rest (tail sampling), then exports to Jaeger.

## Dashboards

`deploy/observability/grafana/dashboards/amrutam-overview.json` (auto-provisioned): request rate by route, 5xx ratio vs the 0.05 % budget, read/write p95/p99 with SLO threshold lines, booking outcomes, consultation transitions, webhook outcomes, queue depth, jobs by outcome, DB pool, cache hit ratio, auth events, event-loop lag, heap, job duration.

## Alerts (`deploy/observability/alerts.yml`)

| Alert | Severity | Meaning / first action |
|---|---|---|
| `ApiHighErrorRate`, `ApiErrorBudgetFastBurn` | page | 5xx above budget — check `/readyz`, DB, last deploy; roll back |
| `ReadLatencySLOBreach`, `WriteLatencySLOBreach` | ticket | p95 over SLO 10 min — look at traces for the slow route/query |
| `DbPoolSaturated` | ticket | requests queueing for connections — slow queries or too few DB connections |
| `JobsDeadLettered` | page | a saga step exhausted retries — see runbook in `architecture.md` §9 |
| `JobQueueBacklog`, `WorkerDown` | ticket / page | add workers / holds won't expire, payments won't progress |
| `LoginFailureSpike`, `RefreshTokenReuse`, `WebhookSignatureFailures` | ticket | security signals |

## Health endpoints

* `/healthz` — liveness: process is up (touches nothing external).
* `/readyz` — readiness: database (and Redis when configured) reachable; failing it removes the pod from the load balancer without restarting it.

## Useful queries

```promql
# p95 by route
histogram_quantile(0.95, sum by (le, route) (rate(http_request_duration_seconds_bucket[5m])))
# booking contention (lost races per successful hold)
sum(rate(bookings_total{outcome="slot_unavailable"}[5m])) / sum(rate(bookings_total{outcome="held"}[5m]))
# conversion: confirmed vs expired holds
sum(increase(consultation_transitions_total{to="confirmed"}[1h])) / sum(increase(consultation_transitions_total{to="pending_payment"}[1h]))
```
