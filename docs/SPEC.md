# 虎牙弹幕长期监听与分析平台 Spec

- 状态：Draft v0.1
- 日期：2026-08-31
- 目标版本：MVP
- 默认时区：Asia/Shanghai

## 1. 背景

现有项目能够连接单个虎牙房间并实时解析弹幕、礼物和人气消息，但它仍是一个一次性运行的 Node.js 模块，缺少主播开播检测、长期进程管理、持久化、查询分析、监控告警和可操作界面。

本项目将其扩展为一个可以长期在后台运行的平台。管理员配置需要关注的主播后，系统自动检测开播状态，在直播期间采集并保存数据，并通过 API 和 Web 页面提供分时段弹幕量、每日高频弹幕文本 Top 10 等分析。

## 2. 产品目标

MVP 必须实现：

1. 管理 1 个虎牙房间，可启用、停用监听任务；数据模型保留未来扩展多房间的能力。
2. 后台自动判断主播是否开播，记录开播和下播时间。
3. 开播后自动连接弹幕服务；异常断开后自动恢复。
4. 持久化弹幕原始数据，并保留接收时间、主播、用户和场次信息。
5. 查询指定时间范围内按分钟、5 分钟、15 分钟或小时聚合的弹幕数量。
6. 查询每日出现次数最多的 10 条弹幕文本及其出现次数。
7. 提供简单管理和分析页面。
8. 服务或宿主机重启后自动恢复全部已启用任务。
9. 提供健康检查、结构化日志和基本运行指标。

## 3. 首期非目标

- 不支持虎牙以外的平台。
- 不发送弹幕，不登录用户账号。
- 不抓取加入平台之前的历史弹幕。
- 不在 MVP 中实现情感分析、主题模型、AI 摘要或复杂中文分词。
- 不承诺恢复上游在网络断开期间产生但未重放的消息。
- 不在 MVP 中实现多机高可用；首期目标是可靠的单机部署。

## 4. 术语与口径

- 房间：管理员配置的虎牙直播间。
- 直播场次：一次从开播到下播的连续直播，记为 `live_session`。
- 弹幕时间：优先采用平台消息自带时间；当前协议没有可信源时间时采用平台接收时间，并标记时间来源。
- 分时段弹幕量：半开区间 `[start, end)` 内接收到的弹幕数量。
- 每日 Top 10：自然日内出现次数最多的 10 条弹幕文本。匹配键为 `NFC(content.trim())`；不忽略大小写，不合并标点或不同 Emoji。空文本不参与排行。
- 排序规则：先按出现次数降序，再按规范化文本升序，保证并列结果稳定。例如 `" 666 "` 与 `"666"` 归为一条，`"666"` 与 `"666！"` 分别统计。
- 每日活跃用户榜不属于 MVP 必需功能，可在后续基于原始数据增加。
- 自然日：默认按 `Asia/Shanghai` 的 00:00:00 至次日 00:00:00 计算。

## 5. 用户角色与核心流程

MVP 只有“管理员”角色。

### 5.1 添加主播

1. 管理员输入虎牙房间号或短码。
2. 系统访问虎牙页面，解析主播 UID、主播名称及当前状态。
3. 系统拒绝重复房间；解析失败时展示可操作的错误原因。
4. 创建成功后默认启用后台检测。

### 5.2 自动监听

1. 调度器定期检查已启用房间。
2. 检测为开播时创建或恢复直播场次，并启动采集器。
3. 采集器完成协议握手和分组注册后，状态才变为“监听中”。
4. 收到的弹幕进入持久化队列并写入数据库。
5. 检测为下播且满足防抖条件后关闭场次和采集连接。
6. 网络断开或协议错误时进入恢复流程，不结束直播场次。

### 5.3 查看分析

1. 管理员选择房间及日期或时间范围。
2. 页面展示直播场次、累计弹幕量和分时段趋势。
3. 页面展示每日高频弹幕文本 Top 10。
4. 管理员可以查询或导出该范围内的原始弹幕。

