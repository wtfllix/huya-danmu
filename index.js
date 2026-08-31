// huya-danmu v3 — 虎牙直播弹幕监听(新版协议)
// 协议:ws://ws.api.huya.com → wsLaunch(WUP) → registerGroup(["live:<uid>","chat:<uid>"]) → 实时消息
// 消息 URI:1400=弹幕 6501=礼物 8006=人气
// 与原版 API 完全兼容:new huya_danmu(roomid), on('message'|'connect'|'error'|'close'), start()/stop()
const ws = require('ws')
const https = require('https')
const http = require('http')
const crypto = require('crypto')
const events = require('events')
const { Taf, HUYA } = require('./lib')

// ---- Taf.Wup.readFrom 补丁:新版响应带 context/status map,需要默认 Map 类 ----
Taf.Wup.prototype.readFrom = function (t) {
  this.iVersion = t.readInt16(1, true)
  this.cPacketType = t.readInt8(2, true)
  this.iMessageType = t.readInt32(3, true)
  this.iRequestId = t.readInt32(4, true)
  this.sServantName = t.readString(5, true)
  this.sFuncName = t.readString(6, true)
  this.sBuffer = t.readBytes(7, true)
  this.iTimeout = t.readInt32(8, true)
  this.context = t.readMap(9, true, new Taf.Map(new Taf.STRING, new Taf.STRING))
  this.status = t.readMap(10, true, new Taf.Map(new Taf.STRING, new Taf.STRING))
}

// WebSocketCommand 类型(新版协议)
const CMD = {
  WupReq: 3,
  WupRsp: 4,
  S2C_MsgPushReq: 7,
  C2S_RegisterGroupReq: 16,
  S2C_RegisterGroupRsp: 17,
  C2S_HeartBeatReq: 20,
  S2C_HeartBeatRsp: 21,
  S2C_MsgPushReq_V2: 22,
}

const WS_URL = 'ws://ws.api.huya.com'
const HEARTBEAT_INTERVAL = 60000
const UA = 'Mozilla/5.0 (Linux; Android 5.1.1; Nexus 6 Build/LYZ28E) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/63.0.3239.84 Mobile Safari/537.36'

function toAB(b) { return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) }
function md5(s) { return crypto.createHash('md5').update(String(s)).digest('hex') }

class huya_danmu extends events {
  constructor(opt) {
    super()
    if (typeof opt === 'string') {
      this._roomid = opt
    } else if (typeof opt === 'object') {
      this._roomid = opt.roomid
      if (opt.proxy) this._proxy = opt.proxy
    }
    this._gift_info = {}
    this._starting = false
    this._stopped = false
    this._retry = 0
  }

  // ---------- 页面请求 ----------
  _fetch(url) {
    return new Promise((resolve, reject) => {
      const mod = url.startsWith('https') ? https : http
      const req = mod.get(url, { headers: { 'User-Agent': UA } }, res => {
        let d = ''
        res.on('data', c => (d += c))
        res.on('end', () => resolve(d))
      })
      req.on('error', reject)
      req.setTimeout(15000, () => req.destroy(new Error('request timeout')))
    })
  }

  // 从新版页面 HNF_GLOBAL_INIT 提取主播 uid(不再需要 SUBSID/TOPSID)
  async _get_uid() {
    const body = await this._fetch(`https://m.huya.com/${this._roomid}`)
    const m = body.match(/"lUid"\s*:\s*(\d+)/)
    if (!m) throw new Error('无法从页面获取 lUid,房间可能不存在')
    return parseInt(m[1])
  }

  // ---------- 生命周期 ----------
  async start() {
    if (this._starting) return
    this._starting = true
    this._stopped = false
    try {
      this._yyuid = await this._get_uid()
    } catch (e) {
      this._starting = false
      this.emit('error', e)
      this.emit('close')
      return
    }
    this._connect()
  }

  _connect() {
    const opt = { perMessageDeflate: false }
    if (this._proxy) {
      const { SocksProxyAgent } = require('socks-proxy-agent')
      opt.agent = new SocksProxyAgent(this._proxy)
    }
    const client = new ws(WS_URL, opt)
    this._client = client
    client.on('open', () => this._on_open())
    client.on('message', data => this._on_message(data))
    client.on('error', err => this.emit('error', err))
    client.on('close', () => this._on_close())
  }

