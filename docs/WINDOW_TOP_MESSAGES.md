# Batch Window Analytics

## Confirmed Application Limits

Inspected on 2026-09-07. No existing limit was removed.

| Route | Requests per minute | Key / scope |
| --- | --- | --- |
| `/api/v1/analytics/realtime-top-messages` | 60 | IP, this route only, per process |
| `/api/v1/analytics/session-top-messages` | 60 | IP, this route only, per process |
| `/api/v1/analytics/window-top-messages` | 6 | IP, this route only, per process |
| `/api/v1/rooms`, other analytics, health checks | No application limiter | Not shared with the above |

These are fixed 60-second windows beginning with an IP's first counted request,
not rolling windows. Room IDs, parameters and bearer tokens do not create new
quotas. Cached requests also count. Existing realtime/session routes validate
parameters before counting; the batch route counts before parameter validation.
Authentication runs before these route handlers. Application-generated 429s
include `Retry-After` in integer seconds. Batch concurrency rejection uses 5 seconds.

Fastify has no `trustProxy` configuration: `request.ip` is the socket peer, not an
arbitrary `X-Forwarded-For` header. Behind Nginx, clients may therefore share the
proxy IP quota. Do not enable unconditional proxy trust on a publicly reachable
port. Multiple application processes have independent counters and concurrency
limits, so these are not cluster-wide guarantees.

## Nginx Audit Still Required

There is no Nginx configuration in this repository or `/etc/nginx` on the inspected
machine. Production `limit_req_zone`, `limit_req`, inheritance, bursts, key choice,
and response headers have NOT been verified. On the deployment host inspect
`nginx -T` (or `docker exec <nginx-container> nginx -T`), including all includes.
Do not publish the full output without checking for secrets.

Check the zone key (IP/token/URI), which locations reference each zone, inherited
limits, `burst`/`nodelay`, `limit_req_status` (Nginx defaults to 503), trusted proxy
chains, and any CDN limits. A separate batch zone/location should not silently
inherit the lightweight endpoint's policy. Configure Nginx-generated 429s to emit
`Retry-After` too; the application cannot add a header to requests Nginx rejects.
Validate effective behavior with different IPs, rooms, tokens and routes before
changing limits. The application change does not modify Nginx.

## Contract

```http
GET /api/v1/analytics/window-top-messages?room_id=<uuid>&date=2026-09-06&timezone=Asia%2FShanghai&window=10m&limit=50
```

`room_id` and a real `YYYY-MM-DD` date are required. `timezone` defaults to
`Asia/Shanghai` and must be an IANA zone; `window` is currently only `10m`;
`limit` defaults to 50 and accepts integers 1..50. Explicit `from`/`to` are rejected.
Bounds are local midnight to the next local midnight, capped at 24 elapsed hours.
A 23-hour DST day is supported; a 25-hour day returns 400 rather than silently
truncating. Each bucket is 10 elapsed minutes anchored at local midnight.

Only buckets whose end is at or before the captured `as_of` are included. A future
date returns zero windows. An ordinary past date returns 144 ordered windows,
each with independent Top N. Returned times are UTC ISO 8601 instants.

The envelope contains `room_id`, `date`, canonical `timezone`, `window`, `as_of`,
`generated_at`, and `windows`. Each window contains `from`, `to`, `data_complete`,
`status`, `total_messages`, and `items`. Items use the existing realtime schema:
`rank`, `content`, `message_count`, `share`. Counts and ranks are decimal strings.

Aggregation preserves realtime rules: `occurred_at` in `[from,to)`, grouping by
`content_normalized`, count descending then content ascending using database
collation, `row_number()` with no extra tied entries. Empty normalized text counts
toward the total/share denominator but not the ranking. No raw message sampling.

| status | Meaning |
| --- | --- |
| `data_available` | Observed messages; no recorded overlapping incident |
| `no_messages_observed` | Zero stored messages; NOT proof that no messages were sent |
| `collection_gap` | Recorded incident overlaps the bucket, even if items exist |
| `raw_data_unavailable` | Overlap with a completed, verified archive; total is null and items are empty |

`data_complete` is false for known gaps/archive uncertainty and null otherwise,
matching the existing conservative realtime semantics. No heartbeat/coverage
ledger exists, so true completeness or confirmed absence of messages cannot be
inferred. Unrecorded outages remain unknown. Incidents use half-open overlap.
Verified archives are treated conservatively because the archive process can
remove hot partitions and does not persist a definitive partition-deleted flag;
even if deletion failed, this endpoint will not claim a complete raw-data result.
It does not read Parquet archives. Archive status takes precedence over incidents.

Database failures/timeouts return HTTP 503 with `ANALYTICS_QUERY_FAILED`, never a
successful empty ranking. Source unavailability is 503 `DATA_SOURCE_UNAVAILABLE`;
missing rooms are 404. The response is all-or-error, not partially successful.

## Cost, Cache And Observability

The service permits at most two active batch requests per application process.
The SQL runs in a read-only repeatable-read transaction with a 15-second statement
timeout and 16 MB `work_mem` per operation (not a total query memory cap).
One bounded, partition-prunable message scan groups by bucket and text, then
`row_number()` partitions by bucket. Completeness is materialized once per bucket.
There are not 144 independent message queries. At most 144 x 50 items are returned.

No batch result cache is enabled, and responses use `Cache-Control: no-store`.
Every successful request reads a fresh database snapshot, including backfilled or
repaired records. Existing realtime/session caches are unchanged. Do not add a
historical TTL-only cache: introduce durable revisions covering message writes,
repairs, incident changes and partition removal, and key cached snapshots by those
revisions, including changes made by other processes.

Structured `window_top_messages` completion logs record `database_ms` (room lookup
and database operation, including pool wait), `total_ms`, `window_count`,
`cache_hit: false`, `cache_enabled: false`, and `outcome`. Failures are logged too.
Validation/rate/concurrency rejections use normal Fastify request logs.

## Verification

`npm test` runs unit/API tests; `npm run check` validates JavaScript syntax.
An optional embedded PostgreSQL integration/plan test can be run without changing
application dependencies:

```sh
npm install --prefix /tmp/huya-window-validation --no-audit --no-fund @electric-sql/pglite
WINDOW_TEST_PGLITE=/tmp/huya-window-validation/node_modules/@electric-sql/pglite node test/database-window-top.test.js
```

The integration test executes the real schema/query, exercises boundary, ranking,
empty-text, gap, archive and DST cases, and uses `EXPLAIN (ANALYZE, BUFFERS, FORMAT
JSON)` on 100,000 synthetic messages with the same work-memory/timeout settings.
It asserts one raw-table scan, partition pruning and at most 144 completeness
checks. This is not a production capacity benchmark: before deployment, run the
exported `WINDOW_TOP_SQL` with representative peak-day data and production
PostgreSQL collation/version, inspecting elapsed time, buffers, sort spills and
ingestion latency. Keep the conservative limits until that measurement is done.

The 2026-09-07 local run took approximately 231 ms for 7,200 SQL result rows, with
one message-partition scan, 144 incident checks, 144 archive checks and zero
temporary read/write blocks. A sequential scan was chosen because nearly all
fixture rows belonged to the requested room/day; the other month was pruned.