## 6. 房间与采集状态机

房间运行状态：

- `disabled`：管理员停用。
- `unknown`：尚未成功取得状态。
- `offline`：已确认未开播。
- `starting`：检测到开播，正在连接和握手。
- `listening`：握手与分组注册成功，正在接收消息。
- `degraded`：主播仍可能在播，但连接、解析或存储异常。
- `stopping`：正在确认下播或清理资源。

状态规则：

- 离线房间默认每 60 秒检查一次，配置范围为 15～300 秒。
- 一次可信的开播结果即可触发 `offline → starting`。
- 两次连续下播结果才触发下播，避免短暂接口异常切断场次。
- `connect` 仅表示 WebSocket 建立；只有握手和订阅确认成功才进入 `listening`。
- 异常重连采用带随机抖动的指数退避，默认 1 秒起步、最长 60 秒。
- WebSocket 成功打开但握手失败时，不重置退避计数。
- 每次状态变化都写入状态历史，记录原因和检测来源。
- 重启后根据数据库中的已启用房间重建任务；未正常关闭的场次先复核直播状态再决定恢复或结束。

开播状态检测必须封装为独立适配器，不能让 HTML 正则散落在调度逻辑中。适配器输出：

```ts
type LiveStatusResult = {
  status: 'live' | 'offline' | 'unknown'
  roomId: string
  anchorUid?: string
  anchorName?: string
  checkedAt: string
  source: string
  reason?: string
}
```

## 7. 功能需求

### FR-1 房间管理

- 添加、查看、编辑、启用、停用和删除房间。
- 房间号按字符串保存，兼容数字房间号和短码。
- 删除默认采用软删除，历史弹幕与场次不被级联删除。
- 展示最后检测时间、当前状态、最后消息时间和最近错误。

### FR-2 开播检测与场次

- 自动检测开播和下播。
- 每次直播生成独立场次。
- 场次保存检测到的开始时间、结束时间及其来源。
- 短暂重连不得生成新场次。
- 若无法准确获得平台开播时间，字段必须明确标记为“检测时间”。

### FR-3 弹幕采集

- 保存弹幕内容、用户 UID、用户昵称、房间、场次、接收时间和原始载荷。
- 支持当前协议的 V1/V2 推送。
- 单条解析失败不得终止连接，但必须计数并记录可诊断日志。
- 不把内容哈希当作天然唯一 ID；用户连续发送相同内容必须保存为多条记录。
- 事件采用平台事件 ID（若存在）或平台内部生成的摄取 ID，保证写入幂等。
- 礼物和人气事件保留扩展接口，但 MVP 不持久化，也不进入弹幕统计。

### FR-4 数据查询

- 按房间、场次、时间范围、用户 UID 和关键词查询弹幕。
- 默认倒序分页，使用游标分页，避免大表深度 offset。
- 支持 CSV 导出；导出任务不得阻塞 API 请求线程。
- 所有 API 时间使用带时区的 ISO 8601，数据库统一存 UTC。

### FR-5 数据分析

- 分时段弹幕量支持 `1m`、`5m`、`15m`、`1h` 粒度。
- 返回没有弹幕的空时间桶，计数为 0。
- 支持按房间和场次过滤。
- 每日高频弹幕 Top 10 按第 4 节的文本规范化和排序口径计算，并返回代表文本、次数和占当日弹幕总量的比例。
- 聚合结果由后台任务增量更新，并每天执行一次原始数据对账修正。
- 管理员可触发指定日期的重新聚合。

### FR-6 管理页面

MVP 页面包括：

1. 房间列表：运行状态、是否开播、最近消息、最近错误、启停操作。
2. 房间详情：场次列表、实时消息流和连接状态。
3. 分析页：时间范围、粒度选择、弹幕量折线图和高频弹幕文本 Top 10。
4. 原始弹幕页：筛选、分页和导出。
5. 系统概览页：数据库、归档和备份目标的容量、使用率、最近 7/30 天增长趋势、预计写满日期及最近归档结果。

