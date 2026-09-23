const crypto = require('node:crypto')

function stableJson(value) {
  return JSON.stringify(value, (_key, item) => {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      return Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]]))
    }
    return item
  })
}

function paidSnapshotSignature(items) {
  return stableJson((items || []).map(item => {
    const copy = { ...item }
    if (copy.display) {
      copy.display = { ...copy.display }
      delete copy.display.remaining_sec
    }
    return copy
  }))
}

class RealtimeEventBus {
  constructor({ ringSize = 3000 } = {}) {
    this.ringSize = ringSize
    this.rooms = new Map()
  }

  #room(roomId) {
    const key = String(roomId)
    let state = this.rooms.get(key)
    if (!state) {
      state = { events: [], subscribers: new Set(), paidSnapshot: null, paidSignature: null }
      this.rooms.set(key, state)
    }
    return state
  }

  publish(roomId, event) {
    const state = this.#room(roomId)
    const value = { ...event, event_id: String(event.event_id || crypto.randomUUID()) }
    state.events.push(value)
    if (state.events.length > this.ringSize) state.events.splice(0, state.events.length - this.ringSize)
    for (const listener of [...state.subscribers]) {
      try { listener(value) } catch (_) { /* a slow/broken client must not stop the collector */ }
    }
    return value
  }

  publishPaidSnapshot(roomId, event) {
    const state = this.#room(roomId)
    const signature = paidSnapshotSignature(event.items)
    if (state.paidSignature === signature) {
      if (state.paidSnapshot) {
        state.paidSnapshot = { ...event, event_id: state.paidSnapshot.event_id }
      }
      return null
    }
    state.paidSignature = signature
    state.paidSnapshot = { ...event, event_id: String(event.event_id || crypto.randomUUID()) }
    return this.publish(roomId, state.paidSnapshot)
  }

  restorePaidSnapshot(roomId, snapshot) {
    if (!snapshot || !Array.isArray(snapshot.items) || snapshot.items.length === 0) return false
    const state = this.#room(roomId)
    state.paidSnapshot = { ...snapshot, items: [...snapshot.items] }
    state.paidSignature = paidSnapshotSignature(state.paidSnapshot.items)
    return true
  }

  getCurrentPaidSnapshot(roomId) {
    return this.#room(roomId).paidSnapshot
  }

  getSince(roomId, lastEventId) {
    const events = this.#room(roomId).events
    if (!lastEventId) return []
    const index = events.findIndex(event => event.event_id === String(lastEventId))
    return index === -1 ? null : events.slice(index + 1)
  }

  subscribe(roomId, listener) {
    const state = this.#room(roomId)
    state.subscribers.add(listener)
    let active = true
    return () => {
      if (!active) return
      active = false
      state.subscribers.delete(listener)
    }
  }

  subscriberCount(roomId) {
    return this.#room(roomId).subscribers.size
  }

  bufferSize(roomId) {
    return this.#room(roomId).events.length
  }
}

module.exports = { RealtimeEventBus }
