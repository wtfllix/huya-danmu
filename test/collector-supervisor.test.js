const test = require('node:test')
const assert = require('node:assert/strict')

const { CollectorSupervisor, restoreSnapshotPayload } = require('../src/services/collector-supervisor')
const { RealtimeEventBus } = require('../src/services/realtime-event-bus')
const HuyaDanmu = require('../index')
const { HuyaStatusDetector } = require('../src/huya/status-detector')
const { Database } = require('../src/db')
const { roomLiveStatus } = require('../src/services/live-status')

function createSupervisor() {
  const enqueued = []
  const published = []
  const eventBus = new RealtimeEventBus({ ringSize: 20 })
  eventBus.subscribe('room-1', event => published.push(event))
  const supervisor = new CollectorSupervisor({
    database: {},
    detector: {},
    spool: { enqueue: async event => enqueued.push(event) },
    config: { bigGiftThresholdHuyaCoin: 100 },
    eventBus,
    logger: {}
  })
  return { supervisor, enqueued, published, eventBus }
}

test('chat and all gifts are persisted, while only large gifts enter realtime stream', async () => {
  const { supervisor, enqueued, published } = createSupervisor()
  const room = { id: 'room-1' }
  const session = { id: 'session-1' }
  const occurredAt = Date.parse('2026-09-22T12:34:56.789Z')

  for (const [payTotalRaw, totalHuyaCoin] of [
    ['10', 0.1], ['9999', 99.99], ['10000', 100], ['10001', 100.01]
  ]) {
    await supervisor.onMessage(room, session, {
      type: 'gift', time: occurredAt, itemType: 1, name: '礼物', count: 1,
      payTotalRaw, totalHuyaCoin, from: { rid: `user-${payTotalRaw}`, name: '用户' }
    })
  }
  await supervisor.onMessage(room, session, { type: 'online', time: Date.now(), count: 123 })
  await supervisor.onMessage(room, session, {
    type: 'chat', time: occurredAt, from: { rid: 'user-3', name: '测试用户' }, content: '测试弹幕'
  })

  assert.equal(enqueued.length, 5)
  assert.deepEqual(enqueued.map(item => item.type), ['gift', 'gift', 'gift', 'gift', 'chat'])
  assert.deepEqual(published.map(item => item.event_type), ['gift', 'gift', 'chat'])
  assert.equal(published[0].gift.total_huya_coin, 100)
  assert.equal(published[1].gift.total_huya_coin, 100.01)
  assert.deepEqual(published.map(item => item.occurred_at), [
    '2026-09-22T12:34:56.789Z',
    '2026-09-22T12:34:56.789Z',
    '2026-09-22T12:34:56.789Z'
  ])
  assert.deepEqual(enqueued.slice(0, 4).map(item => item.rawPayload.gift.pay_total_raw),
    ['10', '9999', '10000', '10001'])
  assert.equal(supervisor.metrics.online, 1)
  assert.equal(supervisor.metrics.gift, 4)
})

test('the verified 10-Huya-coin horn gift is persisted but not published', async () => {
  const { supervisor, enqueued, published } = createSupervisor()
  await supervisor.onMessage({ id: 'room-1' }, { id: 'session-1' }, {
    type: 'gift', time: Date.now(), itemType: 22177, name: '喇叭', count: 1,
    payTotalRaw: '1000', totalHuyaCoin: 10,
    from: { rid: 'user-horn', name: '用户' }
  })

  assert.equal(enqueued.length, 1)
  assert.equal(enqueued[0].rawPayload.gift.item_type, 22177)
  assert.equal(enqueued[0].rawPayload.gift.pay_total_raw, '1000')
  assert.equal(enqueued[0].rawPayload.gift.total_huya_coin, 10)
  assert.equal(published.length, 0)
})

