// huya-danmu v3 — 虎牙直播弹幕监听(双协议自适应)
//
// 默认协议(推荐):新协议 wsLaunch(WUP) → registerGroup(命令16)
//   —— 只依赖 lUid,任何房间可用;弹幕/礼物/人气全功能
// 可选协议:opt.protocol = 'legacy' 时用老协议 RegisterReq(命令1)
//   —— 单包进组更轻量,但**收不到礼物消息**(服务器不推送 6501)
//
// 消息推送 —— 命令7(V1) / 命令22(V2),URI: 1400=弹幕 6501=礼物 8006=人气
// 心跳     —— 命令20 → 回包21,每 60s
//
// 与原版 API 完全兼容:
//   new huya_danmu(roomid | {roomid, proxy, protocol?})
//   client.on('connect' | 'message' | 'error' | 'close')
//   client.start() / client.stop()
const ws = require('ws')
const https = require('https')
const zlib = require('zlib')
const crypto = require('crypto')
const { EventEmitter } = require('events')
const { Taf, HUYA } = require('./lib')
const { RawPacketCapture } = require('./src/huya/raw-capture')

// ---- TARS reader 诊断补丁:读取越界时附加 offset/length/tag/type 上下文 ----
// 只改变错误对象,不改变正常读取语义,也不吞掉原始 stack。
let lastTarsHeader = null

function buildTarsReaderError(buffer, offset, expectedReadBytes, cause) {
  const bufferLength = buffer.length
  const remainingBytes = Math.max(0, bufferLength - offset)
  const context = {
    bufferLength,
    offset,
    remainingBytes,
    expectedReadBytes,
    tag: lastTarsHeader?.tag ?? null,
    type: lastTarsHeader?.type ?? null
  }
  const error = new Error(
    `TARS read failed: bufferLength=${bufferLength} offset=${offset} remaining=${remainingBytes} ` +
    `expected=${expectedReadBytes} tag=${context.tag} type=${context.type} cause=${cause.message}`
  )
  error.name = 'TarsReaderError'
  error.cause = cause
  error.tars = context
  if (cause.stack) error.stack = `${error.stack}\nCaused by: ${cause.stack}`
  return error
}

function isBoundsError(error) {
  return error instanceof RangeError || /outside the bounds|Invalid/.test(String(error.message))
}

function installTarsReaderDiagnostics() {
  if (installTarsReaderDiagnostics.installed) return
  installTarsReaderDiagnostics.installed = true
  const { BinBuffer, JceInputStream } = Taf
  const fixedSizes = {
    readInt8: 1,
    readUInt8: 1,
    readInt16: 2,
    readUInt16: 2,
    readInt32: 4,
    readUInt32: 4,
    readInt64: 8,
    readInt64String: 8,
    readFloat: 4,
    readDouble: 8
  }
  for (const [name, expectedReadBytes] of Object.entries(fixedSizes)) {
    const original = BinBuffer.prototype[name]
    if (typeof original !== 'function') continue
    BinBuffer.prototype[name] = function (...args) {
      const offset = this.position
      try {
        return original.apply(this, args)
      } catch (error) {
        if (!isBoundsError(error)) throw error
        throw buildTarsReaderError(this, offset, expectedReadBytes, error)
      }
    }
  }
  const originalSkip = BinBuffer.prototype.skip
  BinBuffer.prototype.skip = function (bytes) {
    const offset = this.position
    try {
      return originalSkip.call(this, bytes)
    } catch (error) {
      if (!isBoundsError(error)) throw error
      throw buildTarsReaderError(this, offset, bytes, error)
    }
  }
  for (const name of ['readString', 'readBytes']) {
    const original = BinBuffer.prototype[name]
    if (typeof original !== 'function') continue
    BinBuffer.prototype[name] = function (...args) {
      const offset = this.position
      try {
        return original.apply(this, args)
      } catch (error) {
        if (!isBoundsError(error)) throw error
        throw buildTarsReaderError(this, offset, null, error)
      }
    }
  }
  const originalReadFrom = JceInputStream.prototype.readFrom
  JceInputStream.prototype.readFrom = function (...args) {
    const field = originalReadFrom.apply(this, args)
    lastTarsHeader = { tag: field.tag, type: field.type }
    return field
  }
  const originalReadBytes = JceInputStream.prototype.readBytes
  JceInputStream.prototype.readBytes = function (...args) {
    const result = originalReadBytes.apply(this, args)
    if (result instanceof BinBuffer && result !== args[2]) {
      Object.defineProperty(result, '__tarsMeta', {
        configurable: true,
        enumerable: false,
        value: {
          declaredLength: result.length,
          capturedLength: result.length,
          payloadStartOffset: this.buf.position - result.length,
          payloadEndOffset: this.buf.position,
          sourceBufferLength: this.buf.length
        }
      })
    }
    return result
  }
}

installTarsReaderDiagnostics()


// ---- Taf.Wup.readFrom 补丁:新版响应带 context/status map,需要默认 Map 类 ----
Taf.Wup.prototype.readFrom = function (t) {
  this.iVersion = t.readInt16(1, true)
  this.cPacketType = t.readInt8(2, true)
  this.iMessageType = t.readInt32(3, true)
  this.iRequestId = t.readInt32(4, true)
  this.sServantName = t.readString(5, true)
  this.sFuncName = t.readString(6, true)
  this.sBuffer = t.readBytes(7, true)
  this.iTimeout = t.readInt32(8, true)
  this.context = t.readMap(9, true, new Taf.Map(new Taf.STRING, new Taf.STRING))
  this.status = t.readMap(10, true, new Taf.Map(new Taf.STRING, new Taf.STRING))
}

// WebSocketCommand 类型
const CMD = {
  RegisterReq: 1,          // 老协议:WSUserInfo 绑定
  RegisterRsp: 2,
  WupReq: 3,               // WUP 请求(wsLaunch / getPropsList)
  WupRsp: 4,
  S2C_MsgPushReq: 7,       // 消息推送 V1
  C2S_RegisterGroupReq: 16, // 新协议:注册弹幕组
  S2C_RegisterGroupRsp: 17,
  C2S_HeartBeatReq: 20,    // 心跳
  S2C_HeartBeatRsp: 21,
  S2C_MsgPushReq_V2: 22,   // 消息推送 V2
}

