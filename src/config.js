const path = require('node:path')

const projectRoot = path.resolve(__dirname, '..')

function integer(name, fallback, min = 0) {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const value = Number.parseInt(raw, 10)
  if (!Number.isFinite(value) || value < min) throw new Error(`${name} 必须是大于等于 ${min} 的整数`)
  return value
}

function number(name, fallback, min = Number.NEGATIVE_INFINITY) {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isFinite(value) || value < min) throw new Error(`${name} 必须是大于等于 ${min} 的数字`)
  return value
}

function boolean(name, fallback = false) {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  return ['1', 'true', 'yes', 'on'].includes(raw.toLowerCase())
}

function resolvePath(value, fallback) {
  return path.resolve(value || fallback)
}

function loadConfig() {
  const dataDir = resolvePath(process.env.DATA_DIR, path.join(projectRoot, 'data'))
  return {
    env: process.env.NODE_ENV || 'development',
    host: process.env.HOST || '0.0.0.0',
    port: integer('PORT', 3000, 1),
    databaseUrl: process.env.DATABASE_URL || 'postgres://huya:huya@127.0.0.1:5432/huya_danmu',
    databaseSsl: boolean('DATABASE_SSL'),
    apiToken: process.env.ADMIN_API_TOKEN || '',
    alertWebhookUrl: process.env.ALERT_WEBHOOK_URL || '',
    initialRoomId: process.env.HUYA_ROOM_ID || '',
    pollIntervalMs: integer('LIVE_POLL_INTERVAL_SECONDS', 60, 15) * 1000,
    offlineConfirmations: integer('OFFLINE_CONFIRMATIONS', 2, 1),
    ingestBatchSize: integer('INGEST_BATCH_SIZE', 200, 1),
    ingestFlushMs: integer('INGEST_FLUSH_MS', 250, 25),
    bigGiftThresholdHuyaCoin: number('BIG_GIFT_THRESHOLD_HUYA_COIN', 100, 0),
    realtimeRingSize: integer('REALTIME_RING_SIZE', 3000, 1),
    dataDir,
    spoolDir: resolvePath(process.env.SPOOL_DIR, path.join(dataDir, 'spool')),
    archiveDir: resolvePath(process.env.ARCHIVE_DIR, path.join(dataDir, 'archives')),
    backupPath: process.env.BACKUP_PATH ? resolvePath(process.env.BACKUP_PATH) : null,
    databaseStoragePath: process.env.DATABASE_STORAGE_PATH
      ? resolvePath(process.env.DATABASE_STORAGE_PATH)
      : null,
    storageSampleMinutes: integer('STORAGE_SAMPLE_MINUTES', 60, 1),
    hotRetentionMonths: integer('HOT_RETENTION_MONTHS', 12, 1),
    rawPayloadRetentionDays: integer('RAW_PAYLOAD_RETENTION_DAYS', 30, 1),
    allowInsecureWs: boolean('HUYA_ALLOW_INSECURE_WS'),
    proxy: process.env.HUYA_PROXY || '',
    logLevel: process.env.LOG_LEVEL || 'info'
  }
}

module.exports = { loadConfig, integer, number, boolean }
