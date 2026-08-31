const fs = require('node:fs/promises')
const path = require('node:path')
const { storageStatus } = require('../utils')

async function directorySize(directory) {
  let total = 0
  const entries = await fs.readdir(directory, { withFileTypes: true })
  for (const entry of entries) {
    const target = path.join(directory, entry.name)
    if (entry.isDirectory()) total += await directorySize(target)
    else if (entry.isFile()) total += (await fs.stat(target)).size
  }
  return total
}

async function fileSystemSnapshot(target, targetPath, categorySizes = {}) {
  try {
    await fs.mkdir(targetPath, { recursive: true })
    const stat = await fs.statfs(targetPath, { bigint: true })
    const totalBytes = Number(stat.blocks * stat.bsize)
    const availableBytes = Number(stat.bavail * stat.bsize)
    const usedBytes = totalBytes - availableBytes
    const percent = totalBytes ? usedBytes / totalBytes * 100 : null
    return {
      target,
      path: targetPath,
      totalBytes,
      usedBytes,
      availableBytes,
      percent,
      status: storageStatus(percent),
      categorySizes
    }
  } catch (error) {
    return {
      target,
      path: targetPath,
      totalBytes: null,
      usedBytes: null,
      availableBytes: null,
      percent: null,
      status: 'unknown',
      categorySizes,
      error: error.message
    }
  }
}

function addProjection(snapshot, samples) {
  const relevant = samples.filter(item => item.target === snapshot.target && item.used_bytes !== null)
  if (relevant.length < 2 || snapshot.usedBytes === null) return { ...snapshot, growthBytesPerDay: null, daysRemaining: null }
  const first = relevant[0]
  const last = relevant.at(-1)
  const elapsedDays = (new Date(last.sampled_at) - new Date(first.sampled_at)) / 86400000
  if (elapsedDays < 1) return { ...snapshot, growthBytesPerDay: null, daysRemaining: null }
  const growth = (Number(last.used_bytes) - Number(first.used_bytes)) / elapsedDays
  const daysRemaining = growth > 0 ? snapshot.availableBytes / growth : null
  return { ...snapshot, growthBytesPerDay: growth > 0 ? growth : 0, daysRemaining }
}

class StorageService {
  constructor({ database, archiveDir, spoolDir = null, backupPath, databaseStoragePath, webhookUrl = '', fetchImpl = globalThis.fetch, logger = console }) {
    this.database = database
    this.archiveDir = archiveDir
    this.spoolDir = spoolDir
    this.backupPath = backupPath
    this.databaseStoragePath = databaseStoragePath
    this.webhookUrl = webhookUrl
    this.fetch = fetchImpl
    this.logger = logger
    this.latest = []
  }

  async sample() {
    let databaseSizes = {}
    try {
      databaseSizes = await this.database.databaseSizes()
    } catch (error) {
      this.logger.warn?.({ error }, '无法读取 PostgreSQL 分类容量')
    }
    const targets = []
    if (this.databaseStoragePath) {
      targets.push(await fileSystemSnapshot('database', this.databaseStoragePath, databaseSizes))
    } else {
      targets.push({
        target: 'database',
        path: null,
        totalBytes: null,
        usedBytes: databaseSizes.database_bytes ? Number(databaseSizes.database_bytes) : null,
        availableBytes: null,
        percent: null,
        status: 'unknown',
        categorySizes: databaseSizes,
        error: '未配置 DATABASE_STORAGE_PATH，只能读取数据库对象大小'
      })
    }
    const archiveBytes = await directorySize(this.archiveDir).catch(() => 0)
    const spoolBytes = this.spoolDir ? await directorySize(this.spoolDir).catch(() => 0) : 0
    targets.push(await fileSystemSnapshot('archive', this.archiveDir, { archive_bytes: archiveBytes, spool_bytes: spoolBytes }))
    if (this.backupPath) {
      const backupBytes = await directorySize(this.backupPath).catch(() => 0)
      targets.push(await fileSystemSnapshot('backup', this.backupPath, { backup_bytes: backupBytes }))
    } else {
      targets.push({
        target: 'backup', path: null, totalBytes: null, usedBytes: null, availableBytes: null,
        percent: null, status: 'unknown', categorySizes: {}, error: '未配置 BACKUP_PATH'
      })
    }
    for (const target of targets) await this.database.saveStorageSnapshot(target)
    const history = await this.database.storageHistory(24 * 7)
    const previous = new Map(this.latest.map(item => [item.target, item.status]))
    this.latest = targets.map(target => addProjection(target, history))
    for (const target of this.latest) {
      const before = previous.get(target.target)
      if (['warning', 'high', 'critical'].includes(target.status) && before !== target.status) {
        await this.sendAlert(target).catch(error => this.logger.error?.({ error }, '磁盘 Webhook 告警失败'))
      }
    }
    return this.latest
  }

  async sendAlert(target) {
    if (!this.webhookUrl) return
    const response = await this.fetch(this.webhookUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        type: 'storage_threshold',
        target: target.target,
        status: target.status,
        usedPercent: target.percent,
        availableBytes: target.availableBytes,
        daysRemaining: target.daysRemaining,
        occurredAt: new Date().toISOString()
      }),
      signal: AbortSignal.timeout(10000)
    })
    if (!response.ok) throw new Error(`Webhook 返回 HTTP ${response.status}`)
  }

  async history(hours) {
    return this.database.storageHistory(hours)
  }
}

module.exports = { StorageService, fileSystemSnapshot, addProjection, directorySize }