// 消息 URI
const URI = { CHAT: 1400, GIFT: 6501, PAID_MESSAGE: 2001314, ONLINE: 8006 }

const WS_URL = 'ws://ws.api.huya.com'
const WSS_URL = 'wss://cdnws.api.huya.com'
const HEARTBEAT_INTERVAL = 60000
const HANDSHAKE_TIMEOUT = 15000
const MAX_PAGE_SIZE = 5 * 1024 * 1024
const UA = 'Mozilla/5.0 (Linux; Android 6.0; Nexus 5 Build/MRA58N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/79.0.3945.88 Mobile Safari/537.36'

function toAB(b) { return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) }
function md5(s) { return crypto.createHash('md5').update(String(s)).digest('hex') }

function frameMetadata(frameLength, commandBuffer, payloadBuffer) {
  const command = commandBuffer?.__tarsMeta || {}
  const payload = payloadBuffer?.__tarsMeta || {}
  return {
    frameDeclaredLength: command.declaredLength ?? null,
    actualFrameLength: frameLength ?? null,
    payloadDeclaredLength: payload.declaredLength ?? null,
    capturedPayloadLength: payload.capturedLength ?? payloadBuffer?.byteLength ?? payloadBuffer?.length ?? null,
    payloadStartOffset: payload.payloadStartOffset ?? null,
    payloadEndOffset: payload.payloadEndOffset ?? null
  }
}

function readInt64String(t, tag, required = false, fallback = '0') {
  if (!t.skipToTag(tag, required)) return fallback
  const field = t.readFrom()
  switch (field.type) {
    case Taf.DataHelp.EN_ZERO: return '0'
    case Taf.DataHelp.EN_INT8: return String(t.buf.readInt8())
    case Taf.DataHelp.EN_INT16: return String(t.buf.readInt16())
    case Taf.DataHelp.EN_INT32: return String(t.buf.readInt32())
    case Taf.DataHelp.EN_INT64: return t.buf.readInt64String()
    default: throw new Error(`read int64 string type mismatch, tag:${tag}, get type:${field.type}`)
  }
}

function fieldType(t, tag) {
  const position = t.buf.position
  try {
    return t.skipToTag(tag, false) ? t.peekFrom().type : null
  } finally {
    t.buf.position = position
  }
}

function readStringField(t, tag) {
  const type = fieldType(t, tag)
  if (type === Taf.DataHelp.EN_STRING1 || type === Taf.DataHelp.EN_STRING4) {
    return t.readString(tag, false, '')
  }
  return ''
}

const INTEGER_TYPES = new Set([
  Taf.DataHelp.EN_ZERO,
  Taf.DataHelp.EN_INT8,
  Taf.DataHelp.EN_INT16,
  Taf.DataHelp.EN_INT32,
  Taf.DataHelp.EN_INT64
])
const STRING_TYPES = new Set([Taf.DataHelp.EN_STRING1, Taf.DataHelp.EN_STRING4])

function logGiftFieldIssue(logger, details, message) {
  if (logger?.debug) logger.debug(details, message)
  else logger?.warn?.(details, message)
}

function skipCurrentField(t) {
  const field = t.readFrom()
  t.skipField(field.type)
  return field
}

function safeGiftField(t, tag, types, fallback, reader, logger, fieldName) {
  const start = t.buf.position
  try {
    if (!t.skipToTag(tag, false)) return fallback
    const field = t.peekFrom()
    if (!types.has(field.type)) {
      const skipped = skipCurrentField(t)
      logGiftFieldIssue(logger, {
        tag, field: fieldName, expectedTypes: [...types], actualType: skipped.type,
        offset: start
      }, '6501 字段类型不匹配，已跳过')
      return fallback
    }
    return reader()
  } catch (error) {
    const position = t.buf.position
    try {
      t.buf.position = start
      if (t.skipToTag(tag, false)) skipCurrentField(t)
    } catch (_) { /* malformed optional field cannot be recovered further */ }
    logGiftFieldIssue(logger, {
      tag, field: fieldName, offset: position,
      error: error.message
    }, '6501 字段读取失败，已跳过')
    return fallback
  }
}

function safeGiftInt32(t, tag, fallback, logger, fieldName) {
  return safeGiftField(t, tag, INTEGER_TYPES, fallback,
    () => t.readInt32(tag, false, fallback), logger, fieldName)
}

function safeGiftInt64String(t, tag, fallback, logger, fieldName) {
  return safeGiftField(t, tag, INTEGER_TYPES, fallback,
    () => readInt64String(t, tag, false, fallback), logger, fieldName)
}

function safeGiftString(t, tag, fallback, logger, fieldName) {
  return safeGiftField(t, tag, STRING_TYPES, fallback,
    () => t.readString(tag, false, fallback), logger, fieldName)
}

function safeSkipGiftField(t, tag, logger, fieldName) {
  return safeGiftField(t, tag, new Set([
    Taf.DataHelp.EN_ZERO,
    Taf.DataHelp.EN_INT8,
    Taf.DataHelp.EN_INT16,
    Taf.DataHelp.EN_INT32,
    Taf.DataHelp.EN_INT64,
    Taf.DataHelp.EN_FLOAT,
    Taf.DataHelp.EN_DOUBLE,
    Taf.DataHelp.EN_STRING1,
    Taf.DataHelp.EN_STRING4,
    Taf.DataHelp.EN_STRUCTBEGIN,
    Taf.DataHelp.EN_MAP,
    Taf.DataHelp.EN_SIMPLELIST,
    Taf.DataHelp.EN_LIST
  ]), undefined, () => skipCurrentField(t), logger, fieldName)
}

function safeGiftStruct(t, tag, fallback, reader, logger, fieldName) {
  return safeGiftField(t, tag, new Set([Taf.DataHelp.EN_STRUCTBEGIN]), fallback,
    () => t.readStruct(tag, false, { readFrom: reader }), logger, fieldName)
}

