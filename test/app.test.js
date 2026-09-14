const test = require('node:test')
const assert = require('node:assert/strict')
const { buildApp } = require('../src/app')

function fixtures() {
  const database = {
    ready: true,
    listRooms: async () => [],
    getRoomByExternalId: async () => null,
    getRoom: async () => null,
    listArchiveRuns: async () => [],
    messageCounts: async () => [],
    topMessages: async () => [],
    realtimeTopMessages: async () => [],
    sessionTopMessages: async () => null
  }
  const config = { logLevel: 'silent', apiToken: '', hotRetentionMonths: 12 }
  return {
    config, database,
    detector: { detect: async () => ({ anchorUid: '1', anchorName: '主播', metadata: {} }) },
    supervisor: { checkRoom: async () => {}, tick: async () => {}, stopCollector: async () => {} },
    spool: { depth: 0 },
    storage: { latest: [], sample: async () => [], history: async () => [] },
    archives: { archiveDue: async () => [] }
  }
}

test('batch windows validates parameters and does not cache repaired data', async t => {
  const deps = fixtures()
  deps.database.getRoom = async () => ({ id: 'room-1' })
  let calls = 0
  deps.database.windowTopMessages = async params => {
    assert.equal(params.limit, 50)
    assert.equal(params.timezone, 'Asia/Shanghai')
    calls += 1
    return [{ total_messages: String(calls), data_complete: null, items: [] }]
  }
  const app = buildApp(deps)
  t.after(() => app.close())
  const base = '/api/v1/analytics/window-top-messages?room_id=room-1&date=2026-09-06'
  assert.equal((await app.inject(base)).json().windows[0].total_messages, '1')
  const repaired = await app.inject(base)
  assert.equal(repaired.json().windows[0].total_messages, '2')
  assert.equal(repaired.headers['cache-control'], 'no-store')
  for (const extra of ['&window=1m', '&limit=51', '&timezone=invalid', '&from=2026-09-01']) {
    assert.equal((await app.inject(base + extra)).statusCode, 400)
  }
})

test('batch errors never become empty successful rankings', async t => {
  const deps = fixtures()
  const app = buildApp(deps)
  t.after(() => app.close())
  const url = '/api/v1/analytics/window-top-messages?room_id=room-1&date=2026-09-06'
  assert.equal((await app.inject(url)).statusCode, 404)
  deps.database.ready = false
  assert.equal((await app.inject(url)).statusCode, 503)
  deps.database.ready = true
  deps.database.getRoom = async () => ({ id: 'room-1' })
  deps.database.windowTopMessages = async () => { throw new Error('query timeout') }
  const failed = await app.inject(url)
  assert.equal(failed.statusCode, 503)
  assert.equal(failed.json().code, 'ANALYTICS_QUERY_FAILED')
  assert.equal(failed.json().windows, undefined)
})

test('per-IP per-route limits are independent and include Retry-After', async t => {
  const deps = fixtures()
  deps.database.getRoom = async () => ({ id: 'room-1' })
  deps.database.windowTopMessages = async () => []
  const app = buildApp(deps)
  t.after(() => app.close())
  const batch = '/api/v1/analytics/window-top-messages?room_id=room-1&date=2026-09-06'
  for (let i = 0; i < 6; i++) assert.equal((await app.inject(batch)).statusCode, 200)
  const blocked = await app.inject(batch)
  assert.equal(blocked.statusCode, 429)
  assert.ok(Number(blocked.headers['retry-after']) >= 1)
  assert.equal((await app.inject({ url: batch, remoteAddress: '192.0.2.1' })).statusCode, 200)
  const realtime = '/api/v1/analytics/realtime-top-messages?room_id=room-1'
  for (let i = 0; i < 60; i++) assert.equal((await app.inject(realtime)).statusCode, 200)
  const realtimeBlocked = await app.inject(realtime)
  assert.equal(realtimeBlocked.statusCode, 429)
  assert.ok(Number(realtimeBlocked.headers['retry-after']) >= 1)
  for (const url of ['/api/v1/rooms', '/health/live', '/health/ready',
    '/api/v1/analytics/top-messages?room_id=room-1&date=2026-09-06']) {
    assert.equal((await app.inject(url)).statusCode, 200)
  }
  const session = await app.inject('/api/v1/analytics/session-top-messages?room_id=room-1&session_id=11111111-1111-1111-1111-111111111111')
  assert.equal(session.statusCode, 404)
})

test('健康检查和静态管理页面可访问', async t => {
  const app = buildApp(fixtures())
  t.after(() => app.close())
  assert.equal((await app.inject('/health/live')).statusCode, 200)
  const page = await app.inject('/')
  assert.equal(page.statusCode, 200)
  assert.match(page.body, /虎牙弹幕观察台/)
})

