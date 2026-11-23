// 弹幕分区命名与时间范围
// 分区统一按 UTC 边界切分（= 北京时间 08:00 对齐，与 001_init.sql 一致）
// 新版按天分区：danmu_messages_2026_11_24
// 历史月分区：  danmu_messages_2026_11（兼容保留，用于清理旧部署）
const TABLE_PREFIX = 'danmu_messages_'
const MONTH_SUFFIX = /^(\d{4})_(\d{2})$/
const DAY_SUFFIX = /^(\d{4})_(\d{2})_(\d{2})$/
// 供 SQL 侧筛选分区子表使用
const PARTITION_NAME_PATTERN = '^danmu_messages_[0-9]{4}_[0-9]{2}(_[0-9]{2})?$'

const DAY_MS = 86400000

function dayBounds(dateValue) {
  const date = new Date(dateValue)
  const start = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()))
  return { start, end: new Date(start.getTime() + DAY_MS) }
}

function messagePartitionName(dateValue) {
  const { start } = dayBounds(dateValue)
  const year = start.getUTCFullYear()
  const month = String(start.getUTCMonth() + 1).padStart(2, '0')
  const day = String(start.getUTCDate()).padStart(2, '0')
  return `${TABLE_PREFIX}${year}_${month}_${day}`
}

function parsePartitionName(tableName) {
  if (typeof tableName !== 'string' || !tableName.startsWith(TABLE_PREFIX)) return null
  const suffix = tableName.slice(TABLE_PREFIX.length)

  const day = suffix.match(DAY_SUFFIX)
  if (day) {
    const year = Number(day[1])
    const month = Number(day[2])
    const date = Number(day[3])
    const start = new Date(Date.UTC(year, month - 1, date))
    // 拒绝 2026_02_31 这类不存在的日期
    if (start.getUTCFullYear() !== year || start.getUTCMonth() !== month - 1 || start.getUTCDate() !== date) {
      return null
    }
    return {
      tableName,
      granularity: 'day',
      label: `${day[1]}-${day[2]}-${day[3]}`,
      start,
      end: new Date(start.getTime() + DAY_MS)
    }
  }

  const month = suffix.match(MONTH_SUFFIX)
  if (month) {
    const year = Number(month[1])
    const index = Number(month[2])
    if (index < 1 || index > 12) return null
    return {
      tableName,
      granularity: 'month',
      label: `${month[1]}-${month[2]}`,
      start: new Date(Date.UTC(year, index - 1, 1)),
      end: new Date(Date.UTC(year, index, 1))
    }
  }

  return null
}

module.exports = {
  TABLE_PREFIX,
  PARTITION_NAME_PATTERN,
  DAY_MS,
  dayBounds,
  messagePartitionName,
  parsePartitionName
}