function skipGiftRemainder(t, logger) {
  while (t.buf.position < t.buf.length) {
    const start = t.buf.position
    try {
      const field = t.peekFrom()
      if (field.type === Taf.DataHelp.EN_STRUCTEND) {
        t.readFrom()
        return
      }
      skipCurrentField(t)
    } catch (error) {
      logGiftFieldIssue(logger, { offset: start, error: error.message }, '6501 未知字段跳过失败')
      return
    }
  }
}

function readerFieldAt(t) {
  if (t?.buf?.position < t.buf.length) {
    try { return t.peekFrom() } catch (_) { /* keep the last observed header */ }
  }
  return lastTarsHeader ? { ...lastTarsHeader } : null
}

function annotatePaidParseError(error, stream, context = {}) {
  const field = readerFieldAt(stream)
  const currentOffset = stream?.buf?.position ?? null
  const bufferLength = stream?.buf?.length ?? null
  const paid = {
    path: context.path || null,
    listIndex: context.listIndex ?? null,
    currentOffset,
    bufferLength,
    remainingBytes: bufferLength == null || currentOffset == null ? null : Math.max(0, bufferLength - currentOffset),
    expectedTag: context.expectedTag ?? null,
    expectedType: context.expectedType ?? null,
    actualTag: field?.tag ?? null,
    actualType: field?.type ?? null
  }
  error.paid = paid
  error.path = paid.path
  error.listIndex = paid.listIndex
  error.currentOffset = paid.currentOffset
  return error
}

function paidRead(stream, diagnostics, tag, expectedType, reader) {
  const path = `${diagnostics.basePath || diagnostics.path}.tag${tag}`
  try {
    return reader()
  } catch (error) {
    throw annotatePaidParseError(error, stream, {
      path,
      listIndex: diagnostics.listIndex,
      expectedTag: tag,
      expectedType
    })
  }
}

function paidReadPath(stream, diagnostics, path, expectedTag, expectedType, reader) {
  try {
    return reader()
  } catch (error) {
    throw annotatePaidParseError(error, stream, {
      path,
      listIndex: diagnostics.listIndex,
      expectedTag,
      expectedType
    })
  }
}

function readStructVector(t, tag, factory, options = {}) {
  if (!t.skipToTag(tag, false)) return []
  const field = t.readFrom()
  if (field.type !== Taf.DataHelp.EN_LIST) throw new Error(`read vector type mismatch, tag:${tag}`)
  const count = t.readInt32(0, true, 0)
  const result = []
  for (let index = 0; index < count; index++) {
    const itemDiagnostics = options.diagnostics
      ? { ...options.diagnostics, listIndex: index, path: `${options.path || `root.tag${tag}`}[${index}]` }
      : null
    try {
      const value = factory(index, itemDiagnostics)
      t.readStruct(0, true, value)
      result.push(value)
    } catch (error) {
      throw annotatePaidParseError(error, t, {
        path: itemDiagnostics?.path || `${options.path || `root.tag${tag}`}[${index}]`,
        listIndex: index,
        expectedTag: 0,
        expectedType: Taf.DataHelp.EN_STRUCTBEGIN
      })
    }
  }
  return result
}

function readScalar(t, tag) {
  const field = t.readFrom()
  switch (field.type) {
    case Taf.DataHelp.EN_STRING1: return t.buf.readString(t.buf.readUInt8())
    case Taf.DataHelp.EN_STRING4: return t.buf.readString(t.buf.readUInt32())
    case Taf.DataHelp.EN_ZERO: return 0
    case Taf.DataHelp.EN_INT8: return t.buf.readInt8()
    case Taf.DataHelp.EN_INT16: return t.buf.readInt16()
    case Taf.DataHelp.EN_INT32: return t.buf.readInt32()
    case Taf.DataHelp.EN_INT64: return t.buf.readInt64String()
    default: throw new Error(`unsupported scalar map value at tag:${tag}`)
  }
}

function readScalarMap(t, tag) {
  if (!t.skipToTag(tag, false)) return {}
  const field = t.readFrom()
  if (field.type !== Taf.DataHelp.EN_MAP) throw new Error(`read map type mismatch, tag:${tag}`)
  const count = t.readInt32(0, true, 0)
  const result = {}
  for (let index = 0; index < count; index++) {
    const key = readScalar(t, 0)
    const value = readScalar(t, 1)
    result[String(key)] = value
  }
  return result
}

function readUriPayload(ab, readValue) {
  const stream = new Taf.JceInputStream(ab)
  try {
    const first = stream.peekFrom()
    if (first.tag === 0 && first.type !== Taf.DataHelp.EN_STRUCTBEGIN && first.type !== Taf.DataHelp.EN_LIST) {
      const position = stream.buf.position
      const outerId = readInt64String(stream, 0, false, null)
      if (stream.skipToTag(1, false) && stream.peekFrom().type === Taf.DataHelp.EN_STRUCTBEGIN) {
        const value = { readFrom(inner) { Object.assign(this, readValue(inner)) } }
        stream.readStruct(1, true, value)
        return { value, outerId }
      }
      stream.buf.position = position
    }
    return { value: readValue(stream), outerId: null, stream }
  } catch (error) {
    if (error.offset === undefined) error.offset = stream.buf.position
    throw error
  }
}

function parseUserInfo(t) {
  const user = {}
  user.lUid = readInt64String(t, 0, false, '0')
  user.lImid = readInt64String(t, 1, false, '0')
  user.sNickName = t.readString(2, false, '')
  user.iGender = t.readInt32(3, false, 0)
  user.sAvatarUrl = t.readString(4, false, '')
  user.iNobleLevel = t.readInt32(5, false, 0)
  return user
}