test('paid message snapshots are persisted and deduplicated by active state', async () => {
  const { supervisor, enqueued, published, eventBus } = createSupervisor()
  const item = {
    lMessageId: '3175516',
    tMessageUser: { lUid: '10000000000000001', sNickName: '用户', sAvatarUrl: 'avatar' },
    sContent: '支持主播', iCost: 10, iTotalSec: 300, iCountDown: 236, sOffset: '1',
    mExt: { count: '1', iItemType: '22177', lExpireTime: '1790042000' },
    tTarUser: { lUid: '2', sNick: '主播', lRoomId: '3' }, iLevel: 2, iCostPay: 1000
  }
  const message = { type: 'paid_message_snapshot', time: Date.now(), items: [item] }
  await supervisor.onMessage({ id: 'room-1' }, { id: 'session-1' }, message)
  await supervisor.onMessage({ id: 'room-1' }, { id: 'session-1' }, {
    ...message, items: [item, item]
  })

  assert.equal(enqueued.length, 2)
  assert.equal(published.length, 1)
  assert.equal(eventBus.getCurrentPaidSnapshot('room-1').items[0].source_message_id, '3175516')
  assert.equal(published[0].items[0].payment.huya_coin, 10)
})

test('paid snapshot normalization uses sContent for unicode and empty content', async () => {
  const { supervisor, published } = createSupervisor()
  const item = (id, content) => ({
    lMessageId: id,
    tMessageUser: { lUid: '1', sNick: '用户', sAvatar: '' },
    sContent: content, iCost: 10, iTotalSec: 300, iCountDown: 200, sOffset: '',
    mExt: { count: '1', iItemType: '22177', lExpireTime: '1790042000' },
    tTarUser: { lUid: '2', sNick: '主播', lRoomId: '3' }, iLevel: 2, iCostPay: 1000
  })
  await supervisor.onMessage({ id: 'room-1' }, { id: 'session-1' }, {
    type: 'paid_message_snapshot', time: Date.now(), items: [item('unicode', '中文😀'), item('empty', '')]
  })

  assert.equal(published.length, 1)
  assert.equal(published[0].event_type, 'paid_message_snapshot')
  assert.deepEqual(published[0].items.map(value => value.content), ['', '中文😀'])
})

function storedItem(sourceMessageId, expireAt, remainingSec, content = '内容') {
  return {
    source_message_id: sourceMessageId,
    content,
    display: { expire_at: expireAt, remaining_sec: remainingSec }
  }
}

test('warm restore recalculates remaining time, filters expired items and deduplicates IDs', () => {
  const now = Date.parse('2026-09-22T01:00:00.000Z')
  const snapshot = restoreSnapshotPayload({
    event_type: 'paid_message_snapshot', event_id: 'saved-1', items: [
      storedItem('a', '2026-09-22T01:05:00.000Z', 500),
      storedItem('a', '2026-09-22T01:05:00.000Z', 499, 'duplicate'),
      storedItem('expired', '2026-09-22T00:59:59.000Z', 999),
      storedItem('invalid', 'not-a-date', 999)
    ]
  }, now, { warn() {} })

  assert.deepEqual(snapshot.items.map(item => item.source_message_id), ['a'])
  assert.equal(snapshot.items[0].content, 'duplicate')
  assert.ok(snapshot.items[0].display.remaining_sec >= 299)
  assert.ok(snapshot.items[0].display.remaining_sec <= 301)
})

test('warm restore only uses rows returned for active sessions', async () => {
  const eventBus = new RealtimeEventBus()
  const supervisor = new CollectorSupervisor({
    database: {
      listLatestActivePaidMessageSnapshots: async () => [{
        room_id: 'room-current',
        session_id: 'session-current',
        payload: {
          event_type: 'paid_message_snapshot', event_id: 'saved-current',
          items: [storedItem('current', '2026-09-22T02:00:00.000Z', 1)]
        }
      }]
    },
    spool: { enqueue: async () => {} },
    config: {}, eventBus, logger: { warn() {} }
  })
  await supervisor.warmRestorePaidSnapshots(Date.parse('2026-09-22T01:00:00.000Z'))
  assert.equal(eventBus.getCurrentPaidSnapshot('room-current').items[0].source_message_id, 'current')
  assert.equal(eventBus.getCurrentPaidSnapshot('room-previous'), null)
})