test('分析 API 拒绝无效区间', async t => {
  const app = buildApp(fixtures())
  t.after(() => app.close())
  const response = await app.inject('/api/v1/analytics/message-counts?room_id=x&from=no&to=no')
  assert.equal(response.statusCode, 400)
})

test('房间列表标记 HUYA_ROOM_ID 对应的默认房间', async t => {
  const deps = fixtures()
  deps.config.initialRoomId = '2000'
  deps.database.listRooms = async () => [
    { id: 'old', external_room_id: '1000' },
    { id: 'current', external_room_id: '2000' }
  ]
  const app = buildApp(deps)
  t.after(() => app.close())

  const response = await app.inject('/api/v1/rooms')
  assert.equal(response.statusCode, 200)
  assert.deepEqual(response.json(), [
    { id: 'old', external_room_id: '1000', is_default: false },
    { id: 'current', external_room_id: '2000', is_default: true }
  ])
})

test('实时 Top API 使用同一截止时间返回多个窗口并缓存默认查询', async t => {
  const deps = fixtures()
  deps.database.getRoom = async id => id === 'room-1' ? { id } : null
  let calls = 0
  deps.database.realtimeTopMessages = async ({ roomId, windows, at, limit }) => {
    calls += 1
    assert.equal(roomId, 'room-1')
    assert.deepEqual(windows, ['1m', '5m', '10m'])
    assert.equal(limit, 10)
    assert.ok(at instanceof Date)
    return windows.map(window => ({
      window, from: at.toISOString(), to: at.toISOString(), total_messages: '0', data_complete: null, items: []
    }))
  }
  const app = buildApp(deps)
  t.after(() => app.close())

  const url = '/api/v1/analytics/realtime-top-messages?room_id=room-1'
  const first = await app.inject(url)
  const second = await app.inject(url)
  assert.equal(first.statusCode, 200)
  assert.equal(second.statusCode, 200)
  assert.equal(calls, 1)
  assert.equal(first.json().as_of, second.json().as_of)
  assert.deepEqual(first.json().windows.map(item => item.window), ['1m', '5m', '10m'])
})

test('实时 Top API 校验窗口、limit、时区和房间', async t => {
  const deps = fixtures()
  const app = buildApp(deps)
  t.after(() => app.close())
  const base = '/api/v1/analytics/realtime-top-messages?room_id=missing'

  assert.equal((await app.inject(`${base}&windows=2m`)).statusCode, 400)
  assert.equal((await app.inject(`${base}&limit=51`)).statusCode, 400)
  assert.equal((await app.inject(`${base}&at=2026-09-01T20:15:30`)).statusCode, 400)
  assert.equal((await app.inject(base)).statusCode, 404)
})

test('场次 Top API 校验参数、缓存已结束场次并区分房间与场次不存在', async t => {
  const deps = fixtures()
  deps.database.getRoom = async id => id === 'room-1' ? { id } : null
  let calls = 0
  deps.database.sessionTopMessages = async ({ roomId, sessionId, limit }) => {
    if (sessionId === '11111111-1111-1111-1111-111111111111') {
      calls += 1
      assert.equal(roomId, 'room-1')
      assert.equal(limit, 100)
      return {
        session: {
          status: 'completed',
          detected_started_at: '2026-09-02T12:00:00.000Z',
          detected_ended_at: '2026-09-02T19:00:00.000Z',
          platform_started_at: null,
          platform_ended_at: null,
          title: '深夜场',
          category: null
        },
        total_messages: '1500',
        data_complete: null,
        items: [{ rank: '1', content: '666', message_count: '80', share: 0.053 }]
      }
    }
    return null
  }
  const app = buildApp(deps)
  t.after(() => app.close())

  const url = '/api/v1/analytics/session-top-messages?room_id=room-1&session_id=11111111-1111-1111-1111-111111111111&limit=100'
  const first = await app.inject(url)
  const second = await app.inject(url)
  assert.equal(first.statusCode, 200)
  assert.equal(second.statusCode, 200)
  assert.equal(calls, 1)
  assert.equal(first.json().session_id, '11111111-1111-1111-1111-111111111111')
  assert.equal(first.json().session.title, '深夜场')
  assert.deepEqual(first.json().items, [{ rank: '1', content: '666', message_count: '80', share: 0.053 }])

  assert.equal(
    (await app.inject('/api/v1/analytics/session-top-messages?room_id=room-1&session_id=not-a-uuid')).statusCode,
    400
  )
  assert.equal(
    (await app.inject('/api/v1/analytics/session-top-messages?room_id=missing&session_id=11111111-1111-1111-1111-111111111111')).statusCode,
    404
  )
  assert.equal(
    (await app.inject('/api/v1/analytics/session-top-messages?room_id=room-1&session_id=22222222-2222-2222-2222-222222222222')).statusCode,
    404
  )
})
