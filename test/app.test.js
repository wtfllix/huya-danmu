const test = require('node:test')
const assert = require('node:assert/strict')
const { buildApp } = require('../src/app')

function fixtures() {
  const database = {
    ready: true,
    listRooms: async () => [],
    getRoomByExternalId: async () => null,
    getRoom: async () => null,
    listArchiveRuns: async () => [],
    messageCounts: async () => [],
    topMessages: async () => []
  }
  const config = { logLevel: 'silent', apiToken: '', hotRetentionMonths: 12 }
  return {
    config, database,
    detector: { detect: async () => ({ anchorUid: '1', anchorName: '主播', metadata: {} }) },
    supervisor: { checkRoom: async () => {}, tick: async () => {}, stopCollector: async () => {} },
    spool: { depth: 0 },
    storage: { latest: [], sample: async () => [], history: async () => [] },
    archives: { archiveDue: async () => [] }
  }
}

test('健康检查和静态管理页面可访问', async t => {
  const app = buildApp(fixtures())
  t.after(() => app.close())
  assert.equal((await app.inject('/health/live')).statusCode, 200)
  const page = await app.inject('/')
  assert.equal(page.statusCode, 200)
  assert.match(page.body, /虎牙弹幕观察台/)
})

test('分析 API 拒绝无效区间', async t => {
  const app = buildApp(fixtures())
  t.after(() => app.close())
  const response = await app.inject('/api/v1/analytics/message-counts?room_id=x&from=no&to=no')
  assert.equal(response.statusCode, 400)
})
