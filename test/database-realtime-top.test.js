const test = require('node:test')
const assert = require('node:assert/strict')
const { Database } = require('../src/db')

test('实时 Top 查询扫描完整最长窗口并按请求顺序组装结果', async () => {
  const database = Object.create(Database.prototype)
  const at = new Date('2026-09-01T12:15:30.000Z')
  database.query = async (sql, params) => {
    assert.match(sql, /candidate_messages AS MATERIALIZED/)
    assert.match(sql, /occurred_at >=/)
    assert.match(sql, /content_normalized <> ''/)
    assert.deepEqual(params, ['room-1', ['1m', '5m'], [60, 300], at, 300, 10])
    return {
      rows: [
        {
          window: '1m', from_at: new Date('2026-09-01T12:14:30.000Z'), to_at: at,
          total_messages: '20', data_complete: null, rank: '1', content: '666',
          message_count: '5', share: 0.25
        },
        {
          window: '5m', from_at: new Date('2026-09-01T12:10:30.000Z'), to_at: at,
          total_messages: '0', data_complete: false, rank: null, content: null,
          message_count: null, share: null
        }
      ]
    }
  }

  const result = await database.realtimeTopMessages({
    roomId: 'room-1', windows: ['1m', '5m'], at, limit: 10
  })
  assert.deepEqual(result, [
    {
      window: '1m', from: '2026-09-01T12:14:30.000Z', to: at.toISOString(),
      total_messages: '20', data_complete: null,
      items: [{ rank: '1', content: '666', message_count: '5', share: 0.25 }]
    },
    {
      window: '5m', from: '2026-09-01T12:10:30.000Z', to: at.toISOString(),
      total_messages: '0', data_complete: false, items: []
    }
  ])
})
