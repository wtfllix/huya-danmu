const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFileSync } = require('node:child_process')
const { scanTarsBuffer, scanTarsSignatures } = require('../src/huya/tars-scanner')
const { paidMessagePayload } = require('./protocol-fixtures')

const paidLayoutB = path.join(__dirname, 'fixtures/huya/paid-layout-b')

test('scanner reads a normal fixture and reports structure only', () => {
  const result = scanTarsBuffer(Buffer.from(paidMessagePayload()))
  assert.equal(result.aborted, false)
  assert.equal(result.abort, null)
  assert.ok(result.events.length > 0)
  assert.match(result.output, /tag=0 type=LIST length=2/)
  assert.match(result.output, /type=STRUCT_BEGIN/)
  assert.doesNotMatch(result.output, /SCAN_ABORT/)
})

test('scanner reports offset/remaining and aborts on a truncated buffer', () => {
  const truncated = Buffer.from(paidMessagePayload()).subarray(0, 10)
  const result = scanTarsBuffer(truncated)
  assert.equal(result.aborted, true)
  assert.ok(result.abort)
  assert.equal(typeof result.abort.offset, 'number')
  assert.equal(typeof result.abort.remaining, 'number')
  assert.match(result.output, /SCAN_ABORT offset=\d+ remaining=\d+ reason=/)
  assert.ok(result.lines.length > 0)
})

test('scanner aborts on an unknown field type without crashing', () => {
  const result = scanTarsBuffer(Buffer.from([0x0e]))
  assert.equal(result.aborted, true)
  assert.match(result.abort.reason, /unknown type 14/)
})

test('scanner CLI exits non-zero on truncated input and zero on valid input', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'huya-scan-'))
  const valid = path.join(dir, 'valid.bin')
  const broken = path.join(dir, 'broken.bin')
  fs.writeFileSync(valid, Buffer.from(paidMessagePayload()))
  fs.writeFileSync(broken, Buffer.from(paidMessagePayload()).subarray(0, 8))
  const cli = path.resolve(__dirname, '../scripts/scan-tars-packet.js')

  const validOut = execFileSync(process.execPath, [cli, valid], { encoding: 'utf8' })
  assert.match(validOut, /type=STRUCT_BEGIN/)

  let exitCode = 0
  let brokenOut = ''
  try {
    brokenOut = execFileSync(process.execPath, [cli, broken], { encoding: 'utf8' })
  } catch (error) {
    exitCode = error.status
    brokenOut = error.stdout
  }
  assert.equal(exitCode, 1)
  assert.match(brokenOut, /SCAN_ABORT/)
})

test('scanner emits tag/type signatures and exact item boundaries for layout B', () => {
  const file = fs.readdirSync(paidLayoutB).sort().at(-1)
  const result = scanTarsSignatures(fs.readFileSync(path.join(paidLayoutB, file)))
  assert.equal(result.aborted, false)
  assert.deepEqual(result.signatures.list, { tag: 1, count: 5, offset: 28, endOffset: 2211 })
  assert.deepEqual(result.signatures.items.map(item => ({
    index: item.index,
    start: item.startOffset,
    end: item.endOffset,
    next: item.nextOffset
  })), [
    { index: 0, start: 31, end: 473, next: 473 },
    { index: 1, start: 473, end: 925, next: 925 },
    { index: 2, start: 925, end: 1371, next: 1371 },
    { index: 3, start: 1371, end: 1789, next: 1789 },
    { index: 4, start: 1789, end: 2211, next: 2211 }
  ])
  assert.match(result.signatures.items[0].text, /I64\(0\)/)
  assert.match(result.signatures.items[3].text, /I32\(0\)/)
  assert.match(result.signatures.items[3].text, /I8\(5\)/)
})
