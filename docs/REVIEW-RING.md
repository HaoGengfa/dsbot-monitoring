# 环形图代码审查报告（REVIEW-RING）

> 审查对象：`donutChart` / `drawStatus` / `drawRooms` / `drawFails` 四个函数
> 审查方式：只读不改。静态读码 + headless Chrome 实测（CDP 驱动，1920×1080，静态服务 127.0.0.1:8899 提供 `neural.html` + `neural-snapshot.json`）
> 审查者：代码评审工程师

## 0. 结论与锚点

**结论：可合并，有 3 条建议修复、2 条可选优化。**

幂等性与空数据兜底两项均通过实测，未发现阻塞级缺陷。

| 项 | 值 |
|---|---|
| `public/neural.js` | `60547f5d01a3f151908080e7ff50e43f`（1653 行） |
| `public/neural.html` | `9c163bcd7523516e4fb210c641ad9fd3`（1003 行） |
| 被审函数位置 | `donutChart` L1176 · `drawStatus` L1353 · `drawRooms` L1398 · `drawFails` L680 |

> 行号仅供定位，**结论绑定上方 md5**；字节一变本报告作废重审（AGENTS §7.2）。

---

## 1. 幂等性（§7.1）

**判定：通过。** 用页面自带的只读调试钩子 `window.__renderNeural(window.__neuralData)` 连续重渲染 5 次，逐次统计 DOM：

| 轮次 | `svg.donut` | `circle.dseg` | `title` | `.dlegend` | `.chart-wrap` |
|---|---|---|---|---|---|
| 首轮 | 4 | 12 | 12 | 4 | 4 |
| 第 1 次重绘 | 4 | 12 | 12 | 4 | 4 |
| 第 2 次重绘 | 4 | 12 | 12 | 4 | 4 |
| 第 3 次重绘 | 4 | 12 | 12 | 4 | 4 |
| 第 4 次重绘 | 4 | 12 | 12 | 4 | 4 |
| 第 5 次重绘 | 4 | 12 | 12 | 4 | 4 |

四个函数全部走 `box.innerHTML = ...` 全量替换，**没有增量 append 路径**，这是幂等的根因；与历史上 `replaceCard()` 那种「先建后取」的增量写法不同，结构上不具备累积条件。

补充：恢复原数据后仍是 4 环 / 12 段（`C3_restored`），没有泄漏。

**建议保留的一个约束**：`drawFails` 用 `box.classList.toggle('as-chart', ...)`、`drawNums` 用 `box.classList.add('as-chart')`，`add` 是幂等的但语义不明确，建议统一成 `toggle(x, cond)`，避免后人改成 `classList.add/remove` 组合时留下残留。

---

## 2. 空数据兜底（逐函数实测）

把 `__neuralData` 分别改成空 bots / 单成员 / 全零输出 / 全空闲，逐个渲染观察：

| 场景 | 结果 | 判定 |
|---|---|---|
| 空 bots + 空 rooms + 空 feed | 2 环 / 3 段，无异常抛出 | ✅ 静默降级 |
| 单成员 | 3 环 / 5 段 | ✅ |
| 全员空闲无输出 | 状态环 3 段，`0% / 0% / 100%` | ✅ 语义正确 |
| 还原原数据 | 4 环 / 12 段 | ✅ 无残留 |

**`drawStatus`（L1353）**：`idle = Math.max(0, bots.length - working - pend)` 用了 `Math.max(0, ...)` 兜底，`Math.max(1, bots.length)` 做分母防除零——两处都对。

**`drawRooms`（L1398）**：`if (!rows.length) { box.innerHTML = '<div class="fail-empty">没有群数据</div>'; return; }`，空群有明确文案，不是空白画布。✅

**`drawFails`（L680）**：空记录时 `'<div class="fail-empty">没有重试或失败记录</div>'` 并提前 return。✅

**`donutChart`（L1176）**：`const total = rows.reduce(...) || 1`，空数组不会除零。但有一个**边界行为需要记录**（见 §4-B1）。

---

## 3. 同一分母

逐个核对「扇区值 / 中心数字 / 图例百分比」是否同源：

| 函数 | 扇区 value | 中心数字 | 图例 % 分母 | 一致 |
|---|---|---|---|---|
| `drawStatus` L1353 | `working` / `pend` / `idle`（人数） | `bots.length` | `Math.max(1, bots.length)` | ✅ 同为「人数」，三段相加 = 总数 |
| `drawRooms` L1398 | `r.out`（群输出 token） | `fmt(totalOut)` | `totalOut` | ✅ 同为群产出 |
| `drawFails` L680 | `r.retries`（**已修**，不再 `\|\| 1`） | `totalRetries` | `totalRetries` | ✅ 同为重试次数 |
| `drawNums` L1461 | `r.out`（按模型 outTokens） | `fmt(totalOut)` | `totalOut` | ✅ 同为输出 token |

**`drawFails` 有一处历史问题已在前端修掉，记录在此以防回退**：上一版是 `value: r.retries || 1`，会把「0 重试但 15 次失败」的类画成面积 1、图例百分比 3%，同时分母 `totalRetries` 不含它——两个数指向不同口径。现版本改成 `value: r.retries` + `drawable = segs.filter(s => s.value > 0)`，扇区只画真实重试数，0 重试的类只留在图例里且百分比显示 `—`，口径统一。**建议把这条写成注释或测试断言**，否则下一个人很容易为了「别出现 0 面积」把 `|| 1` 加回去。