  _on_open() {
    this._retry = 0
    this.emit('connect')
    // 1) wsLaunch
    const wup = new Taf.Wup()
    wup.setServant('launch')
    wup.setFunc('wsLaunch')
    wup.setRequestId(1)
    wup.writeStruct('tReq', this._make_launch_req())
    this._send_ws_cmd(CMD.WupReq, wup.encode())
    // 心跳
    clearInterval(this._heartbeat_timer)
    this._heartbeat_timer = setInterval(() => this._heartbeat(), HEARTBEAT_INTERVAL)
  }

  _make_launch_req() {
    const r = {}
    r.lUid = this._yyuid
    r.sGuid = ''
    r.sUA = 'webh5&1.0.0&websocket'
    r.sAppSrc = ''
    r.tDeviceInfo = {}
    r.tDeviceInfo.writeTo = function (t) { for (let i = 0; i < 5; i++) t.writeString(i, '') }
    r.writeTo = function (t) {
      t.writeInt64(0, this.lUid)
      t.writeString(1, this.sGuid)
      t.writeString(2, this.sUA)
      t.writeString(3, this.sAppSrc)
      t.writeStruct(4, this.tDeviceInfo)
    }
    return r
  }

  // 2) 注册弹幕组
  _register_group() {
    const g = {}
    g.vGroupId = [`live:${this._yyuid}`, `chat:${this._yyuid}`]
    g.sToken = ''
    g.writeTo = function (t) {
      t.writeTo(0, Taf.DataHelp.EN_LIST)
      t.writeInt32(0, this.vGroupId.length)
      for (const x of this.vGroupId) t.writeString(0, x)
      t.writeString(1, this.sToken)
    }
    const s = new Taf.JceOutputStream()
    g.writeTo(s)
    this._send_ws_cmd(CMD.C2S_RegisterGroupReq, s.getBinBuffer())
  }

  // 3) 拉取礼物名称表
  _get_gift_list() {
    const req = new HUYA.GetPropsListReq()
    const uid = new HUYA.UserId()
    uid.lUid = this._yyuid
    uid.sHuYaUA = 'webh5&1.0.0&websocket'
    req.tUserId = uid
    req.iTemplateType = HUYA.EClientTemplateType.TPL_WEB
    this._send_wup('PropsUIServer', 'getPropsList', req, 3)
  }

  _heartbeat() {
    this._send_ws_cmd(CMD.C2S_HeartBeatReq, null)
  }

  // ---------- 发送 ----------
  _send_ws_cmd(cmdType, vData) {
    if (!this._client || this._client.readyState !== ws.OPEN) return
    const cmd = new HUYA.WebSocketCommand()
    cmd.iCmdType = cmdType
    if (vData) cmd.vData = vData
    const s = new Taf.JceOutputStream()
    cmd.writeTo(s)
    this._client.send(s.getBuffer())
  }

  _send_wup(servant, func, reqObj, requestId) {
    const wup = new Taf.Wup()
    wup.setServant(servant)
    wup.setFunc(func)
    wup.setRequestId(requestId || 2)
    wup.writeStruct('tReq', reqObj)
    this._send_ws_cmd(CMD.WupReq, wup.encode())
  }

  // ---------- 接收 ----------
  _on_message(data) {
    try {
      const cmd = new HUYA.WebSocketCommand()
      cmd.readFrom(new Taf.JceInputStream(toAB(Buffer.from(data))))
      switch (cmd.iCmdType) {
        case CMD.WupRsp:
          this._on_wup_rsp(cmd)
          break
        case CMD.S2C_RegisterGroupRsp:
          this._get_gift_list()
          break
        case CMD.S2C_HeartBeatRsp:
          break
        case CMD.S2C_MsgPushReq:
          this._on_push_v1(cmd)
          break
        case CMD.S2C_MsgPushReq_V2:
          this._on_push_v2(cmd)
          break
        default:
          break
      }
    } catch (e) {
      this.emit('error', e)
    }
  }

  _on_wup_rsp(cmd) {
    const wup = new Taf.Wup()
    wup.decode(cmd.vData.buffer)
    if (wup.sFuncName === 'wsLaunch') {
      this._register_group()
    } else if (wup.sFuncName === 'getPropsList') {
      try {
        const rsp = new HUYA.GetPropsListRsp()
        new Taf.JceInputStream(wup.newdata.get('tRsp').buffer).readStruct(0, true, rsp)
        rsp.vPropsItemList.value.forEach(item => {
          this._gift_info[item.iPropsId + ''] = { name: item.sPropsName, price: item.iPropsYb / 100 }
        })
      } catch (e) { /* 礼物表失败不影响主流程 */ }
    }
  }

