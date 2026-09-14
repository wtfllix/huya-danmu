const test = require('node:test')
const assert = require('node:assert/strict')
const { parseWindowQuery, createWindowTopService } = require('../src/services/window-top-service')

test('window parameters reject normalized invalid dates and invalid limits', () => {
  const base = { room_id: 'room', date: '2026-09-06' }
  assert.equal(parseWindowQuery(base).limit, 50)
  for (const patch of [{ date: '2026-02-30' }, { date: '2026-13-01' }, { date: '' }, { date: '0000-01-01' },
    { limit: '0' }, { limit: '1.5' }, { limit: '50x' }, { timezone: '+08:00' }, { room_id: '' }]) {
    assert.throws(() => parseWindowQuery({ ...base, ...patch }), { statusCode: 400 })
  }
})

test('batch service bounds concurrency and records failed and successful timing', async () => {
  let finish
  const pending = new Promise(resolve => { finish = resolve })
  const events = []
  const log = { info: value => events.push(value), error: () => {} }
  const run = createWindowTopService({ ready: true, getRoom: async () => ({}), windowTopMessages: () => pending })
  const first = run({}, log)
  const second = run({}, log)
  await assert.rejects(run({}, log), { statusCode: 429, retryAfter: 5 })
  finish([])
  await first
  await second
  await run({}, log)
  assert.equal(events.length, 3)
  assert.ok(events.every(event => event.total_ms >= event.database_ms && event.window_count === 0 && event.cache_hit === false))
  const failed = createWindowTopService({ ready: true, getRoom: async () => { throw new Error('offline') } })
  await assert.rejects(failed({}, log), { statusCode: 503, code: 'ANALYTICS_QUERY_FAILED' })
  assert.equal(events.at(-1).outcome, 'error')
})
