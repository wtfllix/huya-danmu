const fs = require('node:fs/promises')
const path = require('node:path')
const crypto = require('node:crypto')
const parquet = require('parquetjs-lite')

const schema = new parquet.ParquetSchema({
  ingest_id: { type: 'UTF8', compression: 'GZIP' },
  room_id: { type: 'UTF8', compression: 'GZIP' },
  session_id: { type: 'UTF8', optional: true, compression: 'GZIP' },
  source_event_id: { type: 'UTF8', optional: true, compression: 'GZIP' },
  occurred_at: { type: 'UTF8', compression: 'GZIP' },
  received_at: { type: 'UTF8', compression: 'GZIP' },
  time_source: { type: 'UTF8', compression: 'GZIP' },
  sender_uid: { type: 'UTF8', optional: true, compression: 'GZIP' },
  sender_name: { type: 'UTF8', compression: 'GZIP' },
  content: { type: 'UTF8', compression: 'GZIP' },
  content_normalized: { type: 'UTF8', compression: 'GZIP' },
  raw_payload: { type: 'UTF8', optional: true, compression: 'GZIP' }
})

async function fileHash(file) {
  const hash = crypto.createHash('sha256')
  const handle = await fs.open(file, 'r')
  try {
    for await (const chunk of handle.createReadStream()) hash.update(chunk)
  } finally {
    await handle.close()
  }
  return hash.digest('hex')
}

function partitionRange(tableName) {
  const match = tableName.match(/^danmu_messages_(\d{4})_(\d{2})$/)
  if (!match) throw new Error('非法弹幕分区名称')
  const year = Number(match[1])
  const month = Number(match[2]) - 1
  return {
    start: new Date(Date.UTC(year, month, 1)),
    end: new Date(Date.UTC(year, month + 1, 1)),
    label: `${match[1]}-${match[2]}`
  }
}

class ArchiveService {
  constructor({ database, archiveDir, backupPath = null, logger = console }) {
    this.database = database
    this.archiveDir = archiveDir
    this.backupPath = backupPath
    this.logger = logger
    this.running = false
  }

  async archiveDue(hotRetentionMonths = 12) {
    if (this.running) throw Object.assign(new Error('已有归档任务正在运行'), { statusCode: 409 })
    this.running = true
    try {
      const now = new Date()
      const cutoff = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - hotRetentionMonths, 1))
      const partitions = await this.database.listMessagePartitionsBefore(cutoff)
      const results = []
      for (const partition of partitions) results.push(await this._archivePartition(partition.table_name))
      return results
    } finally {
      this.running = false
    }
  }

  async archivePartition(tableName) {
    if (this.running) throw Object.assign(new Error('已有归档任务正在运行'), { statusCode: 409 })
    this.running = true
    try {
      return await this._archivePartition(tableName)
    } finally {
      this.running = false
    }
  }

  async _archivePartition(tableName) {
    const range = partitionRange(tableName)
    const directory = path.join(this.archiveDir, String(range.start.getUTCFullYear()))
    const finalPath = path.join(directory, `${range.label}.parquet`)
    const temporaryPath = `${finalPath}.tmp`
    const existing = await this.database.getCompletedArchive(range.start, range.end)
    if (existing) {
      try {
        const checksum = await fileHash(finalPath)
        if (checksum === existing.checksum) {
          if (this.backupPath) {
            const backupDir = path.join(this.backupPath, String(range.start.getUTCFullYear()))
            const backupFile = path.join(backupDir, path.basename(finalPath))
            await fs.mkdir(backupDir, { recursive: true })
            if (existing.backup_status !== 'verified') await fs.copyFile(finalPath, backupFile)
            if (await fileHash(backupFile) !== checksum) throw new Error('归档备份校验失败')
            if (existing.backup_status !== 'verified') await this.database.markArchiveBackedUp(existing.id)
            await this.database.dropMessagePartition(tableName)
            existing.backup_status = 'verified'
          }
          return { runId: existing.id, tableName, path: finalPath, bytesWritten: Number(existing.bytes_written),
            rowCount: Number(existing.row_count), checksum, backupStatus: existing.backup_status, reused: true }
        }
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
      }
    }

    const runId = await this.database.createArchiveRun({ rangeStart: range.start, rangeEnd: range.end })
    let writer
    try {
      await fs.mkdir(directory, { recursive: true })
      writer = await parquet.ParquetWriter.openFile(schema, temporaryPath)
      writer.setRowGroupSize(8192)
      let cursorAt = null
      let cursorId = null
      let rowCount = 0
      while (true) {
        const values = []
        let cursorWhere = ''
        if (cursorAt && cursorId) {
          values.push(cursorAt, cursorId)
          cursorWhere = `WHERE (occurred_at, ingest_id) > ($1, $2)`
        }
        values.push(5000)
        const result = await this.database.query(
          `SELECT ingest_id, room_id, session_id, source_event_id, occurred_at, received_at,
                  time_source, sender_uid, sender_name, content, content_normalized, raw_payload
           FROM ${tableName} ${cursorWhere}
           ORDER BY occurred_at, ingest_id LIMIT $${values.length}`,
          values
        )
        if (!result.rows.length) break
        for (const row of result.rows) {
          await writer.appendRow({
            ...row,
            occurred_at: new Date(row.occurred_at).toISOString(),
            received_at: new Date(row.received_at).toISOString(),
            raw_payload: row.raw_payload ? JSON.stringify(row.raw_payload) : undefined
          })
        }
        rowCount += result.rows.length
        const last = result.rows.at(-1)
        cursorAt = last.occurred_at
        cursorId = last.ingest_id
      }
      await writer.close()
      writer = null
      await fs.rename(temporaryPath, finalPath)

      const reader = await parquet.ParquetReader.openFile(finalPath)
      const archivedRows = reader.getRowCount().toNumber()
      await reader.close()
      if (archivedRows !== rowCount) throw new Error(`Parquet 行数校验失败：预期 ${rowCount}，实际 ${archivedRows}`)

      const stat = await fs.stat(finalPath)
      const checksum = await fileHash(finalPath)
      let backupStatus = 'not_configured'
      if (this.backupPath) {
        const backupDir = path.join(this.backupPath, String(range.start.getUTCFullYear()))
        const backupFile = path.join(backupDir, path.basename(finalPath))
        await fs.mkdir(backupDir, { recursive: true })
        await fs.copyFile(finalPath, backupFile)
        if (await fileHash(backupFile) !== checksum) throw new Error('归档备份校验失败')
        backupStatus = 'verified'
      }
      await this.database.finishArchiveRun(runId, {
        path: finalPath,
        bytesWritten: stat.size,
        rowCount,
        checksum,
        backupStatus,
        status: 'completed'
      })
      let partitionDropped = false
      if (backupStatus === 'verified') {
        try {
          await this.database.dropMessagePartition(tableName)
          partitionDropped = true
        } catch (error) {
          this.logger.warn?.({ error, tableName }, '归档已完成，但删除热数据分区失败，将在下次维护重试')
        }
      }
      return { runId, tableName, path: finalPath, bytesWritten: stat.size, rowCount, checksum, backupStatus, partitionDropped }
    } catch (error) {
      if (writer) await writer.close().catch(() => {})
      await fs.unlink(temporaryPath).catch(() => {})
      await this.database.finishArchiveRun(runId, {
        path: finalPath,
        bytesWritten: null,
        rowCount: null,
        checksum: null,
        status: 'failed',
        error: error.message
      }).catch(() => {})
      throw error
    }
  }
}

module.exports = { ArchiveService, partitionRange, fileHash }
