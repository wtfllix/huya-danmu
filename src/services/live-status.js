const LIVE_STATUS_SOURCE = 'm.huya.com:HNF_GLOBAL_INIT'

function parsePlatformLiveStatus(value) {
  // Reject coercions such as null/false/'' -> 0: missing data cannot prove OFFLINE.
  if (typeof value !== 'number' && !(typeof value === 'string' && /^\d+$/.test(value))) return null
  const status = Number(value)
  return Number.isSafeInteger(status) && status >= 0 ? status : null
}

function validIsoTime(value) {
  if (typeof value !== 'string') return null
  const date = new Date(value)
  // Persisted times use canonical UTC ISO; reject invalid or silently normalized dates.
  return Number.isFinite(date.getTime()) && date.toISOString() === value ? value : null
}

function roomLiveStatus(room, pollIntervalMs = 60_000, now = Date.now()) {
  const metadata = room.metadata || {}
  const observedAt = validIsoTime(metadata.liveStatusObservedAt)
  const observedMs = observedAt ? Date.parse(observedAt) : NaN
  const validUntilMs = observedMs + 2 * pollIntervalMs
  const validUntil = Number.isFinite(validUntilMs) && Number.isFinite(new Date(validUntilMs).getTime())
    ? new Date(validUntilMs).toISOString() : null
  const rawStatus = parsePlatformLiveStatus(metadata.liveStatus)
  let status = 'unknown'
  // Platform authority always takes precedence over collector runtime_status.
  // An explicit failure is UNKNOWN immediately, even inside the freshness window.
  if (observedAt && validUntil && pollIntervalMs > 0 && observedMs <= now && now <= validUntilMs && rawStatus !== null) {
    if (metadata.liveStatusState === 'live' && rawStatus === 2) status = 'live'
    if (metadata.liveStatusState === 'offline' && rawStatus !== 2) status = 'offline'
  }
  return {
    room_id: room.id,
    external_room_id: room.external_room_id,
    status,
    observed_at: observedAt,
    valid_until: validUntil,
    live_started_at: status === 'live' ? validIsoTime(metadata.liveStartedAt) : null,
    source: LIVE_STATUS_SOURCE
  }
}

module.exports = { LIVE_STATUS_SOURCE, parsePlatformLiveStatus, validIsoTime, roomLiveStatus }