function parseFansBadge(bytes) {
  if (!bytes) return null
  try {
    const t = new Taf.JceInputStream(bytes)
    const badge = {
      lBadgeId: readInt64String(t, 0, false, '0'),
      sBadgeName: t.readString(1, false, ''),
      iBadgeLevel: t.readInt32(2, false, 0),
      iCustomBadgeFlag: t.readInt32(3, false, 0),
      tSuperFansInfo: null,
      tExternal: null
    }
    if (fieldType(t, 4) === Taf.DataHelp.EN_STRUCTBEGIN) {
      badge.tSuperFansInfo = t.readStruct(4, false, { readFrom(inner) {
        this.iSuperFansLevel = inner.readInt32(0, false, 0)
        this.iLevel = inner.readInt32(1, false, this.iSuperFansLevel)
      } })
    }
    if (fieldType(t, 5) === Taf.DataHelp.EN_STRUCTBEGIN) {
      badge.tExternal = t.readStruct(5, false, { readFrom(inner) {
        this.iFansIdentity = inner.readInt32(0, false, 0)
      } })
    }
    return {
      anchor_uid: null,
      name: badge.sBadgeName,
      level: badge.iBadgeLevel,
      custom: Boolean(badge.iCustomBadgeFlag),
      fans_identity: badge.tExternal?.iFansIdentity || 0,
      super_fans_level: badge.tSuperFansInfo?.iSuperFansLevel || badge.tSuperFansInfo?.iLevel || 0,
      badge_id: badge.lBadgeId
    }
  } catch (_) {
    return null
  }
}

function parseChatValue(t) {
  const chat = {}
  chat.tUserInfo = t.readStruct(0, false, { readFrom(inner) { Object.assign(this, parseUserInfo(inner)) } })
  chat.lTid = readInt64String(t, 1, false, '0')
  chat.lSid = readInt64String(t, 2, false, '0')
  chat.sContent = t.readString(3, false, '')
  chat.vDecorationPrefix = readStructVector(t, 8, () => ({ readFrom(inner) {
    this.iAppId = inner.readInt32(0, false, 0)
    this.iViewType = inner.readInt32(1, false, 0)
    this.vData = inner.readBytes(2, false, null)
  } }))
  chat.lPid = readInt64String(t, 11, false, '0')
  chat.sMessageId = readStringField(t, 20) || readStringField(t, 12)
  return chat
}

function parseGiftValueLayout(t, logger, legacy = false) {
  const gift = {}
  gift.iItemType = safeGiftInt32(t, 0, 0, logger, 'iItemType')
  gift.strPayId = safeGiftString(t, 1, '', logger, 'strPayId')
  gift.iItemCount = safeGiftInt32(t, 2, 0, logger, 'iItemCount')
  gift.lPresenterUid = safeGiftInt64String(t, 3, '0', logger, 'lPresenterUid')
  gift.lSenderUid = safeGiftInt64String(t, 4, '0', logger, 'lSenderUid')
  gift.sPresenterNick = safeGiftString(t, 5, '', logger, 'sPresenterNick')
  gift.sSenderNick = safeGiftString(t, 6, '', logger, 'sSenderNick')
  gift.iSenderIcon = safeGiftString(t, 14, '', logger, 'iSenderIcon')

  gift.sPropsName = safeGiftString(t, 20, '', logger, 'sPropsName')
  if (legacy) {
    gift.lRoomId = safeGiftInt64String(t, 21, '0', logger, 'lRoomId')
    gift.iPayType = safeGiftInt32(t, 22, 0, logger, 'iPayType')
    gift.iNobleLevel = safeGiftInt32(t, 23, 0, logger, 'iNobleLevel')
    gift.tEffectInfo = safeGiftStruct(t, 24, { iPriceLevel: 0 }, function (inner) {
      this.iPriceLevel = safeGiftInt32(inner, 0, 0, logger, 'tEffectInfo.iPriceLevel')
    }, logger, 'tEffectInfo') || { iPriceLevel: 0 }
    gift.lComboSeqId = safeGiftInt64String(t, 25, '0', logger, 'lComboSeqId')
    gift.lPayTotal = safeGiftInt64String(t, 26, '0', logger, 'lPayTotal')
  } else {
    // New live layout: tag 23 is a struct and tag 24 is lRoomId.
    safeSkipGiftField(t, 21, logger, 'iAccpet')
    safeSkipGiftField(t, 22, logger, 'iEventType')
    safeSkipGiftField(t, 23, logger, 'userInfo')
    gift.lRoomId = safeGiftInt64String(t, 24, '0', logger, 'lRoomId')
    safeSkipGiftField(t, 25, logger, 'lHomeOwnerUid')
    safeSkipGiftField(t, 26, logger, 'streamerInfo')
    gift.iPayType = safeGiftInt32(t, 27, 0, logger, 'iPayType')
    gift.iNobleLevel = safeGiftInt32(t, 28, 0, logger, 'iNobleLevel')
    safeSkipGiftField(t, 29, logger, 'tNobleLevel')
    gift.tEffectInfo = safeGiftStruct(t, 30, { iPriceLevel: 0 }, function (inner) {
      this.iPriceLevel = safeGiftInt32(inner, 0, 0, logger, 'tEffectInfo.iPriceLevel')
    }, logger, 'tEffectInfo') || { iPriceLevel: 0 }
    safeSkipGiftField(t, 31, logger, 'vExUid')
    safeSkipGiftField(t, 32, logger, 'iComboStatus')
    safeSkipGiftField(t, 33, logger, 'iPidColorType')
    safeSkipGiftField(t, 34, logger, 'iMultiSend')
    safeSkipGiftField(t, 35, logger, 'iVFanLevel')
    safeSkipGiftField(t, 36, logger, 'iUpgradeLevel')
    safeSkipGiftField(t, 37, logger, 'sCustomText')
    safeSkipGiftField(t, 38, logger, 'tDIYEffect')
    gift.lComboSeqId = safeGiftInt64String(t, 39, '0', logger, 'lComboSeqId')
    safeSkipGiftField(t, 40, logger, 'reserved')
    gift.lPayTotal = safeGiftInt64String(t, 41, '0', logger, 'lPayTotal')
    safeSkipGiftField(t, 42, logger, 'vBizData')
  }
  skipGiftRemainder(t, logger)
  return gift
}

