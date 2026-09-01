const fs = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const { Transform } = require('node:stream')
const { Pool } = require('pg')
const QueryStream = require('pg-query-stream')
const { normalizeContent, sha256 } = require('../utils')

class Database {
  constructor({ connectionString, ssl = false, logger = console }) {
    this.pool = new Pool({
      connectionString,
      ssl: ssl ? { rejectUnauthorized: false } : false,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000
    })
    this.logger = logger
    this.ready = false
    this.partitionCache = new Set()
    this.pool.on('error', error => this.logger.error?.({ error }, 'PostgreSQL 连接池异常'))
  }

  query(text, params) {
    return this.pool.query(text, params)
  }

  async migrate() {
    const migrationPath = path.resolve(__dirname, '../../migrations/001_init.sql')
    const sql = await fs.readFile(migrationPath, 'utf8')
    await this.pool.query(sql)
    await this.pool.query(
      `INSERT INTO schema_migrations(version) VALUES ('001_init') ON CONFLICT DO NOTHING`
    )
    this.ready = true
  }

  async close() {
    this.ready = false
    await this.pool.end()
  }

  async ensureMessagePartition(dateValue, client = this.pool) {
    const date = new Date(dateValue)
    const year = date.getUTCFullYear()
    const month = date.getUTCMonth()
    const key = `${year}_${String(month + 1).padStart(2, '0')}`
    if (this.partitionCache.has(key)) return
    const start = new Date(Date.UTC(year, month, 1)).toISOString()
    const end = new Date(Date.UTC(year, month + 1, 1)).toISOString()
    const table = `danmu_messages_${key}`
    await client.query(
      `CREATE TABLE IF NOT EXISTS ${table} PARTITION OF danmu_messages
       FOR VALUES FROM ('${start}') TO ('${end}')`
    )
    await client.query(`CREATE INDEX IF NOT EXISTS ${table}_room_time_idx ON ${table} (room_id, occurred_at DESC)`)
    await client.query(`CREATE INDEX IF NOT EXISTS ${table}_sender_time_idx ON ${table} (room_id, sender_uid, occurred_at DESC)`)
    this.partitionCache.add(key)
  }

  async listRooms() {
    const { rows } = await this.query(`SELECT * FROM rooms WHERE deleted_at IS NULL ORDER BY created_at`)
    return rows
  }

  async getRoom(id) {
    const { rows } = await this.query(`SELECT * FROM rooms WHERE id = $1 AND deleted_at IS NULL`, [id])
    return rows[0] || null
  }

  async getRoomByExternalId(externalRoomId) {
    const { rows } = await this.query(
      `SELECT * FROM rooms WHERE external_room_id = $1 AND deleted_at IS NULL`,
      [String(externalRoomId)]
    )
    return rows[0] || null
  }

