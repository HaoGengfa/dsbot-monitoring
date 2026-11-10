# PRD-GAP · neural.html 17 个面板字段核对

> 核对日期：2026-11-09
> 核对对象：`public/neural.html`（md5 `9c163bcd7523516e4fb210c641ad9fd3`，1003 行）+ `public/neural.js`（1646 行）
> 数据源：`GET http://127.0.0.1:18791/api/live` 实拉，`normalizeLive()`（`neural.js:42`）为归一化层
> 判定口径：**保留**＝字段真实且语义正确；**改造**＝字段可用但表达/口径有问题；**删除**＝无真实数据支撑或与其它面板重复；**补字段**＝接口缺该字段，需后端补

## 实测数据基线（本次拉取）

| 项 | 实测值 | 说明 |
|---|---|---|
| `bots` | 14 | 成员数 |
| 全队 `outTokens` 合计 | **1,166,959** | `sum(b.stats.outTokens)` |
| `DSP-ADMIN` 单人 `outTokens` | **632,204** | 占全队 54.2% |
| `feed` 总条数 | 935 | `normalizeLive` 只用末尾 60 条做日志 |
| `feed` 中 `k==='room'` 且带 `room` 字段 | **115** | 群消息唯一真实来源 |
| `feed` 出现的事件种类 | `reply/request/room/stopped/think/tool/turn` | 与 `KIND_ORDER`（`neural.js:609`）七项一致 |
| `activity.buckets` | 60 | 分钟级活性桶 |
| `openWorks` | 9 | 未闭合工作项 |

---

## 一、逐面板判定表

| # | 面板 | DOM（行号） | 真实字段来源 | 判定 | 依据 |
|---|---|---|---|---|---|
| 1 | `p-bars` 活跃度 | `neural.html:932` | `activity.buckets` → `data.activity`（`neural.js:128`） | **保留** | 60 个真实分钟桶，`drawBars` 只取末 20（`neural.js:242` `all.slice(-20)`），有数据 |
| 2 | `p-hour` 今日时段 | `neural.html:933` | `hourly[hh]`，由 `feed[].at` 按小时聚合（`neural.js:106`） | **保留** | 从真实 `feed.at` 聚合，非编造；注意排除 `k==='room'`（`neural.js:107`） |
| 3 | `p-line` 回执时延 | `neural.html:934` | `exchanges[]` 配对 request→reply（`buildLatency`，`neural.js:662`） | **保留** | 由 `exchanges.from/to/role/time` 真实配对计算，无配对时显示「还没有配对成功的派活/回执」 |
| 4 | `p-radar` 能力雷达 | `neural.html:937` | `stats.toolCounts`（`neural.js:371`） | **改造** | 字段真实（`toolCounts` 有 17 个键），但分类靠 `catOf()` 字符串归并（`neural.js:32`）；**建议补字段**：接口直接给 `toolCategory`，避免前端猜分类 |
| 5 | `p-tools` 工具调用 | `neural.html:938` | `stats.toolCounts`（`drawTools`，`neural.js:1318`） | **保留** | 真实计数，按次数排序 |
| 6 | `p-roles` 角色分布 | `neural.html:939` | `bot.role`（`drawRoles`，`neural.js:1338`） | **保留** | `role` 为接口直给字符串，空值归入「未标注」 |
| 7 | `p-holo` 协作环 | `neural.html:942` | `exchanges[]` + `holo-stage` canvas（`drawHolo`，`neural.js:778`） | **保留** | 橙色＝派活、蓝色＝回执（`neural.html:964` 图注），由真实 `exchanges.role` 驱动 |
| 8 | `p-step` 当前步进 | `neural.html:969` | `activity.turn` / `activity.step`（`drawSteps`，`neural.js:1288`） | **保留** | 接口直给真实值，注释已写明「不用推导」 |
| 9 | `p-cards` 成员产出占比 | `neural.html:971` | `stats.outTokens`（`drawCards`，`neural.js:1218`） | **改造** | 字段真实，但 `tone()`（`neural.js:1225`）把 `working` 映射成 `#3dffc0`，与「回执」色同源；**需拆色**（见二-1） |
| 10 | `p-eff` 单轮效率 | `neural.html:973` | `outPerTurn = outTokens/turns`（`neural.js:66`） | **保留** | 前端相除，接口不给该字段，注释已声明「不编数」 |
| 11 | `p-status` 状态与效率 | `neural.html:975` | `working`/`pending`/`turns`/`tools`/`toolErrors`（`drawStatus`，`neural.js:1353`） | **改造** | 环形图分母＝`bots.length`（`neural.js:1382`），但「待回执」来自 `pending` 前端推算（`buildPending`，`neural.js:450`），**需补字段** `tasks[].ackedAt` 已存在但未用（见二-2） |
| 12 | `p-rooms` 群维度 | `neural.html:977` | `rooms[]` + `roomEvents`（`drawRooms`，`neural.js:1391`） | **保留** | `rooms`（2 群）+ `feed[k==='room']`（115 条）真实；注释已说明 `exchanges` 无群 id，群消息只能从 feed 算 |
| 13 | `p-num` 产出 | `neural.html:981` | 全队 `outTokens/inTokens/cacheTokens/turns/tools`（`drawNums`，`neural.js:1454`） | **改造** | 环形图分母＝全队 `totalOut`（`neural.js:1494`），与 hero 单人值口径不同（见二-3） |
| 14 | `p-log` 日志流 | `neural.html:987` | `feed` 末 60 条（`normalizeLive` `neural.js:76`） | **补字段** | 60 条硬截断（`d.feed.slice(-60)`）；实测 feed 935 条，**前端只拿到 60 条**，日志「实时 240 条」的宣称与后端给量不符；需后端放大 `feed` 上限或分页 |
| 15 | `p-flow` 事件流转 | `neural.html:990` | `exchanges[]`（`drawFlow`，`neural.js:569`） | **保留** | 真实 `from/to/role/time`，时间轴按 `generatedAt` 对齐 |
| 16 | `p-kind` 事件构成 | `neural.html:992` | `kinds` 计数（`normalizeLive` `neural.js:99`） | **保留** | 七种事件与 `KIND_ORDER`（`neural.js:609`）完全对应，实测七种都出现 |
| 17 | `p-alerts` 异常与失败 | `neural.html:994` | `buildAlerts` + `stats.failures/retries`（`neural.js:469`/`680`） | **保留** | `failures[].code/message` 真实（实测 `TIMEOUT`），环形图分母＝`totalRetries`（`neural.js:714`） |

