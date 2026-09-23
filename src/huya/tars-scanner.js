const TYPE_NAMES = {
  0: 'INT8',
  1: 'INT16',
  2: 'INT32',
  3: 'INT64',
  4: 'FLOAT',
  5: 'DOUBLE',
  6: 'STRING1',
  7: 'STRING4',
  8: 'MAP',
  9: 'LIST',
  10: 'STRUCT_BEGIN',
  11: 'STRUCT_END',
  12: 'ZERO',
  13: 'SIMPLELIST'
}

const INTEGER_TYPES = new Set([0, 1, 2, 3, 12])

class ScanAbort extends Error {
  constructor(reason) {
    super(reason)
    this.name = 'ScanAbort'
  }
}

class TarsScanner {
  constructor(buffer, options = {}) {
    if (!Buffer.isBuffer(buffer)) {
      if (buffer instanceof ArrayBuffer) buffer = Buffer.from(buffer)
      else if (ArrayBuffer.isView(buffer)) buffer = Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength)
      else throw new TypeError('scanTarsBuffer 需要 Buffer / ArrayBuffer / TypedArray')
    }
    this.buffer = buffer
    this.view = new DataView(buffer.buffer, buffer.byteOffset, buffer.byteLength)
    this.length = buffer.byteLength
    this.position = 0
    this.maxDepth = options.maxDepth || 64
    this.maxEvents = options.maxEvents || 100000
    this.lines = []
    this.events = []
    this.aborted = false
    this.abort = null
  }

  #require(bytes) {
    if (this.position + bytes > this.length) {
      throw new ScanAbort(`need ${bytes} bytes, remaining ${this.length - this.position}`)
    }
  }

  #u8() {
    this.#require(1)
    return this.view.getUint8(this.position++)
  }

  #i32() {
    this.#require(4)
    const value = this.view.getInt32(this.position)
    this.position += 4
    return value
  }

  #header() {
    const offset = this.position
    const first = this.#u8()
    let tag = (first >> 4) & 0x0f
    const type = first & 0x0f
    if (tag === 15) tag = this.#u8()
    return { offset, tag, type }
  }

  #record(depth, offset, tag, type) {
    if (this.events.length >= this.maxEvents) throw new ScanAbort('max events exceeded')
    const name = TYPE_NAMES[type] || `UNKNOWN(${type})`
    const event = { depth, offset, tag, type, name, length: null, count: null, endOffset: null }
    this.events.push(event)
    this.lines.push(`${'  '.repeat(depth)}@${String(offset).padStart(4, '0')} tag=${tag} type=${name}`)
    return this.events.length - 1
  }

  #annotate(index, label, value) {
    this.events[index][label] = value
    this.lines[index] += ` ${label}=${value}`
  }

  // Reads the silent count field that follows a LIST / MAP header.
  #readCount() {
    const field = this.#header()
    if (!INTEGER_TYPES.has(field.type)) {
      throw new ScanAbort(`list/map count field is ${TYPE_NAMES[field.type] || field.type} at offset ${field.offset}`)
    }
    switch (field.type) {
      case 12: return 0
      case 0: this.#require(1); { const v = this.view.getInt8(this.position); this.position += 1; return v }
      case 1: this.#require(2); { const v = this.view.getInt16(this.position); this.position += 2; return v }
      case 2: return this.#i32()
      case 3: this.#require(8); { const v = Number(this.view.getBigInt64(this.position)); this.position += 8; return v }
      default: throw new ScanAbort('unsupported count type')
    }
  }

  // Returns true when the field was a STRUCT_END terminator.
  #scanField(depth) {
    if (depth > this.maxDepth) throw new ScanAbort('max depth exceeded')
    const field = this.#header()
    const index = this.#record(depth, field.offset, field.tag, field.type)
    let structEnd = false
    switch (field.type) {
      case 11:
        structEnd = true
        break
      case 12:
        break
      case 0: this.#require(1); this.position += 1; break
      case 1: this.#require(2); this.position += 2; break
      case 2: this.#require(4); this.position += 4; break
      case 3: this.#require(8); this.position += 8; break
      case 4: this.#require(4); this.position += 4; break
      case 5: this.#require(8); this.position += 8; break
      case 6: {
        const length = this.#u8()
        this.#require(length)
        this.position += length
        this.#annotate(index, 'length', length)
        break
      }
      case 7: {
        const length = this.#i32()
        if (length < 0) throw new ScanAbort(`negative string length ${length}`)
        this.#require(length)
        this.position += length
        this.#annotate(index, 'length', length)
        break
      }
      case 8: {
        const count = this.#readCount()
        if (count < 0) throw new ScanAbort(`negative map count ${count}`)
        this.#annotate(index, 'length', count)
        for (let item = 0; item < count * 2; item++) this.#scanField(depth + 1)
        break
      }
      case 9: {
        const count = this.#readCount()
        if (count < 0) throw new ScanAbort(`negative list count ${count}`)
        this.#annotate(index, 'length', count)
        for (let item = 0; item < count; item++) this.#scanField(depth + 1)
        break
      }
      case 10:
        while (!this.#scanField(depth + 1)) { /* consume struct body */ }
        break
      case 13: {
        const element = this.#header()
        if (element.type !== 0) throw new ScanAbort(`simple list element type ${TYPE_NAMES[element.type] || element.type}`)
        const length = this.#readCount()
        if (length < 0) throw new ScanAbort(`negative simple list length ${length}`)
        this.#require(length)
        this.position += length
        this.#annotate(index, 'length', length)
        break
      }
      default:
        throw new ScanAbort(`unknown type ${field.type}`)
    }
    this.events[index].endOffset = this.position
    return structEnd
  }

  scan() {
    try {
      while (this.position < this.length) this.#scanField(0)
    } catch (error) {
      this.aborted = true
      this.abort = {
        offset: this.position,
        remaining: this.length - this.position,
        reason: error instanceof ScanAbort ? error.message : `unexpected ${error.name}: ${error.message}`
      }
    }
    return this.#result()
  }

  #result() {
    const lines = this.lines.slice()
    if (this.aborted) {
      lines.push(`SCAN_ABORT offset=${this.abort.offset} remaining=${this.abort.remaining} reason=${this.abort.reason}`)
    }
    return {
      output: lines.length ? `${lines.join('\n')}\n` : '',
      lines,
      events: this.events,
      aborted: this.aborted,
      abort: this.abort,
      remaining: this.length - this.position,
      totalLength: this.length
    }
  }
}

