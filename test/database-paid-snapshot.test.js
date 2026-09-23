const test = require('node:test')
const assert = require('node:assert/strict')
const { Database } = require('../src/db')

test('latest paid snapshot query joins the current active session', async () => {
  const database = Object.create(Database.prototype)
  let queryText = ''
  database.query = async text => {
    queryText = text
    return { rows: [{ room_id: 'room-1', session_id: 'session-current', payload: { items: [] } }] }
  }
  const rows = await database.listLatestActivePaidMessageSnapshots()
  assert.equal(rows[0].session_id, 'session-current')
  assert.match(queryText, /event_type = 'paid_message_snapshot'/)
  assert.match(queryText, /session\.status = 'active'/)
  assert.match(queryText, /stream\.session_id = session\.id/)
  assert.match(queryText, /DISTINCT ON \(stream\.room_id\)/)
})
