const crypto = require('node:crypto')
const HuyaDanmu = require('../../index')
const { RealtimeEventBus } = require('./realtime-event-bus')

function restoreSnapshotPayload(payload, now = Date.now(), logger = console) {
  if (!payload || !Array.isArray(payload.items)) return null
  const itemsById = new Map()
  for (const item of payload.items) {
    const sourceMessageId = String(item?.source_message_id || '')
    const expireAtMs = Date.parse(item?.display?.expire_at || '')
    if (!sourceMessageId || !Number.isFinite(expireAtMs)) {
      logger.warn?.({ sourceMessageId }, '丢弃无法恢复的上头条项目')
      continue
    }
    const remainingSec = Math.max(0, Math.ceil((expireAtMs - now) / 1000))
    if (remainingSec <= 0) continue
    itemsById.set(sourceMessageId, {
      ...item,
      source_message_id: sourceMessageId,
      display: { ...item.display, remaining_sec: remainingSec }
    })
  }
  const items = [...itemsById.values()].sort((left, right) =>
    left.source_message_id.localeCompare(right.source_message_id))
  if (!items.length) return null
  return { ...payload, items }
}

class CollectorSupervisor {
  constructor({ database, detector, spool, config = {}, eventBus, logger = console }) {
    this.database = database
    this.detector = detector
    this.spool = spool
    this.config = config
    this.eventBus = eventBus || new RealtimeEventBus({ ringSize: config.realtimeRingSize || 3000 })
    this.logger = logger
    this.runtime = new Map()
    this.started = false
    this.metrics = { chat: 0, gift: 0, paid_message_snapshot: 0, online: 0, errors: 0, parseErrors: 0, reconnects: 0, statusCheckErrors: 0 }
  }

  async start() {
    if (this.started) return
    this.started = true
    if (this.config.initialRoomId && !(await this.database.getRoomByExternalId(this.config.initialRoomId))) {
      await this.database.createRoom({
        externalRoomId: this.config.initialRoomId
      })
    }
    await this.tick()
    this.timer = setInterval(() => this.tick(), this.config.pollIntervalMs)
    this.timer.unref?.()
  }

  async stop() {
    clearInterval(this.timer)
    this.started = false
    for (const state of this.runtime.values()) state.client?.stop()
    this.runtime.clear()
  }

  async warmRestorePaidSnapshots(now = Date.now()) {
    const rows = await this.database.listLatestActivePaidMessageSnapshots()
    let restored = 0
    for (const row of rows) {
      const snapshot = restoreSnapshotPayload(row.payload, now, this.logger)
      if (!snapshot) continue
      if (this.eventBus.restorePaidSnapshot(row.room_id, snapshot)) restored += 1
    }
    return restored
  }

  async tick() {
    const rooms = await this.database.listRooms()
    for (const room of rooms) {
      if (!room.enabled) {
        await this.stopCollector(room, 'disabled')
        continue
      }
      this.checkRoom(room).catch(error => this.logger.error?.({ error, roomId: room.id }, '房间状态检查失败'))
    }
  }

  async checkRoom(room) {
    const state = this.runtime.get(room.id) || { checking: false, offlineCount: 0, client: null, session: null }
    this.runtime.set(room.id, state)
    if (state.checking) return
    state.cancelled = false
    state.checking = true
    try {
      const result = await this.detector.detect(room.external_room_id)
      if (state.cancelled) return
      await this.database.recordStatusCheck(room.id, result)
      if (result.status === 'live') {
        state.offlineCount = 0
        if (!state.client) await this.startCollector(room, result, state)
        else if (state.ready) await this.database.setRoomStatus(room.id, 'listening', { error: null })
      } else {
        state.offlineCount += 1
        const activeSession = state.session || await this.database.getActiveSession(room.id)
        if (activeSession && state.offlineCount >= this.config.offlineConfirmations) {
          await this.stopCollector(room, 'offline')
        } else if (activeSession) {
          state.session = activeSession
          await this.database.setRoomStatus(room.id, 'stopping', { reason: 'offline_confirmation_pending' })
        } else if (!state.client) {
          await this.database.setRoomStatus(room.id, 'offline', { source: result.source })
        }
      }
    } catch (error) {
      this.metrics.statusCheckErrors += 1
      const status = state.client ? 'degraded' : 'unknown'
      await this.database.setRoomStatus(room.id, status, {
        reason: 'status_check_failed',
        error: { message: error.message, code: error.code || null }
      })
      throw error
    } finally {
      state.checking = false
    }
  }

