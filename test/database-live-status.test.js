const test = require('node:test')
const assert = require('node:assert/strict')
const { Database } = require('../src/db')

const observedAt = '2026-10-10T08:42:20.000Z'
const liveStartedAt = '2026-10-10T07:15:00.000Z'

test('成功观察同时写入 authority 与 last_checked_at；失败和启动仅改变 state', async () => {
  const database = Object.create(Database.prototype)
  const calls = []
  database.query = async (sql, params) => { calls.push({ sql, params }); return { rows: [] } }
  await database.recordStatusCheck('room', {
    status: 'live', checkedAt: observedAt, anchorUid: '123',
    metadata: { liveStatus: 2, liveStartedAt, title: '直播' }
  })
  assert.match(calls[0].sql, /last_checked_at = \$4/)
  assert.match(calls[0].sql, /metadata = metadata \|\| \$5::jsonb/)
  assert.equal(calls[0].params[3], observedAt)
  assert.deepEqual(calls[0].params[4], {
    liveStatus: 2, liveStartedAt, title: '直播', liveStatusState: 'live', liveStatusObservedAt: observedAt
  })
  await database.recordLiveStatusFailure('room')
  await database.resetLiveStatusAuthorities()
  for (const { sql } of calls.slice(1)) {
    assert.match(sql, /metadata = metadata \|\| '\{"liveStatusState":"unknown"\}'::jsonb/)
    assert.doesNotMatch(sql, /last_checked_at\s*=|liveStatusObservedAt|"liveStatus"|live_sessions/)
  }
  await assert.rejects(database.recordStatusCheck('room', { status: 'live', checkedAt: 'invalid' }), /无效/)
})

test('新 session 将有效平台时间写入 platform_started_at，不伪造 platform_ended_at', async () => {
  const database = Object.create(Database.prototype)
  database.getActiveSession = async () => null
  database.query = async (sql, params) => {
    assert.match(sql, /INSERT INTO live_sessions/)
    assert.match(sql, /platform_started_at/)
    assert.doesNotMatch(sql, /platform_ended_at/)
    assert.equal(params[3], liveStartedAt)
    return { rows: [{ id: params[0], platform_started_at: params[3] }] }
  }
  assert.equal((await database.startSession('room', { liveStartedAt })).platform_started_at, liveStartedAt)
})

test('已有 active session 缺平台时间可补齐，非 NULL 时间不覆盖且不拆场', async () => {
  const database = Object.create(Database.prototype)
  const active = { id: 'same-session', platform_started_at: null }
  database.getActiveSession = async () => active
  let updates = 0
  database.query = async (sql, params) => {
    updates += 1
    assert.match(sql, /platform_started_at = COALESCE\(platform_started_at, \$2::timestamptz\)/)
    assert.doesNotMatch(sql, /detected_started_at|detected_ended_at|platform_ended_at/)
    assert.equal(params[0], active.id)
    active.platform_started_at = params[1]
    return { rows: [active] }
  }
  assert.equal(await database.startSession('room', { liveStartedAt: 'invalid' }), active)
  assert.equal(updates, 0)
  assert.equal(await database.startSession('room', { liveStartedAt }), active)
  assert.equal(updates, 1)
  assert.equal(await database.startSession('room', { liveStartedAt: observedAt }), active)
  assert.equal(active.platform_started_at, liveStartedAt)
  assert.equal(updates, 1)
})

test('session 不使用无效时间或 detected start 作为平台时间', async () => {
  const database = Object.create(Database.prototype)
  database.getActiveSession = async () => null
  database.query = async (_sql, params) => {
    assert.equal(params[3], null)
    return { rows: [{ platform_started_at: null }] }
  }
  for (const liveStartedAt of [null, undefined, 'invalid', '2026-02-30T00:00:00.000Z']) {
    await database.startSession('room', { liveStartedAt })
  }
})
