const { Taf } = require('../lib')

function writeInt64String(stream, tag, value) {
  const integer = BigInt(String(value))
  stream.writeTo(tag, Taf.DataHelp.EN_INT64)
  stream.buf.writeUInt32(Number((integer >> 32n) & 0xffffffffn))
  stream.buf.writeUInt32(Number(integer & 0xffffffffn))
}

function writeMap(stream, tag, entries) {
  stream.writeTo(tag, Taf.DataHelp.EN_MAP)
  stream.writeInt32(0, entries.length)
  for (const [key, value] of entries) {
    stream.writeString(0, key)
    stream.writeString(1, String(value))
  }
}

function writeVector(stream, tag, values) {
  stream.writeTo(tag, Taf.DataHelp.EN_LIST)
  stream.writeInt32(0, values.length)
  for (const value of values) stream.writeStruct(0, value)
}

function user({ uid, name, avatar, noble = 0 }) {
  return {
    writeTo(stream) {
      writeInt64String(stream, 0, uid)
      stream.writeString(2, name)
      stream.writeString(4, avatar)
      stream.writeInt32(5, noble)
    }
  }
}

function badgeBytes() {
  const badge = new Taf.JceOutputStream()
  writeInt64String(badge, 0, '9007199254740993')
  badge.writeString(1, '粉丝牌')
  badge.writeInt32(2, 19)
  badge.writeInt32(3, 0)
  badge.writeStruct(4, { writeTo(stream) { stream.writeInt32(0, 2) } })
  badge.writeStruct(5, { writeTo(stream) { stream.writeInt32(0, 1) } })
  return badge.getBinBuffer()
}

function chatPayload() {
  const stream = new Taf.JceOutputStream()
  writeInt64String(stream, 0, '9007199254740995')
  stream.writeStruct(1, {
    writeTo(inner) {
      inner.writeStruct(0, user({ uid: '9007199254740994', name: '弹幕用户', avatar: 'avatar', noble: 3 }))
      writeInt64String(inner, 1, '123')
      writeInt64String(inner, 2, '456')
      inner.writeString(3, '你好')
      writeVector(inner, 8, [{
        writeTo(decoration) {
          decoration.writeInt32(0, 10400)
          decoration.writeBytes(2, badgeBytes())
        }
      }])
      writeInt64String(inner, 11, '789')
      inner.writeString(12, 'message-1')
    }
  })
  return stream.getBuffer()
}

function giftPayload({ payTotal = '500', itemCount = 5, unknownTag = false, effectTypeMismatch = false } = {}) {
  const stream = new Taf.JceOutputStream()
  stream.writeInt32(0, 23097)
  stream.writeString(1, 'payment-1')
  stream.writeInt32(2, itemCount)
  writeInt64String(stream, 3, '1234')
  writeInt64String(stream, 4, '9007199254740994')
  stream.writeString(5, '主播')
  stream.writeString(6, '送礼用户')
  stream.writeString(7, '送出礼物')
  stream.writeInt32(8, itemCount)
  stream.writeInt32(9, 1)
  stream.writeInt32(10, 2)
  stream.writeInt32(11, 3)
  stream.writeInt32(12, 4)
  stream.writeInt32(13, 5)
  stream.writeString(14, 'gift-avatar')
  stream.writeString(15, 'presenter-avatar')
  stream.writeInt32(16, 1)
  stream.writeString(17, '')
  stream.writeBoolean(18, false)
  stream.writeInt32(19, 0)
  stream.writeString(20, '贵族水晶')
  stream.writeInt8(21, 1)
  stream.writeInt32(22, 4)
  stream.writeStruct(23, { writeTo(userInfo) { userInfo.writeInt32(0, 1) } })
  writeInt64String(stream, 24, '3000')
  writeInt64String(stream, 25, '4000')
  stream.writeStruct(26, { writeTo(streamerInfo) { streamerInfo.writeString(0, 'streamer') } })
  stream.writeInt32(27, 1)
  stream.writeInt32(28, 7)
  stream.writeStruct(29, { writeTo(noble) { noble.writeInt32(0, 7) } })
  if (effectTypeMismatch) stream.writeString(30, 'unexpected-effect')
  else stream.writeStruct(30, { writeTo(effect) { effect.writeInt32(0, 1) } })
  stream.writeTo(31, Taf.DataHelp.EN_LIST)
  stream.writeInt32(0, 1)
  writeInt64String(stream, 0, '9876543210123456')
  stream.writeInt32(32, 1)
  stream.writeInt32(33, 2)
  stream.writeInt32(34, 1)
  stream.writeInt32(35, 3)
  stream.writeInt32(36, 4)
  stream.writeString(37, 'custom')
  stream.writeStruct(38, { writeTo(diy) { diy.writeString(0, 'effect') } })
  writeInt64String(stream, 39, '8')
  stream.writeString(40, 'reserved')
  writeInt64String(stream, 41, payTotal)
  stream.writeTo(42, Taf.DataHelp.EN_LIST)
  stream.writeInt32(0, 1)
  stream.writeInt32(0, 1)
  if (unknownTag) stream.writeString(43, 'future-extension')
  return stream.getBuffer()
}