  _on_push_v1(cmd) {
    const msg = {}
    msg.readFrom = function (t) {
      this.iUri = t.readInt32(1, true, 0)
      this.sMsg = t.readBytes(2, true, null)
    }
    msg.readFrom(new Taf.JceInputStream(cmd.vData.buffer))
    if (msg.sMsg) this._handle_uri(msg.iUri, msg.sMsg.buffer)
  }

  _on_push_v2(cmd) {
    const v2 = {}
    v2.readFrom = function (t) {
      this.sGroupId = t.readString(0, true, '')
      const head = t.readFrom()
      const items = []
      if (head.type === Taf.DataHelp.EN_LIST) {
        const n = t.readInt32(0, true)
        for (let i = 0; i < n; i++) {
          const item = {}
          item.readFrom = function (tt) {
            this.iUri = tt.readInt64(0, true, 0)
            this.sMsg = tt.readBytes(1, true, null)
          }
          try {
            item.readFrom(t)
            items.push(item)
          } catch (e) { break /* 解析失败中断,避免流错位 */ }
        }
      }
      this.vMsgItem = items
    }
    v2.readFrom(new Taf.JceInputStream(cmd.vData.buffer))
    for (const item of v2.vMsgItem) {
      if (!item.sMsg) continue
      try {
        this._handle_uri(item.iUri, item.sMsg.buffer)
      } catch (e) { /* 单条 item 失败跳过 */ }
    }
  }

  _handle_uri(uri, ab) {
    try {
      if (uri === 1400) {
        // 弹幕 MessageNotice: tUserInfo(0) lTid(1) sContent(3)
        const s = new Taf.JceInputStream(ab)
        const chat = {}
        chat.readFrom = function (t) {
          const u = {}
          u.readFrom = function (tt) {
            this.lUid = tt.readInt64(0, true, 0)
            this.sNickName = tt.readString(2, true, '')
          }
          this.tUserInfo = t.readStruct(0, true, u)
          this.sContent = t.readString(3, true, '')
        }
        chat.readFrom(s)
        this.emit('message', {
          type: 'chat',
          time: Date.now(),
          from: { name: chat.tUserInfo.sNickName, rid: String(chat.tUserInfo.lUid) },
          id: md5(JSON.stringify(chat)),
          content: chat.sContent,
        })
      } else if (uri === 6501) {
        // 礼物 SendItemSubBroadcastPacket
        const s = new Taf.JceInputStream(ab)
        const g = {}
        g.readFrom = function (t) {
          this.iItemType = t.readInt32(0, true, 0)
          this.iItemCount = t.readInt32(2, true, 0)
          this.lPresenterUid = t.readInt64(3, true, 0)
          this.lSenderUid = t.readInt64(4, true, 0)
          this.sSenderNick = t.readString(6, true, '')
        }
        g.readFrom(s)
        if (g.lPresenterUid !== this._yyuid) return
        const info = this._gift_info[g.iItemType + ''] || { name: `礼物(${g.iItemType})`, price: 0 }
        this.emit('message', {
          type: 'gift',
          time: Date.now(),
          name: info.name,
          from: { name: g.sSenderNick, rid: String(g.lSenderUid) },
          id: md5(JSON.stringify(g)),
          count: g.iItemCount,
          price: g.iItemCount * info.price,
          earn: g.iItemCount * info.price,
        })
      } else if (uri === 8006) {
        // 人气 AttendeeCountNotice
        const s = new Taf.JceInputStream(ab)
        const on = {}
        on.readFrom = function (t) { this.iAttendeeCount = t.readInt32(0, true, 0) }
        on.readFrom(s)
        this.emit('message', { type: 'online', time: Date.now(), count: on.iAttendeeCount })
      }
      // 其他 uri(系统/活动消息)忽略
    } catch (e) { /* 单条消息失败不影响整体 */ }
  }

  // ---------- 断线重连(指数退避) ----------
  _on_close() {
    clearInterval(this._heartbeat_timer)
    if (this._stopped) return
    const delay = Math.min(1000 * Math.pow(2, this._retry++), 30000)
    clearTimeout(this._reconnect_timer)
    this._reconnect_timer = setTimeout(() => {
      if (this._stopped) return
      this._connect()
    }, delay)
    this.emit('close')
  }

  stop() {
    this._stopped = true
    clearInterval(this._heartbeat_timer)
    clearTimeout(this._reconnect_timer)
    this.removeAllListeners()
    if (this._client) {
      try { this._client.terminate() } catch (e) { /* ignore */ }
      this._client = null
    }
  }
}

module.exports = huya_danmu
