const test = require('node:test')
const assert = require('node:assert/strict')
const EventEmitter = require('node:events')
const https = require('node:https')
const zlib = require('node:zlib')
const HuyaDanmu = require('../index')
const { Taf, HUYA } = require('../lib')

function mockHttpsResponse(t, { body, encoding, statusCode = 200 }) {
  const originalGet = https.get
  let requestOptions
  https.get = (url, options, callback) => {
    requestOptions = options
    const request = new EventEmitter()
    request.setTimeout = () => request
    request.destroy = error => request.emit('error', error)
    process.nextTick(() => {
      const response = new EventEmitter()
      response.statusCode = statusCode
      response.headers = encoding ? { 'content-encoding': encoding } : {}
      response.resume = () => {}
      callback(response)
      if (statusCode >= 200 && statusCode < 300) {
        response.emit('data', body.subarray(0, Math.ceil(body.length / 2)))
        response.emit('data', body.subarray(Math.ceil(body.length / 2)))
        response.emit('end')
      }
    })
    return request
  }
  t.after(() => { https.get = originalGet })
  return () => requestOptions
}

for (const [encoding, compress] of [
  ['gzip', zlib.gzipSync],
  ['deflate', zlib.deflateSync],
  ['br', zlib.brotliCompressSync]
]) {
  test(`页面请求可解压 ${encoding} 响应`, async t => {
    const html = '<script>{"lUid":1860008570,"lYyid":2112672604}</script>'
    const getRequestOptions = mockHttpsResponse(t, { body: compress(Buffer.from(html)), encoding })
    const client = new HuyaDanmu('116864')

    assert.equal(await client._fetch('https://m.huya.com/116864'), html)
    assert.equal(getRequestOptions().headers['Accept-Encoding'], 'gzip, deflate, br')
  })
}

test('页面请求拒绝非成功状态码', async t => {
  mockHttpsResponse(t, { body: Buffer.alloc(0), statusCode: 503 })
  const client = new HuyaDanmu('116864')
  await assert.rejects(client._fetch('https://m.huya.com/116864'), /HTTP 503/)
})

test('客户端支持停止后再次启动且保留业务监听器', async () => {
  class Probe extends HuyaDanmu {
    async _get_room_info() { return { lUid: 1, lChannelId: 1, lSubChannelId: 1 } }
    _connect() { this.connectCalls = (this.connectCalls || 0) + 1; this._starting = false }
  }
  const client = new Probe('1')
  let messages = 0
  client.on('message', () => messages++)
  await client.start()
  client.stop()
  await client.start()
  client.emit('message', {})
  assert.equal(client.connectCalls, 2)
  assert.equal(messages, 1)
  assert.ok(client instanceof EventEmitter)
})

test('客户端校验 roomid 并默认使用 WSS', () => {
  assert.throws(() => new HuyaDanmu(null), /roomid/)
  assert.equal(new HuyaDanmu(1995)._roomid, '1995')
  assert.equal(new HuyaDanmu('1995')._ws_url, HuyaDanmu.WSS_URL)
})

test('V2 批量推送正确消费列表中的结构边界', () => {
  const payload = new Taf.JceOutputStream()
  payload.writeString(0, 'live:1')
  payload.writeTo(1, Taf.DataHelp.EN_LIST)
  payload.writeInt32(0, 1)
  payload.writeStruct(0, {
    writeTo(stream) {
      stream.writeInt64(0, 1400)
      const bytes = new Taf.BinBuffer()
      bytes.writeBytes(new Uint8Array([1, 2, 3]))
      stream.writeBytes(1, bytes)
    }
  })
  const command = new HUYA.WebSocketCommand()
  command.vData = payload.getBinBuffer()
  const client = new HuyaDanmu('1')
  const received = []
  client._handle_uri = uri => received.push(uri)
  client._on_push_v2(command)
  assert.deepEqual(received, [1400])
})
