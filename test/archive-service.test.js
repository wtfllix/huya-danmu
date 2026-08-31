const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const os = require('node:os')
const path = require('node:path')
const parquet = require('parquetjs-lite')
const { ArchiveService, partitionRange } = require('../src/services/archive-service')

test('分区名称转换为正确月份范围', () => {
  const range = partitionRange('danmu_messages_2026_08')
  assert.equal(range.start.toISOString(), '2026-08-01T00:00:00.000Z')
  assert.equal(range.end.toISOString(), '2026-09-01T00:00:00.000Z')
  assert.throws(() => partitionRange('rooms'))
})

test('Parquet 归档完成校验和备份后才删除分区', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'huya-archive-'))
  t.after(() => fs.rm(root, { recursive: true, force: true }))
  let page = 0
  const finished = []
  const dropped = []
  const database = {
    createArchiveRun: async () => 'run-1',
    getCompletedArchive: async () => null,
    query: async () => ({ rows: page++ ? [] : [{
      ingest_id: 'id-1', room_id: 'room-1', session_id: null, source_event_id: null,
      occurred_at: new Date('2025-01-01T01:00:00Z'), received_at: new Date('2025-01-01T01:00:01Z'),
      time_source: 'received', sender_uid: 'user-1', sender_name: '用户', content: '666',
      content_normalized: '666', raw_payload: { type: 'chat' }
    }] }),
    finishArchiveRun: async (_id, patch) => finished.push(patch),
    dropMessagePartition: async name => dropped.push(name)
  }
  const service = new ArchiveService({
    database,
    archiveDir: path.join(root, 'archives'),
    backupPath: path.join(root, 'backups')
  })
  const result = await service.archivePartition('danmu_messages_2025_01')
  assert.equal(result.rowCount, 1)
  assert.equal(result.backupStatus, 'verified')
  assert.deepEqual(dropped, ['danmu_messages_2025_01'])
  assert.equal(finished[0].status, 'completed')
  const reader = await parquet.ParquetReader.openFile(result.path)
  const cursor = reader.getCursor()
  assert.equal((await cursor.next()).content, '666')
  await reader.close()
})