function legacyGiftPayload({ payTotal = '500', itemCount = 5 } = {}) {
  const stream = new Taf.JceOutputStream()
  stream.writeInt32(0, 23097)
  stream.writeString(1, 'payment-legacy')
  stream.writeInt32(2, itemCount)
  writeInt64String(stream, 3, '1234')
  writeInt64String(stream, 4, '9007199254740994')
  stream.writeString(5, '主播')
  stream.writeString(6, '送礼用户')
  stream.writeString(14, 'gift-avatar')
  stream.writeString(20, '旧礼物')
  writeInt64String(stream, 21, '3000')
  stream.writeInt32(22, 1)
  stream.writeInt32(23, 4)
  stream.writeStruct(24, { writeTo(effect) { effect.writeInt32(0, 1) } })
  writeInt64String(stream, 25, '8')
  writeInt64String(stream, 26, payTotal)
  return stream.getBuffer()
}

function paidMessagePayload({ contents = ['上头条内容', '过期'] } = {}) {
  const stream = new Taf.JceOutputStream()
  writeVector(stream, 0, [
    {
      writeTo(item) {
        item.writeStruct(0, user({ uid: '1001', name: '付费用户', avatar: 'paid-avatar' }))
        item.writeString(1, contents[0] ?? '')
        item.writeInt32(2, 10)
        item.writeInt32(3, 300)
        item.writeInt32(4, 236)
        item.writeString(5, 'offset-1')
        writeMap(item, 6, [['count', '1'], ['iItemType', '22177'], ['lExpireTime', '1790042000'], ['lPid', '88']])
        writeInt64String(item, 7, '3175516')
        item.writeStruct(8, { writeTo(target) {
          writeInt64String(target, 0, '2')
          target.writeString(1, '主播')
          writeInt64String(target, 2, '3000')
        } })
        item.writeInt32(9, 2)
        item.writeInt32(10, 1000)
      }
    },
    {
      writeTo(item) {
        item.writeStruct(0, user({ uid: '1002', name: '过期用户', avatar: 'expired-avatar' }))
        item.writeString(1, contents[1] ?? '')
        item.writeInt32(2, 1)
        item.writeInt32(3, 60)
        item.writeInt32(4, 0)
        item.writeString(5, 'offset-2')
        writeMap(item, 6, [['count', '1'], ['iItemType', '1']])
        writeInt64String(item, 7, '3175517')
        item.writeStruct(8, { writeTo(target) {
          writeInt64String(target, 0, '2')
          target.writeString(1, '主播')
          writeInt64String(target, 2, '3000')
        } })
        item.writeInt32(9, 1)
        item.writeInt32(10, 100)
      }
    }
  ])
  return stream.getBuffer()
}

module.exports = { chatPayload, giftPayload, legacyGiftPayload, paidMessagePayload }
