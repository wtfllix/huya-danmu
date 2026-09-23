const test = require('node:test')
const assert = require('node:assert/strict')
const { startupPhase } = require('../src/server')

test('startup phase logs successful stages without exposing configuration', async () => {
  const messages = []
  const logger = {
    info(message) { messages.push(['info', message]) },
    error(details, message) { messages.push(['error', details, message]) }
  }
  const result = await startupPhase('database connected', async () => 7, logger)
  assert.equal(result, 7)
  assert.deepEqual(messages, [['info', 'database connected']])
})

test('startup phase identifies the failed stage and rethrows', async () => {
  const messages = []
  const failure = new Error('connection refused')
  const logger = {
    info(message) { messages.push(['info', message]) },
    error(details, message) { messages.push(['error', details, message]) }
  }
  await assert.rejects(
    startupPhase('migrations applied', async () => { throw failure }, logger),
    failure
  )
  assert.equal(messages[0][0], 'error')
  assert.equal(messages[0][1].phase, 'migrations applied')
  assert.equal(messages[0][1].error, failure)
  assert.equal(messages[0][2], 'startup failed: migrations applied')
})
