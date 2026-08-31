# huya-danmu

Node.js 虎牙直播弹幕监听模块(适配虎牙新版页面与协议)。

> **v3 说明**:虎牙页面改版后,旧版抓取 `SUBSID/TOPSID` 的方式已失效。v3 重写了协议层:
> 从新版页面提取主播 uid,通过 WebSocket 实时接收弹幕/礼物/人气,API 与旧版完全兼容。

## 安装

```bash
npm install huya-danmu --save
```

## 简单使用

```javascript
const huya_danmu = require('huya-danmu')
const roomid = '1995'          // 房间号或短码,如 'edc595'
const client = new huya_danmu(roomid)

client.on('connect', () => {
    console.log(`已连接huya ${roomid}房间弹幕~`)
})

client.on('message', msg => {
    switch (msg.type) {
        case 'chat':
            console.log(`[${msg.from.name}]:${msg.content}`)
            break
        case 'gift':
            console.log(`[${msg.from.name}]->赠送${msg.count}个${msg.name}`)
            break
        case 'online':
            console.log(`[当前人气]:${msg.count}`)
            break
    }
})

client.on('error', e => {
    console.log(e)
})

client.on('close', () => {
    console.log('close')
})

client.start()
```

## API

### 开始监听弹幕

```javascript
const huya_danmu = require('huya-danmu')
const roomid = '1995'
const client = new huya_danmu(roomid)
client.start()
```

### 使用 socks5 代理监听

```javascript
const huya_danmu = require('huya-danmu')
const roomid = '1995'
const proxy = 'socks://name:pass@127.0.0.1:1080'
const client = new huya_danmu({ roomid, proxy })
client.start()
```

### 使用老协议模式(可选)

```javascript
// 老协议(RegisterReq 单包绑定)更轻量,但收不到礼物消息(服务器不推送)
const client = new huya_danmu({ roomid, protocol: 'legacy' })
client.start()
```

### 停止监听弹幕

```javascript
client.stop()
```

### 断线重连

断线后自动重连(指数退避,最长 30s),无需手动处理。

```javascript
client.on('close', _ => {
    console.log('已断线,将自动重连')
})
```

### 监听事件

```javascript
client.on('connect', _ => console.log('connect'))
client.on('message', console.log)
client.on('error', console.log)
client.on('close', _ => console.log('close'))
```

### msg 对象

msg 对象 type 有 `chat`、`gift`、`online` 三种值。

#### chat 消息
```javascript
{
    type: 'chat',
    time: '毫秒时间戳,Number',
    from: { name: '发送者昵称,String', rid: '发送者uid,String' },
    id: '弹幕唯一id,String',
    content: '聊天内容,String'
}
```

#### gift 消息
```javascript
{
    type: 'gift',
    time: '毫秒时间戳,Number',
    name: '礼物名称,String',
    from: { name: '发送者昵称,String', rid: '发送者uid,String' },
    id: '唯一ID,String',
    count: '礼物数量,Number',
    price: '礼物总价值(单位Y币),Number',
    earn: '礼物总价值(单位元),Number'
}
```

#### online 消息
```javascript
{
    type: 'online',
    time: '毫秒时间戳,Number',
    count: '当前人气值,Number'
}
```

## 协议说明(v3)

### 默认协议:wsLaunch + registerGroup(新协议)

1. 请求 `https://m.huya.com/<roomid>`,从 `HNF_GLOBAL_INIT` JSON 提取主播 `lUid`(任何房间都有)
2. 连接 `ws://ws.api.huya.com`
3. 发送 `wsLaunch` WUP 请求(命令类型 3)
4. 注册弹幕组 `live:<uid>`、`chat:<uid>`(命令类型 16)
5. 每 60s 发送心跳(命令类型 20,回包 21)
6. 实时接收推送(命令类型 7/22),URI:1400=弹幕、6501=礼物、8006=人气
7. 礼物名称通过 `PropsUIServer/getPropsList` 拉取

**优点**:只依赖 `lUid`,未开播房间也能连接(开播后自动开始收弹幕);弹幕/礼物/人气全功能。

### 可选协议:RegisterReq(老协议)

- `opt.protocol: 'legacy'` 启用
- 单包 `WSUserInfo` 绑定(命令类型 1),需要页面 `lChannelId`/`lSubChannelId`(仅开播房间有)
- 更轻量,但**收不到礼物消息**

## 依赖

- [ws](https://www.npmjs.com/package/ws)
- [socks-proxy-agent](https://www.npmjs.com/package/socks-proxy-agent)
- `lib.js` 为虎牙 Taf/JCE 协议编解码库(源自本项目旧版,协议格式未变;修复了 `skipField` 对 int64 等类型不支持的问题)

## License

MIT
