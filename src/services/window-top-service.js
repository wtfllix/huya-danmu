const { performance } = require('node:perf_hooks')

function windowError(message, code = 'INVALID_PARAMETER', statusCode = 400) {
  return Object.assign(new Error(message), { code, statusCode })
}

function parseWindowQuery(query) {
  const { room_id: roomId, date, window = '10m', timezone = 'Asia/Shanghai', limit = '50' } = query
  if (!roomId) throw windowError('room_id is required')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '') || date.startsWith('0000-') || !Number.isFinite(Date.parse(date)) ||
      new Date(date).toISOString().slice(0, 10) !== date) throw windowError('date must be a valid YYYY-MM-DD')
  if (window !== '10m') throw windowError('window must be 10m')
  if (query.from !== undefined || query.to !== undefined) throw windowError('Use date, not from/to; maximum span is one day')
  if (!/^\d+$/.test(String(limit)) || Number(limit) < 1 || Number(limit) > 50) throw windowError('limit must be 1..50')
  let zone
  try {
    zone = new Intl.DateTimeFormat('en', { timeZone: timezone }).resolvedOptions().timeZone
  } catch {
    throw windowError('timezone must be an IANA timezone')
  }
  if (/^[+-]/.test(zone)) throw windowError('timezone must be an IANA timezone')
  return { roomId, date, timezone: zone, window, limit: Number(limit) }
}

function createWindowTopService(database) {
  let active = 0
  return async (params, log) => {
    const started = performance.now()
    let databaseMs = 0
    let windowCount = 0
    let outcome = 'error'
    if (active >= 2) throw Object.assign(windowError('Batch analytics is busy', 'ANALYTICS_BUSY', 429), { retryAfter: 5 })
    active += 1
    try {
      if (!database.ready) throw windowError('Data source unavailable', 'DATA_SOURCE_UNAVAILABLE', 503)
      const dbStarted = performance.now()
      try {
        if (!await database.getRoom(params.roomId)) throw windowError('Room not found', 'ROOM_NOT_FOUND', 404)
        const at = new Date()
        const windows = await database.windowTopMessages({ ...params, at })
        windowCount = windows.length
        outcome = 'ok'
        return { room_id: params.roomId, date: params.date, timezone: params.timezone,
          window: params.window, as_of: at.toISOString(), generated_at: new Date().toISOString(), windows }
      } finally {
        databaseMs = performance.now() - dbStarted
      }
    } catch (error) {
      if (error.statusCode) throw error
      log.error({ err: error }, 'Window analytics query failed')
      throw windowError('Window analytics query failed', 'ANALYTICS_QUERY_FAILED', 503)
    } finally {
      active -= 1
      log.info({ event: 'window_top_messages', database_ms: databaseMs,
        total_ms: performance.now() - started, window_count: windowCount,
        cache_hit: false, cache_enabled: false, outcome }, 'Window analytics completed')
    }
  }
}

module.exports = { parseWindowQuery, createWindowTopService }
