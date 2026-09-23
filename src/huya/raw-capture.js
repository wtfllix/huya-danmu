const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const DEFAULT_DIR = '/tmp/opencode/gifts-live'
const DEFAULT_MAX_PACKETS = 200

// Raw capture is opt-in. 1400 keeps parse failures; 2001314 keeps packets
// while protocol layouts are being diagnosed.
const CAPTURE_POLICY = {
  1400: 'fail',
  2001314: 'all'
}

function envBoolean(value, fallback = false) {
  if (value === undefined || value === '') return fallback
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase())
}

function resolveCaptureOptions(options = {}) {
  return {
    enabled: options.enabled !== undefined
      ? Boolean(options.enabled)
      : envBoolean(process.env.HUYA_DEBUG_CAPTURE_ENABLED, false),
    dir: options.dir || process.env.HUYA_DEBUG_CAPTURE_DIR || DEFAULT_DIR,
    maxPackets: Number.isFinite(options.maxPackets) && options.maxPackets > 0
      ? Math.floor(options.maxPackets)
      : DEFAULT_MAX_PACKETS,
  }
}

function compactIso(date) {
  return date.toISOString().replace(/[-:]/g, '')
}

function toBuffer(payload) {
  if (payload == null) return null
  if (Buffer.isBuffer(payload)) return Buffer.from(payload)
  if (payload instanceof ArrayBuffer) return Buffer.from(payload)
  if (ArrayBuffer.isView(payload)) return Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength)
  return null
}

class RawPacketCapture {
  constructor(options = {}) {
    this.options = resolveCaptureOptions(options)
    this.logger = options.logger || console
    this.fs = options.fs || fs
    this.now = options.now || (() => new Date())
    this.randomId = options.randomId || (() => crypto.randomBytes(4).toString('hex'))
    this.broken = false
    this.dirReady = false
  }

  get enabled() {
    return this.options.enabled && !this.broken
  }

  policyFor(uri) {
    return CAPTURE_POLICY[String(uri)] || 'off'
  }

  shouldCaptureAll(uri) {
    return this.enabled && this.policyFor(uri) === 'all'
  }

