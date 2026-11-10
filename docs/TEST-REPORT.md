# TEST-REPORT · neural.html 验收

> 本轮验收对象：`dsbot-monitoring/public/neural.html`（17 面板看板）
> 结论绑定**同一次运行**的文件 md5 与退出码，不跨轮引用。

## 0. 绑定信息（报告有效性前提）

| 项 | 值 |
|---|---|
| 运行时间 | 2026-11-09T10:38:46.750Z（本地 18:38） |
| 视口 | 1440×900（headless Chrome，`--headless=new`） |
| 页面地址 | `http://127.0.0.1:18811/neural.html` |
| **被测 `public/neural.html`** | `9c163bcd7523516e4fb210c641ad9fd3` |
| **被测 `public/neural.js`** | `60547f5d01a3f151908080e7ff50e43f` |
| **验收脚本 `tests/neural-acceptance.cjs`** | `91d5eeb357778607cb10d6d12deed056` |
| **实际退出码** | **1**（有不通过） |
| 断言总数 | 5，通过 3，不通过 2 |

命令与退出码取法（不接管道，避免 `$?` 变成 `tail` 的）：

```bash
$NODE tests/neural-acceptance.cjs --url=http://127.0.0.1:18811/neural.html; echo "EXIT=$?"
# → EXIT=1
```

三个 md5 取自同一次运行的前后两次测量，一致。

## 1. 结果总表

| 编号 | 断言 | 判定 | 实测 |
|---|---|---|---|
| N-01 | 17 个面板无溢出 | ✗ **不通过** | 面板 17 个；溢出 2 个：`p-hour`(+9px)、`p-flow`(+14px) |
| N-02 | 页面无纵向滚动 | ✓ 通过 | `documentElement` 900/900，`body` 900 |
| N-03 | 5 块新面板有 DOM 内容 | ✓ 通过 | `p-line`:51 / `p-radar`:32 / `p-holo`:46 / `p-status`:42 / `p-rooms`:28 |
| N-04 | 加载与渲染期无 JS 报错 | ✓ 通过 | 0 条（含 `error` / `unhandledrejection` 钩子） |
| N-05 | 被截断文本均带 `title` | ✗ **不通过** | 截断 12 处；缺 `title` 10 处 |

**不通过项涉及：N-01、N-05。退出码 1。**

## 2. 缺陷明细

### D-N01 · `p-hour` 与 `p-flow` 内容被裁切（一般）

| 项 | 内容 |
|---|---|
| 现象 | 两个面板的 `scrollHeight` 分别比 `clientHeight` 大 **9px / 14px**，而 panel 自身 `overflow: hidden`，被裁部分用户看不到 |
| 证据位置 | `public/neural.html:879` `.hour-body { flex:1 1 auto; min-height:0; display:grid; ... padding: 2px 14px 6px }`；`public/neural.html:419` `.p-flow > .flow-body { flex:1 1 auto; min-height:0; display:flex; flex-direction:column }` |
| 实测细节 | `.hour-body` 内容实高 54（`hour-strip` 52 + 一行脚注），容器 46；`.flow-body` 内容 104（`ftl-wrap` 68 + `alert-sum` 36），容器 90 |
| 根因 | 子项都有 `min-height:0` 可以收缩，但**内容本身高度固定**（`hour-foot` 52px、`alert-sum` 36px 不参与压缩），父级只分配了更少高度，超出部分被 panel 的 `overflow:hidden` 直接裁掉 |
| 判定依据 | 用「未被声明为滚动容器 ⇔ 不得溢出」区分：显式 `overflow-y:auto/scroll` 的容器允许超出（那是有意滚动），其余溢出即裁切缺陷 |
| 影响 | 「今日时段」脚注与「流程」告警汇总有被截断的行；不是排版错位，是内容丢失 |

**修复建议（给前端，仅供参考）**：这两块要么给足固定高度（让 `p-hour` / `p-flow` 的最低高度覆盖内容），要么把 `.hour-body` / `.flow-body` 改成 `overflow-y:auto` 变成可滚动区。二选一都行，但不能维持「内容比容器高、外面 `overflow:hidden`」这个组合。

### D-N05 · 截断文本缺 `title`（一般）

10 处被省略号截掉但**没有 `title` 属性**的元素，用户无法看到完整内容：