function parseGiftValue(t, logger = console) {
  // Keep compatibility with the old generated struct while making the live
  // layout (tag 23 struct, tag 24 room id, tag 41 pay total) authoritative.
  const legacyLayout = INTEGER_TYPES.has(fieldType(t, 23))
  return parseGiftValueLayout(t, logger, legacyLayout)
}

function parsePaidMessageValue(t, diagnostics = { path: 'root' }) {
  const basePath = diagnostics.path
  const totalSecType = fieldType(t, 3)
  let tags
  if (INTEGER_TYPES.has(totalSecType)) {
    tags = { totalSec: 3, countDown: 4, offset: 5, ext: 6, messageId: 7, target: 8, level: 9, costPay: 10, targetRoomId: 2 }
  } else if (STRING_TYPES.has(totalSecType)) {
    tags = { totalSec: 4, countDown: 5, offset: 6, ext: 8, messageId: 9, target: 10, level: 11, costPay: 12, targetRoomId: 3 }
  } else {
    throw annotatePaidParseError(
      new Error(`unsupported 2001314 item layout: tag 3 type ${totalSecType}`),
      t,
      { path: `${basePath}.tag3`, listIndex: diagnostics.listIndex, expectedTag: 3, expectedType: 'INTEGER|STRING' }
    )
  }
  const item = {}
  const userPath = `${basePath}.tag0`
  item.tMessageUser = paidReadPath(t, diagnostics, userPath, 0, 'STRUCT_BEGIN', () =>
    t.readStruct(0, false, { readFrom(inner) {
      this.lUid = paidReadPath(inner, diagnostics, `${userPath}.tag0`, 0, 'INTEGER', () =>
        readInt64String(inner, 0, false, '0'))
      this.sNick = paidReadPath(inner, diagnostics, `${userPath}.tag1`, 1, 'STRING1|STRING4', () =>
        inner.readString(1, false, ''))
      if (!this.sNick) this.sNick = paidReadPath(inner, diagnostics, `${userPath}.tag2`, 2, 'STRING1|STRING4', () =>
        inner.readString(2, false, ''))
      this.sAvatar = paidReadPath(inner, diagnostics, `${userPath}.tag2`, 2, 'STRING1|STRING4', () =>
        inner.readString(2, false, ''))
      if (!this.sAvatar) this.sAvatar = paidReadPath(inner, diagnostics, `${userPath}.tag4`, 4, 'STRING1|STRING4', () =>
        inner.readString(4, false, ''))
    } }))
  item.sContent = paidRead(t, { ...diagnostics, basePath }, 1, 'STRING1|STRING4', () => t.readString(1, false, ''))
  item.iCost = paidRead(t, { ...diagnostics, basePath }, 2, 'INTEGER', () => t.readInt32(2, false, 0))
  item.iTotalSec = paidRead(t, { ...diagnostics, basePath }, tags.totalSec, 'INTEGER', () => t.readInt32(tags.totalSec, false, 0))
  item.iCountDown = paidRead(t, { ...diagnostics, basePath }, tags.countDown, 'INTEGER', () => t.readInt32(tags.countDown, false, 0))
  item.sOffset = paidRead(t, { ...diagnostics, basePath }, tags.offset, 'STRING1|STRING4', () => t.readString(tags.offset, false, ''))
  item.mExt = paidRead(t, { ...diagnostics, basePath }, tags.ext, 'MAP', () => readScalarMap(t, tags.ext))
  item.lMessageId = paidRead(t, { ...diagnostics, basePath }, tags.messageId, 'INTEGER', () =>
    readInt64String(t, tags.messageId, false, '0'))
  const targetPath = `${basePath}.tag${tags.target}`
  item.tTarUser = paidReadPath(t, diagnostics, targetPath, tags.target, 'STRUCT_BEGIN', () =>
    t.readStruct(tags.target, false, { readFrom(inner) {
      this.lUid = paidReadPath(inner, diagnostics, `${targetPath}.tag0`, 0, 'INTEGER', () =>
        readInt64String(inner, 0, false, '0'))
      this.sNick = paidReadPath(inner, diagnostics, `${targetPath}.tag1`, 1, 'STRING1|STRING4', () =>
        inner.readString(1, false, ''))
      this.lRoomId = paidReadPath(inner, diagnostics, `${targetPath}.tag${tags.targetRoomId}`,
        tags.targetRoomId, 'INTEGER', () => readInt64String(inner, tags.targetRoomId, false, '0'))
    } }))
  item.iLevel = paidRead(t, { ...diagnostics, basePath }, tags.level, 'INTEGER', () => t.readInt32(tags.level, false, 0))
  item.iCostPay = paidRead(t, { ...diagnostics, basePath }, tags.costPay, 'INTEGER', () => t.readInt32(tags.costPay, false, 0))
  return item
}

function parsePaidMessageItems(stream, diagnostics = null) {
  diagnostics ||= { items: [] }
  const itemFactory = (_index, itemDiagnostics) => ({ readFrom(inner) {
    Object.assign(this, parsePaidMessageValue(inner, itemDiagnostics))
  } })
  const first = stream.peekFrom()
  if (first.tag === 0 && first.type === Taf.DataHelp.EN_LIST) {
    return readStructVector(stream, 0, itemFactory, { diagnostics, path: 'root.tag0' })
  }
  if (first.tag === 0 && first.type === Taf.DataHelp.EN_STRUCTBEGIN) {
    skipCurrentField(stream)
    if (stream.buf.position >= stream.buf.length) {
      throw new Error('unsupported 2001314 layout: missing top-level tag 1 list')
    }
    const itemsField = stream.peekFrom()
    if (itemsField.tag !== 1 || itemsField.type !== Taf.DataHelp.EN_LIST) {
      throw new Error(
        `unsupported 2001314 layout: expected top-level tag 1 list, got tag ${itemsField.tag} type ${itemsField.type}`
      )
    }
    return readStructVector(stream, 1, itemFactory, { diagnostics, path: 'root.tag1' })
  }
  throw new Error(`unsupported 2001314 layout: top-level tag ${first.tag} type ${first.type}`)
}