  #ensureDir() {
    if (this.dirReady) return true
    try {
      this.fs.mkdirSync(this.options.dir, { recursive: true })
      this.dirReady = true
      return true
    } catch (error) {
      this.broken = true
      this.logger?.warn?.({ error, dir: this.options.dir }, 'raw capture 目录创建失败，已停用抓包')
      return false
    }
  }

  #baseName(uri, status) {
    const room = 'room' + String(this.roomId || 'unknown')
    return `${compactIso(this.now())}-${room}-uri${uri}-${status}-${this.randomId()}`
  }

  #writeBin(uri, roomId, payload, frameMeta = null) {
    const buffer = toBuffer(payload)
    if (!buffer) return null
    if (!this.#ensureDir()) return null
    this.roomId = roomId
    const base = this.#baseName(uri, 'pending')
    const binPath = path.join(this.options.dir, `${base}.bin`)
    try {
      this.fs.writeFileSync(binPath, buffer)
    } catch (error) {
      this.broken = true
      this.logger?.warn?.({ error, dir: this.options.dir }, 'raw capture 写盘失败，已停用抓包')
      return null
    }
    return {
      uri: Number(uri),
      roomId: String(roomId),
      capturedAt: this.now().toISOString(),
      payloadLength: buffer.length,
      frameMeta: frameMeta || null,
      dir: this.options.dir,
      base,
      binPath,
      status: 'pending'
    }
  }

  #renameTo(token, status) {
    const nextBase = token.base.replace(/-pending-/, `-${status}-`)
    if (nextBase === token.base) return token
    const nextPath = path.join(token.dir, `${nextBase}.bin`)
    try {
      this.fs.renameSync(token.binPath, nextPath)
      token.binPath = nextPath
      token.base = nextBase
      token.status = status
    } catch (error) {
      this.logger?.warn?.({ error }, 'raw capture 重命名失败')
      token.status = status
    }
    return token
  }

  #metadata(token, parseOk, error) {
    const tars = error?.tars || {}
    const metadata = {
      uri: token.uri,
      room_id: token.roomId,
      captured_at: token.capturedAt,
      payload_length: token.payloadLength,
      parse_ok: parseOk,
      error_name: error?.name || null,
      error_message: error?.message || null
    }
    if (!parseOk) {
      metadata.reader_offset = tars.offset ?? error?.offset ?? null
      metadata.last_tag = tars.tag ?? error?.tag ?? null
      metadata.last_type = tars.type ?? error?.type ?? null
      metadata.buffer_length = tars.bufferLength ?? null
      metadata.remaining_bytes = tars.remainingBytes ?? null
      metadata.expected_read_bytes = tars.expectedReadBytes ?? null
    }
    if (token.frameMeta) Object.assign(metadata, token.frameMeta)
    if (error?.paid) Object.assign(metadata, {
      path: error.paid.path,
      list_index: error.paid.listIndex,
      current_offset: error.paid.currentOffset,
      expected_tag: error.paid.expectedTag,
      expected_type: error.paid.expectedType,
      actual_tag: error.paid.actualTag,
      actual_type: error.paid.actualType
    })
    return metadata
  }

  #writeJson(token, parseOk, error) {
    if (!this.#ensureDir()) return
    const metadata = this.#metadata(token, parseOk, error)
    try {
      this.fs.writeFileSync(path.join(token.dir, `${token.base}.json`), `${JSON.stringify(metadata, null, 2)}\n`)
    } catch (writeError) {
      this.logger?.warn?.({ error: writeError }, 'raw capture metadata 写盘失败')
    }
  }

  // Called before business parsing for "all" policy URIs. Raw bytes hit disk first.
  start(uri, roomId, payload, frameMeta = null) {
    if (!this.shouldCaptureAll(uri)) return null
    return this.#writeBin(uri, roomId, payload, frameMeta)
  }

  // Called after parsing to record the outcome and finalise the ok/fail name.
  finish(token, { parseOk, error = null } = {}) {
    if (!token) return null
    this.#renameTo(token, parseOk ? 'ok' : 'fail')
    this.#writeJson(token, Boolean(parseOk), error)
    this.#cleanup(token.uri, parseOk ? 'ok' : 'fail')
    return token
  }

  // Called when a "fail" policy URI throws.
  failure(uri, roomId, payload, error, frameMeta = null) {
    if (!this.enabled || this.policyFor(uri) !== 'fail') return null
    const token = this.#writeBin(uri, roomId, payload, frameMeta)
    if (!token) return null
    this.#renameTo(token, 'fail')
    this.#writeJson(token, false, error)
    this.#cleanup(uri, 'fail')
    return token
  }

  #cleanup(uri, status) {
    const policy = this.policyFor(uri)
    if (policy !== 'all') return
    let entries
    try {
      entries = this.fs.readdirSync(this.options.dir)
    } catch (error) {
      this.logger?.warn?.({ error }, 'raw capture 目录读取失败')
      return
    }
    const marker = `-uri${uri}-`
    const bins = entries.filter(name => name.endsWith('.bin') && name.includes(marker)).sort()
    const excess = bins.length - this.options.maxPackets
    for (let index = 0; index < excess; index++) {
      const bin = bins[index]
      const json = bin.replace(/\.bin$/, '.json')
      for (const file of [bin, json]) {
        try { this.fs.unlinkSync(path.join(this.options.dir, file)) } catch (_) { /* best effort */ }
      }
    }
  }
}

module.exports = {
  RawPacketCapture,
  resolveCaptureOptions,
  compactIso,
  DEFAULT_DIR,
  DEFAULT_MAX_PACKETS,
  CAPTURE_POLICY
}
