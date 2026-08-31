const fs = require('node:fs/promises')
const { loadConfig } = require('./config')
const { Database } = require('./db')
const { HuyaStatusDetector } = require('./huya/status-detector')
const { DurableSpool } = require('./services/durable-spool')
const { CollectorSupervisor } = require('./services/collector-supervisor')
const { StorageService } = require('./services/storage-service')
const { ArchiveService } = require('./services/archive-service')
const { buildApp } = require('./app')

function shanghaiDate(date = new Date(Date.now() - 86400000)) {
  return new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit'
  }).format(date)
}

async function main() {
  const config = loadConfig()
  await Promise.all([
    fs.mkdir(config.spoolDir, { recursive: true }),
    fs.mkdir(config.archiveDir, { recursive: true }),
    config.backupPath ? fs.mkdir(config.backupPath, { recursive: true }) : Promise.resolve()
  ])

  const database = new Database({ connectionString: config.databaseUrl, ssl: config.databaseSsl })
  await database.migrate()
  const detector = new HuyaStatusDetector()
  const spool = new DurableSpool({
    directory: config.spoolDir,
    batchSize: config.ingestBatchSize,
    flushMs: config.ingestFlushMs,
    processBatch: events => database.insertEventBatch(events)
  })
  await spool.start()
  const supervisor = new CollectorSupervisor({ database, detector, spool, config })
  const storage = new StorageService({
    database,
    archiveDir: config.archiveDir,
    spoolDir: config.spoolDir,
    backupPath: config.backupPath,
    databaseStoragePath: config.databaseStoragePath,
    webhookUrl: config.alertWebhookUrl
  })
  const archives = new ArchiveService({
    database, archiveDir: config.archiveDir, backupPath: config.backupPath
  })
  const app = buildApp({ config, database, detector, supervisor, spool, storage, archives })

  await app.listen({ host: config.host, port: config.port })
  await supervisor.start()
  const sampleStorage = async () => {
    const samples = await storage.sample()
    if (samples.some(item => ['high', 'critical'].includes(item.status))) {
      await archives.archiveDue(config.hotRetentionMonths)
    }
    return samples
  }
  sampleStorage().catch(error => app.log.warn({ err: error }, '初始存储采样失败'))
  const storageTimer = setInterval(
    () => sampleStorage().catch(error => app.log.error({ err: error }, '存储采样或自动归档失败')),
    config.storageSampleMinutes * 60000
  )
  const runMaintenance = async () => {
    try {
      const dates = await database.pendingDailyTopDates()
      for (const date of dates) await database.finalizeDailyTop(date)
      await database.runMaintenance(config.rawPayloadRetentionDays)
      await archives.archiveDue(config.hotRetentionMonths)
    } catch (error) {
      app.log.error({ err: error }, '每日维护任务失败')
    }
  }
  const initialMaintenanceTimer = setTimeout(runMaintenance, 60000)
  const maintenanceTimer = setInterval(runMaintenance, 86400000)

  let closing = false
  const shutdown = async signal => {
    if (closing) return
    closing = true
    app.log.info({ signal }, '正在停止服务')
    clearInterval(storageTimer)
    clearInterval(maintenanceTimer)
    clearTimeout(initialMaintenanceTimer)
    await supervisor.stop()
    await spool.stop({ drain: true })
    await app.close()
    await database.close()
  }
  process.once('SIGTERM', () => shutdown('SIGTERM').then(() => process.exit(0)))
  process.once('SIGINT', () => shutdown('SIGINT').then(() => process.exit(0)))
}

if (require.main === module) {
  main().catch(error => {
    console.error(error)
    process.exit(1)
  })
}

module.exports = { main, shanghaiDate }
