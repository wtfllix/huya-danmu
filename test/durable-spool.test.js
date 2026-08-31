const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const { DurableSpool } = require('../src/services/durable-spool')

test('重启后恢复尚未提交的磁盘缓冲', async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'huya-spool-'))
  t.after(() => fs.rm(directory, { recursive: true, force: true }))
  const first = new DurableSpool({ directory, batchSize: 10, flushMs: 60000, processBatch: async () => {} })
  await first.start()
  await first.enqueue({ ingestId: 'a', content: '第一条' })
  await first.enqueue({ ingestId: 'b', content: '第二条' })
  await first.stop({ drain: false })

  const processed = []
  const second = new DurableSpool({
    directory,
    batchSize: 10,
    flushMs: 60000,
    processBatch: async batch => processed.push(...batch)
  })
  await second.start()
  await second.drain()
  assert.deepEqual(processed.map(item => item.ingestId), ['a', 'b'])
  assert.equal(second.depth, 0)
  assert.equal(await fs.readFile(path.join(directory, 'pending.ndjson'), 'utf8'), '')
  await second.stop()
})
