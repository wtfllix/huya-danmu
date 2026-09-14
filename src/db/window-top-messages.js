const WINDOW_TOP_SQL = `WITH content_counts AS MATERIALIZED (
  SELECT date_bin(interval '10 minutes', occurred_at, $2::timestamptz) AS from_at,
         content_normalized AS content, count(*)::bigint AS message_count
  FROM danmu_messages
  WHERE room_id = $1 AND occurred_at >= $2::timestamptz AND occurred_at < $3::timestamptz
  GROUP BY 1, 2
), totals AS (
  SELECT from_at, sum(message_count)::bigint AS total_messages FROM content_counts GROUP BY from_at
), ranked AS (
  SELECT from_at, content, message_count,
         row_number() OVER (PARTITION BY from_at ORDER BY message_count DESC, content ASC) AS rank
  FROM content_counts WHERE content <> ''
), windows AS (
  SELECT from_at, from_at + interval '10 minutes' AS to_at
  FROM generate_series($2::timestamptz, $3::timestamptz - interval '10 minutes', interval '10 minutes') AS from_at
), completeness AS MATERIALIZED (
  SELECT w.*,
    EXISTS (SELECT 1 FROM collector_incidents i WHERE i.room_id = $1
      AND i.started_at < w.to_at AND COALESCE(i.ended_at, $3::timestamptz) > w.from_at) AS has_gap,
    EXISTS (SELECT 1 FROM archive_runs a WHERE a.status = 'completed' AND a.backup_status = 'verified'
      AND a.range_start < w.to_at AND a.range_end > w.from_at) AS archived
  FROM windows w
)
SELECT w.from_at, w.to_at, w.has_gap, w.archived, COALESCE(t.total_messages, 0)::bigint AS total_messages,
       r.rank, r.content, r.message_count,
       r.message_count::float8 / NULLIF(t.total_messages, 0) AS share
FROM completeness w
LEFT JOIN totals t USING (from_at)
LEFT JOIN ranked r ON r.from_at = w.from_at AND r.rank <= $4
ORDER BY w.from_at, r.rank NULLS LAST`

async function windowTopMessages(database, { roomId, date, timezone, at, limit }) {
  const client = await database.pool.connect()
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY')
    await client.query("SET LOCAL statement_timeout = '15s'")
    await client.query("SET LOCAL work_mem = '16MB'")
    const bounds = await client.query(`SELECT $1::date::timestamp AT TIME ZONE $2 AS from_at,
      ($1::date + 1)::timestamp AT TIME ZONE $2 AS to_at`, [date, timezone])
    const { from_at: from, to_at: dayEnd } = bounds.rows[0]
    // Bound work to 24 elapsed hours, including on DST transition dates.
    if (dayEnd - from <= 0 || dayEnd - from > 86400000) {
      throw Object.assign(new Error('Local day must span 1..24 hours'), { statusCode: 400, code: 'INVALID_PARAMETER' })
    }
    const end = new Date(from.getTime() + Math.max(0, Math.floor((Math.min(dayEnd, at) - from) / 600000)) * 600000)
    const { rows } = await client.query(WINDOW_TOP_SQL, [roomId, from, end, limit])
    await client.query('COMMIT')
    const windows = new Map()
    for (const row of rows) {
      const key = row.from_at.toISOString()
      if (!windows.has(key)) {
        windows.set(key, { from: key, to: row.to_at.toISOString(),
          data_complete: row.has_gap || row.archived ? false : null,
          status: row.archived ? 'raw_data_unavailable' : row.has_gap ? 'collection_gap' :
            String(row.total_messages) === '0' ? 'no_messages_observed' : 'data_available',
          total_messages: row.archived ? null : String(row.total_messages), items: [] })
      }
      if (row.rank !== null && !row.archived) windows.get(key).items.push({ rank: String(row.rank),
        content: row.content, message_count: String(row.message_count), share: Number(row.share) })
    }
    return [...windows.values()]
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {})
    throw error
  } finally {
    client.release()
  }
}

module.exports = { WINDOW_TOP_SQL, windowTopMessages }