**统计：保留 11 · 改造 3 · 删除 0 · 补字段 2**（其中 1 项同时「改造+补字段」，按主判归入改造：`p-status`）

---

## 二、三处必须改的口径问题

### 1. `p-cards` 与 `p-status`：`working` 与「回执」共用 `#3dffc0`

- `drawCards` 的 `tone()`：`neural.js:1225` → `bot.working ? '#3dffc0' : ...`
- `drawStatus` 的 segs：`neural.js:1369` → `{ label:'工作中', color:'#3dffc0' }`
- 同时 `KIND_ORDER`（`neural.js:609`）里 `reply` 也是 `#4fc3ff`，但 `p-cards` 的 working 绿与 `dsh` 五态绿 `#2f9e44` 不同源，**同屏出现两种绿**。

判定：**改造**。工作中与回执必须分色；建议回执统一 `#4fc3ff`（与 `KIND_ORDER` 的 `reply` 一致），工作中保留一支专属绿。

### 2. `p-status`：「待回执」是前端推算，接口其实有真字段

- 前端：`buildPending(exchanges, now)`（`neural.js:450`）按时间窗口推算谁在等回执。
- 接口：`tasks[]` 每条有 `dispatchedAt` / `ackedAt` / `state`（实测 `{"id":"bf30473d…","to":"DS","state":"working","ackedAt":null}`）。

判定：**改造 + 补字段**。`ackedAt === null && state === 'working'` 就是权威「待回执」，不必前端按时间猜。要求接口在 `bots[]` 上直接给 `awaitingAck: boolean`，或前端改读 `tasks[]`。

### 3. `p-num` 与 `p-holo` hero：627k vs 1.1M 口径冲突

- `p-num` 环形图中心：全队 `totalOut` = **1,166,959**（`neural.js:1494`）
- `p-holo` hero 卡片：`hero = working[0] || members[0]`（`neural.js:864`），实测取到 `DSP-ADMIN` 单人 **632,204**，显示 `632.2k`
- 两者并排出现，用户看到「627k」与「1.1M」会认为数据打架。

判定：**改造**。hero 在无点击锁定时应显示**全队合计**（1.1M）；锁定某成员时才显示单人值。当前 `applyFocus`（`neural.js:1515`）只做视觉聚焦，没有切 hero 数据口径。

---

## 三、两处需后端补字段

| # | 需求 | 当前状态 | 影响的条目 |
|---|---|---|---|
| F1 | `feed` 上限放大或支持分页 | 前端只取末 60 条（`neural.js:76` `slice(-60)`），实测 feed 935 条 | #14 `p-log` |
| F2 | `bots[].awaitingAck` 或前端改读 `tasks[].ackedAt` | 接口已有 `tasks[].ackedAt/state`，未使用 | #11 `p-status` |
| F3（建议） | `toolCounts` 附 `toolCategory` | 前端靠 `catOf()` 字符串猜测归类（`neural.js:32`） | #4 `p-radar` |

---

## 四、待确认问题（N 处）

| # | 问题 | 影响 |
|---|---|---|
| Q1 | 「实时 240 条」的日志宣称（看板文案）与前端只取 60 条冲突，哪个是目标值？ | #14 `p-log` 容量 |
| Q2 | hero 卡片是否要「无锁定 = 全队合计、锁定 = 单人」两态？需确认交互 | #13/#7 口径 |
| Q3 | 工作中绿是否统一到五态 `#2f9e44`？当前用 `#3dffc0`，与 AI 活动台色板不同源 | #9/#11 配色 |
| Q4 | `p-radar` 的五类归类（读取/执行/写改/搜索/其他）是否为产品定义口径？ | #4 `p-radar` |

**小计：17 个面板，M = 17，N = 4 处待确认。**

---

_本文件仅做字段核对，不改动 `neural.html` / `neural.js`。所有行号对应上述 md5。_