系统概览页必须满足：

- 首页始终显示存储健康卡片，状态分为 `normal`、`warning`、`high`、`critical` 和 `unknown`。
- 分别展示数据库盘、归档盘和备份目标；目标不可访问时显示 `unknown`，不能误报为 0 使用率。
- 展示总容量、已用容量、可用容量、使用率、最近采样时间和数据增长速度。
- 展示按最近 7 天线性趋势推算的预计写满日期；数据不足 24 小时或增长速度不可信时显示“数据不足”，不能给出虚假日期。
- 展示 PostgreSQL 数据、索引、WAL、临时文件和归档文件的分类占用；无法获得分类时至少展示文件系统总量。
- 展示最近一次归档的时间、范围、文件大小、校验状态和备份状态。
- 达到 70%、80% 或 90% 阈值时，页面分别显示黄色、橙色或红色提示，并给出推荐处理动作。
- MVP 只允许从页面手动触发“重新采样”和“执行到期归档”；扩容、迁移和删除数据不提供一键操作。

### FR-7 运维

- 提供 `/health/live` 和 `/health/ready`。
- 输出 JSON 日志，至少包含 `room_id`、`session_id`、`component` 和错误码。
- 暴露房间状态、接收数量、写入延迟、解析失败、重连次数和队列深度指标。
- 暴露磁盘使用率、数据库大小、归档大小、每日增长量和预计剩余天数指标。
- 关键异常可配置 Webhook 告警：连续 10 分钟无法检测状态、直播中连续 5 分钟未恢复连接、持久化队列接近上限。

## 8. 非功能需求

### 8.1 可靠性

- 服务进程崩溃后由容器或进程管理器自动拉起。
- 平台内部对已接收事件采用至少一次写入语义，重复写入由摄取 ID 约束消除。
- 数据库短暂不可用时写入本地持久化缓冲；MVP 默认至少容纳 10 分钟或 100,000 条事件，以先达到者为准。
- 缓冲接近容量时告警，不允许静默丢弃。
- 无法弥补上游断线期间未重放的数据，分析页面应显示采集异常区间。

### 8.2 性能基线

MVP 基线按以下规模设计：

- 配置并监听 1 个房间；架构不阻止后续扩展。
- 容量压力上限按全天持续 10 条弹幕/秒设计。
- 短时峰值吞吐 100 条弹幕/秒，持续吞吐 10 条/秒。
- 30 天时间范围的小时聚合查询 P95 小于 2 秒。
- 单日高频弹幕 Top 10 查询 P95 小于 1 秒。

超过该规模时需要重新评估队列、分区和多进程采集模型。

### 8.3 容量估算与数据保留

按 10 条/秒全天持续计算，这是容量上限，不代表主播实际平均流量：

| 周期 | 弹幕条数 |
| --- | ---: |
| 每天 | 864,000 |
| 每 30 天 | 25,920,000 |
| 每年 | 315,360,000 |
| 每 5 年 | 1,576,800,000 |

若平均每条 PostgreSQL 数据（正文、行开销和索引）占 300～500 字节，则每年约占 95～158 GB。考虑表膨胀、维护空间和短期 WAL 后，建议按每年 120～220 GB 热存储预算。若额外永久保存平均 500 字节的 JSON 原始协议载荷，每年还会增加约 158 GB，整体可能达到每年 250～400 GB；备份需要另计一份或多份容量。

不同在线时长下的粗略预算如下：

| 场景 | 年弹幕量 | PostgreSQL 热数据/年 | 压缩归档/年 |
| --- | ---: | ---: | ---: |
| 10 条/秒、24 小时/天 | 3.15 亿 | 120～220 GB | 20～60 GB |
| 10 条/秒、8 小时/天 | 1.05 亿 | 40～73 GB | 7～20 GB |
| 3 条/秒、8 小时/天 | 3,154 万 | 12～22 GB | 2～6 GB |

