const USER_AGENT = 'Mozilla/5.0 (Linux; Android 13) AppleWebKit/537.36 Chrome/124 Mobile Safari/537.36'

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

function parseRoomStatus(html, roomId, checkedAt = new Date()) {
  const init = extractGlobalInit(html)
  const roomInfo = init.roomInfo || {}
  const profile = roomInfo.tProfileInfo || init.roomProfile || {}
  const liveInfo = roomInfo.tLiveInfo || {}
  const anchorUid = profile.lUid || profile.lYyid || init.roomProfile?.lUid
  const liveStatus = Number(roomInfo.eLiveStatus)
  const hasChannel = Number(liveInfo.lChannelId || roomInfo.lChannelId || 0) > 0

  if (!anchorUid) throw new Error('无法从虎牙页面识别主播 UID')

  return {
    status: liveStatus === 2 || (Number.isNaN(liveStatus) && hasChannel) ? 'live' : 'offline',
    roomId: String(roomId),
    anchorUid: String(anchorUid),
    anchorName: profile.sNick || profile.sNickName || null,
    checkedAt: checkedAt.toISOString(),
    source: 'm.huya.com:HNF_GLOBAL_INIT',
    metadata: {
      liveStatus: Number.isNaN(liveStatus) ? null : liveStatus,
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
    const checkedAt = new Date()
    const response = await this.fetch(`https://m.huya.com/${encodeURIComponent(String(roomId))}`, {
      headers: { 'user-agent': USER_AGENT },
      signal: AbortSignal.timeout(this.timeoutMs),
      redirect: 'follow'
    })
    if (!response.ok) throw new Error(`虎牙页面请求失败：HTTP ${response.status}`)
    return parseRoomStatus(await response.text(), roomId, checkedAt)
  }
}

module.exports = { HuyaStatusDetector, extractGlobalInit, parseRoomStatus }
