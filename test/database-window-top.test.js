const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs/promises')
const path = require('node:path')
const { WINDOW_TOP_SQL, windowTopMessages } = require('../src/db/window-top-messages')

test('window query uses one bounded scan and rolls back failures', async () => {
  const statements = []
  let released = false
  const database = { pool: { connect: async () => ({
    query: async (sql, params) => {
      statements.push(sql)
      if (sql.includes('AS from_at,') && sql.includes('$1::date')) return { rows: [{
        from_at: new Date('2026-09-05T16:00:00Z'), to_at: new Date('2026-09-06T16:00:00Z')
      }] }
      if (sql === WINDOW_TOP_SQL) {
        assert.equal(params[2].toISOString(), '2026-09-05T16:20:00.000Z')
        throw new Error('timeout')
      }
      return { rows: [] }
    }, release: () => { released = true }
  }) } }
  await assert.rejects(windowTopMessages(database, { roomId: 'room', date: '2026-09-06',
    timezone: 'Asia/Shanghai', at: new Date('2026-09-05T16:29:59Z'), limit: 50 }), /timeout/)
  assert.equal(statements.filter(sql => sql === WINDOW_TOP_SQL).length, 1)
  assert.equal(statements.at(-1), 'ROLLBACK')
  assert.ok(released)
})

