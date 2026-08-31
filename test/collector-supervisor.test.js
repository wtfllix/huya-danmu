const test = require('node:test')
const assert = require('node:assert/strict')

const { CollectorSupervisor } = require('../src/services/collector-supervisor')

function createSupervisor() {
  const enqueued = []
  const supervisor = new CollectorSupervisor({
    database: {},
    detector: {},
    spool: { enqueue: async event => enqueued.push(event) },
    config: {},
    logger: {}
  })
  return { supervisor, enqueued }
}

test('only chat messages are persisted', async () => {
  const { supervisor, enqueued } = createSupervisor()
  const room = { id: 'room-1' }
  const session = { id: 'session-1' }

  await supervisor.onMessage(room, session, { type: 'gift', time: Date.now(), name: '礼物' })
  await supervisor.onMessage(room, session, { type: 'online', time: Date.now(), count: 123 })
  await supervisor.onMessage(room, session, {
    type: 'chat',
    time: Date.now(),
    from: { rid: 'user-1', name: '测试用户' },
    content: '测试弹幕'
  })

  assert.equal(enqueued.length, 1)
  assert.equal(enqueued[0].type, 'chat')
  assert.equal(enqueued[0].content, '测试弹幕')
  assert.deepEqual(supervisor.metrics, {
    chat: 1,
    gift: 1,
    online: 1,
    errors: 0,
    parseErrors: 0,
    reconnects: 0,
    statusCheckErrors: 0
  })
})