`drawFails` 里 `fails`（失败条数）与 `retries`（重试次数）是两个不同的量，当前只在 tooltip 里并排展示（`重试 N 次 · 失败 M 条`），不参与任何百分比，✅ 处理正确。

---

## 4. 截断与 title

**结论：`title` 覆盖完整，但有一处未转义（B2）。**

四环的 `title` 实测：

```
工作中 · 7 人 · 50%        待回执 · 4 人 · 29%        空闲 · 3 人 · 21%
Bot 作战指挥室 · 221k · 42%      Neura 研发群 · 306k · 58%
v4.1-flash · 1.1M · 11 人 · 92%   kimi-k3.1-pro · 47k · 1 人 · 4%   …
RATE_LIMIT · 32 次 · 58%    SERVER · 15 次 · 27%    TRANSPORT · 8 次 · 15%
```

用超长 + 含特殊字符的模型名（`vendor/very-long-model-name-1"<>&`）实测：`title` 里渲染为转义后的文本，页面未出现原始标签（`hasRawTag: false`）。✅

### 4-B1 `donutChart` 空数组会画出一个「满圈」

`rows = []` 时 `total = 0 || 1 = 1`，`segs` 为空串 → 输出 `<svg>` 里**只有中心和说明文字，没有任何扇区**。这本身没有错，但页面上的表现是**一个空的圆环位**（没有描边），与「数据为 0」在视觉上无法区分。

- 建议：`rows.length === 0` 时返回明确的空态（如虚线空环 + 「无数据」），或让调用方在 `drawable.length === 0` 时不要输出 `<div class="chart-wrap">`。
- 参考：`drawFails` 已经做了 `box.classList.toggle('as-chart', drawable.length > 0)`，其它三个函数没有做同类判断——**口径不一致**。

### 4-B2 `donutChart` 的参数未转义（L1201–L1202）

```js
`<text ... class="dtotal">${o.center || ''}</text>`
`<text ... class="dcap">${o.caption || ''}</text>`
```

`x.label` 走了 `escapeHtml`（L1197），但 **`o.center` / `o.caption` 是裸插值**。当前所有调用点传入的都是 `String(数字)` / 常量字符串，**现网无实际风险**；但 `donutChart` 是通用渲染函数，任何人将来传一个带用户输入的值进去就是注入点。

- 建议：`o.center` / `o.caption` 同样套 `escapeHtml`，成本一行，零风险。
- 同类：`legend()` L1211 的 `<span class="dl-val">${x.text || x.value}</span>` 也是裸插值（`x.label` 已转义）。

### 4-B3 环形图上的百分比我用了「独立复算」核对

按 `neural-snapshot.json` 实算模型环：`v4.1-flash` 81.26% / `kimi` 8.91% / `grok` 8.06% / `gpt-6-sol` 1.77%；页面 `title` 显示 92% / 4% / 2% / 1%。差异原因是页面连的是**实时 `/api/live`**（14 人、1.2M），快照是 14 人、514k——**不是算错，是数据源不同**。这一点我在审查时一开始误判为分母不一致，记录在此避免后人重复踩坑：**核对环百分比必须用页面实际收到的数据，不能用快照文件反推**。

---

## 5. 建议修复清单

| 编号 | 级别 | 位置 | 问题 | 建议 |
|---|---|---|---|---|
| **B1** | 建议修复 | `donutChart` L1176 | 空数组渲染出无扇区的空环，与「值为 0」不可区分 | 空数据返回明确空态；或调用方统一按 `drawable.length > 0` 决定是否输出 chart-wrap，与 `drawFails` 保持同一口径 |
| **B2** | 建议修复 | `donutChart` L1201–L1202、`legend` L1211 | `o.center` / `o.caption` / `x.text` 未转义 | 套 `escapeHtml`，一行成本 |
| **B3** | 建议修复 | `drawNums` L1501 | `box.classList.add('as-chart')` 之后从不移除；若将来模型环数据为空，空环位会保留 | 改成 `toggle('as-chart', drawable.length > 0)`，与 `drawFails` 一致 |

## 6. 可选优化

| 编号 | 位置 | 说明 |
|---|---|---|
| C1 | `donutChart` L1189 | `const len = Math.max(0, (x.value / total) * C - 2)` 的 `-2` 是固定间隙，小比例扇区（<1%）会被减成 0 宽而无提示；可考虑对 `<0.5%` 的段合并成「其他」 |
| C2 | `drawRooms` L1448 | 图例百分比 `(r.out / Math.max(1, totalOut))` 与扇区 `value: r.out` 同源 ✅，但若 `totalOut === 0`，所有行显示 `0%`、中心显示 `0`，视觉上像「坏了」；可复用 `drawFails` 的 `—` 写法 |

## 7. 已知不审项

- 视觉层（环直径 92/104/56/120 是否合适、环上标签是否重叠）不在本次范围，交给 DS 的视口矩阵测试。
- `drawNums` 的 hero 数字与环中心是否应同源，属 FE 的「hero 无锁定时显示全队合计」任务范围，不在四个函数内。

---

## 8. 复现方式

```bash
cd /Volumes/livingArea/dsbot-monitoring/public
python3 -m http.server 8899 --bind 127.0.0.1     # 静态服务，无需起 18791
# 浏览器打开 http://127.0.0.1:8899/neural.html
# 控制台：window.__renderNeural(window.__neuralData) 连按 5 次，
#         document.querySelectorAll('svg.donut circle.dseg').length 应恒为 12
```

幂等判定式：连续重绘 N 次后，`svg.donut` 数、`circle.dseg` 数、`title` 数、`.dlegend` 数全部不变。