class huya_danmu extends EventEmitter {
  constructor(opt) {
    super()
    const options = (opt && typeof opt === 'object' && !Array.isArray(opt)) ? opt : {}
    if (typeof opt === 'string' || typeof opt === 'number') {
      this._roomid = String(opt)
    } else if (opt && typeof opt === 'object' && !Array.isArray(opt)) {
      this._roomid = String(opt.roomid || '')
      if (opt.proxy) this._proxy = opt.proxy
      if (opt.protocol === 'legacy') this._protocol = 'legacy'
      if (opt.wsUrl) this._ws_url = opt.wsUrl
      this._logger = opt.logger || console
    }
    if (!this._roomid) throw new TypeError('roomid 必须是非空字符串或数字')
    this._ws_url = this._ws_url || WSS_URL
    this._logger = this._logger || console
    this._capture = new RawPacketCapture({ ...(options.debugCapture || {}), logger: this._logger })
    this._gift_info = {}      // 礼物 id → {name, price}
    this._starting = false
    this._stopped = false
    this._retry = 0           // 重连退避计数
  }

  // ================= 页面信息 =================

  _fetch(url) {
    return new Promise((resolve, reject) => {
      const req = https.get(url, { headers: { 'User-Agent': UA, 'Accept-Encoding': 'gzip, deflate, br' } }, res => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          res.resume()
          reject(new Error(`虎牙页面请求失败: HTTP ${res.statusCode}`))
          return
        }
        const chunks = []
        let size = 0
        res.on('data', c => {
          size += c.length
          if (size > MAX_PAGE_SIZE) {
            req.destroy(new Error('虎牙页面响应超过 5 MB'))
            return
          }
          chunks.push(c)
        })
        res.on('end', () => {
          try {
            let buf = Buffer.concat(chunks)
            const options = { maxOutputLength: MAX_PAGE_SIZE }
            switch (String(res.headers['content-encoding'] || '').trim().toLowerCase()) {
              case 'gzip': buf = zlib.gunzipSync(buf, options); break
              case 'deflate': buf = zlib.inflateSync(buf, options); break
              case 'br': buf = zlib.brotliDecompressSync(buf, options); break
            }
            if (buf.length > MAX_PAGE_SIZE) throw new Error('虎牙页面响应超过 5 MB')
            resolve(buf.toString('utf8'))
          } catch (error) {
            reject(error)
          }
        })
      })
      req.on('error', reject)
      req.setTimeout(15000, () => req.destroy(new Error('request timeout')))
    })
  }

  // 从新版页面提取房间信息:
  //   lUid/lYyid —— 任何房间都有(主播身份)
  //   lChannelId/lSubChannelId —— 仅开播房间有(直播流频道)
  async _get_room_info() {
    const body = await this._fetch(`https://m.huya.com/${this._roomid}`)
    const find = kw => {
      const m = body.match(new RegExp('"' + kw + '"\\s*:\\s*(\\d+)'))
      return m ? m[1] : '0'
    }
    const info = {
      lUid: find('lUid') !== '0' ? find('lUid') : find('lYyid'),
      lChannelId: find('lChannelId'),
      lSubChannelId: find('lSubChannelId'),
    }
    if (!info.lUid || info.lUid === '0') throw new Error('无法从页面获取主播 uid,房间可能不存在')
    return info
  }

  // ================= 生命周期 =================

  async start() {
    if (this._starting || (this._client && this._client.readyState < ws.CLOSING)) return
    this._starting = true
    this._stopped = false
    try {
      this._info = await this._get_room_info()
    } catch (e) {
      this._starting = false
      this.emit('error', e)
      this.emit('close')
      return
    }
    this._connect()
  }

  _connect() {
    this._starting = true
    const opt = { perMessageDeflate: false }
    if (this._proxy) {
      const { SocksProxyAgent } = require('socks-proxy-agent')
      opt.agent = new SocksProxyAgent(this._proxy)
    }
    const client = new ws(this._ws_url, opt)
    this._client = client
    client.on('open', () => this._on_open())
    client.on('message', data => this._on_message(data))
    client.on('error', err => this.emit('error', err))
    client.on('close', () => this._on_close())
  }

  _on_open() {
    // 协议选择:默认新协议(全功能);legacy 需房间在播(有 lChannelId)
    if (this._protocol === 'legacy' && this._info.lChannelId !== '0' && this._info.lSubChannelId !== '0') {
      this._handshake_mode = 'legacy'
      this._handshake_legacy()
    } else {
      this._handshake_mode = 'new'
      this._handshake_new()
    }
    this.emit('connect')
    clearTimeout(this._handshake_timer)
    this._handshake_timer = setTimeout(() => {
      const error = new Error('虎牙协议握手超时')
      error.code = 'HUYA_HANDSHAKE_TIMEOUT'
      this.emit('error', error)
      if (this._client) this._client.terminate()
    }, HANDSHAKE_TIMEOUT)
    clearInterval(this._heartbeat_timer)
    this._heartbeat_timer = setInterval(() => this._heartbeat(), HEARTBEAT_INTERVAL)
  }

  // ================= 握手:老协议(RegisterReq) =================
  // 单包绑定 WSUserInfo,real-url 等长期使用的方案,最轻量
  // 注意:此模式收不到礼物消息(6501),仅弹幕+人气
  _handshake_legacy() {
    const info = new HUYA.WSUserInfo()
    info.lUid = this._info.lUid
    info.bAnonymous = true
    info.sGuid = ''
    info.sToken = ''
    info.lTid = this._info.lChannelId
    info.lSid = this._info.lSubChannelId
    info.lGroupId = 0
    info.lGroupType = 0
    const j = new Taf.JceOutputStream()
    info.writeTo(j)
    this._send_ws_cmd(CMD.RegisterReq, j.getBinBuffer())
  }

  // ================= 握手:新协议(wsLaunch + registerGroup) =================
  // 官方 web 客户端当前方案,只依赖 lUid,未开播房间也能注册
  _handshake_new() {
    const wup = new Taf.Wup()
    wup.setServant('launch')
    wup.setFunc('wsLaunch')
    wup.setRequestId(1)
    wup.writeStruct('tReq', this._make_launch_req())
    this._send_ws_cmd(CMD.WupReq, wup.encode())
  }

  _make_launch_req() {
    const r = {}
    r.lUid = this._info.lUid
    r.sGuid = ''
    r.sUA = 'webh5&1.0.0&websocket'
    r.sAppSrc = ''
    r.tDeviceInfo = {}
    r.tDeviceInfo.writeTo = function (t) { for (let i = 0; i < 5; i++) t.writeString(i, '') }
    r.writeTo = function (t) {
      t.writeInt64(0, this.lUid)
      t.writeString(1, this.sGuid)
      t.writeString(2, this.sUA)
      t.writeString(3, this.sAppSrc)
      t.writeStruct(4, this.tDeviceInfo)
    }
    return r
  }

  _register_group() {
    const g = {}
    g.vGroupId = [`live:${this._info.lUid}`, `chat:${this._info.lUid}`]
    g.sToken = ''
    g.writeTo = function (t) {
      t.writeTo(0, Taf.DataHelp.EN_LIST)
      t.writeInt32(0, this.vGroupId.length)
      for (const x of this.vGroupId) t.writeString(0, x)
      t.writeString(1, this.sToken)
    }
    const s = new Taf.JceOutputStream()
    g.writeTo(s)
    this._send_ws_cmd(CMD.C2S_RegisterGroupReq, s.getBinBuffer())
  }

  // ================= 心跳 =================

  _heartbeat() {
    this._send_ws_cmd(CMD.C2S_HeartBeatReq, null)
  }

  // ================= 发送 =================

  _send_ws_cmd(cmdType, vData) {
    if (!this._client || this._client.readyState !== ws.OPEN) return
    const cmd = new HUYA.WebSocketCommand()
    cmd.iCmdType = cmdType
    if (vData) cmd.vData = vData
    const s = new Taf.JceOutputStream()
    cmd.writeTo(s)
    this._client.send(s.getBuffer())
  }

  _send_wup(servant, func, reqObj, requestId) {
    const wup = new Taf.Wup()
    wup.setServant(servant)
    wup.setFunc(func)
    wup.setRequestId(requestId || 2)
    wup.writeStruct('tReq', reqObj)
    this._send_ws_cmd(CMD.WupReq, wup.encode())
  }

  // ================= 接收 =================

  _on_message(data) {
    try {
      const cmd = new HUYA.WebSocketCommand()
      cmd.readFrom(new Taf.JceInputStream(toAB(Buffer.from(data))))
      switch (cmd.iCmdType) {
        case CMD.RegisterRsp:
          this._on_ready()
          break
        case CMD.WupRsp:
          this._on_wup_rsp(cmd)
          break
        case CMD.S2C_RegisterGroupRsp:
          this._on_ready()
          this._get_gift_list()
          break
        case CMD.S2C_MsgPushReq:
          this._on_push_v1(cmd, Buffer.from(data).byteLength)
          break
        case CMD.S2C_MsgPushReq_V2:
          this._on_push_v2(cmd, Buffer.from(data).byteLength)
          break
        // RegisterRsp / HeartBeatRsp:无需处理
        default:
          break
      }
    } catch (e) {
      this.emit('error', e)
    }
  }

  _on_ready() {
    if (!this._starting) return
    clearTimeout(this._handshake_timer)
    this._starting = false
    this._retry = 0
    this.emit('ready')
  }

  _on_wup_rsp(cmd) {
    const wup = new Taf.Wup()
    wup.decode(cmd.vData.buffer)
    if (wup.sFuncName === 'wsLaunch') {
      // 新协议:wsLaunch 成功后注册弹幕组
      this._register_group()
    } else if (wup.sFuncName === 'getPropsList') {
      this._parse_gift_list(wup)
    }
  }

  _parse_gift_list(wup) {
    try {
      const rsp = new HUYA.GetPropsListRsp()
      new Taf.JceInputStream(wup.newdata.get('tRsp').buffer).readStruct(0, true, rsp)
      rsp.vPropsItemList.value.forEach(item => {
        this._gift_info[item.iPropsId + ''] = { name: item.sPropsName, price: item.iPropsYb / 100 }
      })
    } catch (e) { this.emit('parseError', { uri: 'getPropsList', error: e }) }
  }

  _get_gift_list() {
    const req = new HUYA.GetPropsListReq()
    const uid = new HUYA.UserId()
    uid.lUid = this._info.lUid
    uid.sHuYaUA = 'webh5&1.0.0&websocket'
    req.tUserId = uid
    req.iTemplateType = HUYA.EClientTemplateType.TPL_WEB
    this._send_wup('PropsUIServer', 'getPropsList', req, 3)
  }

  _on_push_v1(cmd, frameLength = null) {
    const msg = {}
    msg.readFrom = function (t) {
      this.iUri = t.readInt32(1, true, 0)
      this.sMsg = t.readBytes(2, true, null)
    }
    msg.readFrom(new Taf.JceInputStream(cmd.vData.getBuffer()))
    if (msg.sMsg) {
      const payload = msg.sMsg.getBuffer()
      this._handle_uri(msg.iUri, payload, frameMetadata(frameLength, cmd.vData, msg.sMsg))
    }
  }

  _on_push_v2(cmd, frameLength = null) {
    // V2:sGroupId(0) + vMsgItem(1)[ {iUri int64, sMsg} ]
    const v2 = {}
    v2.readFrom = function (t) {
      this.sGroupId = t.readString(0, true, '')
      const head = t.readFrom()
      const items = []
      if (head.type === Taf.DataHelp.EN_LIST) {
        const n = t.readInt32(0, true)
        for (let i = 0; i < n; i++) {
          const item = {}
          item.readFrom = function (tt) {
            this.iUri = tt.readInt64(0, true, 0)
            this.sMsg = tt.readBytes(1, true, null)
          }
          try {
            t.readStruct(0, true, item)
            items.push(item)
          } catch (e) {
            this.emitParseError = e
            break
          }
        }
      }
      this.vMsgItem = items
    }
    v2.readFrom(new Taf.JceInputStream(cmd.vData.getBuffer()))
    if (v2.emitParseError) this.emit('parseError', { uri: 'push-v2', error: v2.emitParseError })
    for (const item of v2.vMsgItem) {
      if (!item.sMsg) continue
      const payload = item.sMsg.getBuffer()
      this._handle_uri(item.iUri, payload, frameMetadata(frameLength, cmd.vData, item.sMsg))
    }
  }

  _handle_uri(uri, ab, frameMeta = null) {
    // Raw capture happens before any business field is read. 2001314 keeps every
    // packet so an "ok" layout can be diffed against a "fail" layout; 1400 only
    // keeps packets that fail to parse.
    const captureToken = this._capture ? this._capture.start(uri, this._roomid, ab, frameMeta) : null
    try {
      if (uri === URI.CHAT) {
        const { value: chat, outerId } = readUriPayload(ab, parseChatValue)
        const badgeDecoration = chat.vDecorationPrefix.find(item => item.iAppId === 10400)
        const fanBadge = parseFansBadge(badgeDecoration?.vData?.buffer)
        if (fanBadge) fanBadge.anchor_uid = chat.lPid
        this.emit('message', {
          type: 'chat',
          time: Date.now(),
          sourcePushMessageId: outerId,
          sourceMessageId: chat.sMessageId || null,
          from: {
            name: chat.tUserInfo.sNickName,
            rid: String(chat.tUserInfo.lUid),
            avatar: chat.tUserInfo.sAvatarUrl,
            nobleLevel: chat.tUserInfo.iNobleLevel
          },
          id: chat.sMessageId || md5(JSON.stringify(chat)),
          content: chat.sContent,
          fanBadge,
          tid: chat.lTid,
          sid: chat.lSid,
          pid: chat.lPid
        })
      } else if (uri === URI.GIFT) {
        const { value: g, outerId } = readUriPayload(ab, stream => parseGiftValue(stream, this._logger))
        if (this._info?.lUid && g.lPresenterUid !== String(this._info.lUid)) return
        const info = this._gift_info[g.iItemType + ''] || {}
        const name = g.sPropsName || info.name || `礼物(${g.iItemType})`
        const payTotalRaw = String(g.lPayTotal || '0')
        const payTotalCents = BigInt(payTotalRaw)
        const totalHuyaCoin = Number(payTotalCents / 100n) + Number(payTotalCents % 100n) / 100
        this.emit('message', {
          type: 'gift',
          time: Date.now(),
          sourcePushMessageId: outerId,
          paymentId: g.strPayId,
          itemType: g.iItemType,
          name,
          from: { name: g.sSenderNick, rid: g.lSenderUid, avatar: g.iSenderIcon, nobleLevel: g.iNobleLevel },
          id: outerId || md5(JSON.stringify(g)),
          count: g.iItemCount,
          payTotalRaw,
          totalHuyaCoin,
          priceLevel: g.tEffectInfo.iPriceLevel,
          roomId: g.lRoomId,
          presenterUid: g.lPresenterUid,
          payType: g.iPayType,
          comboSeqId: g.lComboSeqId
        })
      } else if (uri === URI.PAID_MESSAGE) {
        const stream = new Taf.JceInputStream(ab)
        const items = parsePaidMessageItems(stream)
        this.emit('message', {
          type: 'paid_message_snapshot',
          time: Date.now(),
          items: items.filter(item => item.iCountDown > 0)
        })
      } else if (uri === URI.ONLINE) {
        // 人气 AttendeeCountNotice
        const s = new Taf.JceInputStream(ab)
        const on = {}
        on.readFrom = function (t) { this.iAttendeeCount = t.readInt32(0, true, 0) }
        on.readFrom(s)
        this.emit('message', { type: 'online', time: Date.now(), count: on.iAttendeeCount })
      }
      // 其他 uri(系统/活动消息)忽略
      if (captureToken) this._capture.finish(captureToken, {
        parseOk: true,
        error: null
      })
    } catch (e) {
      if (this._capture) {
        if (captureToken) this._capture.finish(captureToken, {
          parseOk: false,
          error: e
        })
        else this._capture.failure(uri, this._roomid, ab, e, frameMeta)
      }
      this.emit('parseError', {
        uri,
        error: e,
        payloadLength: ab?.byteLength ?? ab?.length ?? null,
        offset: e.offset ?? e.tars?.offset ?? null,
        tag: e.tag ?? e.tars?.tag ?? null,
        type: e.type ?? e.tars?.type ?? null,
        bufferLength: e.tars?.bufferLength ?? null,
        remainingBytes: e.tars?.remainingBytes ?? null,
        expectedReadBytes: e.tars?.expectedReadBytes ?? null,
        path: e.paid?.path ?? null,
        listIndex: e.paid?.listIndex ?? null,
        currentOffset: e.paid?.currentOffset ?? null,
        expectedTag: e.paid?.expectedTag ?? null,
        expectedType: e.paid?.expectedType ?? null,
        actualTag: e.paid?.actualTag ?? null,
        actualType: e.paid?.actualType ?? null,
        ...frameMeta
      })
    }
  }

  // ================= 断线重连(指数退避) =================

  _on_close() {
    clearInterval(this._heartbeat_timer)
    clearTimeout(this._handshake_timer)
    this._starting = false
    if (this._stopped) return
    const delay = Math.min(1000 * Math.pow(2, this._retry++), 30000)
    clearTimeout(this._reconnect_timer)
    this._reconnect_timer = setTimeout(() => {
      if (this._stopped) return
      this._connect()
    }, delay)
    this.emit('close')
  }

  stop() {
    this._stopped = true
    this._starting = false
    clearInterval(this._heartbeat_timer)
    clearTimeout(this._reconnect_timer)
    clearTimeout(this._handshake_timer)
    if (this._client) {
      const client = this._client
      this._client = null
      client.removeAllListeners()
      try { client.terminate() } catch (e) { /* ignore */ }
    }
  }
}

module.exports = huya_danmu
module.exports.WS_URL = WS_URL
module.exports.WSS_URL = WSS_URL
