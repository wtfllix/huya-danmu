const test = require('node:test')
const assert = require('node:assert/strict')
const { RealtimeEventBus } = require('../src/services/realtime-event-bus')

test('ring buffer replays after Last-Event-ID and reports misses', () => {
  const bus = new RealtimeEventBus({ ringSize: 2 })
  bus.publish('room', { event_type: 'chat', event_id: 'a' })
  bus.publish('room', { event_type: 'chat', event_id: 'b' })
  assert.deepEqual(bus.getSince('room', 'a').map(event => event.event_id), ['b'])
  bus.publish('room', { event_type: 'chat', event_id: 'c' })
  assert.equal(bus.getSince('room', 'a'), null)
  assert.deepEqual(bus.getSince('room', 'b').map(event => event.event_id), ['c'])
})

test('subscriber cleanup removes listeners', () => {
  const bus = new RealtimeEventBus()
  const unsubscribe = bus.subscribe('room', () => {})
  assert.equal(bus.subscriberCount('room'), 1)
  unsubscribe()
  unsubscribe()
  assert.equal(bus.subscriberCount('room'), 0)
})

test('paid snapshot keeps one card per source message and current state in memory', () => {
  const bus = new RealtimeEventBus()
  const first = bus.publishPaidSnapshot('room', {
    event_type: 'paid_message_snapshot', event_id: 's1', items: [{ source_message_id: 'm1' }]
  })
  const duplicate = bus.publishPaidSnapshot('room', {
    event_type: 'paid_message_snapshot', event_id: 's2', items: [{ source_message_id: 'm1' }]
  })
  assert.equal(first.event_id, 's1')
  assert.equal(duplicate, null)
  assert.equal(bus.getCurrentPaidSnapshot('room').event_id, 's1')
})

test('restore only changes current state and ignores remaining_sec in business signature', () => {
  const bus = new RealtimeEventBus()
  const received = []
  bus.subscribe('room', event => received.push(event))
  const snapshot = {
    event_type: 'paid_message_snapshot', event_id: 'restored-1',
    items: [{ source_message_id: 'm1', display: { expire_at: '2026-09-22T01:00:00.000Z', remaining_sec: 300 } }]
  }
  assert.equal(bus.restorePaidSnapshot('room', snapshot), true)
  assert.equal(bus.bufferSize('room'), 0)
  assert.deepEqual(received, [])
  assert.equal(bus.getCurrentPaidSnapshot('room').event_id, 'restored-1')

  const upstream = {
    ...snapshot,
    event_id: 'upstream-1',
    items: [{ ...snapshot.items[0], display: { ...snapshot.items[0].display, remaining_sec: 299 } }]
  }
  assert.equal(bus.publishPaidSnapshot('room', upstream), null)
  assert.deepEqual(received, [])
  assert.equal(bus.getCurrentPaidSnapshot('room').event_id, 'restored-1')
})