const SIGNATURE_NAMES = {
  INT8: 'I8', INT16: 'I16', INT32: 'I32', INT64: 'I64',
  FLOAT: 'F32', DOUBLE: 'F64', STRING1: 'STR', STRING4: 'STR',
  MAP: 'MAP', LIST: 'LIST', STRUCT_BEGIN: 'S', STRUCT_END: 'E',
  ZERO: 'Z', SIMPLELIST: 'BYTES'
}

function listItemSignatures(result) {
  if (result.aborted) return { list: null, items: [] }
  const list = result.events.find(event =>
    event.depth === 0 && event.type === 9 && (event.tag === 0 || event.tag === 1))
  if (!list || !Number.isInteger(list.endOffset)) return { list: null, items: [] }
  const roots = result.events.filter(event =>
    event.depth === list.depth + 1 && event.offset > list.offset &&
    event.offset < list.endOffset && event.tag === 0 && event.type === 10)
  return {
    list: { tag: list.tag, count: list.length, offset: list.offset, endOffset: list.endOffset },
    items: roots.map((root, index) => {
      const events = result.events.filter(event =>
        event.offset >= root.offset && event.offset < root.endOffset && event.depth >= root.depth)
      const lines = events.map(event => {
        const name = SIGNATURE_NAMES[event.name] || event.name
        const suffix = (event.name === 'LIST' || event.name === 'MAP') && event.length != null
          ? `[${event.length}]`
          : ''
        return `${'  '.repeat(event.depth - root.depth)}${name}(${event.tag})${suffix}`
      })
      return {
        index,
        startOffset: root.offset,
        endOffset: root.endOffset,
        bytesConsumed: root.endOffset - root.offset,
        nextOffset: roots[index + 1]?.offset ?? list.endOffset,
        lines,
        text: lines.join('\n')
      }
    })
  }
}

function scanTarsBuffer(buffer, options = {}) {
  return new TarsScanner(buffer, options).scan()
}

function scanTarsSignatures(buffer, options = {}) {
  const result = scanTarsBuffer(buffer, options)
  return { ...result, signatures: listItemSignatures(result) }
}

module.exports = { scanTarsBuffer, scanTarsSignatures, listItemSignatures, TarsScanner, TYPE_NAMES }
