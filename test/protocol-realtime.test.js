const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const HuyaDanmu = require('../index')
const { Taf } = require('../lib')
const { chatPayload, giftPayload, legacyGiftPayload, paidMessagePayload } = require('./protocol-fixtures')

const fixtureRoot = path.join(__dirname, 'fixtures/huya')

function rawFixtures(directory) {
  const root = path.join(fixtureRoot, directory)
  return fs.readdirSync(root).sort().map(name => ({
    name,
    buffer: fs.readFileSync(path.join(root, name))
  }))
}

function toArrayBuffer(buffer) {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength)
}

function collect(client) {
  const messages = []
  const errors = []
  client.on('message', message => messages.push(message))
  client.on('parseError', error => errors.push(error))
  return { messages, errors }
}

test('1400 fixture preserves string IDs, user fields and fan badge', () => {
  const client = new HuyaDanmu('1')
  const result = collect(client)
  client._handle_uri(1400, chatPayload())
  assert.equal(result.errors.length, 0)
  const message = result.messages[0]
  assert.equal(message.sourcePushMessageId, '9007199254740995')
  assert.equal(message.sourceMessageId, 'message-1')
  assert.equal(message.from.rid, '9007199254740994')
  assert.equal(message.from.avatar, 'avatar')
  assert.equal(message.from.nobleLevel, 3)
  assert.deepEqual(message.fanBadge, {
    anchor_uid: '789', name: '粉丝牌', level: 19, custom: false,
    fans_identity: 1, super_fans_level: 2, badge_id: '9007199254740993'
  })
})

test('1400 captured failure raws parse without losing message IDs', () => {
  const fixtures = rawFixtures('chat-1400-fail')
  assert.equal(fixtures.length, 14)
  for (const fixture of fixtures) {
    const client = new HuyaDanmu('919191')
    const result = collect(client)
    client._handle_uri(1400, toArrayBuffer(fixture.buffer))
    assert.equal(result.errors.length, 0, fixture.name)
    assert.equal(result.messages.length, 1, fixture.name)
    assert.equal(typeof result.messages[0].sourceMessageId, 'string', fixture.name)
    assert.match(result.messages[0].sourceMessageId, /^\d+$/, fixture.name)
    assert.notEqual(result.messages[0].content, '', fixture.name)
  }
})

test('1400 captured success raws remain compatible', () => {
  const fixtures = rawFixtures('chat-1400-success')
  assert.equal(fixtures.length, 5)
  for (const fixture of fixtures) {
    const client = new HuyaDanmu('919191')
    const result = collect(client)
    client._handle_uri(1400, toArrayBuffer(fixture.buffer))
    assert.equal(result.errors.length, 0, fixture.name)
    assert.equal(result.messages.length, 1, fixture.name)
    assert.equal(typeof result.messages[0].sourceMessageId, 'string', fixture.name)
  }
})

test('6501 new layout parses fields after tag 20 without struct-order assumptions', () => {
  const client = new HuyaDanmu('1')
  client._info = { lUid: 1234 }
  const result = collect(client)
  client._handle_uri(6501, giftPayload({ payTotal: '500' }))
  assert.equal(result.errors.length, 0)
  assert.equal(result.messages[0].payTotalRaw, '500')
  assert.equal(result.messages[0].totalHuyaCoin, 5)
  assert.equal(result.messages[0].count, 5)
  assert.equal(result.messages[0].from.rid, '9007199254740994')
  assert.equal(result.messages[0].roomId, '3000')
  assert.equal(result.messages[0].payType, 1)
  assert.equal(result.messages[0].from.nobleLevel, 7)
  assert.equal(result.messages[0].priceLevel, 1)
  assert.equal(result.messages[0].comboSeqId, '8')
})

test('6501 lPayTotal threshold matrix is exact and remains safe', () => {
  const cases = [
    ['10', 0.1, false],
    ['9999', 99.99, false],
    ['10000', 100, false],
    ['10001', 100.01, false]
  ]
  for (const [payTotal, expected, _sse] of cases) {
    const client = new HuyaDanmu('1')
    client._info = { lUid: 1234 }
    const result = collect(client)
    client._handle_uri(6501, giftPayload({ payTotal }))
    assert.equal(result.errors.length, 0)
    assert.equal(result.messages[0].payTotalRaw, payTotal)
    assert.equal(result.messages[0].totalHuyaCoin, expected)
  }
})

