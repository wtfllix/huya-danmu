const test = require('node:test')
const assert = require('node:assert/strict')
const { dayBounds, messagePartitionName, parsePartitionName } = require('../src/db/partition')

test('弹幕分区按 UTC 天切分，与北京时间 08:00 对齐', () => {
  // 北京时间 11-24 07:00 仍属于 11-23 的分区（UTC 边界 = 北京 08:00）
  const range = dayBounds('2026-11-23T23:00:00Z')
  assert.equal(range.start.toISOString(), '2026-11-23T00:00:00.000Z')
  assert.equal(range.end.toISOString(), '2026-11-24T00:00:00.000Z')
  assert.equal(messagePartitionName('2026-11-23T23:00:00Z'), 'danmu_messages_2026_11_23')
  assert.equal(messagePartitionName('2026-11-24T00:00:00Z'), 'danmu_messages_2026_11_24')
})

test('按天分区名称可解析回范围', () => {
  const parsed = parsePartitionName('danmu_messages_2026_11_24')
  assert.equal(parsed.granularity, 'day')
  assert.equal(parsed.label, '2026-11-24')
  assert.equal(parsed.start.toISOString(), '2026-11-24T00:00:00.000Z')
  assert.equal(parsed.end.toISOString(), '2026-11-25T00:00:00.000Z')
})

test('历史月分区名称仍可解析（兼容旧部署）', () => {
  const parsed = parsePartitionName('danmu_messages_2026_08')
  assert.equal(parsed.granularity, 'month')
  assert.equal(parsed.label, '2026-08')
  assert.equal(parsed.start.toISOString(), '2026-08-01T00:00:00.000Z')
  assert.equal(parsed.end.toISOString(), '2026-09-01T00:00:00.000Z')
})

test('非法或越界的分区名称返回 null', () => {
  for (const name of ['rooms', 'danmu_messages_', 'danmu_messages_2026', 'danmu_messages_2026_13',
    'danmu_messages_2026_11_31', 'danmu_messages_2026_02_30', 'danmu_messages_2026_11_24_x',
    'danmu_messages_2026_00_10', undefined, null]) {
    assert.equal(parsePartitionName(name), null, String(name))
  }
})
