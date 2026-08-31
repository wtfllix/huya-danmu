const test = require('node:test')
const assert = require('node:assert/strict')
const { normalizeContent, storageStatus } = require('../src/utils')

test('弹幕文本只合并首尾空白和 Unicode 等价形式', () => {
  assert.equal(normalizeContent(' 666 '), '666')
  assert.equal(normalizeContent('e\u0301'), 'é')
  assert.notEqual(normalizeContent('666'), normalizeContent('666！'))
})

test('磁盘水位状态边界正确', () => {
  assert.equal(storageStatus(null), 'unknown')
  assert.equal(storageStatus(69.9), 'normal')
  assert.equal(storageStatus(70), 'warning')
  assert.equal(storageStatus(80), 'high')
  assert.equal(storageStatus(90), 'critical')
})
