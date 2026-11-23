const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { Database } = require('../src/db')

// 真实 PostgreSQL（PGlite/WASM）集成测试，需通过环境变量指向 pglite 模块路径：
//   RETENTION_TEST_PGLITE=@electric-sql/pglite npm test
async function pgliteDatabase(t) {
  const { PGlite } = require(process.env.RETENTION_TEST_PGLITE)
  const pg = new PGlite()
  t.after(() => pg.close())
  await pg.exec(await fs.readFile(path.join(__dirname, '../migrations/001_init.sql'), 'utf8'))
  await pg.exec(await fs.readFile(path.join(__dirname, '../migrations/002_realtime_stream_events.sql'), 'utf8'))

  // 只借用 Database 的方法，连接层替换成 PGlite
  const database = Object.create(Database.prototype)
  database.pool = pg
  database.partitionCache = new Set()
  database.logger = { warn () {}, error () {}, info () {} }
  return { database, pg }
}

const ROOM_ID = '11111111-1111-1111-1111-111111111111'
const DAY_MS = 86400000

async function seedDays(database, pg, { days, retentionDays }) {
  const now = Date.now()
  await pg.query(
    `INSERT INTO rooms(id, external_room_id, anchor_name) VALUES ($1, '116864', '主播')`, [ROOM_ID]
  )
  for (let offset = days; offset >= 0; offset--) {
    const at = new Date(now - offset * DAY_MS)
    await database.ensureMessagePartition(at)
    await pg.query(
      `INSERT INTO danmu_messages(ingest_id, room_id, occurred_at, received_at, time_source,
        sender_name, content, content_normalized, content_hash)
       VALUES (gen_random_uuid(), $1, $2, $2, 'source', '观众', '666', '666', repeat('a', 64))`,
      [ROOM_ID, at]
    )
    await pg.query(
      `INSERT INTO stream_events(ingest_id, room_id, event_type, occurred_at, received_at, payload)
       VALUES (gen_random_uuid(), $1, 'online', $2, $2, '{}'::jsonb)`,
      [ROOM_ID, at]
    )
    await pg.query(`INSERT INTO room_status_history(room_id, to_status, created_at) VALUES ($1, 'offline', $2)`,
      [ROOM_ID, at])
  }
  assert.equal(Number((await pg.query('SELECT count(*) AS count FROM danmu_messages')).rows[0].count), days + 1)
  return retentionDays
}

test('保留策略只留最近 N 天，并 DROP 完全过期的日分区', { skip: !process.env.RETENTION_TEST_PGLITE }, async t => {
  const { database, pg } = await pgliteDatabase(t)
  const days = 40
  const retentionDays = 30
  await seedDays(database, pg, { days })

  const result = await database.pruneExpired(retentionDays)

  assert.equal(result.retentionDays, retentionDays)
  // 41 天的数据按天分区：整日早于 cutoff 的分区应被 DROP（第 0..days 天中保留最近 30 天）
  const older = days - retentionDays
  assert.equal(result.droppedPartitions.length, older)
  assert.ok(result.droppedPartitions.every(name => /^danmu_messages_\d{4}_\d{2}_\d{2}$/.test(name)))
  // 删除量 = 过期分区内的行 + 边界分区里越界的行
  assert.ok(result.deleted.danmuMessages >= older)
  assert.ok(result.deleted.streamEvents >= older)
  assert.ok(result.deleted.roomStatusHistory >= older)

  const partitions = (await pg.query(
    `SELECT child.relname AS table_name FROM pg_inherits
     JOIN pg_class parent ON parent.oid = inhparent
     JOIN pg_class child ON child.oid = inhrelid
     WHERE parent.relname = 'danmu_messages'`)).rows.map(row => row.table_name)
  assert.equal(partitions.length, retentionDays + 1)
  for (const dropped of result.droppedPartitions) assert.ok(!partitions.includes(dropped))

  const oldest = (await pg.query('SELECT min(occurred_at) AS at FROM danmu_messages')).rows[0].at
  assert.ok(new Date(oldest).getTime() >= Date.now() - (retentionDays + 1) * DAY_MS)

  // 未分区表按时间裁剪
  const streamCount = Number((await pg.query('SELECT count(*) AS count FROM stream_events')).rows[0].count)
  const statusCount = Number((await pg.query('SELECT count(*) AS count FROM room_status_history')).rows[0].count)
  assert.ok(streamCount <= retentionDays + 1)
  assert.ok(statusCount <= retentionDays + 1)
})

test('保留策略可重复执行且幂等', { skip: !process.env.RETENTION_TEST_PGLITE }, async t => {
  const { database, pg } = await pgliteDatabase(t)
  await seedDays(database, pg, { days: 35 })
  await database.pruneExpired(30)
  const second = await database.pruneExpired(30)
  assert.deepEqual(second.droppedPartitions, [])
  assert.equal(second.deleted.danmuMessages, 0)
  assert.equal(second.deleted.streamEvents, 0)
  assert.equal(second.deleted.roomStatusHistory, 0)
})

test('历史月分区在完全过期后被 DROP', { skip: !process.env.RETENTION_TEST_PGLITE }, async t => {
  const { database, pg } = await pgliteDatabase(t)
  await pg.query(`INSERT INTO rooms(id, external_room_id) VALUES ($1, '116864')`, [ROOM_ID])
  await pg.query(`CREATE TABLE danmu_messages_2026_09 PARTITION OF danmu_messages
    FOR VALUES FROM ('2026-09-01T00:00:00Z') TO ('2026-10-01T00:00:00Z')`)
  const listed = await database.listMessagePartitionsBefore(new Date(Date.now()))
  assert.deepEqual(listed.map(row => row.table_name), ['danmu_messages_2026_09'])

  const result = await database.pruneExpired(30)
  assert.deepEqual(result.droppedPartitions, ['danmu_messages_2026_09'])
})

test('已有历史月分区覆盖时按日建分区不会报错', { skip: !process.env.RETENTION_TEST_PGLITE }, async t => {
  const { database, pg } = await pgliteDatabase(t)
  const at = new Date()
  const year = at.getUTCFullYear()
  const month = String(at.getUTCMonth() + 1).padStart(2, '0')
  const start = `${year}-${month}-01T00:00:00Z`
  const next = new Date(Date.UTC(year, at.getUTCMonth() + 1, 1)).toISOString()
  await pg.query(`CREATE TABLE danmu_messages_${year}_${month} PARTITION OF danmu_messages
    FOR VALUES FROM ('${start}') TO ('${next}')`)
  await database.ensureMessagePartition(at)
  const partitions = (await pg.query(
    `SELECT child.relname AS table_name FROM pg_inherits
     JOIN pg_class parent ON parent.oid = inhparent
     JOIN pg_class child ON child.oid = inhrelid
     WHERE parent.relname = 'danmu_messages'`)).rows.map(row => row.table_name)
  assert.deepEqual(partitions, [`danmu_messages_${year}_${month}`])
})
