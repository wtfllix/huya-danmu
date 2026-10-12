const test = require('node:test')
const assert = require('node:assert/strict')
const { roomLiveStatus } = require('../src/services/live-status')

const observedAt = '2026-10-10T08:42:20.000Z'
const t0 = Date.parse(observedAt)

for (const [state, raw] of [['live', 2], ['offline', 1], ['offline', 3]]) {
  test(`${state}/${raw} freshness 在 2×60 秒窗口边界判定`, () => {
    const room = { id: 'room', metadata: {
      liveStatus: raw, liveStatusState: state, liveStatusObservedAt: observedAt
    } }
    for (const seconds of [0, 30, 119, 120, 121]) {
      const result = roomLiveStatus(room, 60_000, t0 + seconds * 1000)
      assert.equal(result.status, seconds <= 120 ? state : 'unknown')
      assert.equal(result.observed_at, observedAt)
      assert.equal(result.valid_until, '2026-10-10T08:44:20.000Z')
    }
    assert.equal(roomLiveStatus(room, 30_000, t0 + 61_000).status, 'unknown')
  })
}

test('缺数据、无效时间、未来观察、状态冲突以及显式失败全部 UNKNOWN', () => {
  const metadata = { liveStatus: 2, liveStatusState: 'live', liveStatusObservedAt: observedAt }
  for (const patch of [
    { liveStatusState: 'unknown' }, { liveStatusState: undefined }, { liveStatus: null },
    { liveStatusState: 'offline' }, { liveStatus: 3 },
    { liveStatusObservedAt: undefined }, { liveStatusObservedAt: 'invalid' },
    { liveStatusObservedAt: '2026-02-30T08:42:20.000Z' }, { liveStatusObservedAt: t0 },
    { liveStatusObservedAt: '2026-10-10T08:43:20.000Z' }
  ]) {
    assert.equal(roomLiveStatus({ runtime_status: 'listening', metadata: { ...metadata, ...patch } }, 60_000, t0).status, 'unknown')
  }
  assert.equal(roomLiveStatus({}).status, 'unknown')
})
