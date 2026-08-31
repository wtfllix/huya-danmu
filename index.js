// huya-danmu v3 — 虎牙直播弹幕监听(双协议自适应)
//
// 默认协议(推荐):新协议 wsLaunch(WUP) → registerGroup(命令16)
//   —— 只依赖 lUid,任何房间可用;弹幕/礼物/人气全功能
// 可选协议:opt.protocol = 'legacy' 时用老协议 RegisterReq(命令1)
//   —— 单包进组更轻量,但**收不到礼物消息**(服务器不推送 6501)
//
// 消息推送 —— 命令7(V1) / 命令22(V2),URI: 1400=弹幕 6501=礼物 8006=人气
// 心跳     —— 命令20 → 回包21,每 60s
//
// 与原版 API 完全兼容:
//   new huya_danmu(roomid | {roomid, proxy, protocol?})
//   client.on('connect' | 'message' | 'error' | 'close')
//   client.start() / client.stop()
const ws = require('ws')
const https = require('https')
const crypto = require('crypto')
const { EventEmitter } = require('events')
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

// WebSocketCommand 类型
const CMD = {
  RegisterReq: 1,          // 老协议:WSUserInfo 绑定
  RegisterRsp: 2,
  WupReq: 3,               // WUP 请求(wsLaunch / getPropsList)
  WupRsp: 4,
  S2C_MsgPushReq: 7,       // 消息推送 V1
  C2S_RegisterGroupReq: 16, // 新协议:注册弹幕组
  S2C_RegisterGroupRsp: 17,
  C2S_HeartBeatReq: 20,    // 心跳
  S2C_HeartBeatRsp: 21,
  S2C_MsgPushReq_V2: 22,   // 消息推送 V2
}

// 消息 URI
const URI = { CHAT: 1400, GIFT: 6501, ONLINE: 8006 }

const WS_URL = 'ws://ws.api.huya.com'
const WSS_URL = 'wss://cdnws.api.huya.com'
const HEARTBEAT_INTERVAL = 60000
const HANDSHAKE_TIMEOUT = 15000
const UA = 'Mozilla/5.0 (Linux; Android 6.0; Nexus 5 Build/MRA58N) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/79.0.3945.88 Mobile Safari/537.36'

function toAB(b) { return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) }
function md5(s) { return crypto.createHash('md5').update(String(s)).digest('hex') }

class huya_danmu extends EventEmitter {
  constructor(opt) {
    super()
    if (typeof opt === 'string' || typeof opt === 'number') {
      this._roomid = String(opt)
    } else if (opt && typeof opt === 'object' && !Array.isArray(opt)) {
      this._roomid = String(opt.roomid || '')
      if (opt.proxy) this._proxy = opt.proxy
      if (opt.protocol === 'legacy') this._protocol = 'legacy'
      if (opt.wsUrl) this._ws_url = opt.wsUrl
    }
    if (!this._roomid) throw new TypeError('roomid 必须是非空字符串或数字')
    this._ws_url = this._ws_url || WSS_URL
    this._gift_info = {}      // 礼物 id → {name, price}
    this._starting = false
    this._stopped = false
    this._retry = 0           // 重连退避计数
  }

  // ================= 页面信息 =================

