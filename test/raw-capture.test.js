const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const HuyaDanmu = require('../index')
const { Taf } = require('../lib')
const { chatPayload, paidMessagePayload } = require('./protocol-fixtures')

const quietLogger = { warn() {}, debug() {}, error() {} }

function tempDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'huya-capture-'))
}

function files(dir) {
  return fs.readdirSync(dir).sort()
}

function bins(dir) {
  return files(dir).filter(name => name.endsWith('.bin'))
}

function readMeta(dir, binName) {
  const json = binName.replace(/\.bin$/, '.json')
  return JSON.parse(fs.readFileSync(path.join(dir, json), 'utf8'))
}

function malformedPaidPayload() {
  const stream = new Taf.JceOutputStream()
  stream.writeInt32(0, 5)
  return stream.getBinBuffer().buffer
}

test('1400 captures only failed packets', () => {
  const dir = tempDir()
  const client = new HuyaDanmu({ roomid: '919191', debugCapture: { enabled: true, dir }, logger: quietLogger })
  client._handle_uri(1400, chatPayload())
  assert.equal(files(dir).length, 0)

  client.on('parseError', () => {})
  client._handle_uri(1400, chatPayload().slice(0, 40))
  const bin = bins(dir)
  assert.equal(bin.length, 1)
  assert.match(bin[0], /-uri1400-fail-/)
  const meta = readMeta(dir, bin[0])
  assert.equal(meta.uri, 1400)
  assert.equal(meta.room_id, '919191')
  assert.equal(meta.parse_ok, false)
  assert.ok(meta.payload_length > 0)
  assert.ok('reader_offset' in meta)
  assert.ok('last_tag' in meta)
  assert.ok('last_type' in meta)
})

test('2001314 captures successful packets before parsing', () => {
  const dir = tempDir()
  const client = new HuyaDanmu({ roomid: '919191', debugCapture: { enabled: true, dir }, logger: quietLogger })
  const messages = []
  client.on('message', message => messages.push(message))
  client._handle_uri(2001314, paidMessagePayload())
  assert.equal(messages.length, 1)
  const bin = bins(dir)
  assert.equal(bin.length, 1)
  assert.match(bin[0], /-uri2001314-ok-/)
  const meta = readMeta(dir, bin[0])
  assert.equal(meta.uri, 2001314)
  assert.equal(meta.parse_ok, true)
  assert.equal(meta.error_message, null)
})

test('capture metadata keeps frame and payload lengths', () => {
  const dir = tempDir()
  const client = new HuyaDanmu({ roomid: '919191', debugCapture: { enabled: true, dir }, logger: quietLogger })
  const fixture = fs.readFileSync(path.join(__dirname, 'fixtures/huya/paid-layout-b',
    '20260922T035933.780Z-room919191-uri2001314-fail-8e6da4e5.bin'))
  client._handle_uri(2001314, fixture.buffer.slice(fixture.byteOffset, fixture.byteOffset + fixture.byteLength), {
    frameDeclaredLength: 4464,
    actualFrameLength: 4478,
    payloadDeclaredLength: fixture.length,
    capturedPayloadLength: fixture.length,
    payloadStartOffset: 12,
    payloadEndOffset: 4436
  })
  const bin = bins(dir)[0]
  const meta = readMeta(dir, bin)
  assert.equal(meta.frameDeclaredLength, 4464)
  assert.equal(meta.capturedPayloadLength, fixture.length)
  assert.equal(meta.diagnostics, undefined)
})

test('2001314 captures failed packets with the parse error', () => {
  const dir = tempDir()
  const client = new HuyaDanmu({ roomid: '919191', debugCapture: { enabled: true, dir }, logger: quietLogger })
  const errors = []
  client.on('parseError', error => errors.push(error))
  client._handle_uri(2001314, malformedPaidPayload())
  assert.equal(errors.length, 1)
  const bin = bins(dir)
  assert.equal(bin.length, 1)
  assert.match(bin[0], /-uri2001314-fail-/)
  const meta = readMeta(dir, bin[0])
  assert.equal(meta.parse_ok, false)
  assert.match(meta.error_message, /unsupported 2001314 layout/)
})

test('capture disabled writes nothing', () => {
  const dir = tempDir()
  const client = new HuyaDanmu({ roomid: '919191', debugCapture: { enabled: false, dir }, logger: quietLogger })
  client._handle_uri(2001314, paidMessagePayload())
  client._handle_uri(1400, chatPayload().slice(0, 40))
  assert.equal(files(dir).length, 0)
})

test('capture write failure never breaks business parsing', () => {
  const filePath = path.join(os.tmpdir(), `huya-capture-file-${Date.now()}`)
  fs.writeFileSync(filePath, 'not-a-directory')
  const warnings = []
  const client = new HuyaDanmu({
    roomid: '919191',
    debugCapture: { enabled: true, dir: filePath },
    logger: { warn(...args) { warnings.push(args) }, debug() {}, error() {} }
  })
  const messages = []
  client.on('message', message => messages.push(message))
  client._handle_uri(2001314, paidMessagePayload())
  assert.equal(messages.length, 1)
  assert.ok(warnings.length >= 1)
})

test('2001314 retention keeps only the newest packets', () => {
  const dir = tempDir()
  const client = new HuyaDanmu({ roomid: '919191', debugCapture: { enabled: true, dir, maxPackets: 3 }, logger: quietLogger })
  for (let index = 0; index < 5; index++) client._handle_uri(2001314, paidMessagePayload())
  assert.equal(bins(dir).length, 3)
  assert.equal(files(dir).filter(name => name.endsWith('.json')).length, 3)
})

test('reader bounds errors carry offset/tag/type context', () => {
  const dir = tempDir()
  const client = new HuyaDanmu({ roomid: '919191', debugCapture: { enabled: false, dir }, logger: quietLogger })
  const errors = []
  client.on('parseError', error => errors.push(error))
  // tag=3 STRING1, length byte 0xff with no payload -> DataView read past end.
  client._handle_uri(1400, Uint8Array.from([0x36, 0xff]).buffer)
  assert.equal(errors.length, 1)
  assert.equal(errors[0].error.name, 'TarsReaderError')
  assert.equal(errors[0].error.tars.tag, 3)
  assert.equal(errors[0].error.tars.type, 6)
  assert.equal(errors[0].error.tars.bufferLength, 2)
  assert.equal(typeof errors[0].remainingBytes, 'number')
  assert.ok(errors[0].error.cause)
})
