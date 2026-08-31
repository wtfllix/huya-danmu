CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS rooms (
  id uuid PRIMARY KEY,
  external_room_id text NOT NULL,
  anchor_uid text,
  anchor_name text,
  enabled boolean NOT NULL DEFAULT true,
  runtime_status text NOT NULL DEFAULT 'unknown'
    CHECK (runtime_status IN ('disabled', 'unknown', 'offline', 'starting', 'listening', 'degraded', 'stopping')),
  last_checked_at timestamptz,
  last_message_at timestamptz,
  last_error jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz
);

CREATE UNIQUE INDEX IF NOT EXISTS rooms_external_room_id_active_key
  ON rooms (external_room_id) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS room_status_history (
  id bigserial PRIMARY KEY,
  room_id uuid NOT NULL REFERENCES rooms(id),
  from_status text,
  to_status text NOT NULL,
  reason text,
  source text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS room_status_history_room_created_idx
  ON room_status_history (room_id, created_at DESC);

CREATE TABLE IF NOT EXISTS live_sessions (
  id uuid PRIMARY KEY,
  room_id uuid NOT NULL REFERENCES rooms(id),
  detected_started_at timestamptz NOT NULL,
  detected_ended_at timestamptz,
  platform_started_at timestamptz,
  platform_ended_at timestamptz,
  status text NOT NULL CHECK (status IN ('active', 'completed', 'interrupted')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS live_sessions_one_active_per_room
  ON live_sessions (room_id) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS live_sessions_room_started_idx
  ON live_sessions (room_id, detected_started_at DESC);

CREATE TABLE IF NOT EXISTS danmu_messages (
  ingest_id uuid NOT NULL,
  room_id uuid NOT NULL REFERENCES rooms(id),
  session_id uuid REFERENCES live_sessions(id),
  source_event_id text,
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL,
  time_source text NOT NULL CHECK (time_source IN ('source', 'received')),
  sender_uid text,
  sender_name text NOT NULL DEFAULT '',
  content text NOT NULL,
  content_normalized text NOT NULL,
  content_hash char(64) NOT NULL,
  raw_payload jsonb,
  PRIMARY KEY (ingest_id, occurred_at)
) PARTITION BY RANGE (occurred_at);

CREATE TABLE IF NOT EXISTS stream_events (
  ingest_id uuid PRIMARY KEY,
  room_id uuid NOT NULL REFERENCES rooms(id),
  session_id uuid REFERENCES live_sessions(id),
  event_type text NOT NULL CHECK (event_type IN ('gift', 'online')),
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL,
  payload jsonb NOT NULL
);

CREATE INDEX IF NOT EXISTS stream_events_room_time_idx
  ON stream_events (room_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS danmu_minute_stats (
  room_id uuid NOT NULL REFERENCES rooms(id),
  bucket_at timestamptz NOT NULL,
  message_count bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (room_id, bucket_at)
);

CREATE TABLE IF NOT EXISTS danmu_daily_stats (
  room_id uuid NOT NULL REFERENCES rooms(id),
  local_date date NOT NULL,
  message_count bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (room_id, local_date)
);

CREATE TABLE IF NOT EXISTS danmu_daily_content_counts (
  room_id uuid NOT NULL REFERENCES rooms(id),
  local_date date NOT NULL,
  content_hash char(64) NOT NULL,
  content_normalized text NOT NULL,
  representative_content text NOT NULL,
  message_count bigint NOT NULL DEFAULT 0,
  PRIMARY KEY (room_id, local_date, content_hash)
);

CREATE INDEX IF NOT EXISTS danmu_daily_content_rank_idx
  ON danmu_daily_content_counts (room_id, local_date, message_count DESC);

CREATE TABLE IF NOT EXISTS danmu_daily_top_messages (
  room_id uuid NOT NULL REFERENCES rooms(id),
  local_date date NOT NULL,
  rank integer NOT NULL,
  content_hash char(64) NOT NULL,
  content_normalized text NOT NULL,
  representative_content text NOT NULL,
  message_count bigint NOT NULL,
  share double precision NOT NULL,
  PRIMARY KEY (room_id, local_date, rank)
);

CREATE TABLE IF NOT EXISTS collector_incidents (
  id uuid PRIMARY KEY,
  room_id uuid NOT NULL REFERENCES rooms(id),
  session_id uuid REFERENCES live_sessions(id),
  started_at timestamptz NOT NULL,
  ended_at timestamptz,
  type text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE INDEX IF NOT EXISTS collector_incidents_room_started_idx
  ON collector_incidents (room_id, started_at DESC);

CREATE TABLE IF NOT EXISTS storage_snapshots (
  id bigserial PRIMARY KEY,
  target text NOT NULL,
  sampled_at timestamptz NOT NULL DEFAULT now(),
  total_bytes bigint,
  used_bytes bigint,
  available_bytes bigint,
  category_sizes jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL,
  error text
);

CREATE INDEX IF NOT EXISTS storage_snapshots_target_sampled_idx
  ON storage_snapshots (target, sampled_at DESC);

CREATE TABLE IF NOT EXISTS archive_runs (
  id uuid PRIMARY KEY,
  started_at timestamptz NOT NULL,
  finished_at timestamptz,
  range_start timestamptz NOT NULL,
  range_end timestamptz NOT NULL,
  path text,
  bytes_written bigint,
  row_count bigint,
  checksum char(64),
  backup_status text NOT NULL DEFAULT 'pending',
  status text NOT NULL,
  error text
);