| 类名 | 文本片段 | `scrollWidth` / `clientWidth` |
|---|---|---|
| `rk-name` | `post_to_group` | 86 / 82 |
| `rk-name` | `team_task_create` | 106 / 82 |
| `st`（×5） | `bash` / `read` / `bash` / `bash` / `write` | 24–30 / **0** |
| `EM` | `2 群 · 群消息 115 · 12 人 · 跨群 6` | 188 / 166 |
| `x` | `Read QA report section for neural` | 238 / 80 |
| `x` | `已按你这条信息全部落地，结论： **① 服务**…` | 851 / 80 |
| `x` | `/Volumes/livingArea/dsbot-monitoring/pub` | 383 / 80 |

- `.st` 的 `clientWidth = 0` 值得单独看：`public/neural.html:854` 给了 `overflow:hidden; text-overflow:ellipsis; white-space:nowrap`，但在 `step-row` 网格里被挤到 0 宽，**整段文字一个字都看不到**，且没有 `title` 兜底。
- `.x` 那一列最宽截断到 80px、内容最长 851px，损失比例最大。

**修复建议**：给这些元素补 `title`（值用完整文本），或改用可展开的提示。`.st` 若要保留 0 宽，就不该留文本节点在 DOM 里——两者留一个即可。

## 3. 判据自查（哪些观测能被反例推翻）

按 `AGENTS.md` §7.4，逐条自查过：

| 判据 | 反例能不能掀翻它 |
|---|---|
| N-01 面板无溢出 | 能。把 `p-hour` 高度改到够用，它就从红转绿；反之把任一 panel 的 `overflow:hidden` 去掉、内容变多，它会新红 |
| N-02 页面无滚动 | 能。`scrollHeight === clientHeight` 是等式，任一视口出现 1px 溢出即红 |
| N-03 5 块面板有 DOM | **偏弱**：只判存在与子节点数，不判内容正确。它的价值是防「面板被删掉」这类回归，不承担内容验收 |
| N-04 无 JS 报错 | 能。钩子在页面脚本前注入，加载期异常也会被抓到；反过来，全局吞异常（`try/catch` 空实现）会让它假绿——这是已知盲区，本脚本抓不到 |
| N-05 截断带 title | 能。判的是 `scrollWidth > clientWidth` 且真被省略，没截断的元素不会被误伤 |

**N-05 判据改过两轮**，记录在此以免下次误判：

1. 第一版把 SVG 元素也算进来（`className` 是 `SVGAnimatedString`），报了 426 处假阳性；
2. 第二版改为只判 `HTMLElement` + 只取叶子节点 + 必须真溢出（`scrollWidth - clientWidth > 2`）且声明了 `ellipsis`/`line-clamp`，收敛到 12 处真实截断；其中 2 处带了 `title`，10 处没有——即当前的不通过项。

## 4. 未覆盖 / 未执行（不计入通过率）

| 项 | 原因 |
|---|---|
| 其它视口（1680 / 1920 / 2560） | 本轮只按 1440×900 判；多视口矩阵是 DS 的任务，不在本报告范围 |
| 环形图直径与标签重叠 | 属视觉度量，非本脚本 5 条断言范围 |
| 数据内容正确性（17 面板里的数字对不对） | 需要与真实数据源逐项比对，本轮未做 |
| 交互（点击、抽屉、筛选切换） | 无交互断言，仅判加载后静态状态 |

## 5. 复现方式

```bash
# 1) 起静态服务（public 目录）
$NODE /tmp/serve-public.mjs          # 监听 127.0.0.1:18811

# 2) 跑验收
cd /Volumes/livingArea/dsbot-monitoring
$NODE tests/neural-acceptance.cjs --url=http://127.0.0.1:18811/neural.html; echo "EXIT=$?"
```

脚本零第三方依赖，用 Node 标准库 + Chrome CDP；`CHROME_PATH` 可覆盖浏览器路径。

## 6. 结论

**本轮不通过，退出码 1。** 5 条断言 3 通过 2 不通过：

- 功能骨架是好的：17 个面板齐、页面不滚动、5 块新面板都有内容、没有 JS 报错；
- 两处真问题：`p-hour` / `p-flow` 内容被裁切（9px / 14px），以及 10 处截断文本缺 `title`。

修完这两处后需要按同一脚本重跑，本报告的 md5 与退出码随之作废。