建议初始准备至少 500 GB SSD 作为数据库盘，并把永久归档和备份放在另一块 1 TB 磁盘、NAS 或对象存储。上线 7 天后，以真实平均正文长度、索引大小、在线时长和压缩率重新计算；该实测值优先于本表估算。

“永久保留”采用以下已确认的分层策略：

- 规范化弹幕记录永久保留。
- PostgreSQL 默认保存最近 12 个月的可即时查询原始记录。
- 更早的原始记录按月导出为带 GZIP 压缩的 Parquet 文件，永久归档；预计约 20～60 GB/年，最终以运行 7 天后的实测压缩率校准。归档格式保留升级到 Zstandard 的兼容空间。
- 分钟统计、每日总量和每日 Top 10 结果永久保存在 PostgreSQL，支持全历史即时查询。
- 完整 `raw_payload` 默认只保留 30 天；它用于排查协议问题，不属于永久业务数据。若要求永久保存，必须单独评估约 158 GB/年以上的增量。
- 历史归档支持异步检索和导出，不承诺像最近 12 个月一样即时分页浏览。
- 归档文件必须有校验和、清单和至少一份独立备份；成功校验归档与备份前，不得删除 PostgreSQL 热数据。
- 用户 UID 和昵称属于用户生成数据；日志中不得额外复制完整弹幕正文。

磁盘容量保护规则：

- 每日至少检查一次数据库盘、归档盘和备份目标的剩余空间，并估算按最近 7 天增长速度计算的预计写满日期。
- 使用率达到 70% 时产生普通告警；达到 80% 时产生高优先级告警并立即执行到期分区归档；达到 90% 时产生紧急告警。
- 除按既定策略清理超过 30 天的 `raw_payload` 外，系统不得因为磁盘水位自动删除弹幕、聚合或归档文件。
- 空间不足时按“扩容或迁移归档 → 调整热数据窗口 → 经管理员明确确认后删除最旧历史数据”的顺序处理。
- 删除任何永久业务数据前，必须展示时间范围、预计释放空间和备份状态，并记录审计日志。

### 8.4 安全

- 默认只监听内网地址；公网部署必须启用 HTTPS。
- MVP 使用单管理员账号或反向代理认证。
- 密码、数据库连接串、Webhook 密钥只从环境变量或密钥文件读取。
- 管理操作写入审计日志。
- 采集器优先使用 WSS；如果虎牙只允许 WS，必须通过配置显式开启并在状态页提示。

## 9. 建议技术架构

首期采用模块化单体，避免过早拆分微服务：

```text
Web UI / API
      |
Room Supervisor ── Live Status Adapter
      |
Collector Manager ── Huya Collector(s)
      |
Durable Ingest Buffer
      |
Persistence Worker ── PostgreSQL
      |
Aggregation Worker ── Minute/Daily Stats
```

建议技术选择：

- 运行时：Node.js LTS + TypeScript。
- API：Fastify；统一生成 OpenAPI 文档。
- 数据库：PostgreSQL 16 或更高版本。
- 页面：MVP 使用无构建步骤的原生 HTML/CSS/JavaScript 管理界面，由 API 服务托管；复杂交互增加后可迁移到 React。
- 后台任务：首期使用数据库租约和进程内调度，不强制引入 Redis。
- 部署：Docker Compose，包含应用与 PostgreSQL；同时提供非容器化启动说明。

采集协议层与平台层必须分离。现有 `index.js` 应重构为不负责无限重连和页面状态判断的纯采集适配器，由 `Collector Manager` 管理生命周期。

## 10. 数据模型