test('6501 unknown extension tag does not drop the gift', () => {
  const client = new HuyaDanmu('1')
  client._info = { lUid: 1234 }
  const result = collect(client)
  client._handle_uri(6501, giftPayload({ payTotal: '10', unknownTag: true }))
  assert.equal(result.errors.length, 0)
  assert.equal(result.messages.length, 1)
  assert.equal(result.messages[0].totalHuyaCoin, 0.1)
})

test('6501 optional field type mismatch is logged and does not drop the gift', () => {
  const debug = []
  const client = new HuyaDanmu({ roomid: '1', logger: {
    debug(details, message) { debug.push({ details, message }) }
  } })
  client._info = { lUid: 1234 }
  const result = collect(client)
  client._handle_uri(6501, giftPayload({ payTotal: '10', effectTypeMismatch: true }))
  assert.equal(result.errors.length, 0)
  assert.equal(result.messages.length, 1)
  assert.equal(result.messages[0].priceLevel, 0)
  assert.equal(result.messages[0].payTotalRaw, '10')
  assert.equal(debug[0].details.tag, 30)
})

test('6501 preserves int64 lPayTotal as a string beyond JS safe integer range', () => {
  const client = new HuyaDanmu('1')
  client._info = { lUid: 1234 }
  const result = collect(client)
  client._handle_uri(6501, giftPayload({ payTotal: '9007199254740993' }))
  assert.equal(result.errors.length, 0)
  assert.equal(result.messages[0].payTotalRaw, '9007199254740993')
})

test('6501 old generated layout remains compatible', () => {
  const client = new HuyaDanmu('1')
  client._info = { lUid: 1234 }
  const result = collect(client)
  client._handle_uri(6501, legacyGiftPayload({ payTotal: '500' }))
  assert.equal(result.errors.length, 0)
  assert.equal(result.messages[0].payTotalRaw, '500')
  assert.equal(result.messages[0].roomId, '3000')
})

test('2001314 fixture filters expired items and keeps multi-item snapshot', () => {
  const client = new HuyaDanmu('1')
  const result = collect(client)
  client._handle_uri(2001314, paidMessagePayload())
  assert.equal(result.errors.length, 0)
  assert.equal(result.messages.length, 1)
  assert.equal(result.messages[0].items.length, 1)
  assert.equal(result.messages[0].items[0].lMessageId, '3175516')
  assert.equal(result.messages[0].items[0].mExt.count, '1')
})

test('2001314 sContent remains the paid-message content, including unicode and empty text', () => {
  const client = new HuyaDanmu('1')
  const result = collect(client)
  client._handle_uri(2001314, paidMessagePayload({ contents: ['中文😀', ''] }))
  assert.equal(result.errors.length, 0)
  assert.deepEqual(result.messages[0].items.map(item => item.sContent), ['中文😀'])
})

test('2001314 captured layout B raws parse tag 1 items through the common item parser', () => {
  const fixtures = rawFixtures('paid-layout-b')
  assert.equal(fixtures.length, 5)
  fixtures.forEach((fixture, index) => {
    const client = new HuyaDanmu('919191')
    const result = collect(client)
    client._handle_uri(2001314, toArrayBuffer(fixture.buffer))
    assert.equal(result.errors.length, 0, fixture.name)
    assert.equal(result.messages.length, 1, fixture.name)
    assert.equal(result.messages[0].items.length, index + 1, fixture.name)
    for (const item of result.messages[0].items) {
      assert.ok(item.iCountDown > 0, fixture.name)
      assert.equal(item.tTarUser.lRoomId, '919191', fixture.name)
      assert.equal(typeof item.lMessageId, 'string', fixture.name)
      assert.equal(item.mExt.iItemType, '22177', fixture.name)
    }
  })
})

test('reader treats exact EOF between fields as optional end and value EOF as truncation', () => {
  const complete = new Taf.JceInputStream(Uint8Array.from([0x0c]).buffer)
  assert.equal(complete.readInt32(0, true, 1), 0)
  assert.equal(complete.skipToTag(1, false), false)

  const truncated = new Taf.JceInputStream(Uint8Array.from([0x02, 0x00, 0x00]).buffer)
  assert.throws(() => truncated.readInt32(0, true, 0), error => {
    assert.equal(error.name, 'TarsReaderError')
    assert.equal(error.tars.offset, 1)
    assert.equal(error.tars.expectedReadBytes, 4)
    return true
  })

  const unterminatedStruct = new Taf.JceInputStream(Uint8Array.from([0x0a, 0x0c]).buffer)
  const field = unterminatedStruct.readFrom()
  assert.throws(() => unterminatedStruct.skipField(field.type), error => {
    assert.equal(error.name, 'TarsReaderError')
    assert.equal(error.tars.offset, 2)
    return true
  })
})