test('upstream snapshot replaces restored state and remaining-only changes do not broadcast', async () => {
  const { supervisor, published, eventBus } = createSupervisor()
  const saved = {
    event_type: 'paid_message_snapshot', event_id: 'restored', room_id: 'room-1', session_id: 'session-1',
    items: [storedItem('a', '2026-09-22T02:00:00.000Z', 500), storedItem('b', '2026-09-22T02:00:00.000Z', 500)]
  }
  eventBus.restorePaidSnapshot('room-1', saved)
  const upstreamItem = (id, remainingSec) => ({
    lMessageId: id,
    tMessageUser: { lUid: '1', sNick: '用户', sAvatar: '' },
    sContent: '内容', iCost: 10, iTotalSec: 300, iCountDown: remainingSec,
    sOffset: '', mExt: { count: '1', iItemType: '22177', lExpireTime: '1790042000' },
    tTarUser: { lUid: '2', sNick: '主播', lRoomId: '3' }, iLevel: 2, iCostPay: 1000
  })
  await supervisor.onMessage({ id: 'room-1' }, { id: 'session-1' }, {
    type: 'paid_message_snapshot', time: Date.now(), items: [upstreamItem('a', 235)]
  })
  assert.deepEqual(eventBus.getCurrentPaidSnapshot('room-1').items.map(item => item.source_message_id), ['a'])
  assert.equal(published.length, 1)

  await supervisor.onMessage({ id: 'room-1' }, { id: 'session-1' }, {
    type: 'paid_message_snapshot', time: Date.now(), items: [upstreamItem('a', 234)]
  })
  assert.equal(published.length, 1)
})