  async createRoom({ externalRoomId, anchorUid = null, anchorName = null, metadata = {} }) {
    const id = crypto.randomUUID()
    const { rows } = await this.query(
      `INSERT INTO rooms(id, external_room_id, anchor_uid, anchor_name, metadata)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [id, String(externalRoomId), anchorUid, anchorName, metadata]
    )
    return rows[0]
  }

  async updateRoom(id, patch) {
    const allowed = {
      anchor_uid: patch.anchorUid,
      anchor_name: patch.anchorName,
      enabled: patch.enabled,
      metadata: patch.metadata
    }
    const entries = Object.entries(allowed).filter(([, value]) => value !== undefined)
    if (!entries.length) return this.getRoom(id)
    const values = entries.map(([, value]) => value)
    const sets = entries.map(([key], index) => `${key} = $${index + 2}`)
    const { rows } = await this.query(
      `UPDATE rooms SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 AND deleted_at IS NULL RETURNING *`,
      [id, ...values]
    )
    return rows[0] || null
  }

  async softDeleteRoom(id) {
    const { rowCount } = await this.query(
      `UPDATE rooms SET enabled = false, runtime_status = 'disabled', deleted_at = now(), updated_at = now()
       WHERE id = $1 AND deleted_at IS NULL`,
      [id]
    )
    return rowCount > 0
  }

  async setRoomStatus(roomId, status, { reason = null, source = null, details = {}, error = undefined } = {}) {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      const current = await client.query(`SELECT runtime_status FROM rooms WHERE id = $1 FOR UPDATE`, [roomId])
      if (!current.rows[0]) throw new Error('房间不存在')
      const from = current.rows[0].runtime_status
      await client.query(
        `UPDATE rooms SET runtime_status = $2,
         last_error = CASE WHEN $4::boolean THEN $3::jsonb ELSE last_error END,
         updated_at = now() WHERE id = $1`,
        [roomId, status, error === undefined ? null : error, error !== undefined]
      )
      if (from !== status || reason) {
        await client.query(
          `INSERT INTO room_status_history(room_id, from_status, to_status, reason, source, details)
           VALUES ($1, $2, $3, $4, $5, $6)`,
          [roomId, from, status, reason, source, details]
        )
      }
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async recordStatusCheck(roomId, result) {
    await this.query(
      `UPDATE rooms SET anchor_uid = COALESCE($2, anchor_uid), anchor_name = COALESCE($3, anchor_name),
       last_checked_at = $4, metadata = metadata || $5::jsonb, last_error = NULL, updated_at = now()
       WHERE id = $1`,
      [roomId, result.anchorUid, result.anchorName, result.checkedAt, result.metadata || {}]
    )
  }

  async getActiveSession(roomId) {
    const { rows } = await this.query(
      `SELECT * FROM live_sessions WHERE room_id = $1 AND status = 'active' ORDER BY detected_started_at DESC LIMIT 1`,
      [roomId]
    )
    return rows[0] || null
  }

  async startSession(roomId, metadata = {}) {
    const active = await this.getActiveSession(roomId)
    if (active) return active
    const { rows } = await this.query(
      `INSERT INTO live_sessions(id, room_id, detected_started_at, status, metadata)
       VALUES ($1, $2, now(), 'active', $3) RETURNING *`,
      [crypto.randomUUID(), roomId, metadata]
    )
    return rows[0]
  }

  async endSession(roomId, status = 'completed') {
    const { rows } = await this.query(
      `UPDATE live_sessions SET status = $2, detected_ended_at = now(), updated_at = now()
       WHERE room_id = $1 AND status = 'active' RETURNING *`,
      [roomId, status]
    )
    return rows[0] || null
  }

  async listSessions(roomId, limit = 50) {
    const { rows } = await this.query(
      `SELECT * FROM live_sessions WHERE room_id = $1 ORDER BY detected_started_at DESC LIMIT $2`,
      [roomId, limit]
    )
    return rows
  }

  async insertEventBatch(events) {
    if (!events.length) return
    const months = new Map()
    for (const event of events) {
      if (event.type !== 'chat') continue
      const date = new Date(event.occurredAt)
      months.set(`${date.getUTCFullYear()}-${date.getUTCMonth()}`, date)
    }
    for (const date of months.values()) await this.ensureMessagePartition(date)

    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      for (const event of events) {
        if (event.type === 'chat') await this.#insertChat(client, event)
        else await this.#insertStreamEvent(client, event)
      }
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async #insertChat(client, event) {
    const normalized = normalizeContent(event.content)
    const hash = sha256(normalized)
    const inserted = await client.query(
      `INSERT INTO danmu_messages(
         ingest_id, room_id, session_id, source_event_id, occurred_at, received_at, time_source,
         sender_uid, sender_name, content, content_normalized, content_hash, raw_payload
       ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (ingest_id, occurred_at) DO NOTHING RETURNING ingest_id`,
      [event.ingestId, event.roomId, event.sessionId, event.sourceEventId, event.occurredAt,
        event.receivedAt, event.timeSource, event.senderUid, event.senderName, event.content,
        normalized, hash, event.rawPayload || null]
    )
    if (!inserted.rowCount) return

    await client.query(
      `INSERT INTO danmu_minute_stats(room_id, bucket_at, message_count)
       VALUES ($1, date_trunc('minute', $2::timestamptz), 1)
       ON CONFLICT (room_id, bucket_at) DO UPDATE
       SET message_count = danmu_minute_stats.message_count + 1`,
      [event.roomId, event.occurredAt]
    )
    await client.query(
      `INSERT INTO danmu_daily_stats(room_id, local_date, message_count)
       VALUES ($1, ($2::timestamptz AT TIME ZONE 'Asia/Shanghai')::date, 1)
       ON CONFLICT (room_id, local_date) DO UPDATE
       SET message_count = danmu_daily_stats.message_count + 1`,
      [event.roomId, event.occurredAt]
    )
    if (normalized) {
      await client.query(
        `INSERT INTO danmu_daily_content_counts(
           room_id, local_date, content_hash, content_normalized, representative_content, message_count
         ) VALUES ($1, ($2::timestamptz AT TIME ZONE 'Asia/Shanghai')::date, $3, $4, $5, 1)
         ON CONFLICT (room_id, local_date, content_hash) DO UPDATE
         SET message_count = danmu_daily_content_counts.message_count + 1`,
        [event.roomId, event.occurredAt, hash, normalized, event.content]
      )
    }
    await client.query(`UPDATE rooms SET last_message_at = $2, updated_at = now() WHERE id = $1`, [event.roomId, event.receivedAt])
  }

  async #insertStreamEvent(client, event) {
    await client.query(
      `INSERT INTO stream_events(ingest_id, room_id, session_id, event_type, occurred_at, received_at, payload)
       VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
      [event.ingestId, event.roomId, event.sessionId, event.type, event.occurredAt, event.receivedAt, event.rawPayload]
    )
  }

  async listMessages({ roomId, from, to, senderUid, keyword, cursorAt, cursorId, limit }) {
    const values = [roomId]
    const where = ['room_id = $1']
    const add = (sql, value) => {
      values.push(value)
      where.push(sql.replace('?', `$${values.length}`))
    }
    if (from) add('occurred_at >= ?', from)
    if (to) add('occurred_at < ?', to)
    if (senderUid) add('sender_uid = ?', senderUid)
    if (keyword) add(`content ILIKE '%' || ? || '%'`, keyword)
    if (cursorAt && cursorId) {
      values.push(cursorAt, cursorId)
      where.push(`(occurred_at, ingest_id) < ($${values.length - 1}, $${values.length})`)
    }
    values.push(limit)
    const { rows } = await this.query(
      `SELECT ingest_id, room_id, session_id, occurred_at, received_at, sender_uid, sender_name, content
       FROM danmu_messages WHERE ${where.join(' AND ')}
       ORDER BY occurred_at DESC, ingest_id DESC LIMIT $${values.length}`,
      values
    )
    return rows
  }

  async messageCsvStream({ roomId, from, to, senderUid, keyword }) {
    const values = [roomId]
    const where = ['room_id = $1']
    const add = (sql, value) => {
      values.push(value)
      where.push(sql.replace('?', `$${values.length}`))
    }
    if (from) add('occurred_at >= ?', from)
    if (to) add('occurred_at < ?', to)
    if (senderUid) add('sender_uid = ?', senderUid)
    if (keyword) add(`content ILIKE '%' || ? || '%'`, keyword)
    const client = await this.pool.connect()
    const query = new QueryStream(
      `SELECT occurred_at, received_at, sender_uid, sender_name, content
       FROM danmu_messages WHERE ${where.join(' AND ')} ORDER BY occurred_at, ingest_id`,
      values,
      { batchSize: 1000 }
    )
    const source = client.query(query)
    let header = true
    const csv = new Transform({
      writableObjectMode: true,
      transform(row, _encoding, callback) {
        const escape = value => `"${String(value ?? '').replaceAll('"', '""')}"`
        const line = [row.occurred_at.toISOString(), row.received_at.toISOString(), row.sender_uid,
          row.sender_name, row.content].map(escape).join(',')
        const prefix = header ? '\uFEFF"occurred_at","received_at","sender_uid","sender_name","content"\n' : ''
        header = false
        callback(null, `${prefix}${line}\n`)
      },
      flush(callback) {
        if (header) this.push('\uFEFF"occurred_at","received_at","sender_uid","sender_name","content"\n')
        callback()
      }
    })
    let released = false
    const release = () => {
      if (released) return
      released = true
      client.release()
    }
    source.once('end', release)
    source.once('error', release)
    source.once('close', release)
    csv.once('close', () => {
      if (!source.destroyed) source.destroy()
      release()
    })
    return source.pipe(csv)
  }

  async messageCounts({ roomId, from, to, interval }) {
    const allowed = { '1m': '1 minute', '5m': '5 minutes', '15m': '15 minutes', '1h': '1 hour' }
    const step = allowed[interval]
    if (!step) throw Object.assign(new Error('interval 只支持 1m、5m、15m、1h'), { statusCode: 400 })
    const { rows } = await this.query(
      `WITH buckets AS (
         SELECT generate_series($2::timestamptz, $3::timestamptz - $4::interval, $4::interval) AS bucket_at
       ), counts AS (
         SELECT date_bin($4::interval, bucket_at, '1970-01-01'::timestamptz) AS bucket_at,
                sum(message_count)::bigint AS message_count
         FROM danmu_minute_stats
         WHERE room_id = $1 AND bucket_at >= $2 AND bucket_at < $3
         GROUP BY 1
       )
       SELECT b.bucket_at, COALESCE(c.message_count, 0)::bigint AS message_count
       FROM buckets b LEFT JOIN counts c USING (bucket_at) ORDER BY b.bucket_at`,
      [roomId, from, to, step]
    )
    return rows
  }

  async topMessages({ roomId, date, limit = 10 }) {
    const { rows } = await this.query(
      `WITH ranked AS (
         SELECT c.content_normalized, c.representative_content, c.message_count,
                d.message_count AS total,
                row_number() OVER (ORDER BY c.message_count DESC, c.content_normalized ASC) AS rank
         FROM danmu_daily_content_counts c
         JOIN danmu_daily_stats d USING (room_id, local_date)
         WHERE c.room_id = $1 AND c.local_date = $2
       )
       SELECT rank, representative_content AS content, message_count,
              CASE WHEN total = 0 THEN 0 ELSE message_count::float8 / total END AS share
       FROM ranked WHERE rank <= $3 ORDER BY rank`,
      [roomId, date, limit]
    )
    if (rows.length) return rows
    const historical = await this.query(
      `SELECT rank, representative_content AS content, message_count, share
       FROM danmu_daily_top_messages WHERE room_id = $1 AND local_date = $2 AND rank <= $3 ORDER BY rank`,
      [roomId, date, limit]
    )
    return historical.rows
  }

  async realtimeTopMessages({ roomId, windows, at, limit = 10 }) {
    const durationSeconds = { '1m': 60, '5m': 300, '10m': 600 }
    const durations = windows.map(window => durationSeconds[window])
    const maxDuration = Math.max(...durations)
    const { rows } = await this.query(
      `WITH window_defs AS (
         SELECT requested.window, requested.duration_seconds, requested.ordinal,
                $4::timestamptz - make_interval(secs => requested.duration_seconds) AS from_at
         FROM unnest($2::text[], $3::integer[]) WITH ORDINALITY
              AS requested(window, duration_seconds, ordinal)
       ), candidate_messages AS MATERIALIZED (
         SELECT ingest_id, occurred_at, content_normalized
         FROM danmu_messages
         WHERE room_id = $1
           AND occurred_at >= $4::timestamptz - make_interval(secs => $5)
           AND occurred_at < $4::timestamptz
       ), window_totals AS (
         SELECT w.window, w.ordinal, w.from_at, count(m.ingest_id)::bigint AS total_messages
         FROM window_defs w
         LEFT JOIN candidate_messages m ON m.occurred_at >= w.from_at
         GROUP BY w.window, w.ordinal, w.from_at
       ), content_counts AS (
         SELECT w.window, m.content_normalized AS content, count(*)::bigint AS message_count
         FROM window_defs w
         JOIN candidate_messages m ON m.occurred_at >= w.from_at
         WHERE m.content_normalized <> ''
         GROUP BY w.window, m.content_normalized
       ), ranked AS (
         SELECT window, content, message_count,
                row_number() OVER (
                  PARTITION BY window ORDER BY message_count DESC, content ASC
                ) AS rank
         FROM content_counts
       )
       SELECT t.window, t.from_at, $4::timestamptz AS to_at, t.total_messages,
              CASE WHEN EXISTS (
                SELECT 1 FROM collector_incidents i
                WHERE i.room_id = $1 AND i.started_at < $4::timestamptz
                  AND COALESCE(i.ended_at, $4::timestamptz) > t.from_at
              ) THEN false ELSE NULL END AS data_complete,
              r.rank, r.content, r.message_count,
              CASE WHEN t.total_messages = 0 THEN 0
                   ELSE r.message_count::float8 / t.total_messages END AS share
       FROM window_totals t
       LEFT JOIN ranked r ON r.window = t.window AND r.rank <= $6
       ORDER BY t.ordinal, r.rank NULLS LAST`,
      [roomId, windows, durations, at, maxDuration, limit]
    )

    const result = new Map(windows.map(window => [window, null]))
    for (const row of rows) {
      let item = result.get(row.window)
      if (!item) {
        item = {
          window: row.window,
          from: row.from_at.toISOString(),
          to: row.to_at.toISOString(),
          total_messages: String(row.total_messages),
          data_complete: row.data_complete,
          items: []
        }
        result.set(row.window, item)
      }
      if (row.rank !== null) {
        item.items.push({
          rank: String(row.rank),
          content: row.content,
          message_count: String(row.message_count),
          share: Number(row.share)
        })
      }
    }
    return windows.map(window => result.get(window))
  }

  async finalizeDailyTop(date) {
    const client = await this.pool.connect()
    try {
      await client.query('BEGIN')
      await client.query(`DELETE FROM danmu_daily_top_messages WHERE local_date = $1`, [date])
      await client.query(
        `WITH ranked AS (
           SELECT room_id, local_date, c.content_hash, c.content_normalized,
                  c.representative_content, c.message_count AS message_count,
                  row_number() OVER (
                  PARTITION BY room_id, local_date ORDER BY c.message_count DESC, c.content_normalized ASC
                  ) AS rank,
                  d.message_count AS total
           FROM danmu_daily_content_counts c
           JOIN danmu_daily_stats d USING (room_id, local_date)
           WHERE c.local_date = $1
         )
         INSERT INTO danmu_daily_top_messages(
           room_id, local_date, rank, content_hash, content_normalized, representative_content, message_count, share
         )
         SELECT room_id, local_date, rank,
                content_hash, content_normalized, representative_content, message_count,
                message_count::float8 / total
         FROM ranked WHERE rank <= 100`,
        [date]
      )
      await client.query('COMMIT')
    } catch (error) {
      await client.query('ROLLBACK')
      throw error
    } finally {
      client.release()
    }
  }

  async pendingDailyTopDates() {
    const { rows } = await this.query(
      `SELECT DISTINCT local_date
       FROM danmu_daily_content_counts
       WHERE local_date < (now() AT TIME ZONE 'Asia/Shanghai')::date
       ORDER BY local_date`
    )
    return rows.map(row => row.local_date instanceof Date ? row.local_date.toISOString().slice(0, 10) : String(row.local_date))
  }

  async saveStorageSnapshot(snapshot) {
    await this.query(
      `INSERT INTO storage_snapshots(target, total_bytes, used_bytes, available_bytes, category_sizes, status, error)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [snapshot.target, snapshot.totalBytes, snapshot.usedBytes, snapshot.availableBytes,
        snapshot.categorySizes || {}, snapshot.status, snapshot.error || null]
    )
  }

  async storageHistory(hours = 720) {
    const { rows } = await this.query(
      `SELECT * FROM storage_snapshots WHERE sampled_at >= now() - ($1::text || ' hours')::interval
       ORDER BY target, sampled_at`,
      [hours]
    )
    return rows
  }

  async databaseSizes() {
    const { rows } = await this.query(
      `SELECT pg_database_size(current_database())::bigint AS database_bytes,
              COALESCE((SELECT sum(pg_total_relation_size(format('%I.%I', schemaname, tablename)::regclass))
                FROM pg_tables WHERE schemaname = 'public' AND tablename LIKE 'danmu_messages%'), 0)::bigint AS messages_bytes,
              COALESCE((SELECT sum(pg_indexes_size(format('%I.%I', schemaname, tablename)::regclass))
                FROM pg_tables WHERE schemaname = 'public'), 0)::bigint AS indexes_bytes`
    )
    try {
      const system = await this.query(
        `SELECT COALESCE((SELECT sum(size) FROM pg_ls_waldir()), 0)::bigint AS wal_bytes,
                COALESCE((SELECT sum(size) FROM pg_ls_tmpdir()), 0)::bigint AS temporary_bytes`
      )
      return { ...rows[0], ...system.rows[0] }
    } catch {
      return rows[0]
    }
  }

  async listMessagePartitionsBefore(cutoff) {
    const { rows } = await this.query(
      `SELECT child.relname AS table_name
       FROM pg_inherits
       JOIN pg_class parent ON pg_inherits.inhparent = parent.oid
       JOIN pg_class child ON pg_inherits.inhrelid = child.oid
       WHERE parent.relname = 'danmu_messages' AND child.relname ~ '^danmu_messages_[0-9]{4}_[0-9]{2}$'
       ORDER BY child.relname`
    )
    return rows.filter(row => {
      const match = row.table_name.match(/(\d{4})_(\d{2})$/)
      const end = new Date(Date.UTC(Number(match[1]), Number(match[2]), 1))
      return end <= new Date(cutoff)
    })
  }

  async dropMessagePartition(tableName) {
    if (!/^danmu_messages_\d{4}_\d{2}$/.test(tableName)) throw new Error('非法分区名称')
    await this.query(`DROP TABLE ${tableName}`)
    this.partitionCache.delete(tableName.slice('danmu_messages_'.length))
  }

  async createArchiveRun({ rangeStart, rangeEnd }) {
    const id = crypto.randomUUID()
    await this.query(
      `INSERT INTO archive_runs(id, started_at, range_start, range_end, status)
       VALUES ($1, now(), $2, $3, 'running')`,
      [id, rangeStart, rangeEnd]
    )
    return id
  }

  async getCompletedArchive(rangeStart, rangeEnd) {
    const { rows } = await this.query(
      `SELECT * FROM archive_runs
       WHERE range_start = $1 AND range_end = $2 AND status = 'completed'
       ORDER BY finished_at DESC LIMIT 1`,
      [rangeStart, rangeEnd]
    )
    return rows[0] || null
  }

  async markArchiveBackedUp(id) {
    await this.query(`UPDATE archive_runs SET backup_status = 'verified' WHERE id = $1`, [id])
  }

  async finishArchiveRun(id, patch) {
    await this.query(
      `UPDATE archive_runs SET finished_at = now(), path = $2, bytes_written = $3, row_count = $4,
       checksum = $5, backup_status = $6, status = $7, error = $8 WHERE id = $1`,
      [id, patch.path, patch.bytesWritten, patch.rowCount, patch.checksum,
        patch.backupStatus || 'pending', patch.status, patch.error || null]
    )
  }

  async listArchiveRuns(limit = 50) {
    const { rows } = await this.query(`SELECT * FROM archive_runs ORDER BY started_at DESC LIMIT $1`, [limit])
    return rows
  }

  async runMaintenance(rawPayloadRetentionDays = 30) {
    const clearedPayloads = await this.query(
      `UPDATE danmu_messages SET raw_payload = NULL
       WHERE raw_payload IS NOT NULL AND occurred_at < now() - ($1::text || ' days')::interval`,
      [rawPayloadRetentionDays]
    )
    const clearedWorkingCounts = await this.query(
      `DELETE FROM danmu_daily_content_counts WHERE local_date <
       (now() AT TIME ZONE 'Asia/Shanghai')::date - 7`
    )
    return { clearedPayloads: clearedPayloads.rowCount, clearedWorkingCounts: clearedWorkingCounts.rowCount }
  }
}

module.exports = { Database }
