const test = require('node:test')
const assert = require('node:assert/strict')
const { buildApp } = require('../src/app')
const { RealtimeEventBus } = require('../src/services/realtime-event-bus')

function fixtures(eventBus) {
  let databaseCalls = 0
  return {
    eventBus,
    database: {
      ready: true,
      listRooms: async () => [],
      getRoom: async () => { databaseCalls += 1; return { id: 'room-1' } }
    },
    databaseCalls: () => databaseCalls,
    config: { logLevel: 'silent', apiToken: '' },
    detector: {},
    supervisor: { metrics: {}, checkRoom: async () => {}, tick: async () => {}, stopCollector: async () => {} },
    spool: { depth: 0 },
    storage: { latest: [], sample: async () => [], history: async () => [] },
    archives: { archiveDue: async () => [] }
  }
}

async function openStream(deps, options = {}) {
  const app = buildApp(deps)
  const response = await app.inject({
    url: '/api/v1/rooms/room-1/events',
    payloadAsStream: true,
    ...options
  })
  return { app, response, stream: response.stream() }
}

async function readAvailable(stream) {
  await new Promise(resolve => setImmediate(resolve))
  const chunks = []
  let chunk
  while ((chunk = stream.read()) !== null) chunks.push(Buffer.from(chunk))
  return Buffer.concat(chunks).toString()
}

test('SSE headers, initial snapshot, heartbeat and close cleanup', async () => {
  const bus = new RealtimeEventBus()
  bus.restorePaidSnapshot('room-1', {
    event_type: 'paid_message_snapshot', event_id: 'snapshot-1', items: [{ source_message_id: 'm1' }]
  })
  const originalSetInterval = global.setInterval
  const originalClearInterval = global.clearInterval
  let heartbeatCallback
  global.setInterval = (callback, delay) => {
    assert.equal(delay, 15_000)
    heartbeatCallback = callback
    return { unref() {} }
  }
  global.clearInterval = () => {}
  const deps = fixtures(bus)
  const { app, response, stream } = await openStream(deps)
  try {
    assert.equal(response.statusCode, 200)
    assert.equal(response.headers['content-type'], 'text/event-stream')
    assert.equal(response.headers['cache-control'], 'no-cache, no-transform')
    assert.equal(response.headers.connection, 'keep-alive')
    assert.equal(response.headers['x-accel-buffering'], 'no')
    const initial = await readAvailable(stream)
    assert.match(initial, /event: paid_message_snapshot/)
    const data = JSON.parse(initial.match(/data: (.+)/)[1])
    assert.equal(data.event_type, 'paid_message_snapshot')
    assert.deepEqual(data.items, [{ source_message_id: 'm1' }])
    assert.equal(bus.bufferSize('room-1'), 0)
    heartbeatCallback()
    assert.match(await readAvailable(stream), /: heartbeat/)
    assert.equal(bus.subscriberCount('room-1'), 1)
    response.raw.res.emit('close')
    assert.equal(bus.subscriberCount('room-1'), 0)
  } finally {
    global.setInterval = originalSetInterval
    global.clearInterval = originalClearInterval
    await app.close()
  }
})

test('SSE Last-Event-ID replays the ring and sends reset after a buffer miss', async () => {
  const bus = new RealtimeEventBus({ ringSize: 2 })
  bus.publish('room-1', { event_type: 'chat', event_id: 'e1', content: 'one' })
  bus.publish('room-1', { event_type: 'chat', event_id: 'e2', content: 'two' })
  const replay = await openStream(fixtures(bus), { headers: { 'last-event-id': 'e1' } })
  try {
    const replayBody = await readAvailable(replay.stream)
    assert.match(replayBody, /id: e2/)
    assert.doesNotMatch(replayBody, /id: e1/)
    replay.response.raw.res.emit('close')
  } finally {
    await replay.app.close()
  }

  bus.publish('room-1', { event_type: 'chat', event_id: 'e3', content: 'three' })
  bus.restorePaidSnapshot('room-1', {
    event_type: 'paid_message_snapshot', event_id: 'snapshot-current',
    items: [{ source_message_id: 'current' }]
  })
  const missed = await openStream(fixtures(bus), { headers: { 'last-event-id': 'e1' } })
  try {
    const missedBody = await readAvailable(missed.stream)
    assert.match(missedBody, /event: reset/)
    assert.match(missedBody, /event: paid_message_snapshot/)
    assert.ok(missedBody.indexOf('event: reset') < missedBody.indexOf('event: paid_message_snapshot'))
    assert.match(missedBody, /"event_type":"paid_message_snapshot"/)
    missed.response.raw.res.emit('close')
  } finally {
    await missed.app.close()
  }
})

test('100 SSE clients do not trigger room database queries', async () => {
  const bus = new RealtimeEventBus()
  const deps = fixtures(bus)
  const connections = await Promise.all(Array.from({ length: 100 }, () => openStream(deps)))
  try {
    assert.equal(deps.databaseCalls(), 0)
    assert.equal(bus.subscriberCount('room-1'), 100)
  } finally {
    for (const connection of connections) connection.response.raw.res.emit('close')
    for (const connection of connections) await connection.app.close()
    assert.equal(bus.subscriberCount('room-1'), 0)
  }
})