function lifecycleFixture(t, detector) {
  const room = {
    id: 'room-1', external_room_id: '116864', enabled: true, runtime_status: 'listening',
    last_checked_at: '2026-10-10T08:42:20.000Z', metadata: {
      liveStatus: 2, liveStatusState: 'live', liveStatusObservedAt: '2026-10-10T08:42:20.000Z'
    }
  }
  const session = { id: 'same-session', status: 'active', platform_started_at: null }
  const ends = []
  const database = Object.create(Database.prototype)
  // Exercise the real authority write methods; capture the JSONB merge payload.
  database.query = async (sql, params) => {
    if (['BEGIN', 'COMMIT', 'ROLLBACK'].includes(sql)) return { rows: [] }
    if (sql.includes('SELECT * FROM rooms')) return { rows: [room] }
    if (sql.includes('last_checked_at = $4')) {
      room.last_checked_at = params[3]
      Object.assign(room.metadata, params[4])
    } else if (sql.includes('"liveStatusState":"unknown"')) {
      room.metadata.liveStatusState = 'unknown'
    } else if (sql.includes('UPDATE live_sessions')) {
      assert.match(sql, /COALESCE\(platform_started_at/)
      session.platform_started_at ||= params[1]
      return { rows: [session] }
    } else assert.fail(`unexpected query: ${sql}`)
    return { rows: [] }
  }
  database.pool = { connect: async () => ({ query: database.query, release() {} }) }
  database.listRooms = async () => [room]
  database.getActiveSession = async () => session.status === 'active' ? session : null
  database.endSession = async (_roomId, status) => { ends.push(status); session.status = status }
  database.setRoomStatus = async (_id, status) => { room.runtime_status = status }
  const supervisor = new CollectorSupervisor({
    database, detector, spool: {}, config: { pollIntervalMs: 60_000, offlineConfirmations: 2 }, logger: {}
  })
  // Keep the actual supervisor startCollector/session path without opening a socket.
  t.mock.method(HuyaDanmu.prototype, 'start', async function () { this.emit('ready') })
  return { supervisor, database, room, session, ends }
}

function detection(status = 'live', liveStartedAt = '2026-10-10T07:15:00.000Z') {
  return {
    status, checkedAt: '2026-10-10T08:42:20.000Z', source: 'm.huya.com:HNF_GLOBAL_INIT',
    metadata: { liveStatus: status === 'live' ? 2 : 3, liveStartedAt }
  }
}

test('重启检测 LIVE 复用 active session，补平台时间，停止服务不 completed', async t => {
  const { supervisor, room, session, ends } = lifecycleFixture(t, { detect: async () => detection() })
  await supervisor.start()
  await supervisor.runtime.get(room.id).checkDone
  const state = supervisor.runtime.get(room.id)
  assert.equal(state.session.id, session.id)
  assert.equal(session.platform_started_at, '2026-10-10T07:15:00.000Z')
  assert.equal(room.metadata.liveStatusState, 'live')
  assert.deepEqual(ends, [])
  await supervisor.stop()
  assert.equal(session.status, 'active')
  assert.deepEqual(ends, [])
  assert.equal(room.metadata.liveStatusState, 'unknown')
  await supervisor.start()
  await supervisor.runtime.get(room.id).checkDone
  assert.equal(supervisor.runtime.get(room.id).session.id, session.id)
  assert.deepEqual(ends, [])
  await supervisor.stop()
})

test('重启 OFFLINE 第一次即更新 authority，第二次确认结束无 client 的孤儿 session', async t => {
  const { supervisor, room, session, ends } = lifecycleFixture(t, { detect: async () => detection('offline') })
  await supervisor.start()
  await supervisor.runtime.get(room.id).checkDone
  assert.equal(room.metadata.liveStatusState, 'offline')
  assert.equal(room.metadata.liveStartedAt, null)
  assert.equal(session.status, 'active')
  assert.equal(room.runtime_status, 'stopping')
  assert.deepEqual(ends, [])
  await supervisor.checkRoom(room)
  assert.deepEqual(ends, ['completed'])
  assert.equal(supervisor.runtime.get(room.id).session, null)
  await supervisor.stop()
})

const failedFetches = [
  ['HTTP 503', async () => ({ ok: false, status: 503 })],
  ['timeout', async () => { throw new DOMException('timed out', 'TimeoutError') }],
  ['缺 HNF', async () => ({ ok: true, text: async () => '<html></html>' })],
  ['invalid JSON', async () => ({ ok: true, text: async () => '<script>window.HNF_GLOBAL_INIT = {broken};</script>' })],
  ['缺 eLiveStatus', async () => ({ ok: true, text: async () => '<script>window.HNF_GLOBAL_INIT = {"roomInfo":{"tLiveInfo":{"lLiveChannel":88}}};</script>' })]
]
for (const [name, fetchImpl] of failedFetches) {
  test(`${name} 立即将旧 LIVE authority 置 UNKNOWN，保留成功诊断且不结束 session`, async t => {
    const { supervisor, room, session, ends } = lifecycleFixture(t, new HuyaStatusDetector({ fetchImpl }))
    // No freshness expiry: the failed check itself must invalidate a fresh LIVE.
    const now = Date.parse(room.last_checked_at) + 30_000
    assert.equal(roomLiveStatus(room, 60_000, now).status, 'live')
    await assert.rejects(supervisor.checkRoom(room))
    assert.equal(room.metadata.liveStatusState, 'unknown')
    assert.equal(room.metadata.liveStatus, 2)
    assert.equal(room.metadata.liveStatusObservedAt, room.last_checked_at)
    assert.equal(roomLiveStatus(room, 60_000, now).status, 'unknown')
    assert.equal(session.status, 'active')
    assert.deepEqual(ends, [])
    await supervisor.stop()
  })
}

test('刚启动未完成首次成功检测为 UNKNOWN，失败后仍待复核', async t => {
  let rejectDetection
  const gate = new Promise((_resolve, reject) => { rejectDetection = reject })
  const { supervisor, room, session, ends } = lifecycleFixture(t, { detect: () => gate })
  await supervisor.start()
  assert.equal(room.metadata.liveStatusState, 'unknown')
  assert.equal(roomLiveStatus(room, 60_000, Date.parse(room.last_checked_at)).status, 'unknown')
  rejectDetection(new Error('HTTP 503'))
  await supervisor.runtime.get(room.id).checkDone
  assert.equal(session.status, 'active')
  assert.deepEqual(ends, [])
  await supervisor.stop()
})

test('UNKNOWN 打断离线连续确认，不能用于结束真实场次，成功后恢复', async t => {
  let result = detection('offline')
  const { supervisor, room, ends } = lifecycleFixture(t, { detect: async () => {
    if (result instanceof Error) throw result
    return result
  } })
  await supervisor.checkRoom(room)
  result = new Error('timeout')
  await assert.rejects(supervisor.checkRoom(room))
  result = detection('offline')
  await supervisor.checkRoom(room)
  assert.deepEqual(ends, [])
  result = detection()
  await supervisor.checkRoom(room)
  assert.equal(room.metadata.liveStatusState, 'live')
  assert.equal(supervisor.runtime.get(room.id).offlineCount, 0)
  await supervisor.stop()
})

test('collector 启动失败不覆盖成功的平台 LIVE authority', async t => {
  const { supervisor, room, ends } = lifecycleFixture(t, { detect: async () => detection() })
  t.mock.method(HuyaDanmu.prototype, 'start', async () => { throw new Error('collector unavailable') })
  await assert.rejects(supervisor.checkRoom(room), /collector unavailable/)
  assert.equal(room.metadata.liveStatusState, 'live')
  assert.equal(room.runtime_status, 'degraded')
  assert.deepEqual(ends, [])
  await supervisor.stop()
})

test('停止服务取消未完成的检测，晚到 LIVE 不启动 collector 或完成 session', async t => {
  let resolveDetection
  const gate = new Promise(resolve => { resolveDetection = resolve })
  const { supervisor, room, session, ends } = lifecycleFixture(t, { detect: () => gate })
  const check = supervisor.checkRoom(room)
  const stopped = supervisor.stop()
  resolveDetection(detection())
  await Promise.all([check, stopped])
  assert.equal(supervisor.runtime.size, 0)
  assert.equal(room.metadata.liveStatusState, 'unknown')
  assert.equal(session.status, 'active')
  assert.deepEqual(ends, [])
})

test('停服时正在复核 OFFLINE 的孤儿 session 不被错误 completed', async t => {
  const { supervisor, database, room, session, ends } = lifecycleFixture(t, { detect: async () => detection('offline') })
  await supervisor.checkRoom(room)
  const state = supervisor.runtime.get(room.id)
  state.session = null
  let resolveLookup
  let lookupStarted
  const started = new Promise(resolve => { lookupStarted = resolve })
  database.getActiveSession = () => {
    lookupStarted()
    return new Promise(resolve => { resolveLookup = resolve })
  }
  const check = supervisor.checkRoom(room)
  await started
  const stopped = supervisor.stop()
  resolveLookup(session)
  await Promise.all([check, stopped])
  assert.equal(session.status, 'active')
  assert.deepEqual(ends, [])
  assert.equal(room.metadata.liveStatusState, 'unknown')
})

test('场次改变重建 collector，迟到的旧连接消息不会进入新场次', async t => {
  const { supervisor, database, room } = lifecycleFixture(t, { detect: async () => detection() })
  await supervisor.checkRoom(room)
  const state = supervisor.runtime.get(room.id)
  const oldClient = state.client
  const next = { id: 'new-session', status: 'active' }
  database.startSession = async () => next
  const messages = []
  t.mock.method(supervisor, 'onMessage', async (_room, session) => messages.push(session.id))
  await supervisor.checkRoom(room)
  assert.notEqual(state.client, oldClient)
  assert.equal(state.session, next)
  oldClient.emit('message', {})
  state.client.emit('message', {})
  assert.deepEqual(messages, ['new-session'])
  await supervisor.stop()
})