  async startCollector(room, detection, state = this.runtime.get(room.id)) {
    const session = await this.database.startSession(room.id, detection.metadata)
    state.session = session
    state.ready = false
    await this.database.setRoomStatus(room.id, 'starting', { reason: 'live_detected', source: detection.source })
    const client = new HuyaDanmu({
      roomid: room.external_room_id,
      proxy: this.config.proxy || undefined,
      wsUrl: this.config.allowInsecureWs ? HuyaDanmu.WS_URL : HuyaDanmu.WSS_URL,
      logger: this.logger
    })
    state.client = client

    client.on('ready', () => {
      state.ready = true
      this.database.setRoomStatus(room.id, 'listening', { reason: 'subscription_ready', error: null })
        .catch(error => this.logger.error?.({ error, roomId: room.id }, '更新监听状态失败'))
    })
    client.on('message', message => this.onMessage(room, session, message))
    client.on('parseError', ({ uri, error, payloadLength, offset, tag, type, bufferLength, remainingBytes, expectedReadBytes }) => {
      this.metrics.parseErrors += 1
      this.logger.warn?.({
        error, uri, payloadLength, offset, tag, type, bufferLength, remainingBytes, expectedReadBytes, roomId: room.id
      }, '虎牙消息解析失败')
    })
    client.on('error', error => {
      this.metrics.errors += 1
      this.logger.error?.({ error, roomId: room.id }, '虎牙采集连接异常')
      this.database.setRoomStatus(room.id, 'degraded', {
        reason: 'collector_error',
        error: { message: error.message, code: error.code || null }
      }).catch(() => {})
    })
    client.on('close', () => {
      this.metrics.reconnects += 1
      if (state.client === client) {
        state.ready = false
        if (!client._client) state.client = null
        this.database.setRoomStatus(room.id, 'degraded', { reason: 'collector_disconnected' }).catch(() => {})
      }
    })
    await client.start()
  }

  async stopCollector(room, reason) {
    const state = this.runtime.get(room.id)
    if (state && reason === 'disabled') state.cancelled = true
    if (state?.client) {
      state.client.stop()
      state.client = null
      state.session = null
      state.ready = false
    }
    await this.database.endSession(room.id)
    await this.database.setRoomStatus(room.id, reason === 'disabled' ? 'disabled' : 'offline', { reason })
  }

  async onMessage(room, session, message) {
    if (this.metrics[message.type] !== undefined) this.metrics[message.type] += 1
    const receivedAt = new Date()
    if (message.type === 'online') return
    const occurredAt = Number.isFinite(message.time) ? new Date(message.time) : receivedAt
    const normalized = this.#normalizeMessage(room, session, message, receivedAt, occurredAt)
    if (!normalized) return
    if (normalized.event.event_type === 'chat') {
      this.eventBus.publish(room.id, normalized.event)
    } else if (normalized.event.event_type === 'gift') {
      const threshold = this.config.bigGiftThresholdHuyaCoin ?? 100
      if (normalized.event.gift.total_huya_coin >= threshold) {
        this.eventBus.publish(room.id, normalized.event)
      }
    } else if (normalized.event.event_type === 'paid_message_snapshot') {
      this.eventBus.publishPaidSnapshot(room.id, normalized.event)
    }
    try {
      await this.spool.enqueue(normalized.persistence)
    } catch (error) {
      this.logger.error?.({ error, roomId: room.id }, '写入本地持久化缓冲失败')
      await this.database.setRoomStatus(room.id, 'degraded', {
        reason: 'spool_write_failed', error: { message: error.message }
      }).catch(() => {})
    }
  }

