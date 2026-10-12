const test = require('node:test')
const assert = require('node:assert/strict')
const { parseRoomStatus, HuyaStatusDetector } = require('../src/huya/status-detector')

function page(status, liveInfo = {}) {
  const data = {
    roomProfile: { lUid: 12345 },
    roomInfo: {
      eLiveStatus: status,
      tProfileInfo: { lUid: 12345, sNick: '测试主播' },
      tLiveInfo: { lLiveChannel: status === 2 ? 88 : 0, sIntroduction: '测试直播', ...liveInfo }
    }
  }
  return `<html><script> window.HNF_GLOBAL_INIT = ${JSON.stringify(data)};</script></html>`
}

test('解析开播和离线状态', () => {
  const live = parseRoomStatus(page(2), 'room')
  const offline = parseRoomStatus(page(0), 'room')
  assert.equal(live.status, 'live')
  assert.equal(live.anchorUid, '12345')
  assert.equal(live.anchorName, '测试主播')
  assert.equal(offline.status, 'offline')
})

test('状态检测器拒绝 HTTP 错误', async () => {
  const detector = new HuyaStatusDetector({ fetchImpl: async () => ({ ok: false, status: 503 }) })
  await assert.rejects(() => detector.detect('1'), /HTTP 503/)
})

for (const status of [1, 3, '1', '3']) {
  test(`eLiveStatus=${status} 明确表示 offline，不推断更细语义`, () => {
    const result = parseRoomStatus(page(status, { iStartTime: 0 }), 'room')
    assert.equal(result.status, 'offline')
    assert.equal(result.metadata.liveStatus, Number(status))
    assert.equal(result.metadata.liveStartedAt, null)
  })
}

for (const status of [undefined, null, 'NaN', '', ' ', false, {}, [], Infinity, -1, 2.5, '2x']) {
  test(`无法可靠解析 eLiveStatus (${JSON.stringify(status)}) 时拒绝 channel fallback`, () => {
    for (const channel of [0, 88]) {
      assert.throws(() => parseRoomStatus(page(status, { lLiveChannel: channel }), 'room'), /eLiveStatus/)
    }
  })
}

test('读取正确的 lLiveChannel 和平台 Unix 开播时间，并忽略不安全的 liveId', () => {
  const observedAt = new Date('2026-10-10T08:42:20.000Z')
  const result = parseRoomStatus(page(2, {
    iStartTime: 1791616500, lLiveChannel: '88', lChannelId: 99,
    lLiveId: '1234567890123456789'
  }), 'room', observedAt)
  assert.equal(result.metadata.liveStartedAt, '2026-10-10T07:15:00.000Z')
  assert.equal(result.metadata.liveChannel, 88)
  assert.equal(result.checkedAt, observedAt.toISOString())
  assert.equal(result.metadata.liveStatusObservedAt, result.checkedAt)
  assert.equal(result.metadata.liveStatusState, 'live')
  assert.equal(result.metadata.liveId, undefined)
})

test('无效平台开播时间不能产生无效 ISO 或 fallback 检测时间', () => {
  for (const iStartTime of [undefined, 0, -1, 'NaN', null, false, true, [], {}, 8640000000001]) {
    assert.equal(parseRoomStatus(page(2, { iStartTime }), 'room').metadata.liveStartedAt, null)
  }
  assert.equal(parseRoomStatus(page(3, { iStartTime: 1791616500 }), 'room').metadata.liveStartedAt, null)
  assert.equal(parseRoomStatus(page(2, { lLiveChannel: undefined, lChannelId: 88 }), 'room').metadata.liveChannel, null)
})

test('有效的数字字符串及带毫秒 Unix seconds 正确转换，原始 int64 liveId 不对外复制', () => {
  for (const iStartTime of ['1791616500.125', 1791616500.125]) {
    const html = page(2, { iStartTime }).replace('"iStartTime"', '"lLiveId":1234567890123456789,"iStartTime"')
    const result = parseRoomStatus(html, 'room')
    assert.equal(result.metadata.liveStartedAt, '2026-10-10T07:15:00.125Z')
    assert.equal(result.metadata.liveId, undefined)
    assert.equal(result.metadata.lLiveId, undefined)
  }
})

test('观察时间在 HTTP response body 完成及解析后采集', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-10T08:42:00.000Z') })
  const detector = new HuyaStatusDetector({ fetchImpl: async () => {
    t.mock.timers.tick(10_000)
    return { ok: true, text: async () => {
      t.mock.timers.tick(10_000)
      return page(2)
    } }
  } })
  assert.equal((await detector.detect('room')).checkedAt, '2026-10-10T08:42:20.000Z')
})

test('检测器正确传入超时 signal 并传播 timeout', async t => {
  // Inject an already-aborted timeout signal: no real sleeps or external requests.
  const timeout = new DOMException('timed out', 'TimeoutError')
  t.mock.method(AbortSignal, 'timeout', timeoutMs => {
    assert.equal(timeoutMs, 15_000)
    return AbortSignal.abort(timeout)
  })
  const detector = new HuyaStatusDetector({ fetchImpl: async (_url, { signal }) => signal.throwIfAborted() })
  await assert.rejects(() => detector.detect('1'), { name: 'TimeoutError' })
})

for (const [html, message] of [['<html></html>', /缺少 HNF_GLOBAL_INIT/],
  ['<script>window.HNF_GLOBAL_INIT = {broken};</script>', /JSON 解析失败/]]) {
  test(`检测器拒绝无效页面：${message}`, async () => {
    const detector = new HuyaStatusDetector({ fetchImpl: async () => ({ ok: true, text: async () => html }) })
    await assert.rejects(() => detector.detect('1'), message)
  })
}
