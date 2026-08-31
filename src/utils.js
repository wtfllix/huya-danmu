const crypto = require('node:crypto')

function normalizeContent(content) {
  return String(content ?? '').trim().normalize('NFC')
}

function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex')
}

function clampLimit(value, fallback = 100, max = 1000) {
  const parsed = Number.parseInt(value, 10)
  if (!Number.isFinite(parsed) || parsed < 1) return fallback
  return Math.min(parsed, max)
}

function parseDate(value, name) {
  const date = new Date(value)
  if (!value || Number.isNaN(date.getTime())) {
    const error = new Error(`${name} 不是有效的 ISO 8601 时间`)
    error.statusCode = 400
    throw error
  }
  return date
}

function storageStatus(percent) {
  if (percent === null || !Number.isFinite(percent)) return 'unknown'
  if (percent >= 90) return 'critical'
  if (percent >= 80) return 'high'
  if (percent >= 70) return 'warning'
  return 'normal'
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms))
}

module.exports = { normalizeContent, sha256, clampLimit, parseDate, storageStatus, sleep }
