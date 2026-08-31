const HuyaDanmu = require('../index')

const roomId = process.argv[2] || '1995'
const client = new HuyaDanmu(roomId)

client.on('connect', () => console.log(`WebSocket 已连接：${roomId}`))
client.on('ready', () => console.log(`弹幕订阅已就绪：${roomId}`))
client.on('message', message => console.log(message))
client.on('parseError', ({ uri, error }) => console.error('解析失败：', uri, error.message))
client.on('error', error => console.error('连接错误：', error.message))
client.on('close', () => console.log('连接关闭，等待自动重连'))

process.once('SIGINT', () => {
  client.stop()
  process.exit(0)
})

client.start()