### `rooms`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | uuid | 内部主键 |
| `external_room_id` | text | 虎牙房间号或短码，唯一 |
| `anchor_uid` | text nullable | 主播 UID，避免 JS int64 精度问题 |
| `anchor_name` | text nullable | 最近一次解析到的名称 |
| `enabled` | boolean | 是否启用检测 |
| `runtime_status` | text | 当前状态 |
| `last_checked_at` | timestamptz | 最近状态检测时间 |
| `last_message_at` | timestamptz nullable | 最近收到消息时间 |
| `last_error` | jsonb nullable | 最近可诊断错误 |
| `created_at` / `updated_at` | timestamptz | 审计时间 |
| `deleted_at` | timestamptz nullable | 软删除时间 |

### `live_sessions`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `id` | uuid | 场次 ID |
| `room_id` | uuid | 房间外键 |
| `detected_started_at` | timestamptz | 检测到开播的时间 |
| `detected_ended_at` | timestamptz nullable | 检测到下播的时间 |
| `platform_started_at` | timestamptz nullable | 平台时间（若可获得） |
| `platform_ended_at` | timestamptz nullable | 平台时间（若可获得） |
| `status` | text | active/completed/interrupted |
| `metadata` | jsonb | 标题、分类等快照 |

### `danmu_messages`

| 字段 | 类型 | 说明 |
| --- | --- | --- |
| `ingest_id` | uuid/ulid | 摄取主键和幂等键 |
| `room_id` | uuid | 房间外键 |
| `session_id` | uuid nullable | 场次外键；异常边界允许为空 |
| `source_event_id` | text nullable | 平台 ID（若存在），不伪造唯一性 |
| `occurred_at` | timestamptz | 用于统计的时间 |
| `received_at` | timestamptz | 本系统接收时间 |
| `time_source` | text | source/received |
| `sender_uid` | text nullable | 发言用户 UID |
| `sender_name` | text | 接收时昵称快照 |
| `content` | text | 弹幕正文 |
| `content_normalized` | text | 仅做首尾空白和 Unicode 规范化 |
| `raw_payload` | jsonb nullable | 可配置保存的原始字段 |

建议按 `occurred_at` 月分区，并建立：

- `(room_id, occurred_at desc)`
- `(room_id, sender_uid, occurred_at desc)`
- 活跃 `source_event_id` 唯一索引（仅非空值）

### 聚合表

- `danmu_minute_stats(room_id, bucket_at, message_count, unique_sender_count)`
- `danmu_daily_content_counts(room_id, local_date, content_normalized, representative_content, message_count)`：当日和近期计算工作表。
- `danmu_daily_top_messages(room_id, local_date, rank, content_normalized, representative_content, message_count, share)`：永久保存每日排行，默认保留前 100 名以便页面扩展。
- `collector_incidents(room_id, session_id, started_at, ended_at, type, details)`
- `storage_snapshots(target, sampled_at, total_bytes, used_bytes, available_bytes, category_sizes, status)`：保存容量历史，用于趋势和预计写满日期。
- `archive_runs(id, started_at, finished_at, range_start, range_end, bytes_written, checksum, backup_status, status, error)`：保存归档执行和校验结果。

每日结算后从工作表生成前 100 名结果；工作表保留 7 天供对账，之后可删除，避免永久保存接近原始数据规模的重复聚合。

## 11. API 草案

```text
POST   /api/v1/rooms
GET    /api/v1/rooms
GET    /api/v1/rooms/:id
PATCH  /api/v1/rooms/:id
POST   /api/v1/rooms/:id/enable
POST   /api/v1/rooms/:id/disable
DELETE /api/v1/rooms/:id

GET    /api/v1/rooms/:id/sessions
GET    /api/v1/rooms/:id/messages
GET    /api/v1/rooms/:id/messages.csv

GET    /api/v1/analytics/message-counts
GET    /api/v1/analytics/top-messages
POST   /api/v1/analytics/rebuild

GET    /api/v1/system/storage
GET    /api/v1/system/storage/history
POST   /api/v1/system/storage/sample
POST   /api/v1/system/archives/run
GET    /api/v1/system/archives

GET    /health/live
GET    /health/ready
```

