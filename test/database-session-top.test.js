const test = require('node:test')
const assert = require('node:assert/strict')
const { Database } = require('../src/db')

test('场次 Top 查询按 session_id 聚合并附带场次信息', async () => {
  const database = Object.create(Database.prototype)
  database.query = async (sql, params) => {
    assert.match(sql, /session_window AS MATERIALIZED/)
    assert.match(sql, /s\.id = \$2 AND s\.room_id = \$1/)
    assert.match(sql, /m\.session_id = \$2/)
    assert.match(sql, /m\.occurred_at >= w\.scan_from AND m\.occurred_at < w\.scan_to/)
    assert.match(sql, /collector_incidents/)
    assert.match(sql, /m\.content_normalized <> ''/)
    assert.deepEqual(params, ['room-1', 'session-1', 50])
    const head = {
      status: 'completed',
      metadata: { title: '深夜场', category: '星秀' },
      detected_started_at: new Date('2026-09-02T12:00:00.000Z'),
      detected_ended_at: new Date('2026-09-02T19:00:00.000Z'),
      platform_started_at: null,
      platform_ended_at: null,
      data_incomplete: true,
      total_messages: '1500'
    }
    return {
      rows: [
        { ...head, rank: '1', content: '666', message_count: '80', share: 0.053 },
        { ...head, rank: '2', content: '哈哈哈哈', message_count: '40', share: 0.027 }
      ]
    }
  }

  const result = await database.sessionTopMessages({ roomId: 'room-1', sessionId: 'session-1', limit: 50 })
  assert.deepEqual(result, {
    session: {
      status: 'completed',
      detected_started_at: '2026-09-02T12:00:00.000Z',
      detected_ended_at: '2026-09-02T19:00:00.000Z',
      platform_started_at: null,
      platform_ended_at: null,
      title: '深夜场',
      category: '星秀'
    },
    total_messages: '1500',
    data_complete: false,
    items: [
      { rank: '1', content: '666', message_count: '80', share: 0.053 },
      { rank: '2', content: '哈哈哈哈', message_count: '40', share: 0.027 }
    ]
  })
})

test('场次 Top 查询无弹幕时返回空排行，未找到场次返回 null', async () => {
  const database = Object.create(Database.prototype)
  let call = 0
  database.query = async () => {
    call += 1
    if (call === 1) {
      return {
        rows: [
          {
            status: 'active',
            metadata: {},
            detected_started_at: new Date('2026-09-03T12:00:00.000Z'),
            detected_ended_at: null,
            platform_started_at: null,
            platform_ended_at: null,
            data_incomplete: false,
            total_messages: '0',
            rank: null,
            content: null,
            message_count: null,
            share: null
          }
        ]
      }
    }
    return { rows: [] }
  }

  const empty = await database.sessionTopMessages({ roomId: 'room-1', sessionId: 'session-1', limit: 50 })
  assert.deepEqual(empty, {
    session: {
      status: 'active',
      detected_started_at: '2026-09-03T12:00:00.000Z',
      detected_ended_at: null,
      platform_started_at: null,
      platform_ended_at: null,
      title: null,
      category: null
    },
    total_messages: '0',
    data_complete: null,
    items: []
  })

  const missing = await database.sessionTopMessages({ roomId: 'room-1', sessionId: 'session-404', limit: 50 })
  assert.equal(missing, null)
})
