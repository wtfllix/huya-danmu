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

完整产品和技术定义见 [docs/SPEC.md](docs/SPEC.md)，与主播主题网站的后续集成路线见 [docs/ROADMAP.md](docs/ROADMAP.md)。

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
GET    /api/v1/rooms/:id/live-status
POST   /api/v1/rooms
PATCH  /api/v1/rooms/:id
DELETE /api/v1/rooms/:id
GET    /api/v1/rooms/:id/sessions
GET    /api/v1/rooms/:id/messages
GET    /api/v1/rooms/:id/messages.csv

GET    /api/v1/analytics/message-counts
GET    /api/v1/analytics/top-messages
GET    /api/v1/analytics/realtime-top-messages
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

### 当前平台直播状态

`GET /api/v1/rooms/:id/live-status` 使用内部 room UUID，仅读取已持久化的虎牙页面观察，不请求虎牙、不启动 collector、不修改房间。不存在的房间返回现有格式的 404；沿用上述 API 令牌认证。响应不含 collector 内部信息、错误详情或完整 metadata，使用 `Cache-Control: no-store`，无额外进程缓存。

```json
{
  "room_id": "<internal room uuid>",
  "external_room_id": "116864",
  "status": "live",
  "observed_at": "2026-10-10T08:42:20.000Z",
  "valid_until": "2026-10-10T08:44:20.000Z",
  "live_started_at": "2026-10-10T07:15:00.000Z",
  "live_session_id": "<internal live session uuid>",
  "source": "m.huya.com:HNF_GLOBAL_INIT"
}
```

状态 authority 仅来自 `roomInfo.eLiveStatus`：成功解析的非负安全整数（或纯数字字符串）中，`2` 为 `live`，其他值为 `offline`；已观察的 `1` / `3` 不推断更细的业务语义。缺失、null、空字符串、布尔值、NaN 或其他无法可靠解析的值均作为检测失败处理。HTTP 错误、超时、缺失 `HNF_GLOBAL_INIT`、无效 JSON 等失败立即将 authority 写成 `unknown`，保留最后成功的原始值和观察时间供诊断。不会因为 `lLiveChannel > 0` 回退到 LIVE，也不会用 channel 为 0 证明 OFFLINE。

成功状态存入 `rooms.metadata` 的 `liveStatus`、`liveStatusState`、`liveStatusObservedAt`、`liveStartedAt`、`liveChannel`。`liveStatusObservedAt` 是响应读取和解析成功后的服务器 UTC 时间，`last_checked_at` 仍为最后成功检测时间。`valid_until = observed_at + 2 × LIVE_POLL_INTERVAL_SECONDS`；在截止时间瞬间仍有效，超过截止时间、缺少有效观察时间或缺少明确 authority 均返回 `unknown`。没有成功观察时两个时间字段为 null；失败或过期时仍可返回最后成功观察及其截止时间。只有有效 LIVE 才返回可靠的 `live_started_at`，其他情况为 null。调用方只依赖 `status`，UNKNOWN 不能等同于平台确认下播。

平台开播时间来自 `tLiveInfo.iStartTime`（Unix seconds），不使用 detected start 替代。有效时间写入新 session 的 `platform_started_at`，已有 active session 仅在该字段为 NULL 时补齐。正确读取 `tLiveInfo.lLiveChannel`；不读取或暴露可能被 JSON.parse 舍入的 `lLiveId`。没有可靠平台下播时间，`platform_ended_at` 保持 NULL。

`runtime_status` 仍仅表示 collector 状态，即使它是 `listening`，本接口也可能返回 `offline` 或 `unknown`。一次成功 OFFLINE 即更新本接口；collector / session 仍需连续 `OFFLINE_CONFIRMATIONS` 次成功 OFFLINE 才停止，失败打断连续确认且不结束场次。服务启动在开放 HTTP 前先置 UNKNOWN，再重新检测：LIVE 复用 active session，OFFLINE 最终纠正孤儿 session，失败保持待复核。服务停止取消并等待在途检查、置 UNKNOWN，保留 active session，不写 completed 或下播时间；手动禁用 collector 将场次标记 interrupted。

默认轮询仍为 60 秒。平台页面已更新且请求成功时，发现开播/下播通常最多约 60 秒加本次请求耗时（detector 超时为 15 秒）；collector / session 两次 OFFLINE 确认通常最多约 120 秒加请求耗时。平台页面自身延迟或连续请求失败时无法保证该上限，此时返回 UNKNOWN。

`live_session_id` 对应 `live_sessions.id`，未知或尚无确认场次时为 null。成功检测在房间行锁下，同一事务创建/复用直播场次并写入 `liveStatus`、`liveStatusState`、`liveStatusObservedAt`、`liveSessionId`；接口只读取该持久快照。失败和暂时 UNKNOWN 保留最后确认 UUID，不伪造新场次。平台开播时间比 active 场次更晚时，将旧场次标记 interrupted 并创建新 UUID；相同、缺失或更早的时间不会使 UUID 倒退。collector 随换场重连，丢弃旧连接的迟到消息。

此字段会改变 strict 客户端的响应 schema。发布时先升级主站兼容解析与本场统计迁移，再升级监听器；主站新版本允许缺少此字段，旧版本不能直接接收新增字段。

### 实时短窗口 Top 榜

一次请求可按同一截止时间查询最近 1、5、10 分钟的完整弹幕排行：

```http
GET /api/v1/analytics/realtime-top-messages?room_id=<uuid>&windows=1m,5m,10m&limit=10
Authorization: Bearer <ADMIN_API_TOKEN>
```

- `windows` 可选，默认 `1m,5m,10m`，只接受这三个不重复的窗口。
- `limit` 可选，默认 `10`，范围为 `1～50`。
- `at` 可选，必须是带时区的 ISO 8601 时间；默认使用服务器当前时间。
- 窗口采用 `[at - window, at)`，按 `occurred_at` 统计全部普通文本弹幕。
- 响应在服务端缓存 12 秒；每个来源 IP 每分钟最多请求 60 次。

### 批量分时 Top 榜

```http
GET /api/v1/analytics/window-top-messages?room_id=<uuid>&date=2026-09-06&timezone=Asia%2FShanghai&window=10m&limit=50
```

一次返回当天所有已结束的十分钟时段，每段独立 Top 50。新接口按 IP 独立限流为每分钟 6 次，
每进程最多两个并发批量请求；429 附带 `Retry-After`。不缓存批量结果，以免补采后返回旧数据。
完整性保持保守语义：已知缺口为 `false`，没有证据证明完整时为 `null`，查询失败返回 503。
参数、状态、限流审计和执行计划验证见 [批量统计说明](docs/WINDOW_TOP_MESSAGES.md)。

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