test('PostgreSQL window aggregation, completeness, DST, boundaries and execution plan',
  { skip: !process.env.WINDOW_TEST_PGLITE }, async t => {
    const { PGlite } = require(process.env.WINDOW_TEST_PGLITE)
    const pg = new PGlite()
    t.after(() => pg.close())
    await pg.exec(await fs.readFile(path.join(__dirname, '../migrations/001_init.sql'), 'utf8'))
    await pg.exec(`CREATE TABLE danmu_messages_2026_09 PARTITION OF danmu_messages
      FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');
      CREATE TABLE danmu_messages_2026_08 PARTITION OF danmu_messages
      FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');
      CREATE INDEX ON danmu_messages_2026_09(room_id, occurred_at);
      INSERT INTO rooms(id, external_room_id) VALUES ('11111111-1111-1111-1111-111111111111', 'test');`)
    const roomId = '11111111-1111-1111-1111-111111111111'
    const add = async (time, content) => pg.query(`INSERT INTO danmu_messages
      (ingest_id, room_id, occurred_at, received_at, time_source, content, content_normalized, content_hash)
      VALUES (gen_random_uuid(), $1, $2, $2, 'source', $3, $3, repeat('0', 64))`, [roomId, time, content])
    await add('2026-09-05T15:59:59Z', 'outside')
    await add('2026-09-05T16:00:00Z', 'a')
    await add('2026-09-05T16:09:59Z', 'b')
    await add('2026-09-05T16:05:00Z', '')
    await add('2026-09-05T16:10:00Z', 'next')
    await add('2026-09-06T16:00:00Z', 'outside')
    await pg.query(`INSERT INTO collector_incidents(id, room_id, started_at, ended_at, type)
      VALUES (gen_random_uuid(), $1, '2026-09-05T16:20:00Z', '2026-09-05T16:30:00Z', 'disconnect')`, [roomId])
    const database = { pool: { connect: async () => ({ query: (sql, params) => pg.query(sql, params), release() {} }) } }
    const params = { roomId, date: '2026-09-06', timezone: 'Asia/Shanghai', at: new Date('2026-09-07T00:00:00Z'), limit: 50 }
    const windows = await windowTopMessages(database, params)
    assert.equal(windows.length, 144)
    assert.equal(windows[0].total_messages, '3')
    assert.deepEqual(windows[0].items.map(item => item.content), ['a', 'b'])
    assert.equal(windows[0].items[0].share, 1 / 3)
    assert.equal(windows[1].items[0].content, 'next')
    assert.equal(windows[1].data_complete, null)
    assert.equal(windows[2].status, 'collection_gap')
    assert.equal(windows[2].data_complete, false)
    assert.equal(windows[3].status, 'no_messages_observed')
    assert.equal(windows[3].data_complete, null)
    await add('2026-09-05T16:05:00Z', 'b')
    const backfilled = await windowTopMessages(database, params)
    assert.equal(backfilled[0].total_messages, '4')
    assert.equal(backfilled[0].items[0].content, 'b')
    assert.equal(backfilled[0].items[0].message_count, '2')
    assert.equal(backfilled[0].items[0].share, 0.5)
    await pg.query(`UPDATE danmu_messages SET content_normalized = 'a'
      WHERE room_id = $1 AND content_normalized = 'b'`, [roomId])
    const repaired = await windowTopMessages(database, params)
    assert.equal(repaired[0].items[0].content, 'a')
    assert.equal(repaired[0].items[0].message_count, '3')
    assert.equal((await windowTopMessages(database, { ...params, limit: 1 }))[0].items.length, 1)
    assert.equal((await windowTopMessages(database, { ...params, at: new Date('2026-09-05T16:29:59Z') })).length, 2)
    assert.equal((await windowTopMessages(database, { ...params, at: new Date('2026-09-05T15:00:00Z') })).length, 0)
    assert.equal((await windowTopMessages(database, { ...params, date: '2026-03-08', timezone: 'America/New_York' })).length, 138)
    await assert.rejects(windowTopMessages(database, { ...params, date: '2026-11-01', timezone: 'America/New_York' }), { statusCode: 400 })
    await pg.query(`INSERT INTO collector_incidents(id, room_id, started_at, type)
      VALUES (gen_random_uuid(), $1, '2026-09-05T16:30:00Z', 'disconnect')`, [roomId])
    const openGap = await windowTopMessages(database, params)
    assert.equal(openGap[3].status, 'collection_gap')
    assert.equal(openGap[143].data_complete, false)
    await pg.exec(`INSERT INTO archive_runs(id, started_at, range_start, range_end, status, backup_status)
      VALUES (gen_random_uuid(), now(), '2026-09-01', '2026-10-01', 'completed', 'verified')`)
    const archived = await windowTopMessages(database, params)
    assert.equal(archived[0].status, 'raw_data_unavailable')
    assert.equal(archived[0].total_messages, null)
    assert.deepEqual(archived[0].items, [])
    await pg.exec(`INSERT INTO danmu_messages
      (ingest_id, room_id, occurred_at, received_at, time_source, content, content_normalized, content_hash)
      SELECT gen_random_uuid(), '${roomId}', '2026-09-05T16:00:00Z'::timestamptz + n * interval '0.864 seconds',
      now(), 'source', (n % 1000)::text, (n % 1000)::text, repeat('0', 64)
      FROM generate_series(0, 99999) n;
      ANALYZE danmu_messages;`)
    await pg.exec("BEGIN; SET LOCAL work_mem = '16MB'; SET LOCAL statement_timeout = '15s';")
    const plan = await pg.query('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ' + WINDOW_TOP_SQL,
      [roomId, new Date('2026-09-05T16:00:00Z'), new Date('2026-09-06T16:00:00Z'), 50])
    const report = plan.rows[0]['QUERY PLAN'][0]
    await pg.exec('COMMIT')
    assert.match(JSON.stringify(report), /WindowAgg/)
    const nodes = []
    function visit(node) {
      nodes.push(node)
      for (const child of node.Plans || []) visit(child)
    }
    visit(report.Plan)
    const scans = nodes.filter(node => node['Relation Name']?.startsWith('danmu_messages'))
    assert.equal(scans.length, 1)
    assert.equal(scans[0]['Relation Name'], 'danmu_messages_2026_09')
    assert.equal(scans[0]['Actual Loops'], 1)
    assert.ok(nodes.filter(node => ['collector_incidents', 'archive_runs'].includes(node['Relation Name']))
      .every(node => node['Actual Loops'] <= 144))
    t.diagnostic(JSON.stringify({ execution_ms: report['Execution Time'], rows: report.Plan['Actual Rows'],
      temp_read_blocks: report.Plan['Temp Read Blocks'], temp_written_blocks: report.Plan['Temp Written Blocks'],
      scans: nodes.filter(node => node['Relation Name']).map(node => ({ table: node['Relation Name'],
        type: node['Node Type'], loops: node['Actual Loops'], rows: node['Actual Rows'] })) }))
  })