示例：

```text
GET /api/v1/analytics/message-counts
  ?room_id=<uuid>&from=2026-08-31T00:00:00%2B08:00
  &to=2026-09-01T00:00:00%2B08:00&interval=15m

GET /api/v1/analytics/top-messages
  ?room_id=<uuid>&date=2026-08-31&timezone=Asia%2FShanghai&limit=10
```

## 12. 验收标准

### AC-1 自动开播监听

给定一个已启用且离线的房间，当主播开播后，系统应在两个检测周期内创建场次并进入 `listening`；无需人工重启服务。

### AC-2 自动恢复

直播中主动断开 WebSocket，系统应记录异常并自动重连；恢复后继续写入同一场次，不能创建重复场次。

### AC-3 重启恢复

直播监听期间重启应用，应用应自动恢复该房间任务，并将停机区间记录为采集异常。

### AC-4 数据完整写入

同一用户连续发送两条完全相同的弹幕，数据库中必须保存两条记录。

### AC-5 分时段统计

插入跨越多个时间桶的固定测试数据后，各粒度 API 必须返回正确数量，并补齐计数为零的时间桶。

### AC-6 每日 Top 10

插入至少 12 种弹幕文本的跨日测试数据后，API 必须按指定时区和房间返回正确前 10 名。测试必须覆盖首尾空白、Unicode 规范化、标点差异和相同次数的稳定排序。

### AC-7 数据库故障

模拟数据库不可用 5 分钟后恢复，故障期间已经进入持久化缓冲的事件必须最终写入且不重复。

### AC-8 可观测性

模拟页面解析失败、握手失败、消息解析失败和队列积压，日志、指标及房间状态页必须能区分四类故障。

### AC-9 磁盘容量保护

模拟磁盘使用率达到 70%、80% 和 90%，系统必须在 API、Web 页面和告警渠道显示对应状态及预计写满日期；不得自动删除永久弹幕或归档数据。模拟存储目标不可访问时，页面必须显示 `unknown` 而不是健康状态。

## 13. 实施阶段

### Phase 0：加固现有协议层

- 修复可重复启停、握手完成状态、WSS 选择和重连退避。
- 将开播检测与 WebSocket 采集拆分。
- 补充录制协议包的离线解析测试和采集器生命周期测试。

### Phase 1：后台服务与存储

- 房间管理 API、状态机和场次管理。
- PostgreSQL schema、迁移、持久化队列和恢复机制。
- Docker Compose、健康检查、日志和基础指标。

### Phase 2：分析与页面

- 分钟/每日聚合任务及对账。
- 趋势、Top 10、原始弹幕查询与 CSV 导出。
- 管理界面和异常区间展示。

### Phase 3：增强能力

- 高频短语趋势、关键词、情绪和直播内容摘要。
- 多平台、多机采集、对象存储归档和更细粒度权限。

## 14. 已确认项与待确认问题

这些问题不阻塞 MVP 设计；未确认时采用括号内默认值：

1. 预计配置和同时开播的房间数？（已确认：1 个）
2. 原始弹幕需要保留多久？（已确认：12 个月热数据 + 永久压缩归档；空间不足时再人工决定扩容或删除）
3. “每日弹幕 Top 10”具体指用户、文本还是关键词？（已确认：高频弹幕文本）
4. 是否需要保存和分析礼物、人气？（MVP 不保存，只保留扩展能力）
5. 部署环境是单台 Linux、NAS 还是云服务器？（单台 Linux + Docker Compose）
6. 是否需要公网访问和多用户权限？（仅管理员、默认内网访问）
7. 是否接受使用 PostgreSQL？（接受；不以 SQLite 作为生产存储）
