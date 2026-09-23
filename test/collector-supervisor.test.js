const test = require('node:test')
const assert = require('node:assert/strict')

const { CollectorSupervisor, restoreSnapshotPayload } = require('../src/services/collector-supervisor')
const { RealtimeEventBus } = require('../src/services/realtime-event-bus')

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