  _fetch(url) {
    return new Promise((resolve, reject) => {
      const req = https.get(url, { headers: { 'User-Agent': UA } }, res => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          res.resume()
          reject(new Error(`虎牙页面请求失败: HTTP ${res.statusCode}`))
          return
        }
        let d = ''
        res.on('data', c => {
          d += c
          if (d.length > 5 * 1024 * 1024) req.destroy(new Error('虎牙页面响应超过 5 MB'))
        })
        res.on('end', () => resolve(d))
      })
      req.on('error', reject)
      req.setTimeout(15000, () => req.destroy(new Error('request timeout')))
    })
  }

  // 从新版页面提取房间信息:
  //   lUid/lYyid —— 任何房间都有(主播身份)
  //   lChannelId/lSubChannelId —— 仅开播房间有(直播流频道)
  async _get_room_info() {
    const body = await this._fetch(`https://m.huya.com/${this._roomid}`)
    const find = kw => {
      const m = body.match(new RegExp('"' + kw + '"\\s*:\\s*(\\d+)'))
      return m ? parseInt(m[1]) : 0
    }
    const info = {
      lUid: find('lUid') || find('lYyid'),
      lChannelId: find('lChannelId'),
      lSubChannelId: find('lSubChannelId'),
    }
    if (!info.lUid) throw new Error('无法从页面获取主播 uid,房间可能不存在')
    return info
  }

  // ================= 生命周期 =================

  async start() {
    if (this._starting || (this._client && this._client.readyState < ws.CLOSING)) return
    this._starting = true
    this._stopped = false
    try {
      this._info = await this._get_room_info()
    } catch (e) {
      this._starting = false
      this.emit('error', e)
      this.emit('close')
      return
    }
    this._connect()
  }

  _connect() {
    this._starting = true
    const opt = { perMessageDeflate: false }
    if (this._proxy) {
      const { SocksProxyAgent } = require('socks-proxy-agent')
      opt.agent = new SocksProxyAgent(this._proxy)
    }
    const client = new ws(this._ws_url, opt)
    this._client = client
    client.on('open', () => this._on_open())
    client.on('message', data => this._on_message(data))
    client.on('error', err => this.emit('error', err))
    client.on('close', () => this._on_close())
  }

  _on_open() {
    // 协议选择:默认新协议(全功能);legacy 需房间在播(有 lChannelId)
    if (this._protocol === 'legacy' && this._info.lChannelId && this._info.lSubChannelId) {
      this._handshake_mode = 'legacy'
      this._handshake_legacy()
    } else {
      this._handshake_mode = 'new'
      this._handshake_new()
    }
    this.emit('connect')
    clearTimeout(this._handshake_timer)
    this._handshake_timer = setTimeout(() => {
      const error = new Error('虎牙协议握手超时')
      error.code = 'HUYA_HANDSHAKE_TIMEOUT'
      this.emit('error', error)
      if (this._client) this._client.terminate()
    }, HANDSHAKE_TIMEOUT)
    clearInterval(this._heartbeat_timer)
    this._heartbeat_timer = setInterval(() => this._heartbeat(), HEARTBEAT_INTERVAL)
  }

  // ================= 握手:老协议(RegisterReq) =================
  // 单包绑定 WSUserInfo,real-url 等长期使用的方案,最轻量
  // 注意:此模式收不到礼物消息(6501),仅弹幕+人气
  _handshake_legacy() {
    const info = new HUYA.WSUserInfo()
    info.lUid = this._info.lUid
    info.bAnonymous = true
    info.sGuid = ''
    info.sToken = ''
    info.lTid = this._info.lChannelId
    info.lSid = this._info.lSubChannelId
    info.lGroupId = 0
    info.lGroupType = 0
    const j = new Taf.JceOutputStream()
    info.writeTo(j)
    this._send_ws_cmd(CMD.RegisterReq, j.getBinBuffer())
  }

  // ================= 握手:新协议(wsLaunch + registerGroup) =================
  // 官方 web 客户端当前方案,只依赖 lUid,未开播房间也能注册
  _handshake_new() {
    const wup = new Taf.Wup()
    wup.setServant('launch')
    wup.setFunc('wsLaunch')
    wup.setRequestId(1)
    wup.writeStruct('tReq', this._make_launch_req())
    this._send_ws_cmd(CMD.WupReq, wup.encode())
  }

  _make_launch_req() {
    const r = {}
    r.lUid = this._info.lUid
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

  _register_group() {
    const g = {}
    g.vGroupId = [`live:${this._info.lUid}`, `chat:${this._info.lUid}`]
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

  // ================= 心跳 =================

  _heartbeat() {
    this._send_ws_cmd(CMD.C2S_HeartBeatReq, null)
  }

  // ================= 发送 =================

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

  // ================= 接收 =================

  _on_message(data) {
    try {
      const cmd = new HUYA.WebSocketCommand()
      cmd.readFrom(new Taf.JceInputStream(toAB(Buffer.from(data))))
      switch (cmd.iCmdType) {
        case CMD.RegisterRsp:
          this._on_ready()
          break
        case CMD.WupRsp:
          this._on_wup_rsp(cmd)
          break
        case CMD.S2C_RegisterGroupRsp:
          this._on_ready()
          this._get_gift_list()
          break
        case CMD.S2C_MsgPushReq:
          this._on_push_v1(cmd)
          break
        case CMD.S2C_MsgPushReq_V2:
          this._on_push_v2(cmd)
          break
        // RegisterRsp / HeartBeatRsp:无需处理
        default:
          break
      }
    } catch (e) {
      this.emit('error', e)
    }
  }

  _on_ready() {
    if (!this._starting) return
    clearTimeout(this._handshake_timer)
    this._starting = false
    this._retry = 0
    this.emit('ready')
  }

  _on_wup_rsp(cmd) {
    const wup = new Taf.Wup()
    wup.decode(cmd.vData.buffer)
    if (wup.sFuncName === 'wsLaunch') {
      // 新协议:wsLaunch 成功后注册弹幕组
      this._register_group()
    } else if (wup.sFuncName === 'getPropsList') {
      this._parse_gift_list(wup)
    }
  }

  _parse_gift_list(wup) {
    try {
      const rsp = new HUYA.GetPropsListRsp()
      new Taf.JceInputStream(wup.newdata.get('tRsp').buffer).readStruct(0, true, rsp)
      rsp.vPropsItemList.value.forEach(item => {
        this._gift_info[item.iPropsId + ''] = { name: item.sPropsName, price: item.iPropsYb / 100 }
      })
    } catch (e) { this.emit('parseError', { uri: 'getPropsList', error: e }) }
  }

  _get_gift_list() {
    const req = new HUYA.GetPropsListReq()
    const uid = new HUYA.UserId()
    uid.lUid = this._info.lUid
    uid.sHuYaUA = 'webh5&1.0.0&websocket'
    req.tUserId = uid
    req.iTemplateType = HUYA.EClientTemplateType.TPL_WEB
    this._send_wup('PropsUIServer', 'getPropsList', req, 3)
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
    // V2:sGroupId(0) + vMsgItem(1)[ {iUri int64, sMsg} ]
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
            t.readStruct(0, true, item)
            items.push(item)
          } catch (e) {
            this.emitParseError = e
            break
          }
        }
      }
      this.vMsgItem = items
    }
    v2.readFrom(new Taf.JceInputStream(cmd.vData.buffer))
    if (v2.emitParseError) this.emit('parseError', { uri: 'push-v2', error: v2.emitParseError })
    for (const item of v2.vMsgItem) {
      if (!item.sMsg) continue
      this._handle_uri(item.iUri, item.sMsg.buffer)
    }
  }

  _handle_uri(uri, ab) {
    try {
      if (uri === URI.CHAT) {
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
          this.lTid = t.readInt64(1, true, 0)
          this.lSid = t.readInt64(2, true, 0)
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
      } else if (uri === URI.GIFT) {
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
        if (g.lPresenterUid !== this._info.lUid) return
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
      } else if (uri === URI.ONLINE) {
        // 人气 AttendeeCountNotice
        const s = new Taf.JceInputStream(ab)
        const on = {}
        on.readFrom = function (t) { this.iAttendeeCount = t.readInt32(0, true, 0) }
        on.readFrom(s)
        this.emit('message', { type: 'online', time: Date.now(), count: on.iAttendeeCount })
      }
      // 其他 uri(系统/活动消息)忽略
    } catch (e) { this.emit('parseError', { uri, error: e }) }
  }

  // ================= 断线重连(指数退避) =================

  _on_close() {
    clearInterval(this._heartbeat_timer)
    clearTimeout(this._handshake_timer)
    this._starting = false
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
    this._starting = false
    clearInterval(this._heartbeat_timer)
    clearTimeout(this._reconnect_timer)
    clearTimeout(this._handshake_timer)
    if (this._client) {
      const client = this._client
      this._client = null
      client.removeAllListeners()
      try { client.terminate() } catch (e) { /* ignore */ }
    }
  }
}

module.exports = huya_danmu
module.exports.WS_URL = WS_URL
module.exports.WSS_URL = WSS_URL
