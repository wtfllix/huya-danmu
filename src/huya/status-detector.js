const USER_AGENT = 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/124 Mobile Safari/537.36'
const { LIVE_STATUS_SOURCE, parsePlatformLiveStatus } = require('../services/live-status')

function extractGlobalInit(html) {
  const match = String(html).match(/window\.HNF_GLOBAL_INIT\s*=\s*(\{.*?\})\s*;?\s*<\/script>/s)
  if (!match) throw new Error('虎牙页面缺少 HNF_GLOBAL_INIT')
  try {
    return JSON.parse(match[1])
  } catch (cause) {
    const error = new Error('虎牙页面状态 JSON 解析失败')
    error.cause = cause
    throw error
  }
}

function parseRoomStatus(html, roomId, checkedAt) {
  const init = extractGlobalInit(html)
  const roomInfo = init.roomInfo || {}
  const profile = roomInfo.tProfileInfo || init.roomProfile || {}
  const liveInfo = roomInfo.tLiveInfo || {}
  const anchorUid = profile.lUid || profile.lYyid || init.roomProfile?.lUid
  const liveStatus = parsePlatformLiveStatus(roomInfo.eLiveStatus)
  // lLiveChannel is diagnostic only: neither a channel nor its absence replaces eLiveStatus.
  const liveChannel = parsePlatformLiveStatus(liveInfo.lLiveChannel)

  if (liveStatus === null) throw new Error('无法从虎牙页面可靠解析 eLiveStatus')
  if (!anchorUid) throw new Error('无法从虎牙页面识别主播 UID')
  const status = liveStatus === 2 ? 'live' : 'offline'
  const rawStart = liveInfo.iStartTime
  const startSeconds = typeof rawStart === 'number' || (typeof rawStart === 'string' && /^\d+(?:\.\d+)?$/.test(rawStart))
    ? Number(rawStart) : NaN
  const startDate = new Date(startSeconds * 1000)
  const liveStartedAt = status === 'live' && Number.isFinite(startSeconds) && startSeconds > 0 && Number.isFinite(startDate.getTime())
    ? startDate.toISOString() : null
  // Capture server observation time only after the response and status parsing succeed.
  const observedAt = (checkedAt || new Date()).toISOString()

  return {
    status,
    roomId: String(roomId),
    anchorUid: String(anchorUid),
    anchorName: profile.sNick || profile.sNickName || null,
    checkedAt: observedAt,
    source: LIVE_STATUS_SOURCE,
    metadata: {
      liveStatus,
      liveStatusState: status,
      liveStatusObservedAt: observedAt,
      liveStartedAt,
      liveChannel,
      // Do not copy lLiveId: JSON.parse may have rounded its 19-digit integer.
      title: liveInfo.sIntroduction || liveInfo.sRoomName || null,
      category: liveInfo.sGameFullName || liveInfo.sGameName || null
    }
  }
}

class HuyaStatusDetector {
  constructor({ fetchImpl = globalThis.fetch, timeoutMs = 15000 } = {}) {
    this.fetch = fetchImpl
    this.timeoutMs = timeoutMs
  }

  async detect(roomId) {
    const response = await this.fetch(`https://m.huya.com/${encodeURIComponent(String(roomId))}`, {
      headers: { 'user-agent': USER_AGENT },
      signal: AbortSignal.timeout(this.timeoutMs),
      redirect: 'follow'
    })
    if (!response.ok) throw new Error(`虎牙页面请求失败：HTTP ${response.status}`)
    return parseRoomStatus(await response.text(), roomId)
  }
}

module.exports = { HuyaStatusDetector, extractGlobalInit, parseRoomStatus }
