const state = { rooms: [], room: null, defaultRoomId: null, counts: [], token: localStorage.getItem('huya_api_token') || '' }
const $ = selector => document.querySelector(selector)

async function api(url, options = {}) {
  const headers = { 'content-type': 'application/json', ...(options.headers || {}) }
  if (state.token) headers.authorization = `Bearer ${state.token}`
  const response = await fetch(url, { ...options, headers })
  if (response.status === 204) return null
  const data = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(data.error || `HTTP ${response.status}`)
  return data
}

function toast(message) {
  const element = $('#toast')
  element.textContent = message
  element.classList.remove('hidden')
  clearTimeout(toast.timer)
  toast.timer = setTimeout(() => element.classList.add('hidden'), 3500)
}

function formatBytes(value) {
  if (value === null || value === undefined || !Number.isFinite(Number(value))) return '未知'
  const units = ['B', 'KB', 'MB', 'GB', 'TB']
  let number = Number(value)
  let index = 0
  while (number >= 1024 && index < units.length - 1) { number /= 1024; index++ }
  return `${number.toFixed(index > 1 ? 1 : 0)} ${units[index]}`
}

function formatTime(value) {
  if (!value) return '—'
  return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'medium' }).format(new Date(value))
}

function statusLabel(status) {
  return ({ disabled: '已暂停', unknown: '状态未知', offline: '未开播', starting: '连接中', listening: '监听中', degraded: '异常恢复中', stopping: '停止中' })[status] || status
}

async function loadHealth() {
  try {
    await api('/health/ready')
    $('#healthBadge').className = 'badge normal'
    $('#healthBadge').textContent = '服务正常'
  } catch {
    $('#healthBadge').className = 'badge error'
    $('#healthBadge').textContent = '服务异常'
  }
}

async function loadRooms() {
  const currentRoomId = state.room?.id
  state.rooms = await api('/api/v1/rooms')
  const defaultRoom = state.rooms.find(room => room.is_default) || null
  const defaultChanged = defaultRoom && defaultRoom.id !== state.defaultRoomId
  state.room = (defaultChanged ? defaultRoom : state.rooms.find(room => room.id === currentRoomId)) || defaultRoom || state.rooms[0] || null
  state.defaultRoomId = defaultRoom?.id || null

  const roomSelect = $('#roomSelect')
  roomSelect.replaceChildren()
  for (const room of state.rooms) {
    const option = document.createElement('option')
    option.value = room.id
    option.textContent = `${room.anchor_name || '未知主播'} · ${room.external_room_id}${room.is_default ? '（默认）' : ''}`
    roomSelect.append(option)
  }
  $('#roomViewSwitcher').classList.toggle('hidden', state.rooms.length < 2)
  if (state.room) roomSelect.value = state.room.id

  $('#roomEmpty').classList.toggle('hidden', Boolean(state.room))
  $('#roomCard').classList.toggle('hidden', !state.room)
  if (!state.room) return
  const room = state.room
  $('#anchorName').textContent = room.anchor_name || '未知主播'
  $('#externalRoomId').textContent = `房间 ${room.external_room_id}`
  $('#runtimeStatus').textContent = statusLabel(room.runtime_status)
  $('#lastChecked').textContent = formatTime(room.last_checked_at)
  $('#lastMessage').textContent = formatTime(room.last_message_at)
  $('#anchorUid').textContent = room.anchor_uid || '—'
  const roomError = $('#roomError')
  roomError.classList.toggle('hidden', !room.last_error)
  roomError.textContent = room.last_error?.message || ''
  $('#roomStatus').className = `status-dot ${room.runtime_status}`
  $('#toggleRoomButton').textContent = room.enabled ? '暂停监听' : '恢复监听'
}

function storageName(target) {
  return ({ database: '数据库', archive: '永久归档', backup: '独立备份' })[target] || target
}

async function loadStorage(force = false) {
  const data = await api(force ? '/api/v1/system/storage/sample' : '/api/v1/system/storage', force ? { method: 'POST' } : {})
  const container = $('#storageCards')
  container.replaceChildren()
  for (const item of data) {
    const card = document.createElement('div')
    card.className = `storage-card ${item.status}`
    const percent = Number.isFinite(item.percent) ? `${item.percent.toFixed(1)}%` : '未知'
    const remaining = Number.isFinite(item.daysRemaining) ? `预计 ${Math.max(0, Math.round(item.daysRemaining))} 天写满` : '写满日期：数据不足'
    card.innerHTML = `<header><span></span><span class="badge ${item.status}"></span></header><div class="storage-value"></div><div class="progress"><span></span></div><div class="storage-meta"></div>`
    card.querySelector('header span').textContent = storageName(item.target)
    card.querySelector('.badge').textContent = item.status
    card.querySelector('.storage-value').textContent = percent
    card.querySelector('.progress span').style.width = `${Math.min(100, item.percent || 0)}%`
    const categories = Object.entries(item.categorySizes || {})
      .filter(([, value]) => Number(value) > 0)
      .map(([key, value]) => `${({ database_bytes: '数据库', messages_bytes: '弹幕表', indexes_bytes: '索引', wal_bytes: 'WAL', temporary_bytes: '临时文件', archive_bytes: '归档', spool_bytes: '待写缓冲', backup_bytes: '备份' })[key] || key} ${formatBytes(value)}`)
      .join(' · ')
    card.querySelector('.storage-meta').textContent = `${formatBytes(item.usedBytes)} / ${formatBytes(item.totalBytes)} · ${remaining}${categories ? ` · ${categories}` : ''}`
    container.append(card)
  }
}