  #normalizeMessage(room, session, message, receivedAt, occurredAt) {
    const roomId = String(room.id)
    const sessionId = String(session.id)
    const received = receivedAt.toISOString()
    const base = {
      room_id: roomId,
      session_id: sessionId,
      occurred_at: occurredAt.toISOString(),
      received_at: received
    }
    if (message.type === 'chat') {
      const event = {
        event_type: 'chat',
        event_id: crypto.randomUUID(),
        source_push_message_id: message.sourcePushMessageId || null,
        source_message_id: message.sourceMessageId || null,
        ...base,
        sender: {
          uid: message.from?.rid ? String(message.from.rid) : null,
          name: message.from?.name || '',
          avatar: message.from?.avatar || '',
          noble_level: Number(message.from?.nobleLevel || 0)
        },
        content: message.content || '',
        fan_badge: message.fanBadge ? {
          anchor_uid: message.fanBadge.anchor_uid ? String(message.fanBadge.anchor_uid) : null,
          name: message.fanBadge.name || '',
          level: Number(message.fanBadge.level || 0),
          custom: Boolean(message.fanBadge.custom),
          fans_identity: Number(message.fanBadge.fans_identity || 0),
          super_fans_level: Number(message.fanBadge.super_fans_level || 0)
        } : null
      }
      return {
        event,
        persistence: {
          ingestId: event.event_id,
          roomId,
          sessionId,
          sourceEventId: event.source_message_id || event.source_push_message_id,
          type: 'chat',
          occurredAt: occurredAt.toISOString(),
          receivedAt: received,
          timeSource: 'received',
          senderUid: event.sender.uid,
          senderName: event.sender.name,
          content: event.content,
          rawPayload: event
        }
      }
    }
    if (message.type === 'gift') {
      const event = {
        event_type: 'gift',
        event_id: crypto.randomUUID(),
        source_push_message_id: message.sourcePushMessageId || null,
        payment_id: message.paymentId || null,
        ...base,
        sender: {
          uid: message.from?.rid ? String(message.from.rid) : null,
          name: message.from?.name || '',
          avatar: message.from?.avatar || '',
          noble_level: Number(message.from?.nobleLevel || 0)
        },
        gift: {
          item_type: Number(message.itemType || 0),
          name: message.name || '',
          count: Number(message.count || 0),
          pay_total_raw: String(message.payTotalRaw || '0'),
          total_huya_coin: Number(message.totalHuyaCoin || 0),
          price_level: Number(message.priceLevel || 0)
        }
      }
      return {
        event,
        persistence: {
          ingestId: event.event_id,
          roomId,
          sessionId,
          sourceEventId: event.payment_id || event.source_push_message_id,
          type: 'gift',
          occurredAt: occurredAt.toISOString(),
          receivedAt: received,
          timeSource: 'received',
          senderUid: event.sender.uid,
          senderName: event.sender.name,
          content: event.gift.name,
          rawPayload: event
        }
      }
    }
    if (message.type === 'paid_message_snapshot') {
      const itemsById = new Map()
      for (const item of (message.items || [])) {
        if (Number(item.iCountDown || 0) <= 0) continue
        const normalizedItem = this.#normalizePaidMessage(item, receivedAt)
        itemsById.set(normalizedItem.source_message_id, normalizedItem)
      }
      const items = [...itemsById.values()].sort((left, right) =>
        left.source_message_id.localeCompare(right.source_message_id))
      const event = {
        event_type: 'paid_message_snapshot',
        event_id: crypto.randomUUID(),
        ...base,
        items
      }
      return {
        event,
        persistence: {
          ingestId: event.event_id,
          roomId,
          sessionId,
          sourceEventId: items.map(item => item.source_message_id).join(',') || null,
          type: 'paid_message_snapshot',
          occurredAt: occurredAt.toISOString(),
          receivedAt: received,
          timeSource: 'received',
          senderUid: null,
          senderName: '',
          content: '',
          rawPayload: event
        }
      }
    }
    return null
  }

  #normalizePaidMessage(item, receivedAt) {
    const ext = item.mExt || {}
    const expireRaw = ext.lExpireTime
    const expireSeconds = Number(expireRaw)
    const expireAt = Number.isFinite(expireSeconds) && expireSeconds > 0
      ? new Date(expireSeconds * 1000).toISOString()
      : new Date(receivedAt.getTime() + Number(item.iCountDown || 0) * 1000).toISOString()
    const rawCostPay = Number(item.iCostPay || 0)
    return {
      source_message_id: String(item.lMessageId || '0'),
      sender: {
        uid: String(item.tMessageUser?.lUid || '0'),
        name: item.tMessageUser?.sNick || item.tMessageUser?.sNickName || '',
        avatar: item.tMessageUser?.sAvatar || item.tMessageUser?.sAvatarUrl || ''
      },
      target: {
        uid: String(item.tTarUser?.lUid || '0'),
        name: item.tTarUser?.sNick || '',
        room_id: String(item.tTarUser?.lRoomId || '0')
      },
      content: item.sContent || '',
      payment: {
        item_type: String(ext.iItemType || 0),
        count: Number(ext.count || 0),
        raw_cost: Number(item.iCost || 0),
        raw_cost_pay: rawCostPay,
        huya_coin: rawCostPay / 100
      },
      display: {
        level: Number(item.iLevel || 0),
        total_sec: Number(item.iTotalSec || 0),
        remaining_sec: Number(item.iCountDown || 0),
        expire_at: expireAt
      },
      source_offset: item.sOffset || ''
    }
  }

  getStatus() {
    return [...this.runtime.entries()].map(([roomId, state]) => ({
      roomId,
      connected: Boolean(state.client),
      sessionId: state.session?.id || null,
      offlineCount: state.offlineCount
    }))
  }
}

module.exports = { CollectorSupervisor, restoreSnapshotPayload }
