# 虎牙弹幕观察台

面向单主播长期运行的虎牙弹幕监听、保存和分析平台。它能自动检测开播状态，开播后连接弹幕服务，保存普通文本弹幕，并在 Web 管理端展示分时段弹幕量、每日高频弹幕 Top 10 和磁盘容量趋势。

## 已实现能力

- 自动检测开播/下播，采用连续两次离线确认避免状态抖动。
- 默认通过 WSS 监听虎牙弹幕，握手失败、断线后自动退避重连。
- PostgreSQL 月分区保存普通文本弹幕；礼物和人气通知不持久化。
- 数据库故障时先写本地持久化缓冲，恢复后幂等补写。
- 实时维护分钟统计、每日总量和每日高频弹幕文本排行。
- Web 页面展示监听状态、趋势图、Top 10、最近弹幕和归档记录。
- 展示数据库、归档、备份的磁盘使用率、增长速度和预计写满时间。
- 70%/80%/90% 磁盘水位分级；不会自动删除永久业务数据。
- 12 个月以前的数据可按月归档成 GZIP 压缩的 Parquet 文件。
- 归档有独立备份且校验通过后，才会删除对应 PostgreSQL 月分区。
- Docker Compose 部署、健康检查、Prometheus 文本指标。

完整产品和技术定义见 [docs/SPEC.md](docs/SPEC.md)。

## 快速启动

需要 Docker 和 Docker Compose。

```bash
cp .env.example .env
```

编辑 `.env`，至少修改 `POSTGRES_PASSWORD` 和 `ADMIN_API_TOKEN`，并按需设置 `HUYA_ROOM_ID`。然后启动：

```bash
docker compose up -d --build
docker compose logs -f app
```

打开 `http://服务器地址:3000`。若配置了 `ADMIN_API_TOKEN`，点击页面右上角“访问令牌”输入令牌。

停止服务不会删除数据：

```bash
docker compose down
```

不要使用 `docker compose down -v`，该命令会删除数据库和平台数据卷。

## 数据与备份

Compose 创建三个持久卷：

- `postgres-data`：最近 12 个月的 PostgreSQL 热数据。
- `app-data`：摄取缓冲和 Parquet 归档。
- `backup-data`：归档副本。

默认三个卷可能仍位于同一块物理磁盘。正式长期运行时，应把 `backup-data` 改为另一块磁盘、NAS 或对象存储挂载点。没有配置可用备份时，归档任务会生成 Parquet 文件，但不会删除 PostgreSQL 分区。

磁盘用量按全天持续 10 条弹幕/秒估算为每年约 120～220 GB PostgreSQL 热数据；每天直播 8 小时约为每年 40～73 GB。上线 7 天后应以 Web 页面的真实增长速度重新评估。

## 高频弹幕 Top 10 口径

每日 Top 10 指当天出现次数最多的 10 条文本：

- 去除首尾空白并执行 Unicode NFC 规范化。
- 不忽略大小写。
- 不合并不同标点、Emoji 或不同长度的“哈哈哈”。
- 数量相同时按规范化文本排序，保证结果稳定。
- 自然日按 `Asia/Shanghai` 计算。

## 环境变量

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DATABASE_URL` | 本机 PostgreSQL | 数据库连接串 |
| `HUYA_ROOM_ID` | 空 | 首次启动自动添加的虎牙房间号 |
| `ADMIN_API_TOKEN` | 空 | API 管理令牌；公网部署必须设置 |
| `ALERT_WEBHOOK_URL` | 空 | 磁盘水位变化时接收 JSON 的 Webhook |
| `LIVE_POLL_INTERVAL_SECONDS` | `60` | 开播状态检测间隔，最小 15 秒 |
| `OFFLINE_CONFIRMATIONS` | `2` | 确认下播所需连续离线次数 |
| `HOT_RETENTION_MONTHS` | `12` | PostgreSQL 热数据月数 |
| `RAW_PAYLOAD_RETENTION_DAYS` | `30` | 调试用完整协议载荷保留天数 |
| `STORAGE_SAMPLE_MINUTES` | `60` | 磁盘容量采样周期 |
| `DATABASE_STORAGE_PATH` | 空 | 应用可读的数据库文件系统路径 |
| `BACKUP_PATH` | 空 | 独立归档备份路径；未配置时不删数据库分区 |
| `HUYA_PROXY` | 空 | 可选 SOCKS5 代理 |
| `HUYA_ALLOW_INSECURE_WS` | `false` | 显式允许使用未加密 WS |

## 主要 API

```text
GET    /api/v1/rooms
POST   /api/v1/rooms
PATCH  /api/v1/rooms/:id
DELETE /api/v1/rooms/:id
GET    /api/v1/rooms/:id/sessions
GET    /api/v1/rooms/:id/messages
GET    /api/v1/rooms/:id/messages.csv

GET    /api/v1/analytics/message-counts
GET    /api/v1/analytics/top-messages
POST   /api/v1/analytics/rebuild

GET    /api/v1/system/storage
POST   /api/v1/system/storage/sample
GET    /api/v1/system/archives
POST   /api/v1/system/archives/run

GET    /health/live
GET    /health/ready
GET    /metrics
```

配置令牌后，`/api/*` 请求需要：

```text
Authorization: Bearer <ADMIN_API_TOKEN>
```

## 本地开发

需要 Node.js 22 或更高版本和 PostgreSQL 16/17。

```bash
npm install
npm test
npm run check
npm start
```

数据库表会在服务启动时自动创建。`npm test` 只运行离线自动化测试，不访问虎牙；实网协议测试使用：

```bash
npm run test:live -- 1995
```

## 继续作为监听库使用

平台仍保留原有模块入口：

```js
const HuyaDanmu = require('./index')
const client = new HuyaDanmu('1995')

client.on('ready', () => console.log('弹幕订阅完成'))
client.on('message', console.log)
client.on('error', console.error)
client.start()
```

`connect` 表示 WebSocket 已打开，`ready` 才表示虎牙握手和弹幕组订阅完成。调用 `stop()` 后可以再次 `start()`。

## 已知边界

- 虎牙不提供断线期间的历史消息重放，因此上游断网区间无法补采；平台只能保证已经接收到本机的数据不因数据库短暂故障而丢失。
- 开播检测依赖虎牙移动页面的 `HNF_GLOBAL_INIT`，页面协议变化时会进入 `unknown/degraded` 并记录错误。
- MVP 面向单机、单主播，不提供多节点高可用。
- 历史 Parquet 归档目前用于永久保存和离线检索；Web 即时分析依赖永久保存的分钟/每日聚合。

## License

MIT