function drawChart(rows) {
  const canvas = $('#messageChart')
  const ratio = window.devicePixelRatio || 1
  const rect = canvas.getBoundingClientRect()
  canvas.width = rect.width * ratio
  canvas.height = rect.height * ratio
  const context = canvas.getContext('2d')
  context.scale(ratio, ratio)
  const width = rect.width
  const height = rect.height
  const pad = { top: 12, right: 10, bottom: 26, left: 42 }
  const counts = rows.map(row => Number(row.message_count))
  const max = Math.max(1, ...counts)
  context.strokeStyle = '#273140'
  context.fillStyle = '#8b98a9'
  context.font = '11px system-ui'
  for (let i = 0; i <= 4; i++) {
    const y = pad.top + (height - pad.top - pad.bottom) * i / 4
    context.beginPath(); context.moveTo(pad.left, y); context.lineTo(width - pad.right, y); context.stroke()
    context.fillText(Math.round(max * (1 - i / 4)).toLocaleString(), 0, y + 4)
  }
  if (!rows.length) return
  const x = index => pad.left + (width - pad.left - pad.right) * index / Math.max(1, rows.length - 1)
  const y = count => pad.top + (height - pad.top - pad.bottom) * (1 - count / max)
  const gradient = context.createLinearGradient(0, pad.top, 0, height - pad.bottom)
  gradient.addColorStop(0, 'rgba(255,122,26,.35)'); gradient.addColorStop(1, 'rgba(255,122,26,0)')
  context.beginPath(); context.moveTo(x(0), height - pad.bottom)
  rows.forEach((row, index) => context.lineTo(x(index), y(Number(row.message_count))))
  context.lineTo(x(rows.length - 1), height - pad.bottom); context.closePath(); context.fillStyle = gradient; context.fill()
  context.beginPath(); rows.forEach((row, index) => index ? context.lineTo(x(index), y(Number(row.message_count))) : context.moveTo(x(index), y(Number(row.message_count))))
  context.strokeStyle = '#ff7a1a'; context.lineWidth = 2; context.stroke()
  const labels = [0, Math.floor((rows.length - 1) / 2), rows.length - 1]
  context.fillStyle = '#8b98a9'
  for (const index of labels) context.fillText(new Date(rows[index].bucket_at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }), Math.max(pad.left, x(index) - 15), height - 7)
}

async function loadAnalytics() {
  if (!state.room) { drawChart([]); return }
  const date = $('#analysisDate').value
  const interval = $('#intervalSelect').value
  const from = `${date}T00:00:00+08:00`
  const [year, month, day] = date.split('-').map(Number)
  const nextDate = new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10)
  const to = `${nextDate}T00:00:00+08:00`
  const params = new URLSearchParams({ room_id: state.room.id, from, to, interval })
  const [counts, top] = await Promise.all([
    api(`/api/v1/analytics/message-counts?${params}`),
    api(`/api/v1/analytics/top-messages?room_id=${state.room.id}&date=${date}&limit=10`)
  ])
  state.counts = counts
  drawChart(counts)
  const total = counts.reduce((sum, row) => sum + Number(row.message_count), 0)
  const peak = counts.reduce((best, row) => Number(row.message_count) > Number(best?.message_count || -1) ? row : best, null)
  $('#dailyTotal').textContent = total.toLocaleString()
  $('#peakCount').textContent = Number(peak?.message_count || 0).toLocaleString()
  $('#peakBucket').textContent = peak ? new Date(peak.bucket_at).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '—'
  const list = $('#topMessages'); list.replaceChildren()
  if (!top.length) { const li = document.createElement('li'); li.className = 'empty-row'; li.textContent = '暂无数据'; list.append(li) }
  for (const item of top) {
    const li = document.createElement('li')
    const content = document.createElement('span'); content.textContent = item.content
    const count = document.createElement('span'); count.className = 'count'; count.textContent = `${Number(item.message_count).toLocaleString()} 次 · ${(Number(item.share) * 100).toFixed(1)}%`
    li.append(content, count); list.append(li)
  }
}

