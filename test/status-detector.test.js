const test = require('node:test')
const assert = require('node:assert/strict')
const { parseRoomStatus, HuyaStatusDetector } = require('../src/huya/status-detector')

function page(status) {
  const data = {
    roomProfile: { lUid: 12345 },
    roomInfo: {
      eLiveStatus: status,
      tProfileInfo: { lUid: 12345, sNick: '测试主播' },
      tLiveInfo: { lChannelId: status === 2 ? 88 : 0, sIntroduction: '测试直播' }
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
