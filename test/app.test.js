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
    realtimeTopMessages: async () => []
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
