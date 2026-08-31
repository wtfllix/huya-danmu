const crypto = require('node:crypto')
const HuyaDanmu = require('../../index')

class CollectorSupervisor {
  constructor({ database, detector, spool, config, logger = console }) {
    this.database = database
    this.detector = detector
    this.spool = spool
    this.config = config
    this.logger = logger
    this.runtime = new Map()
    this.started = false
    this.metrics = { chat: 0, gift: 0, online: 0, errors: 0, parseErrors: 0, reconnects: 0, statusCheckErrors: 0 }
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
      wsUrl: this.config.allowInsecureWs ? HuyaDanmu.WS_URL : HuyaDanmu.WSS_URL
    })
    state.client = client

    client.on('ready', () => {
      state.ready = true
      this.database.setRoomStatus(room.id, 'listening', { reason: 'subscription_ready', error: null })
        .catch(error => this.logger.error?.({ error, roomId: room.id }, '更新监听状态失败'))
    })
    client.on('message', message => this.onMessage(room, session, message))
    client.on('parseError', ({ uri, error }) => {
      this.metrics.parseErrors += 1
      this.logger.warn?.({ error, uri, roomId: room.id }, '虎牙消息解析失败')
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
    // MVP analytics only use user-authored chat messages. Gift and audience
    // notifications may still arrive on the socket, but are intentionally not
    // persisted so they cannot consume retention space or affect statistics.
    if (message.type !== 'chat') return
    const receivedAt = new Date()
    const occurredAt = Number.isFinite(message.time) ? new Date(message.time) : receivedAt
    const event = {
      ingestId: crypto.randomUUID(),
      roomId: room.id,
      sessionId: session.id,
      sourceEventId: null,
      type: message.type,
      occurredAt: occurredAt.toISOString(),
      receivedAt: receivedAt.toISOString(),
      timeSource: 'received',
      senderUid: message.from?.rid || null,
      senderName: message.from?.name || '',
      content: message.content || '',
      rawPayload: message
    }
    try {
      await this.spool.enqueue(event)
    } catch (error) {
      this.logger.error?.({ error, roomId: room.id }, '写入本地持久化缓冲失败')
      await this.database.setRoomStatus(room.id, 'degraded', {
        reason: 'spool_write_failed', error: { message: error.message }
      }).catch(() => {})
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

module.exports = { CollectorSupervisor }
