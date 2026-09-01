const path = require('node:path')
const Fastify = require('fastify')
const fastifyStatic = require('@fastify/static')
const { clampLimit, parseDate } = require('./utils')

function buildApp({ config, database, detector, supervisor, spool, storage, archives, loggerOptions } = {}) {
  const app = Fastify({ logger: loggerOptions || { level: config.logLevel } })

  app.register(fastifyStatic, {
    root: path.resolve(__dirname, '../public'),
    prefix: '/'
  })

  app.addHook('onRequest', async request => {
    if (!request.url.startsWith('/api/')) return
    if (!config.apiToken) return
    const token = request.headers.authorization?.replace(/^Bearer\s+/i, '')
    if (token !== config.apiToken) throw Object.assign(new Error('未授权'), { statusCode: 401 })
  })

  app.setErrorHandler((error, request, reply) => {
    const statusCode = error.statusCode || (error.code === '23505' ? 409 : 500)
    if (statusCode >= 500) request.log.error({ err: error }, '请求处理失败')
    reply.code(statusCode).send({ error: error.message, code: error.code || 'REQUEST_FAILED' })
  })

  app.get('/health/live', async () => ({ status: 'ok' }))
  app.get('/health/ready', async (_request, reply) => {
    if (!database.ready) return reply.code(503).send({ status: 'not_ready' })
    return { status: 'ready', spoolDepth: spool.depth }
  })

  app.get('/metrics', async (_request, reply) => {
    const rooms = await database.listRooms()
    const lines = [
      '# HELP huya_spool_depth Number of events waiting for PostgreSQL',
      '# TYPE huya_spool_depth gauge',
      `huya_spool_depth ${spool.depth}`,
      '# HELP huya_spool_processed_total Events persisted from the durable spool',
      '# TYPE huya_spool_processed_total counter',
      `huya_spool_processed_total ${spool.metrics?.processed || 0}`,
      '# HELP huya_spool_failures_total PostgreSQL batch failures',
      '# TYPE huya_spool_failures_total counter',
      `huya_spool_failures_total ${spool.metrics?.failures || 0}`,
      '# HELP huya_rooms Number of rooms by runtime status',
      '# TYPE huya_rooms gauge'
    ]
    const statuses = new Map()
    for (const room of rooms) statuses.set(room.runtime_status, (statuses.get(room.runtime_status) || 0) + 1)
    for (const [status, count] of statuses) lines.push(`huya_rooms{status="${status}"} ${count}`)
    lines.push('# HELP huya_collector_messages_total Huya events received by type', '# TYPE huya_collector_messages_total counter')
    for (const type of ['chat', 'gift', 'online']) lines.push(`huya_collector_messages_total{type="${type}"} ${supervisor.metrics?.[type] || 0}`)
    lines.push('# HELP huya_collector_errors_total Collector errors', '# TYPE huya_collector_errors_total counter')
    lines.push(`huya_collector_errors_total{type="connection"} ${supervisor.metrics?.errors || 0}`)
    lines.push(`huya_collector_errors_total{type="parse"} ${supervisor.metrics?.parseErrors || 0}`)
    lines.push(`huya_collector_errors_total{type="status_check"} ${supervisor.metrics?.statusCheckErrors || 0}`)
    lines.push('# HELP huya_collector_reconnects_total Collector disconnects followed by reconnect attempts', '# TYPE huya_collector_reconnects_total counter')
    lines.push(`huya_collector_reconnects_total ${supervisor.metrics?.reconnects || 0}`)
    lines.push('# HELP huya_storage_used_percent Filesystem used percent', '# TYPE huya_storage_used_percent gauge')
    for (const item of storage.latest) {
      if (Number.isFinite(item.percent)) lines.push(`huya_storage_used_percent{target="${item.target}"} ${item.percent}`)
    }
    reply.type('text/plain; version=0.0.4').send(`${lines.join('\n')}\n`)
  })

  app.get('/api/v1/rooms', async () => {
    const rooms = await database.listRooms()
    return rooms.map(room => ({
      ...room,
      is_default: Boolean(config.initialRoomId) && room.external_room_id === String(config.initialRoomId)
    }))
  })

  app.post('/api/v1/rooms', async (request, reply) => {
    const externalRoomId = String(request.body?.roomId || '').trim()
    if (!externalRoomId) throw Object.assign(new Error('roomId 不能为空'), { statusCode: 400 })
    if (await database.getRoomByExternalId(externalRoomId)) {
      throw Object.assign(new Error('该房间已经存在'), { statusCode: 409 })
    }
    const detected = await detector.detect(externalRoomId)
    const room = await database.createRoom({
      externalRoomId,
      anchorUid: detected.anchorUid,
      anchorName: detected.anchorName,
      metadata: detected.metadata
    })
    await supervisor.checkRoom(room)
    reply.code(201).send(await database.getRoom(room.id))
  })

  app.get('/api/v1/rooms/:id', async request => {
    const room = await database.getRoom(request.params.id)
    if (!room) throw Object.assign(new Error('房间不存在'), { statusCode: 404 })
    return room
  })

  app.patch('/api/v1/rooms/:id', async request => {
    const patch = {}
    if (typeof request.body?.enabled === 'boolean') patch.enabled = request.body.enabled
    const room = await database.updateRoom(request.params.id, patch)
    if (!room) throw Object.assign(new Error('房间不存在'), { statusCode: 404 })
    await supervisor.tick()
    return database.getRoom(room.id)
  })

  app.delete('/api/v1/rooms/:id', async (request, reply) => {
    const room = await database.getRoom(request.params.id)
    if (!room) throw Object.assign(new Error('房间不存在'), { statusCode: 404 })
    await supervisor.stopCollector(room, 'disabled')
    await database.softDeleteRoom(room.id)
    reply.code(204).send()
  })

  app.get('/api/v1/rooms/:id/sessions', async request => {
    return database.listSessions(request.params.id, clampLimit(request.query.limit, 50, 200))
  })

  app.get('/api/v1/rooms/:id/messages', async request => {
    const query = request.query
    return database.listMessages({
      roomId: request.params.id,
      from: query.from ? parseDate(query.from, 'from') : null,
      to: query.to ? parseDate(query.to, 'to') : null,
      senderUid: query.sender_uid || null,
      keyword: query.keyword || null,
      cursorAt: query.cursor_at ? parseDate(query.cursor_at, 'cursor_at') : null,
      cursorId: query.cursor_id || null,
      limit: clampLimit(query.limit, 100, 500)
    })
  })

  app.get('/api/v1/rooms/:id/messages.csv', async (request, reply) => {
    const query = request.query
    const stream = await database.messageCsvStream({
      roomId: request.params.id,
      from: query.from ? parseDate(query.from, 'from') : null,
      to: query.to ? parseDate(query.to, 'to') : null,
      senderUid: query.sender_uid || null,
      keyword: query.keyword || null
    })
    const name = `huya-danmu-${new Date().toISOString().slice(0, 10)}.csv`
    return reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="${name}"`)
      .send(stream)
  })

  app.get('/api/v1/analytics/message-counts', async request => {
    const { room_id: roomId, from, to, interval = '15m' } = request.query
    if (!roomId) throw Object.assign(new Error('room_id 不能为空'), { statusCode: 400 })
    const fromDate = parseDate(from, 'from')
    const toDate = parseDate(to, 'to')
    if (toDate <= fromDate) throw Object.assign(new Error('to 必须晚于 from'), { statusCode: 400 })
    const maxDays = { '1m': 31, '5m': 90, '15m': 366, '1h': 366 }[interval]
    if (!maxDays) throw Object.assign(new Error('interval 只支持 1m、5m、15m、1h'), { statusCode: 400 })
    if (toDate - fromDate > maxDays * 86400000) {
      throw Object.assign(new Error(`${interval} 粒度单次查询最多 ${maxDays} 天`), { statusCode: 400 })
    }
    return database.messageCounts({ roomId, from: fromDate, to: toDate, interval })
  })

  app.get('/api/v1/analytics/top-messages', async request => {
    const { room_id: roomId, date } = request.query
    if (!roomId || !/^\d{4}-\d{2}-\d{2}$/.test(date || '')) {
      throw Object.assign(new Error('room_id 和 YYYY-MM-DD 格式的 date 必填'), { statusCode: 400 })
    }
    return database.topMessages({ roomId, date, limit: clampLimit(request.query.limit, 10, 100) })
  })

  app.post('/api/v1/analytics/rebuild', async request => {
    const date = request.body?.date
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) {
      throw Object.assign(new Error('YYYY-MM-DD 格式的 date 必填'), { statusCode: 400 })
    }
    await database.finalizeDailyTop(date)
    return { status: 'completed', date }
  })

  app.get('/api/v1/system/storage', async () => storage.latest.length ? storage.latest : storage.sample())
  app.get('/api/v1/system/storage/history', async request => storage.history(clampLimit(request.query.hours, 168, 2160)))
  app.post('/api/v1/system/storage/sample', async () => storage.sample())
  app.get('/api/v1/system/archives', async request => database.listArchiveRuns(clampLimit(request.query.limit, 50, 200)))
  app.post('/api/v1/system/archives/run', async () => ({ results: await archives.archiveDue(config.hotRetentionMonths) }))

  app.get('/', async (_request, reply) => reply.sendFile('index.html'))
  return app
}

module.exports = { buildApp }
