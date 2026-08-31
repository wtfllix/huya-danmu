const test = require('node:test')
const assert = require('node:assert/strict')
const { addProjection } = require('../src/services/storage-service')

test('根据至少一天的容量历史估算增长和写满天数', () => {
  const now = new Date('2026-08-08T00:00:00Z')
  const result = addProjection(
    { target: 'database', usedBytes: 1700, availableBytes: 300 },
    [
      { target: 'database', sampled_at: new Date('2026-08-01T00:00:00Z'), used_bytes: '1000' },
      { target: 'database', sampled_at: now, used_bytes: '1700' }
    ]
  )
  assert.equal(result.growthBytesPerDay, 100)
  assert.equal(result.daysRemaining, 3)
})

test('历史不足时不伪造预计写满日期', () => {
  const result = addProjection(
    { target: 'archive', usedBytes: 100, availableBytes: 900 },
    [{ target: 'archive', sampled_at: new Date(), used_bytes: '100' }]
  )
  assert.equal(result.daysRemaining, null)
  assert.equal(result.growthBytesPerDay, null)
})