async function loadMessages() {
  if (!state.room) return
  const messages = await api(`/api/v1/rooms/${state.room.id}/messages?limit=100`)
  const feed = $('#recentMessages'); feed.replaceChildren()
  if (!messages.length) { const p = document.createElement('p'); p.className = 'empty-row'; p.textContent = '暂无数据'; feed.append(p); return }
  for (const item of messages) {
    const row = document.createElement('div'); row.className = 'message'
    const time = document.createElement('time'); time.textContent = new Date(item.occurred_at).toLocaleTimeString('zh-CN')
    const sender = document.createElement('span'); sender.className = 'sender'; sender.textContent = item.sender_name || '匿名'
    const content = document.createElement('span'); content.textContent = item.content
    row.append(time, sender, content); feed.append(row)
  }
}

async function loadArchives() {
  const rows = await api('/api/v1/system/archives?limit=10')
  const body = $('#archiveRows'); body.replaceChildren()
  if (!rows.length) { const tr = document.createElement('tr'); const td = document.createElement('td'); td.colSpan = 5; td.className = 'empty-row'; td.textContent = '尚无归档任务'; tr.append(td); body.append(tr); return }
  for (const item of rows) {
    const tr = document.createElement('tr')
    const values = [`${formatTime(item.range_start)} — ${formatTime(item.range_end)}`, item.status, Number(item.row_count || 0).toLocaleString(), formatBytes(item.bytes_written), item.backup_status]
    for (const value of values) { const td = document.createElement('td'); td.textContent = value; tr.append(td) }
    body.append(tr)
  }
}

async function refresh() {
  try {
    await Promise.all([loadHealth(), loadRooms(), loadStorage(), loadArchives()])
    await Promise.all([loadAnalytics(), loadMessages()])
  } catch (error) { toast(error.message) }
}

$('#roomForm').addEventListener('submit', async event => {
  event.preventDefault()
  try {
    await api('/api/v1/rooms', { method: 'POST', body: JSON.stringify({ roomId: $('#roomIdInput').value }) })
    $('#roomIdInput').value = ''; await refresh()
  } catch (error) { toast(error.message) }
})
$('#toggleRoomButton').addEventListener('click', async () => {
  try { await api(`/api/v1/rooms/${state.room.id}`, { method: 'PATCH', body: JSON.stringify({ enabled: !state.room.enabled }) }); await refresh() } catch (error) { toast(error.message) }
})
$('#sampleButton').addEventListener('click', () => loadStorage(true).catch(error => toast(error.message)))
$('#archiveButton').addEventListener('click', async () => { try { const result = await api('/api/v1/system/archives/run', { method: 'POST' }); toast(result.results.length ? '归档完成' : '没有到期数据'); await loadArchives() } catch (error) { toast(error.message) } })
$('#exportButton').addEventListener('click', async () => {
  if (!state.room) return
  try {
    const date = $('#analysisDate').value
    const [year, month, day] = date.split('-').map(Number)
    const next = new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10)
    const headers = state.token ? { authorization: `Bearer ${state.token}` } : {}
    const response = await fetch(`/api/v1/rooms/${state.room.id}/messages.csv?from=${date}T00:00:00%2B08:00&to=${next}T00:00:00%2B08:00`, { headers })
    if (!response.ok) throw new Error((await response.json()).error || '导出失败')
    const url = URL.createObjectURL(await response.blob())
    const link = document.createElement('a'); link.href = url; link.download = `huya-danmu-${date}.csv`; link.click()
    URL.revokeObjectURL(url)
  } catch (error) { toast(error.message) }
})
$('#refreshButton').addEventListener('click', refresh)
$('#roomSelect').addEventListener('change', async event => {
  state.room = state.rooms.find(room => room.id === event.target.value) || null
  try {
    await loadRooms()
    await Promise.all([loadAnalytics(), loadMessages()])
  } catch (error) { toast(error.message) }
})
$('#analyzeButton').addEventListener('click', () => loadAnalytics().catch(error => toast(error.message)))
$('#tokenButton').addEventListener('click', () => { const value = prompt('管理员 API Token', state.token); if (value !== null) { state.token = value.trim(); localStorage.setItem('huya_api_token', state.token); refresh() } })
window.addEventListener('resize', () => {
  clearTimeout(state.resizeTimer)
  state.resizeTimer = setTimeout(() => drawChart(state.counts), 100)
})

$('#analysisDate').value = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai' }).format(new Date())
setInterval(() => { $('#clock').textContent = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) }, 1000)
setInterval(() => { loadRooms().then(loadMessages).catch(() => {}) }, 10000)
refresh()
