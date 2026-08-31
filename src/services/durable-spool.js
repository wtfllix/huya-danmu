const fs = require('node:fs/promises')
const path = require('node:path')

class DurableSpool {
  constructor({ directory, processBatch, batchSize = 200, flushMs = 250, logger = console }) {
    this.directory = directory
    this.file = path.join(directory, 'pending.ndjson')
    this.processBatch = processBatch
    this.batchSize = batchSize
    this.flushMs = flushMs
    this.logger = logger
    this.queue = []
    this.started = false
    this.processing = false
    this.writeChain = Promise.resolve()
    this.retryMs = 1000
    this.metrics = { processed: 0, failures: 0, lastBatchDurationMs: 0 }
  }

  async start() {
    if (this.started) return
    await fs.mkdir(this.directory, { recursive: true })
    try {
      const body = await fs.readFile(this.file, 'utf8')
      this.queue = body.split('\n').filter(Boolean).map(line => JSON.parse(line))
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      await fs.writeFile(this.file, '')
    }
    this.started = true
    this.timer = setInterval(() => this.drain(), this.flushMs)
    this.timer.unref?.()
    if (this.queue.length) await this.drain()
  }

  async enqueue(event) {
    if (!this.started) throw new Error('持久化缓冲尚未启动')
    const record = JSON.parse(JSON.stringify(event))
    this.writeChain = this.writeChain.catch(() => {}).then(async () => {
      await fs.appendFile(this.file, `${JSON.stringify(record)}\n`)
      this.queue.push(record)
    })
    await this.writeChain
    if (this.queue.length >= this.batchSize) this.drain()
  }

  async rewritePending() {
    this.writeChain = this.writeChain.then(async () => {
      const temporary = `${this.file}.tmp`
      const body = this.queue.length ? `${this.queue.map(item => JSON.stringify(item)).join('\n')}\n` : ''
      await fs.writeFile(temporary, body)
      await fs.rename(temporary, this.file)
    })
    await this.writeChain
  }

  async drain() {
    if (!this.started || this.processing || !this.queue.length) return
    this.processing = true
    const batch = this.queue.slice(0, this.batchSize)
    const startedAt = Date.now()
    try {
      await this.processBatch(batch)
      this.metrics.processed += batch.length
      this.queue.splice(0, batch.length)
      await this.rewritePending()
      this.retryMs = 1000
    } catch (error) {
      this.metrics.failures += 1
      this.logger.error?.({ error, queueDepth: this.queue.length }, '弹幕批量写入失败')
      const retry = this.retryMs
      this.retryMs = Math.min(this.retryMs * 2, 30000)
      setTimeout(() => this.drain(), retry).unref?.()
    } finally {
      this.metrics.lastBatchDurationMs = Date.now() - startedAt
      this.processing = false
      if (this.queue.length >= this.batchSize) setImmediate(() => this.drain())
    }
  }

  async stop({ drain = true } = {}) {
    clearInterval(this.timer)
    while (this.processing) await new Promise(resolve => setTimeout(resolve, 10))
    if (drain && this.queue.length) await this.drain()
    while (this.processing) await new Promise(resolve => setTimeout(resolve, 10))
    await this.writeChain
    this.started = false
  }

  get depth() {
    return this.queue.length
  }
}

module.exports = { DurableSpool }
