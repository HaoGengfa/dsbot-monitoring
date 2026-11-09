// 作战室看板：左上拓扑、右上流水、中间思考卡、底部用量统计。
const NS = 'http://www.w3.org/2000/svg';
// 底色：默认 'base'（用 :root 的 --bg #0c1017，并让 bg-stage.png 底图透出来）。
// 2026-11-06 之前默认是 'blue'，于是页面一直在用 #0a1526 那层蓝底，
// 底图铺上去后下面的蓝底色还用 rgb(10,21,38) 顶着，跟设计色板对不上。
// ?bg=blue / ?bg=navy 仍可用，只是不再作为默认。
const bgParam = new URLSearchParams(location.search).get('bg') || 'base';
// 干活态动画：glow 外发光 / inset 内柔光 / scan 柔光线扫过（默认）
const fxParam = new URLSearchParams(location.search).get('fx') || 'inset';   // 默认改为卡内呼吸光
// ?demo=1：强制把第一张卡显示为"思考中"，只用于预览动画，不伪造任何数据
const demoPreview = new URLSearchParams(location.search).get('demo') === '1';
let demoBotId = null;
document.body.classList.add(`fx-${fxParam}`);
if (bgParam !== 'off' && bgParam !== 'base') document.body.classList.add(`bg-${bgParam}`);

// 默认：活跃度图占中栏、日志贴右；?swap=0 可回到旧排法
if (new URLSearchParams(location.search).get('swap') !== '0') document.body.classList.add('swap');

// 思考卡外观：默认贴边四角括号；?card=inset 内缩取景框、?card=str 粗角标、?card=off 旧左侧竖条
const cardParam = new URLSearchParams(location.search).get('card');
if (cardParam) document.body.classList.add('card-' + cardParam);
const COLORS = {
  violet: '#8b5cf6', blue: '#3b82f6', green: '#22c55e', cyan: '#06b6d4',
  orange: '#f97316', yellow: '#eab308', magenta: '#ec4899', brown: '#a16207',
  red: '#ef4444', sky: '#0ea5e9', cobalt: '#1d4ed8', gray: '#64748b'
};

const memberListEl = document.getElementById('member-list');
const thoughts = document.getElementById('thoughts');
const logEl = document.getElementById('log');
const statsEl = document.getElementById('stats');
const activityEl = document.getElementById('activity');
const alertsEl = document.getElementById('alerts');
const totalsEl = document.getElementById('totals');

const cards = new Map();
const statCells = new Map();
let botsCache = [];
let mainId = null;
// 被点亮的通信线两端节点 id（drawRing 算，updateRingState 每 tick 用）
let ringTouchedIds = new Set();
// 所有群的管理员 id（含视角管理员）：这些卡的正文是调度结论，排版要宽一格
let adminIdSet = new Set();
let structureKey = '';
let lastFeedAt = null;
let barOrderKey = '';
let nameOf = new Map();

// 时长文案：入参毫秒，返回 45s / 3m12s / 2h5m。
function fmtDur(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  if (m < 60) return `${m}m${String(rest).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}m`;
}

// 颜色取值：入参颜色名，返回十六进制色值。
function colorOf(name) {
  return COLORS[name] || COLORS.gray;
}

// 时分秒：入参毫秒时间戳，返回 HH:MM:SS。
function hms(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// 数字压缩：入参数值，返回 1.2k / 3.4M 这类短写法。
function fmt(n) {
  const v = Number(n);
  if (!Number.isFinite(v) || v <= 0) return '0';
  if (v < 1000) return String(Math.round(v));
  const unit = (x) => (x >= 100 ? String(Math.round(x)) : String(Math.round(x * 10) / 10));
  if (v < 1_000_000) return `${unit(v / 1000)}k`;
  if (v < 1_000_000_000) return `${unit(v / 1_000_000)}M`;
  return `${unit(v / 1_000_000_000)}B`;
}

// 创建 SVG 元素：入参标签名与属性表，返回节点。
function svgEl(tag, attrs = {}) {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

// 显示脚本异常：入参消息文本，副作用是在顶部挂一条红色提示。
function showError(message) {
  let bar = document.getElementById('js-error');
  if (!bar) {
    bar = document.createElement('div');
    bar.id = 'js-error';
    bar.style.cssText = 'position:fixed;left:0;right:0;top:0;z-index:99;padding:8px 14px;'
      + 'background:#7f1d1d;color:#fff;font:12px/1.5 ui-monospace,monospace;white-space:pre-wrap';
    document.body.prepend(bar);
  }
  bar.textContent = `脚本异常：${message}`;
}
window.addEventListener('error', (e) => showError(e.message));
window.addEventListener('unhandledrejection', (e) => showError(String((e.reason && e.reason.message) || e.reason)));

/* ---------------- ① 成员列表（取代原拓扑连线图） ---------------- */

// 设计结论（UI设计师 + 设计规范工程师）：250×270 区域里 11 条线全部汇聚到中心，
// 线宽编码精度只有约 25%，且靠近中心的半段被主 Bot 胶囊遮住，连线只能当装饰。
// 改成「两列排序列表」：按与管家的消息数降序，数值精度 100%，且不新增常驻动画。

const memberList = document.getElementById('member-list');
const listRows = new Map();   // botId -> { el, num }
let listKey = '';

// 重建列表：入参按顺序排好的成员数组，副作用是重排两列 DOM。
function renderMemberList(members) {
  if (!memberList) return;
  const key = members.map((m) => m.id).join('|');
  if (key === listKey) return;
  listKey = key;
  memberList.textContent = '';
  listRows.clear();

  const cols = [document.createElement('div'), document.createElement('div')];
  for (const col of cols) {
    col.className = 'mlist-col';
    memberList.appendChild(col);
  }
  const perCol = Math.ceil(members.length / 2);

  members.forEach((m, i) => {
    const row = document.createElement('div');
    row.className = 'mrow';
    row.dataset.id = m.id;
    row.style.setProperty('--tone', colorOf(m.color));

    const bar = document.createElement('i');
    bar.className = 'mrow-bar';
    const name = document.createElement('span');
    name.className = 'mrow-name';
    name.textContent = m.name;
    const num = document.createElement('span');
    num.className = 'mrow-num';

    row.append(bar, name, num);
    cols[i < perCol ? 0 : 1].appendChild(row);
    listRows.set(m.id, { el: row, num });
  });
}

// 更新状态与消息数：入参 bots 与权重表，副作用是切换样式与文本。
function updateMemberList(bots, weights) {
  for (const bot of bots) {
    const row = listRows.get(bot.id);
    if (!row) continue;
    row.el.classList.toggle('is-working', Boolean(bot.working));
    row.num.textContent = String(weights.get(bot.id) || 0);
  }
}

// 派活/回执的行闪一次（单次 360ms，不循环，不占常驻动画预算）。
function flashMember(id, kind) {
  const row = listRows.get(id);
  if (!row) return;
  const cls = kind === 'request' ? 'flash-req' : kind === 'reply' ? 'flash-rep' : 'flash-dim';
  row.el.classList.remove('flash-req', 'flash-rep', 'flash-dim');
  void row.el.offsetWidth;
  row.el.classList.add(cls);
  setTimeout(() => row.el.classList.remove(cls), 380);
}

/* ---------------- ① 环形成员图（?topo=list 回退到列表） ---------------- */

const SVGNS = 'http://www.w3.org/2000/svg';
const ringEl = document.getElementById('topo-ring');
const topoMode = new URLSearchParams(location.search).get('topo') || 'ring';   // ring | bus | list
const ringMode = topoMode !== 'list';
if (ringMode) document.body.classList.add('topo-ring');

let memberLinks = [];          // [{ a, b, n }] 成员之间有过几次往来
// 「最近通信」的时间窗：大屏是常驻监视，窗口太短会几乎看不到；3 分钟能覆盖一轮协作
const COMM_WINDOW_MS = 180000;
let recentPairs = new Set();   // 窗口内真的发过消息的成员配对（"a|b"），每 tick 重算
let recentKeyStr = '';         // 上面那组的字符串形式，进 drawRing 的缓存 key
const ringLinkEls = new Map(); // "a|b"（排序后） -> path 元素，用于按运行状态实时改类名
const ringNodes = new Map();   // botId -> { g, dot }
const ringLines = new Map();   // botId -> path 元素
const ringPaths = new Map();   // botId -> 路径 d
let ringKey = '';
let currentNodeR = 11;   // 当前视角下的节点基准半径（成员少时会画得更大）

// 建 SVG 元素：入参标签与属性表，返回元素。
function svgNode(tag, attrs) {
  const el = document.createElementNS(SVGNS, tag);
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, String(v));
  return el;
}

// 总线式：管家在左，一条竖向"总线"居中，10 个成员从总线直角分支出去
function drawBus(bots, ordered) {
  if (!ringEl) return;
  const W = ringEl.clientWidth || 320;
  const H = ringEl.clientHeight || 270;
  const key = `bus|${ordered.map((b) => b.id).join('|')}#${W}x${H}`;
  if (key === ringKey) return;
  ringKey = key;

  ringEl.setAttribute('viewBox', `0 0 ${W} ${H}`);
  ringEl.textContent = '';
  ringNodes.clear();
  ringLines.clear();
  ringPaths.clear();

  const main = bots.find((b) => b.id === mainId);
  const members = ordered.filter((b) => !main || b.id !== main.id);

  const hubR = 22;
  const hubX = 46;
  const hubY = H / 2;
  const busX = Math.min(W * 0.40, 124);
  const nodeX = W - 88;   // 留出名字宽度（最长 7 字 ≈ 66px）
  const top = 26;
  const bot = H - 26;
  const step = members.length > 1 ? (bot - top) / (members.length - 1) : 0;

  members.forEach((bot_, i) => {
    const y = top + step * i;
    // 直角走线：管家 → 总线 → 分支到成员（像电路板走线，不用曲线也不交叉）
    const d = `M ${hubX + hubR} ${hubY} L ${busX} ${hubY} L ${busX} ${y} L ${nodeX - 9} ${y}`;
    const line = svgNode('path', { d, class: 'rline' });
    ringEl.appendChild(line);
    ringLines.set(bot_.id, line);
    ringPaths.set(bot_.id, d);
  });

  if (main) {
    const tone = colorOf(main.color);
    const g = svgNode('g', { class: 'rhub' });
    g.appendChild(svgNode('circle', {
      cx: hubX, cy: hubY, r: hubR, fill: tone,
      'fill-opacity': main.working ? 0.3 : 0.14,
      stroke: tone, 'stroke-opacity': main.working ? 0.95 : 0.55, 'stroke-width': 1.6
    }));
    const label = svgNode('text', { x: hubX, y: hubY + 4, 'text-anchor': 'middle', class: 'rhub-label' });
    label.textContent = main.name;
    g.appendChild(label);
    ringEl.appendChild(g);
  }

  members.forEach((bot_, i) => {
    const y = top + step * i;
    const tone = colorOf(bot_.color);
    const g = svgNode('g', { class: `rnode${bot_.working ? ' is-working' : ''}` });
    if (bot_.working) {
      g.appendChild(svgNode('circle', {
        cx: nodeX, cy: y, r: 6.5, fill: 'none', stroke: tone,
        'stroke-width': 1.6, class: 'rhalo'
      }));
    }
    const dot = svgNode('circle', {
      cx: nodeX, cy: y, r: bot_.working ? 8 : 6.5, fill: tone,
      'fill-opacity': bot_.working ? 0.45 : 0.12,
      stroke: tone, 'stroke-opacity': bot_.working ? 1 : 0.42,
      'stroke-width': bot_.working ? 1.8 : 1.5
    });
    const label = svgNode('text', {
      x: nodeX + 13, y: y + 3.4, 'text-anchor': 'start', class: 'rlabel'
    });
    label.textContent = bot_.name;
    g.append(dot, label);
    ringEl.appendChild(g);
    ringNodes.set(bot_.id, { g, dot, label });
  });
}

// 画环形：管家在圆心，成员等分绕圆，连线只作结构暗示（不用线宽编码）
function drawRing(bots, ordered) {
  if (!ringMode || !ringEl) return;
  const W = ringEl.clientWidth || 320;
  const H = ringEl.clientHeight || 270;
  const linkKey = memberLinks.map((l) => `${l.a}>${l.b}:${l.n}`).sort().join(',');
  // 必须把「谁在跑」也放进缓存 key：否则成员开始/停止工作时 key 不变，
  // drawRing 直接 return，连线上的运行态类名就永远不会更新（这就是之前不动的原因）。
  const runKey = ordered.filter((b) => b.working).map((b) => b.id).sort().join(',');
  const key = ordered.map((b) => b.id).join('|') + `#${W}x${H}#${linkKey}#run:${runKey}#recent:${recentKeyStr}`;
  if (key === ringKey) return;
  ringKey = key;

  ringEl.setAttribute('viewBox', `0 0 ${W} ${H}`);
  ringEl.textContent = '';
  ringNodes.clear();
  ringLines.clear();
  ringPaths.clear();

  // 环心：垂直方向要给上下两侧的名字留位置，否则整圈会顶到上沿、
  // 下半截空出白（用户反馈"图偏上，下面空一大块"）。
  // 上侧留 24（名字）+ 6（边距），下侧留 30（名字离节点更远）+ 6。
  const TOP_PAD = 30;
  const BOTTOM_PAD = 36;
  const cx = W / 2;
  const cy = TOP_PAD + (H - TOP_PAD - BOTTOM_PAD) / 2;
  // 成员少的时候把圆点画大——6 个人还用 11px 会显得整张图空荡荡（用户反馈）
  const memberCount = Math.max(1, ordered.length - 1);
  const nodeR = memberCount <= 6 ? 18 : memberCount <= 9 ? 14 : 11;
  currentNodeR = nodeR;   // updateRingState 每 tick 要按它刷新半径
  const hubR = memberCount <= 6 ? 44 : memberCount <= 9 ? 36 : 30;

  // 环半径按「最长名字」反算，保证左右两侧的名字不会被画布裁掉
  const LABEL_FS = 12;   // UI-10 的 --fs-100 下限，禁止低于 12px
  // 名字太长会把环压小：「Bot 作战指挥室调度员」11 个字约 135px，
  // 环半径要给它让位，结果整张图缩一圈。显示截断到 7 字，全名进 title。
  const MAX_LABEL_CHARS = 7;
  const maxChars = ordered.reduce(
    (m, b) => Math.max(m, Math.min([...(b.name || '')].length, MAX_LABEL_CHARS)),
    3
  );
  // 名字单行口径：按最长名字的**实际渲染宽度**反算半径。
  // 原来一律按中文字宽（12.3px/字）算，现在 Bot 名字都改成了 2~3 个字母
  // （CTO / API / QA / DSP-WR），英文只有约 7.5px/字，预留宽度算多了近一倍，
  // 环被无谓地压小；而左右两侧的名字又因为算法不区分中英文被裁出画布。
  // 这里按字符类型逐个累加：CJK 记 12.3px，其它（字母数字标点）记 7.5px，
  // 末尾再留 1px 安全余量。
  const CJK_W = LABEL_FS * 1.025;      // 中文/全角字符宽度
  const LATIN_W = LABEL_FS * 0.625;    // 拉丁字母与数字宽度（实测 12px 字号约 7.5px）
  const labelWidthOf = (name) => {
    let w = 0;
    for (const ch of String(name || '')) {
      w += /[\u4e00-\u9fff\uff00-\uffef]/.test(ch) ? CJK_W : LATIN_W;
    }
    return Math.ceil(w);
  };
  let maxLabelW = 0;
  for (const b of ordered) maxLabelW = Math.max(maxLabelW, labelWidthOf(b.name));
  const LABEL_W = maxLabelW + 2;
  const LABEL_GAP = 7;        // 圆点到名字的间距
  const CANVAS_PAD = 6;       // 画布安全边距，防亚像素裁切
  const NODE_R_MAX = nodeR + 3;   // 执行中节点会再涨，半径要按最大的算，否则一涨就压到字
  // 横向：左右各要放「节点半径 + 间距 + 名字宽度 + 边距」，剩下多少给半径。
  // 原来的 200px 是写死的上限，容器放大后环也跟着不放大（用户反馈"图只能这么大"）。
  // 现在上限跟容器宽度走：最多用到可分配空间的 92%，同时不小于 200 保证小窗时不被压没。
  const rxCap = Math.max(200, Math.floor((W / 2 - NODE_R_MAX - LABEL_GAP - LABEL_W - CANVAS_PAD) * 0.92));
  const rx = Math.min(W / 2 - NODE_R_MAX - LABEL_GAP - LABEL_W - CANVAS_PAD, rxCap);
  // 纵向：上下各有一个名字（约 23px）+ 节点半径，其余全部给半径。
  // 原来这里写死 150，且 NODE_R_MAX 用的是全局值——容器变高也不会放大。
  const ROW_H = 23;               // 上下名字占的高度
  // 纵向不再受 rx 约束（原来是正圆，横向 136 就卡死了 237 的纵向空间，白扔 100px）。
  // 容器是竖长条，改成椭圆正好用满：横向按名字宽度算，纵向按可用高度算。
  // 椭圆长宽比上限 1.9，避免极端窗口下被拉成一条梭子。
  const ryMaxByH = H / 2 - NODE_R_MAX - ROW_H - CANVAS_PAD;
  const ry = Math.max(150, Math.min(ryMaxByH, rx * 1.32));
  // 横向要给左右两侧的名字留够宽度（最长 7 字 ≈ 74px），所以 rx 收窄、ry 放高，
  // 整体变成纵向椭圆：节点和字号都能更大，名字不会被裁。
  const main = bots.find((b) => b.id === mainId);
  const members = ordered.filter((b) => !main || b.id !== main.id);

  // 先把 10 个节点的坐标算出来（成员之间连线要用）
  const posOf = new Map();
  members.forEach((bot, i) => {
    const ang = -Math.PI / 2 + (i * 2 * Math.PI) / Math.max(1, members.length);
    posOf.set(bot.id, { x: cx + rx * Math.cos(ang), y: cy + ry * Math.sin(ang) });
  });

  // 连线先画，压在节点下面
  members.forEach((bot, i) => {
    const ang = -Math.PI / 2 + (i * 2 * Math.PI) / Math.max(1, members.length);
    const nx = cx + rx * Math.cos(ang);
    const ny = cy + ry * Math.sin(ang);
    const ux = Math.cos(ang);
    const uy = Math.sin(ang);
    const p1x = cx + ux * (hubR + 2);
    const p1y = cy + uy * (hubR + 2);
    const p2x = nx - ux * (nodeR + 4);
    const p2y = ny - uy * (nodeR + 4);
    const d = `M ${p1x} ${p1y} L ${p2x} ${p2y}`;
    const line = svgNode('path', { d, class: 'rline' });
    ringEl.appendChild(line);
    ringLines.set(bot.id, line);
    ringPaths.set(bot.id, d);
  });

  // 任务执行期间连线持续流动：
  //   用户要求「全部放开」——凡是在干活的成员，它那条线就亮就流，不再限 3 条。
  //   满载 10 人时就是 10 条一起流（实测 60fps，撑得住）。
  //   卡住的仍不参与循环（循环表示"正常推进"，不表示"出事"）。
  const runningMembers = members
    .filter((b) => b.working && !(b.state === 'stalled'))
    .sort((a, b) => ((b.activity && b.activity.lastAt) || 0) - ((a.activity && a.activity.lastAt) || 0));
  const runLoopIds = new Set(runningMembers.map((b) => b.id));
  const runHotIds = new Set();
  // 交叉线（成员之间）的流光条件：两端在交互。
  // 这里必须用「全部在跑的 bot」而不是 runLoopIds——后者只含环上成员，
  // 排除了中心管理员。原来拿 runLoopIds 当基准，于是"只有管理员在跑、
  // 两个成员最近通信用过"时条件恒为假；可线的 class 又是按 crossActive 拼的，
  // 结果出现「线在流、两端的点位却不亮」（用户 2026-11-06 反馈）。
  const workingIdSet = new Set(bots.filter((b) => b.working).map((b) => b.id));

  // ── 连线：常态就把线画好，但高亮只给「真的在通信」的配对 ──────────
  // 用户要求：线正常连上，不要随便触发两个点之间的高亮。
  //   · 底纹：任意两个成员之间都有一条（全连接），表示同属一个团队
  //   · 高亮：只有最近真的发过消息的那一对才点亮 + 跑流光
  const pairKey = (x, y) => [x, y].sort().join('|');
  // 被点亮的通信线两端：节点据此加 is-touched 态，保证"线亮 ⇒ 两点也亮"
  const touchedIds = new Set();
  const ringLinks = [];
  if (members.length >= 2) {
    const n = members.length;
    for (let i = 0; i < n; i += 1) {
      for (let j = i + 1; j < n; j += 1) {
        const a = members[i].id;
        const b = members[j].id;
        if (!a || !b || a === b) continue;
        const gap = Math.min(j - i, n - (j - i));
        if (n > 14 && gap > 2) continue;   // 人太多时退回只连邻近两档
        ringLinks.push({ a, b, n: 0, gap, structural: true });
      }
    }
  }

  // 真实往来优先：同一对既有骨架又有数据时，只画数据那条，不重复叠两层
  const realPairs = new Set(memberLinks.map((l) => pairKey(l.a, l.b)));
  const linksToDraw = [
    ...ringLinks.filter((l) => !realPairs.has(pairKey(l.a, l.b))),
    ...memberLinks
  ];
  // 正在跑的配对也要画（中心 ↔ 成员），保证「谁在干活」这条线一定画得出来
  for (const b of runningMembers) {
    const k = pairKey(mainId, b.id);
    if (!linksToDraw.some((l) => pairKey(l.a, l.b) === k)) {
      linksToDraw.push({ a: mainId, b: b.id, n: 1 });
    }
  }

  // 成员少时连线也少，透明度给高一点，否则整张图看着是空的
  ringEl.style.setProperty(
    '--mesh-op',
    memberCount <= 6 ? '0.34' : memberCount <= 9 ? '0.24' : '0.16'
  );

  ringLinkEls.clear();

  // 成员之间有过往来的，画一条常驻淡弧；有过几次就多粗一点
  const nodeRdraw = nodeR + 2;
  const hubPos = { x: cx, y: cy };
  for (const link of linksToDraw) {
    // posOf 只存环绕成员的坐标，管家的线要落在圆心，否则会被跳过
    const a = link.a === mainId ? hubPos : posOf.get(link.a);
    const b = link.b === mainId ? hubPos : posOf.get(link.b);
    if (!a || !b) continue;
    const isStruct = !!link.structural;
    const mx = (a.x + b.x) / 2;
    const my = (a.y + b.y) / 2;
    let ctrlX;
    let ctrlY;
    if (isStruct) {
      // 全连接下 45 条弦如果都走直线，中心会糊成一团。按「弦离圆心多近」决定弯多少：
      // 相邻弦只是微微外鼓成花瓣，跨半环的弦鼓得更多，保证每条弧都绕开中心圆盘。
      const ddx2 = b.x - a.x;
      const ddy2 = b.y - a.y;
      const len2 = Math.hypot(ddx2, ddy2) || 1;
      let px2 = -ddy2 / len2;
      let py2 = ddx2 / len2;
      // 垂直方向取「远离圆心」那一侧，弧才不会往中心挤
      if ((mx - cx) * px2 + (my - cy) * py2 < 0) {
        px2 = -px2;
        py2 = -py2;
      }
      const dCenter = Math.hypot(mx - cx, my - cy);
      const bow = Math.max(12, (hubR + 30 - dCenter) * 1.8);
      ctrlX = mx + px2 * bow;
      ctrlY = my + py2 * bow;
    } else if (link.a === mainId || link.b === mainId) {
      // 中心 ↔ 成员的线：和主干直线同向，保持原来的轻微内凹，
      // 否则会向外鼓成第二条线，看着像重复画了两根
      ctrlX = mx + (cx - mx) * 0.45;
      ctrlY = my + (cy - my) * 0.45;
    } else {
      // 数据线：按弦长给弯曲量并向「远离圆心」的一侧鼓，避免长弦（跨半个环的配对）
      // 从中点附近直穿圆心，看着像一条直线横穿画面。
      const ddx = b.x - a.x;
      const ddy = b.y - a.y;
      const len = Math.hypot(ddx, ddy) || 1;
      let px = -ddy / len;
      let py = ddx / len;
      if ((mx - cx) * px + (my - cy) * py < 0) {
        px = -px;
        py = -py;
      }
      const bow = Math.min(len * 0.16, 46);
      ctrlX = mx + px * bow;
      ctrlY = my + py * bow;
    }

    // 控制点不许进圆心圆盘：离圆心太近就沿径向推出去
    const dvx = ctrlX - cx;
    const dvy = ctrlY - cy;
    const dv = Math.hypot(dvx, dvy) || 1;
    const minR = hubR + 22;
    if (dv < minR) {
      ctrlX = cx + (dvx / dv) * minR;
      ctrlY = cy + (dvy / dv) * minR;
    }

    // 两端各自按「朝控制点」的方向退到节点圆周外，弧线不穿进圆点
    const aToC = Math.atan2(ctrlY - a.y, ctrlX - a.x);
    const bToC = Math.atan2(ctrlY - b.y, ctrlX - b.x);
    // 起点贴着中心圆的边框（不是离它 6px 悬空），线看着是从边框里穿出来的
    const aR = link.a === mainId ? hubR + 1 : nodeRdraw;
    const bR = link.b === mainId ? hubR + 1 : nodeRdraw;
    const ax = a.x + Math.cos(aToC) * aR;
    const ay = a.y + Math.sin(aToC) * aR;
    const bx = b.x + Math.cos(bToC) * bR;
    const by = b.y + Math.sin(bToC) * bR;
    const d = `M ${ax} ${ay} Q ${ctrlX} ${ctrlY} ${bx} ${by}`;
    // 骨架线固定细而淡；数据线按往来次数加粗
    const stroke = isStruct ? 0.9 : Math.min(2, 0.9 + link.n * 0.18);
    // 这条线是否连着管家与一个正在跑的成员
    const other = link.a === mainId ? link.b : (link.b === mainId ? link.a : null);
    // 两端都在干活的交叉线：底色也点亮（不只是飘个白块），
    // 这样几个人同时跑时，他们之间任意两两连线都是一条亮线，能看出这一小撮在协作。
    // 交叉线要点亮，只看「最近 60 秒内这两个人真的发过消息」，不看谁在不在跑。
    // 原因：A 给 B 发完消息，A 那一轮就结束了，等 B 收到时 A 已经不在跑，
    // 如果还要求"两端都在跑"，这种真实交互几乎永远抓不到（实测 cross=0）。
    // 也不再要求"都在跑"——那只是各自忙，不是互相通信，正是之前的误报来源。
    // 成员之间的线：只要最近真的通过信就点亮，不管它是结构线还是数据线
    // （之前只判断 isStruct，导致"有往来的那对"被画成数据线后永远点不到，cross 恒为 0）
    const isMemberLink = link.a !== mainId && link.b !== mainId;
    // 点亮要同时满足：最近真的通过信 + 这两端至少有一端还在跑。
    // 只按"3 分钟内通信过"会让两个人都空闲了线还挂着——
    // 用户看到的就是"只有大管家在动，怎么还有两个节点连着"。
    const crossActive = isMemberLink
      && recentPairs.has(pairKey(link.a, link.b))
      && (workingIdSet.has(link.a) || workingIdSet.has(link.b));
    // 这条线亮了，就把两端记进 touchedIds：节点也要给一个"被这条线点亮"的态，
    // 否则会出现「线在流、两头的点还是灰的」——用户看到的就是"有一个点回不亮"。
    if (crossActive) {
      touchedIds.add(link.a);
      touchedIds.add(link.b);
    }
    let linkClass = 'mlink';
    if (isStruct) {
      linkClass += crossActive ? ' is-structure is-cross-active' : ' is-structure';
    } else {
      linkClass += crossActive ? ' is-data is-cross-active' : ' is-data';
    }
    if (other && runLoopIds.has(other)) linkClass += ' is-running';
    else if (other && runHotIds.has(other)) linkClass += ' is-hot';

    const arc = svgNode('path', {
      d, class: linkClass, fill: 'none',
      'stroke-width': stroke,
      'stroke-opacity': isStruct ? 0.2 : Math.min(0.5, 0.16 + link.n * 0.05)
    });
    ringLinkEls.set([link.a, link.b].sort().join('|'), arc);
    ringEl.appendChild(arc);

    // 流光只在「这条线正在承接任务」时出现——平时整张网是静的，不跑。
    // 两种情况会有光：
    //   ① 中心 ↔ 正在干活的成员（任务从中心派出去，绿底 + 白块）
    //   ② 成员 ↔ 成员之间，且两端都在干活（两人确实在交互）——就是交叉的那些线，
    //      只加白块，不改底色，绿色留给①
    // 路径 d 是 起点→终点 的方向，dashoffset 递减就是沿这条线正向跑，
    // 所以光永远顺着线的方向走，不会乱跳。
    if ((other && runLoopIds.has(other)) || crossActive) {
      const flow = svgNode('path', {
        d, class: crossActive ? 'mlink-flow is-cross-flow' : 'mlink-flow',
        fill: 'none', pathLength: '336'
      });
      flow.style.animationDelay = '0s';
      ringEl.appendChild(flow);
    }
  }

  // 把"被通信线点亮的两端"交给 updateRingState：它每 tick 跑，
  // 负责保证这些节点在视觉上和线同步（线亮 ⇒ 点也亮）。
  ringTouchedIds = touchedIds;

  // 圆心：管家
  if (main) {
    const tone = colorOf(main.color);
    const g = svgNode('g', { class: `rhub${main.working ? ' is-working' : ''}` });
    g.appendChild(svgNode('circle', {
      cx, cy, r: hubR, fill: tone, 'fill-opacity': main.working ? 0.34 : 0.14,
      stroke: tone, 'stroke-opacity': main.working ? 1 : 0.55,
      'stroke-width': main.working ? 2 : 1.6, class: 'rhub-core'
    }));
    // 干活时：一圈光从边框向外扩散并淡出，两圈错开半拍 —— 像一道光扫过去，
    // 而不是有个东西在边框上绕圈（多个节点同时绕圈会像一排机械齿轮）。
    if (main.working) {
      // 一次只有一个波：扩散完再起下一个，比两圈叠着更安静
      g.appendChild(svgNode('circle', {
        cx, cy, r: hubR + 2, fill: 'none', stroke: '#ffffff',
        'stroke-width': 1.05, class: 'rhub-ping'
      }));
    }
    // 中心固定显示「管理员」：群视角下中心是这个群的管理员，
    // 具体名字（比如「Neura群调度员」）太长会把圆撑爆，全名放 title 里悬停可见。
    const label = svgNode('text', { x: cx, y: cy + 4, 'text-anchor': 'middle', class: 'rhub-label' });
    label.textContent = '管理员';
    const tip = svgNode('title', {});
    tip.textContent = main.name;
    label.appendChild(tip);
    g.appendChild(label);
    ringEl.appendChild(g);
  }

  // 圆周：成员
  members.forEach((bot, i) => {
    const ang = -Math.PI / 2 + (i * 2 * Math.PI) / Math.max(1, members.length);
    const x = cx + rx * Math.cos(ang);
    const y = cy + ry * Math.sin(ang);
    const tone = colorOf(bot.color);
    const g = svgNode('g', { class: `rnode${bot.working ? ' is-working' : ''}` });
    // 干活时跟大管家同一套语言：一圈淡轨道 + 一段亮弧顺着边框流。
    // 不再用"呼吸光环"——那个只在中心有弧光时显得两套动效不搭。
    // 每个节点按序号错开，避免十个人同时起波
    if (bot.working) {
      const ping = svgNode('circle', {
        cx: x, cy: y, r: 15, fill: 'none', stroke: '#ffffff',
        'stroke-width': 0.9, class: 'rnode-ping'
      });
      ping.style.animationDelay = `${(i * 0.23).toFixed(2)}s`;
      g.appendChild(ping);
    }
    const dot = svgNode('circle', {
      cx: x, cy: y, r: bot.working ? 13.5 : nodeR, fill: tone, 'fill-opacity': bot.working ? 0.45 : 0.12,
      // 空闲统一蓝灰：10 个成员各自上色会让整屏花掉。
      // 成员色变成"稀缺资源"——只有正在干活的那个才亮起自己的颜色。
      stroke: bot.working ? tone : '#5b7290',
      fill: bot.working ? tone : '#5b7290',
      'fill-opacity': bot.working ? 0.45 : 0.08,
      'stroke-opacity': bot.working ? 1 : 0.45,
      'stroke-width': bot.working ? 1.8 : 1.2
    });
    // 中心呼吸小点：只给正在干活的节点。外圈已经有向外扩的波纹，
    // 中心再放一个随节拍明暗的实心点，读起来像"心脏在跳"，
    // 比单靠外圈波纹更容易一眼看出这个节点在运转。
    if (bot.working) {
      const core = svgNode('circle', {
        cx: x, cy: y, r: 4.2, fill: '#ffffff', class: 'rnode-core'
      });
      core.style.animationDelay = `${(i * 0.23).toFixed(2)}s`;
      g.appendChild(core);
    }
    const cosA = Math.cos(ang);
    const sinA = Math.sin(ang);
    // 容器已加宽到 500、rx 按最长名字反算（138），名字一律单行。
    // 原来按「左右两侧且超过 4 字」折两行，现在横向空间足够，折行反而更难读。
    const fullName = bot.name || '';
    // 按**宽度**判截断，而不是字符数：3 个字母（CTO/API）远没到上限，
    // 原来按 7 字符一刀切虽然不会误伤短名，但中文长名该截的也得截。
    // 上限取该节点可用宽度（环半径反算出来的那部分左右留白）。
    const LABEL_MAX_W = Math.max(56, Math.ceil(rx * 0.62));
    const nameW = labelWidthOf(fullName);
    let shownName = fullName;
    if (nameW > LABEL_MAX_W) {
      let acc = '';
      for (const ch of fullName) {
        const next = acc + ch;
        if (labelWidthOf(next) + LATIN_W > LABEL_MAX_W) break;
        acc = next;
      }
      shownName = (acc || fullName.slice(0, 1)) + '…';
    }
    const lines = [shownName];

    let lx = x;
    let ly = y + 4;
    let anchor = 'middle';
    // 名字方位：按节点在环上的实际角度分配锚点。
    // 原来只有 >0.55 / <-0.55 三档，落在正下方（sinA>0 且 |cosA|<0.55）的
    // 相邻两个节点都用 middle，名字宽度一超就叠成「技术架构师原型分析师」。
    // 现在按 cosA 的正负把它们推开：居中的给 middle，偏左给 end、偏右给 start。
    if (cosA > 0.55) { lx = x + nodeR + 8; anchor = 'start'; }
    else if (cosA < -0.55) { lx = x - nodeR - 8; anchor = 'end'; }
    else if (sinA < 0) {
      // 正上方：居中，但要避开左右两侧
      ly = y - nodeR - 8;
      if (cosA > 0.22) { lx = x + 6; anchor = 'start'; }
      else if (cosA < -0.22) { lx = x - 6; anchor = 'end'; }
    } else {
      // 正下方：相邻两节点会撞，按左右半环分开摆，且比上一档再往下让一点
      ly = y + nodeR + 18;
      if (cosA > 0.22) { lx = x + 6; anchor = 'start'; }
      else if (cosA < -0.22) { lx = x - 6; anchor = 'end'; }
    }

    const label = svgNode('text', { x: lx, y: ly, 'text-anchor': anchor, class: 'rlabel' });
    // 被截断的名字挂悬停提示，显示全名
    if (lines[0] !== fullName) {
      const tip = svgNode('title', {});
      tip.textContent = fullName;
      label.appendChild(tip);
    }
    if (lines.length === 1) {
      label.textContent = lines[0];
    } else {
      label.setAttribute('y', ly - 5);
      lines.forEach((txt) => {
        const ts = svgNode('tspan', { x: lx, dy: txt === lines[0] ? 0 : 13 });
        ts.textContent = txt;
        label.appendChild(ts);
      });
    }
    g.append(dot, label);

    ringEl.appendChild(g);
    ringNodes.set(bot.id, { g, dot, label, x, y, tone });
  });
}

// 更新环形状态：入参 bots，副作用是切换描边亮度
function updateRingState(bots) {
  // —— 先同步连线：谁在跑，管家到谁的线就一直流动 ——
  // 名额已放开（用户要求）：凡是在跑的成员，它那条线就是 is-running，
  // 不再区分"前 3 条流动、其余只做静态亮线"——那正是同屏出现绿/灰两种线的原因。
  // 卡住的不参与（循环表示正常推进，不表示出事）。
  const running = bots
    .filter((b) => b.working && b.id !== mainId)
    .sort((a, b) => ((b.activity && b.activity.lastAt) || 0) - ((a.activity && a.activity.lastAt) || 0));
  const loopIds = new Set(running.map((b) => b.id));
  const hotIds = new Set();
  for (const [key, el] of ringLinkEls) {
    const pair = key.split('|');
    const other = pair[0] === mainId ? pair[1] : (pair[1] === mainId ? pair[0] : null);
    el.classList.toggle('is-running', Boolean(other && loopIds.has(other)));
    el.classList.toggle('is-hot', Boolean(other && hotIds.has(other)));
  }

  for (const bot of bots) {
    const node = ringNodes.get(bot.id);
    if (!node) continue;
    node.g.classList.toggle('is-working', Boolean(bot.working));
    // 连到它的通信线是亮的（crossActive），这个点也必须亮起来，
    // 否则线上有光在跑、端点却是灰的，看起来像"有一个点回不亮"。
    node.g.classList.toggle('is-touched', !bot.working && ringTouchedIds.has(bot.id));
    const tone = colorOf(bot.color);
    node.dot.setAttribute('fill-opacity', bot.working ? '0.45' : '0.12');
    node.dot.setAttribute('stroke-opacity', bot.working ? '1' : '0.42');
    node.dot.setAttribute('stroke-width', bot.working ? '1.8' : '1.5');
    node.dot.setAttribute('r', String(bot.working ? currentNodeR + 2.5 : currentNodeR));
  }
}

// 成员之间通信：两个成员节点之间画一条弧线并跑一颗光点（单次 ~900ms，不常驻）
function flowBetween(fromId, toId, kind) {
  const a = ringNodes.get(fromId);
  const b = ringNodes.get(toId);
  if (!a || !b || fromId === toId) return;
  const color = kind === 'request' ? '#ffb547' : kind === 'reply' ? '#3ddc97' : '#8aa6c8';
  // 控制点朝圆心方向拉，形成弧线，避免和环心辐射线重叠
  const mx = (a.x + b.x) / 2;
  const my = (a.y + b.y) / 2;
  const cx0 = ringEl.clientWidth / 2;
  const cy0 = ringEl.clientHeight / 2;
  const ctrlX = mx + (cx0 - mx) * 0.55;
  const ctrlY = my + (cy0 - my) * 0.55;
  const d = `M ${a.x} ${a.y} Q ${ctrlX} ${ctrlY} ${b.x} ${b.y}`;

  const line = svgNode('path', {
    d, fill: 'none', stroke: color, 'stroke-width': 1.6, 'stroke-opacity': 0.55,
    'stroke-dasharray': '4 4'
  });
  const dot = svgNode('circle', { r: 4, fill: color, opacity: 0.98 });
  const glow = svgNode('circle', { r: 10, fill: color, opacity: 0.22 });
  ringEl.append(line, glow, dot);

  const probe = document.createElementNS(SVGNS, 'path');
  probe.setAttribute('d', d);
  const total = probe.getTotalLength();
  const t0 = performance.now();
  const dur = 1400;   // 成员之间的弧线放慢一点，便于肉眼捕捉

  function frame(now) {
    const p = Math.min(1, (now - t0) / dur);
    const eased = 1 - Math.pow(1 - p, 3);
    const pt = probe.getPointAtLength(eased * total);
    dot.setAttribute('cx', pt.x);
    dot.setAttribute('cy', pt.y);
    glow.setAttribute('cx', pt.x);
    glow.setAttribute('cy', pt.y);
    glow.setAttribute('opacity', String(0.22 * (1 - p * 0.6)));
    line.setAttribute('stroke-opacity', String(0.55 * (1 - p * 0.85)));
    if (p < 1) {
      requestAnimationFrame(frame);
      return;
    }
    line.remove();
    glow.remove();
    dot.remove();
  }
  requestAnimationFrame(frame);
}

// 演示：?demo=link 时让 UI设计师 ↔ 前端工程师 之间反复跑弧线，用来看样式（不是真实数据）
function demoLinks() {
  const byName = (n) => botsCache.find((b) => b.name === n);
  const a = byName('UI设计师');
  const b = byName('前端工程师');
  if (!a || !b) return;
  flowBetween(a.id, b.id, 'request');
  setTimeout(() => flowBetween(b.id, a.id, 'reply'), 700);
}
if (new URLSearchParams(location.search).get('demo') === 'link') {
  setTimeout(() => {
    demoLinks();
    setInterval(demoLinks, 3200);
  }, 1500);
}

// 沿连线输运一颗光点：入参成员 id 与类型，副作用是单次 720ms 动画
function flowPulse(botId, kind) {
  const d = ringPaths.get(botId);
  if (!d) return;
  const color = kind === 'request' ? '#ffb547' : kind === 'reply' ? '#3ddc97' : '#64748b';
  const line = ringLines.get(botId);
  if (line) {
    line.classList.add('is-live');
    setTimeout(() => line.classList.remove('is-live'), 420);
  }
  const dotR = kind === 'reply' ? 4 : 4.5;
  const dot = svgNode('circle', { r: dotR, fill: color, opacity: 0.98 });
  const glow = svgNode('circle', { r: 9, fill: color, opacity: 0.22 });
  const tail = svgNode('path', {
    fill: 'none', stroke: color, 'stroke-width': 2.4,
    'stroke-linecap': 'round', 'stroke-opacity': 0.5
  });
  ringEl.append(glow, tail, dot);

  const probe = document.createElementNS(SVGNS, 'path');
  probe.setAttribute('d', d);
  const total = probe.getTotalLength();
  const fromHub = kind !== 'request';
  const t0 = performance.now();
  const dur = 820;
  const ease = (x) => 1 - Math.pow(1 - x, 3);

  function frame(now) {
    const p = Math.min(1, (now - t0) / dur);
    const eased = ease(p);
    const at = (fromHub ? 1 - eased : eased) * total;
    // 拖尾：沿路径取 28px 短段
    const back = Math.max(0, at + (fromHub ? 28 : -28));
    const p1 = probe.getPointAtLength(at);
    const p2 = probe.getPointAtLength(back);
    tail.setAttribute('d', `M ${p2.x} ${p2.y} L ${p1.x} ${p1.y}`);
    tail.setAttribute('stroke-opacity', String(0.5 * (1 - p)));
    const pt = probe.getPointAtLength(at);
    dot.setAttribute('cx', pt.x);
    dot.setAttribute('cy', pt.y);
    glow.setAttribute('cx', pt.x);
    glow.setAttribute('cy', pt.y);
    glow.setAttribute('opacity', String(0.22 * (1 - p * 0.7)));
    if (p < 1) {
      requestAnimationFrame(frame);
      return;
    }
    dot.remove();
    glow.remove();
    tail.remove();
  }
  requestAnimationFrame(frame);
}

/* ---------------- ② 流水 ---------------- */

// 追加一条流水：入参时间、类型、标签与内容，副作用是插入并限制条数。
function pushLog(time, kind, label, text, roomName) {
  const li = document.createElement('li');
  const t = document.createElement('span');
  t.className = 'time';
  t.textContent = hms(time);
  const k = document.createElement('span');
  k.className = `kind ${kind}`;
  // 群消息：把群标放进「类型」这一列里，不新开一列。
  // 之前给群标单开一列，结果是群消息的行比普通行宽出一截，
  // 正文起点整体右移，整块日志看着没对齐（用户 2026-11-06 反馈）。
  // 现在固定三列（时间 / 类型 / 正文），群标只是类型列里的内容。
  if (roomName) {
    k.classList.add('kind-room');
    const r = document.createElement('span');
    r.className = `roomtag ${roomClass(roomName)}`;
    r.textContent = roomShort(roomName);
    r.title = roomName;
    k.appendChild(r);
    k.title = roomName;
  } else {
    k.textContent = label;
  }
  const x = document.createElement('span');
  x.className = 'text';
  x.textContent = text || '';
  li.append(t, k, x);
  logEl.appendChild(li);
  while (logEl.children.length > 90) logEl.firstChild.remove();
}

// 筛选下拉：切换时按群重放日志
// 设置抽屉里的「日志来源」选项：全部 + 各个群。默认全部。
// 去掉原来的「只看 Bot」——它对看板没有意义，只是日志的一个子集。
function syncLogFilterOptions(rooms) {
  const box = document.getElementById('log-source-list');
  if (!box) return;
  const items = [{ id: 'all', name: '全部' }]
    .concat(rooms.map((r) => ({ id: r.id, name: r.name || '群聊' })));

  const key = items.map((i) => i.id).join('|');
  if (box.dataset.key !== key) {
    box.dataset.key = key;
    box.textContent = '';
    for (const it of items) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'settings-opt';
      btn.dataset.value = it.id;
      btn.textContent = it.name;
      btn.addEventListener('click', () => {
        roomFilter = it.id;
        lastFeedAt = null;
        replayLog();
        tick();
        syncLogFilterOptions(rooms);
      });
      box.appendChild(btn);
    }
  }
  for (const btn of box.children) {
    btn.classList.toggle('is-active', btn.dataset.value === roomFilter);
  }
}

/* ---------------- 信息密度：紧凑 / 舒展 ----------------
   紧凑（默认）把全部内容塞进一屏；舒展放开 100vh 锁，卡片按内容撑高、页面整体滚动。
   选择存 localStorage，刷新后保持。
   切换后必须让拓扑重画：环形布局要读容器实际高度，高度变了不重算会歪。 */
const DENSITY_KEY = 'dsh-stage-density';

// 应用密度：入参 'compact' | 'comfort'，副作用是切 body 类名、重算拓扑与卡片网格。
function applyDensity(mode) {
  const m = mode === 'comfort' ? 'comfort' : 'compact';
  document.body.classList.toggle('density-comfort', m === 'comfort');
  try { localStorage.setItem(DENSITY_KEY, m); } catch { /* 隐私模式下写不进去，忽略 */ }
  for (const btn of document.querySelectorAll('#density-list .settings-opt')) {
    btn.classList.toggle('is-active', btn.dataset.value === m);
  }
  // 布局变了：缓存 key 清空，下一帧 tick 会按新尺寸重画拓扑
  ringKey = '';
  // 卡片网格必须等浏览器完成重排之后再算。
  // 原来在这里同步调 fitThoughtGrid：那时 .thoughts 的 clientWidth/clientHeight
  // 还是切换前的旧值，算出的列数按错误尺寸来，于是「从舒展切回紧凑」时
  // 管理员卡被推到单独一行（用户 2026-11-06 反馈），刷新后才正常。
  // 用两层：先清缓存，再在下一帧测一次；rAF 之后布局一定已更新。
  thoughts.dataset.count = '';
  const relayout = () => {
    thoughts.dataset.count = '';
    // 先把所有卡片的跨列重置，避免旧 span 影响这次测量
    for (const card of cards.values()) {
      card.el.style.gridColumn = '';
      card.el.style.gridRow = '';
      card.el.classList.remove('is-wide');
    }
    if (cards.size) fitThoughtGrid(cards.size);
    // 网格定了之后，管理员卡的跨列要重新挂上（renderThoughts 里的逻辑依赖 cols）
    if (cards.size) renderThoughts(botsCache || []);
  };
  requestAnimationFrame(() => requestAnimationFrame(relayout));
}

let densityMode = 'compact';
try { densityMode = localStorage.getItem(DENSITY_KEY) === 'comfort' ? 'comfort' : 'compact'; } catch { /* 同上 */ }
for (const btn of document.querySelectorAll('#density-list .settings-opt')) {
  btn.addEventListener('click', () => {
    densityMode = btn.dataset.value;
    applyDensity(densityMode);
  });
}
applyDensity(densityMode);

// 设置抽屉的开关
function openSettings(open) {
  const drawer = document.getElementById('settings-drawer');
  const mask = document.getElementById('settings-mask');
  if (!drawer || !mask) return;
  drawer.classList.toggle('is-open', open);
  drawer.setAttribute('aria-hidden', String(!open));
  mask.hidden = !open;
}
document.getElementById('settings-btn')?.addEventListener('click', () => openSettings(true));
document.getElementById('settings-close')?.addEventListener('click', () => openSettings(false));
document.getElementById('settings-mask')?.addEventListener('click', () => openSettings(false));
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') openSettings(false);
});

// 日志流的历史与筛选：日志是流式追加的，要支持"按群筛选"就得留住最近的一批，
// 筛选变化时清空重放（最多 90 条，和日志区上限一致）。
let feedHistory = [];
let roomFilter = 'all';          // 'all' | 'personal' | 群 id

function replayLog() {
  if (!logEl) return;
  logEl.textContent = '';
  const list = feedHistory.filter((it) => {
    if (roomFilter === 'all') return true;
    if (roomFilter === 'personal') return it.k !== 'room';
    return it.roomId === roomFilter;
  });
  for (const it of list.slice(-90)) pushFeed(it, nameOf);
}

// 群标的短名：群名太长会把日志挤成两三行，取掉"群/室"这类后缀并截到 6 字。
function roomShort(name) {
  const n = String(name || '群聊').replace(/\s+/g, '');
  const trimmed = n.replace(/(研发群|指挥室|聊天群|群聊)$/, '');
  const base = trimmed || n;
  return base.length > 6 ? `${base.slice(0, 6)}…` : base;
}

// 群标配色：常见两个群给固定色，其余按名字哈希从色板里取，保证同名同色。
const ROOM_TONES = ['#c084fc', '#38bdf8', '#fbbf24', '#34d399', '#f472b6', '#a3e635'];
function roomClass(name) {
  const n = String(name || '');
  if (n.includes('Bot 作战')) return 'roomtag-a';
  if (n.includes('Neura')) return 'roomtag-b';
  let h = 0;
  for (let i = 0; i < n.length; i += 1) h = (h * 31 + n.charCodeAt(i)) % ROOM_TONES.length;
  return `roomtag-x${h}`;
}

// 写一条流水事件：入参事件与名字表，副作用是落到右上流水区。
function pushFeed(item, nameOf) {
  const who = nameOf.get(item.bot) || '?';
  let kind = 'think';
  let label = '思考';
  let text = item.text || '';
  if (item.k === 'request') {
    kind = 'request'; label = '派活'; text = `${who} → ${nameOf.get(item.to) || '?'} · ${text}`;
  } else if (item.k === 'reply') {
    kind = 'reply'; label = '回执'; text = `${who} → ${nameOf.get(item.to) || '?'} · ${text}`;
  } else if (item.k === 'stopped') {
    kind = 'stopped'; label = '中断'; text = `${who} → ${nameOf.get(item.to) || '?'} · ${text}`;
  } else if (item.k === 'tool') {
    kind = 'tool'; label = '工具'; text = `${who} · ${item.tool || 'tool'} ${text}`;
  } else if (item.k === 'turn') {
    kind = 'turn'; label = '轮次'; text = `${who} · ${text}`;
  } else if (item.k === 'room') {
    // 群消息：群名单独占一列（下面的 roomtag），类型列统一写"群"，
    // 这样不筛选时也能一眼看出这条属于哪个群，而不是被压成一条竖字。
    kind = 'room'; label = '群'; text = `${who} · ${text}`;
  } else {
    text = `${who} · ${text}`;
  }
  pushLog(item.at, kind, label, text, item.k === 'room' ? item.room : null);
}

/* ---------------- 活跃度与告警 ---------------- */

// 画活跃度曲线：入参 { buckets, max }，副作用是重建面积、折线与标注。
let lastActivity = null;   // 最后一次活跃度数据
let actDrawnW = 0;         // 上次绘制时的容器宽
let actDrawnH = 0;         // 上次绘制时的容器高
function renderActivity(act) {
  if (!activityEl || !act || !Array.isArray(act.buckets)) return;
  lastActivity = act;                      // 供 ResizeObserver 立即重绘
  const W = Math.round(activityEl.clientWidth) || 396;
  const H = Math.round(activityEl.clientHeight) || 200;
  actDrawnW = W;
  actDrawnH = H;
  activityEl.setAttribute('width', W);
  activityEl.setAttribute('height', H);
  const padX = 8;
  const top = 14;
  // 底部留白从 24 提到 30：加了标题行后绘图区变矮，底部「均值/现在」会贴着边框
  const axisH = 30;
  const bottom = H - axisH;

  activityEl.setAttribute('viewBox', `0 0 ${W} ${H}`);
  activityEl.textContent = '';

  const data = act.buckets;
  const max = Math.max(1, act.max || 1);
  const step = (W - padX * 2) / Math.max(1, data.length - 1);
  const points = data.map((v, i) => [padX + i * step, bottom - (v / max) * (bottom - top)]);

  const area = `M ${points[0][0]} ${bottom} `
    + points.map(([x, y]) => `L ${x} ${y}`).join(' ')
    + ` L ${points[points.length - 1][0]} ${bottom} Z`;
  activityEl.appendChild(svgEl('path', { d: area, class: 'act-area' }));
  const line = points.map(([x, y], i) => `${i === 0 ? 'M' : 'L'} ${x} ${y}`).join(' ');
  activityEl.appendChild(svgEl('path', { d: line, class: 'act-line' }));
  activityEl.appendChild(svgEl('line', { x1: padX, y1: bottom, x2: W - padX, y2: bottom, class: 'act-base' }));

  const peak = Math.max(...data);
  const peakIdx = data.indexOf(peak);
  if (peak > 0) {
    const px = points[peakIdx][0];
    const py = points[peakIdx][1];
    activityEl.appendChild(svgEl('circle', { cx: px, cy: py, r: 7, class: 'act-halo' }));
    activityEl.appendChild(svgEl('circle', { cx: px, cy: py, r: 3.2, class: 'act-peak' }));
  }

  // 当前值与峰值移到标题行，图内不再放文字，避免右端互相压住
  const nowVal = data[data.length - 1] || 0;
  const nowText = document.getElementById('act-now-text');
  if (nowText) nowText.textContent = `当前 ${nowVal}/分 · 峰 ${peak}`;

  const avg = data.length ? Math.round(data.reduce((a, b) => a + b, 0) / data.length) : 0;
  const avgText = svgEl('text', { x: padX, y: H - 8, class: 'act-avg', 'text-anchor': 'start' });
  avgText.textContent = `均值 ${avg}/分 · 合计 ${act.total}`;
  activityEl.appendChild(avgText);

  const endLabel = svgEl('text', { x: W - padX, y: H - 8, class: 'act-axis', 'text-anchor': 'end' });
  endLabel.textContent = '现在';
  activityEl.appendChild(endLabel);
}

// 相对时间：监控大屏上「3 分钟前」比「17:41」更好读，也更省宽度
function relTime(ms) {
  if (!Number.isFinite(ms)) return '';
  const d = Date.now() - ms;
  if (d < 60_000) return '刚刚';
  if (d < 3_600_000) return `${Math.floor(d / 60_000)} 分钟前`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)} 小时前`;
  return `${Math.floor(d / 86_400_000)} 天前`;
}

// 已点过确认的行：大屏有定时轮询，重渲染会把行内反馈冲掉，
// 用这个集合让「变灰 + 确认✓」保持到该条真正从数据里消失为止。
const confirmedRows = new Set();

// 确认任务：写本看板自己的已确认名单，然后刷新（确认完即从列表消失）。
async function confirmTask(id, row) {
  // 立即把该行从 DOM 移除：大屏有定时轮询，任何依赖动画/延迟的反馈都会被重渲染冲掉，
  // 直接移除是唯一稳定、能让用户立刻确认「点到了」的方式。
  // 万一 POST 失败，下一次轮询会把这条重新渲染出来，不会真的丢掉。
  if (row && row.parentNode) row.parentNode.removeChild(row);
  try {
    const res = await fetch('/bot-stage/api/tasks/confirm', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id }),
    });
    const json = await res.json();
    if (!json || !json.ok) {
      await tick();
      return;
    }
    // 延迟 1.6 秒才重渲染：面板只显示 3 行，立刻刷新会让第 4 条马上补位，
    // 看起来像"点了没反应"。留出这个空窗，用户能明确看到少了一行。
    setTimeout(() => { tick(); }, 1600);
  } catch {
    /* 网络异常：下一轮轮询会把它刷回来 */
  }
}

// 任务流转：团队内部的派发与回执流水，用户旁观，只读不可操作。
// 处理中的排最前（正在发生的最值得看），其余按最近回执时间倒序。
const taskFlowEl = document.getElementById('taskflow');

function renderTaskFlow(tasks) {
  if (!taskFlowEl) return;
  const subEl = document.getElementById('taskflow-sub');
  const list = [...(tasks || [])].sort((a, b) => {
    const aw = a.state === 'working' ? 0 : 1;
    const bw = b.state === 'working' ? 0 : 1;
    if (aw !== bw) return aw - bw;
    return (b.ackedAt || b.dispatchedAt) - (a.ackedAt || a.dispatchedAt);
  });
  if (subEl) {
    // 用户要求空态不要「全部完成」：没有任务时副标题留空，减少噪音
    subEl.textContent = list.length ? `${list.length} 条进行中` : '';
  }
  // 没有任务时，让上面的「活跃度」占满整块高度（用户要求）
  // 任务流转现在挂在右上（.right-stack），无任务时收起它、把空间让给日志流
  const rightStack = document.querySelector('.right-stack');
  if (rightStack) rightStack.classList.toggle('no-tasks', list.length === 0);
  taskFlowEl.textContent = '';
  if (!list.length) {
    const empty = document.createElement('div');
    empty.className = 'task-empty';
    empty.textContent = '暂无进行中的任务';
    taskFlowEl.appendChild(empty);
    return;
  }
  for (const t of list.slice(0, 3)) {
    const done = t.state === 'done';   // 刚回执：绿色标记，几秒后从列表消失
    const row = document.createElement('div');
    row.className = 'task-row' + (done ? ' is-done' : '');

    const dot = document.createElement('i');
    dot.className = 'task-dot';

    const titleEl = document.createElement('span');
    titleEl.className = 'task-title';
    titleEl.textContent = t.title;
    titleEl.title = t.title;      // 截断后靠 hover 看全文

    const toEl = document.createElement('span');
    toEl.className = 'task-to';
    // 有回执时显示「谁回的」，比只显示「派给谁」更有信息量
    if (done && t.acker) {
      // 回执人就是被派对象时不重复写名字
      toEl.textContent = t.acker === t.to ? `${t.to} 已回执` : `${t.to} → ${t.acker} 已回执`;
    } else {
      toEl.textContent = t.to;
    }

    const chip = document.createElement('span');
    chip.className = 'task-chip' + (done ? ' is-done' : '');
    chip.textContent = done ? '已回执' : '处理中';

    row.append(dot, titleEl, toEl, chip);
    taskFlowEl.appendChild(row);
  }
}

// 画告警条：入参 bots，副作用是列出需要用户处理的情况。
// 告警忽略记录：key → 到期时间戳。读写失败一律当没忽略，不影响主流程。
const ALERT_MUTE_KEY = 'dsh-alerts-muted';
const ALERT_MUTE_TTL = 24 * 60 * 60 * 1000;

function loadMuted() {
  try {
    const raw = localStorage.getItem(ALERT_MUTE_KEY);
    const obj = raw ? JSON.parse(raw) : {};
    const now = Date.now();
    let changed = false;
    for (const k of Object.keys(obj)) {
      if (!(obj[k] > now)) { delete obj[k]; changed = true; }
    }
    if (changed) localStorage.setItem(ALERT_MUTE_KEY, JSON.stringify(obj));
    return obj;
  } catch {
    return {};
  }
}

function muteAlert(key) {
  try {
    const obj = loadMuted();
    obj[key] = Date.now() + ALERT_MUTE_TTL;
    localStorage.setItem(ALERT_MUTE_KEY, JSON.stringify(obj));
  } catch {
    /* 存不进去就只是这次不生效 */
  }
}

function renderAlerts(bots, tasks) {
  if (!alertsEl) return;
  const now = Date.now();
  const items = [];

  // 「需要你处理」只管真正需要用户介入的事：运行失败、排队、疑似卡住。
  // 任务流转已独立成块，不在这里。

  // 失败与重试：只显示最近 30 分钟内的，按时间倒序
  const fails = [];
  for (const b of bots) {
    const st = b.stats || {};
    const list = st.failures || [];
    for (const f of list) {
      if (!Number.isFinite(f.at)) continue;
      if (now - f.at > 24 * 60 * 60 * 1000) continue;
      fails.push({ at: f.at, bot: b.name, code: f.code, message: f.message });
    }
  }
  fails.sort((a, b) => b.at - a.at);
  // 运行异常折叠成一条汇总：原来逐条最多占 5 格，会把任务列表整个挤出去
  if (fails.length) {
    const f = fails[0];
    items.push({
      tone: 'bad',
      key: `fail:${f.code}`,
      at: f.at,          // 用最新一条失败的时间参与排序
      text: `运行失败 ${fails.length} 条 · 最新 ${f.bot} ${f.code} · ${relTime(f.at)}`
    });
  }

  // 排队的是「要送进某个成员的消息」，方向是 → 成员，不是「成员在排队」。
  // 原来写成「排队 1 条：大管家」会被读反（以为大管家在等别人）。
  const queued = bots.filter((b) => (b.queued || 0) > 0);
  if (queued.length) {
    const total = queued.reduce((s, b) => s + (b.queued || 0), 0);
    const names = queued.map((b) => b.name).join('、');
    items.push({
      tone: 'warn',
      key: 'queue',
      at: now,
      text: `排队 ${total} 条 · 等待 ${names} 处理`
    });
  }

  const stuck = bots.filter((b) => {
    const at = b.activity && b.activity.lastAt;
    return b.working && at && now - at > 10 * 60 * 1000;
  });
  if (stuck.length) {
    const oldest = Math.min(...stuck.map((b) => b.activity.lastAt));
    items.push({
      tone: 'bad',
      key: 'stuck',
      at: oldest,
      text: `疑似卡住：${stuck.map((b) => `${b.name}（${Math.round((now - b.activity.lastAt) / 60000)} 分钟无动作）`).join('、')}`
    });
  }

  const busy = bots.filter((b) => b.working).length;
  if (!items.length) {
    items.push({ tone: 'ok', text: busy ? `${busy} 个成员在干活，暂无待处理` : '全部空闲，暂无待处理' });
  }

  // 被用户忽略的告警：localStorage 里存 { key: 到期时间戳 }，24 小时后自动恢复提示。
  // 不设成永久，否则同类问题真复发了也看不到。
  const muted = loadMuted();
  const mutedCount = items.filter((it) => it.key && muted[it.key]).length;
  const shown = items.filter((it) => !(it.key && muted[it.key]));

  const sub = document.getElementById('alerts-sub');
  if (sub) {
    if (!fails.length) sub.textContent = '暂无告警';
    else if (mutedCount) sub.textContent = `24h ${fails.length} 条失败 · ${mutedCount} 条已忽略`;
    else sub.textContent = `24h ${fails.length} 条失败`;
  }

  // 全被忽略时不再补任何占位条——用户要的是"点完直接消失"。
  // 只有本来就没告警（items 里只有那条空态）时才显示空态。

  // 最新的排最上面（用户要求）：按时间倒序，没有时间的排后面
  shown.sort((a, b) => (b.at || 0) - (a.at || 0));

  alertsEl.textContent = '';
  items.length = 0;
  items.push(...shown);
  for (const item of items) {
    const row = document.createElement('div');
    row.className = `alert ${item.tone}`;
    const dot = document.createElement('i');
    dot.className = 'alert-dot';
    row.append(dot);

    if (item.taskId) {
      // 任务条：第一行标题（超长省略、title 挂全文），第二行派给谁 + 相对时间
      const body = document.createElement('div');
      body.className = 'task-body';
      const titleEl = document.createElement('span');
      titleEl.className = 'task-title';
      titleEl.textContent = item.title;
      titleEl.title = item.title;
      const subEl = document.createElement('span');
      subEl.className = 'task-sub';
      subEl.textContent = item.sub;
      body.append(titleEl, subEl);
      row.append(body);

      row.classList.add('alert-task');
      // 只读状态徽标：任务流转是给我自己消费的流水，不需要用户操作
      const badge = document.createElement('em');
      badge.className = `alert-tick${item.running ? ' is-running' : ' is-acked'}`;
      badge.textContent = item.badge;
      row.append(badge);
    } else {
      const text = document.createElement('span');
      text.className = 'alert-text';
      text.textContent = item.text;
      row.append(text);

      // 只有错误类（失败 / 卡住）才能忽略；排队这种警告不给叉号——
      // 它是"有消息在等"，本身就有时效，不该被静音掉。
      if (item.key && item.tone === 'bad') {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'alert-mute';
        btn.title = '忽略这条（24 小时内不再提示）';
        btn.setAttribute('aria-label', '忽略这条告警');
        btn.textContent = '×';
        btn.addEventListener('click', (ev) => {
          ev.stopPropagation();
          muteAlert(item.key);
          renderAlerts(bots, tasks);
        });
        row.append(btn);
      }
    }
    alertsEl.appendChild(row);
  }
}

// 页面不可见时暂停连线循环（常驻大屏挂一整天，切后台不再耗 CPU）
document.addEventListener('visibilitychange', () => {
  document.documentElement.toggleAttribute('data-doc-hidden', document.hidden);
});

/* ---------------- 成员状态 ---------------- */

const mstatEl = document.getElementById('mstat');

// 渲染成员状态：入参 bots，副作用是写「运行中 / 空闲 / 等候」与最近活跃成员。
// 取舍依据：最近 5 分钟活跃人数与「运行中」实测完全重合，删掉；轮次已在「全队合计」里，不重复。
function renderMembers(bots) {
  if (!mstatEl) return;
  const total = bots.length;
  const working = bots.filter((b) => b.working).length;
  // 三个数字必须都按「Bot 个数」计，否则加不到总数上：
  // 原来 queued 是「排队消息条数」之和，会出现 1 运行 + 10 空闲 = 11，再冒出 3 等候 = 14 的矛盾。
  // 等候中 = 没在跑、但有消息排队的 Bot 数；空闲 = 剩下的。
  const queued = bots.filter((b) => !b.working && (b.queued || 0) > 0).length;
  const idle = total - working - queued;
  const now = Date.now();

  // 最近动过的「空闲」成员：用来化解「空闲 = 没干活」的误解；都闲着时取全员最近一条
  let latest = null;
  for (const b of bots) {
    const at = b.activity && b.activity.lastAt;
    if (!at || b.working) continue;
    if (!latest || at > latest.at) latest = { name: b.name, at };
  }
  if (!latest) {
    for (const b of bots) {
      const at = b.activity && b.activity.lastAt;
      if (!at) continue;
      if (!latest || at > latest.at) latest = { name: b.name, at };
    }
  }

  if (!mstatEl.dataset.ready) {
    mstatEl.dataset.ready = '1';
    mstatEl.innerHTML = '<div class="mstat-row">'
      + '<div class="mstat-cell"><span class="v" id="ms-total"></span><span class="k">总数</span></div>'
      + '<div class="mstat-cell"><span class="v run" id="ms-working"></span><span class="k">运行中</span></div>'
      + '<div class="mstat-cell"><span class="v idle" id="ms-idle"></span><span class="k">空闲</span></div>'
      + '<div class="mstat-cell" id="ms-queue-cell"><span class="v wait" id="ms-queued"></span><span class="k">等候中</span></div>'
      + '</div>';
  }

  mstatEl.querySelector('#ms-total').textContent = String(total);
  mstatEl.querySelector('#ms-working').textContent = String(working);
  mstatEl.querySelector('#ms-idle').textContent = String(idle);
  mstatEl.querySelector('#ms-queued').textContent = String(queued);
  // 队列结构性稀疏：为 0 时整格隐藏，不占一个永远不动的数字位
  const queueCell = mstatEl.querySelector('#ms-queue-cell');
  queueCell.style.display = queued > 0 ? '' : 'none';
  const row = mstatEl.querySelector('.mstat-row');
  if (row) row.classList.toggle('is-four', queued > 0);

  const sub = document.getElementById('ms-sub');
  if (sub) {
    if (latest) {
      const mins = Math.max(0, Math.round((now - latest.at) / 60000));
      sub.textContent = `最近活跃 ${latest.name} · ${mins < 1 ? '刚刚' : `${mins} 分钟前`}`;
    } else {
      sub.textContent = '暂无活动记录';
    }
  }
}

/* ---------------- ③ 思考卡 ---------------- */

// 模型名缩写：入参原始 model 串，返回卡片头可显示的短名（完整串放 title）。
function shortModel(model) {
  if (!model) return '';
  const tail = String(model).split('/').pop().split(':').pop();
  const parts = tail.split('-').filter(Boolean);
  const version = parts.find((p) => /^v?\d+(\.\d+)?/i.test(p)) || '';
  const vendor = parts[0] && parts[0] !== version ? parts[0] : '';
  const label = [vendor, version].filter(Boolean).join(' ');
  const short = label || parts.slice(0, 2).join('-') || tail;
  const VENDOR = {
    deepseek: 'DeepSeek', kimi: 'Kimi', qwen: 'Qwen', glm: 'GLM', gpt: 'GPT',
    claude: 'Claude', gemini: 'Gemini', llama: 'Llama', doubao: 'Doubao',
    zhipu: 'Zhipu', moonshot: 'Moonshot', minimax: 'MiniMax'
  };
  const head = short.split(' ')[0].toLowerCase();
  if (VENDOR[head]) return short.replace(/^\S+/, VENDOR[head]);
  return short.charAt(0).toUpperCase() + short.slice(1);
}

// 生成卡片描边用的圆角矩形 path：入参宽高，返回 SVG 路径 d。
function ringPathFor(w, h, r = 8, inset = 1.2) {
  const x = inset;
  const y = inset;
  const W = Math.max(1, w - inset * 2);
  const H = Math.max(1, h - inset * 2);
  const rr = Math.min(r, W / 2, H / 2);
  return `M ${x + rr} ${y} H ${x + W - rr} A ${rr} ${rr} 0 0 1 ${x + W} ${y + rr}`
    + ` V ${y + H - rr} A ${rr} ${rr} 0 0 1 ${x + W - rr} ${y + H}`
    + ` H ${x + rr} A ${rr} ${rr} 0 0 1 ${x} ${y + H - rr}`
    + ` V ${y + rr} A ${rr} ${rr} 0 0 1 ${x + rr} ${y} Z`;
}

// 把卡片尺寸写进环形路径：入参加载好的卡片元素，副作用是设置 viewBox 与 d。
function paintRing(el) {
  const svg = el.querySelector('.thought-ring');
  if (!svg) return;
  const w = el.clientWidth;
  const h = el.clientHeight;
  if (!w || !h) return;
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  const d = ringPathFor(w, h);
  for (const path of svg.querySelectorAll('path')) {
    if (path.getAttribute('d') !== d) path.setAttribute('d', d);
  }
}

// 按成员数与屏幕尺寸算每行几张：入参数量，副作用是设置网格列数与行数。
function fitThoughtGrid(count) {
  if (!count) return;
  const W = thoughts.clientWidth;
  const H = thoughts.clientHeight;
  const gap = 10;                       /* 与 stage.css 的 .thoughts gap 保持一致 */
  const availW = Math.max(200, W - 20);
  const availH = Math.max(120, H - 20);

  let best = null;
  for (let cols = 2; cols <= 7; cols += 1) {
    const rows = Math.ceil(count / cols);
    const cw = (availW - gap * (cols - 1)) / cols;
    const ch = (availH - gap * (rows - 1)) / rows;
    if (cw < 190 || ch < 112) continue;
    const empty = cols * rows - count;
    const score = Math.min(cw / 1.55, ch) - empty * 26;
    if (!best || score > best.score) best = { cols, rows, score, empty };
  }
  if (!best) best = { cols: 2, rows: Math.ceil(count / 2), empty: 0 };

  thoughts.style.gridTemplateColumns = `repeat(${best.cols}, minmax(0, 1fr))`;
  thoughts.style.gridTemplateRows = `repeat(${best.rows}, minmax(0, 1fr))`;
  thoughts.dataset.cols = String(best.cols);
  thoughts.dataset.count = String(count);
  thoughts.dataset.spanLast = best.empty > 0 ? String(best.empty + 1) : '0';
}

// 增量更新正文：入参卡片，副作用是只替换变了的文字节点。
// —— 原来 renderBody 每帧都 textContent='' 再重建 span，而 updateCard 每个轮询都调它，
//    等于每秒把正文删掉重建 3 次：文字闪、光标每帧重插、滚动位置每帧被重置。
//    用户看到的就是「回执完了卡片先消失再冒出来」。
// 这里改成：文本没变就什么都不碰；变了只改 span 的 textContent，节点本身留着。
function paintBody(card) {
  const full = card.fullText || '';
  const text = full.slice(0, card.shown);
  let span = card.body.querySelector(':scope > .think-text');
  let caret = card.body.querySelector(':scope > .caret');

  if (!text) {
    if (span) span.remove();
    if (caret) caret.remove();
    card.body.classList.add('is-empty');
    return;
  }
  card.body.classList.remove('is-empty');

  if (!span) {
    span = document.createElement('span');
    span.className = 'think-text';
    // 新插入的 span 放在最前，caret 永远在末尾
    card.body.insertBefore(span, card.body.firstChild);
  }
  // 只在内容真的变了时才写文字，避免无谓的重排
  if (span.textContent !== text) span.textContent = text;

  const wantCaret = Boolean(card.typing || card.working);
  if (wantCaret && !caret) {
    caret = document.createElement('span');
    caret.className = 'caret';
    card.body.appendChild(caret);
  } else if (!wantCaret && caret) {
    caret.remove();
  }

  // 滚动位置：打字中跟到底部；写完回顶部一次（用户手动滚过就不再打扰）
  if (card.typing || card.working) {
    card.body.scrollTop = Math.max(0, card.body.scrollHeight - card.body.clientHeight);
  } else if (!card.userScrolled && card.body.scrollTop !== 0) {
    card.body.scrollTop = 0;
  }
}

// 打字机：入参卡片，副作用是按帧把待显示的文本补出来。
function typeOn(card) {
  if (card.typing) return;
  card.typing = true;
  const step = () => {
    const full = card.fullText || '';
    if (card.shown >= full.length) {
      card.typing = false;
      paintBody(card);
      return;
    }
    card.shown = Math.min(full.length, card.shown + 4);
    paintBody(card);
    card.raf = requestAnimationFrame(step);
  };
  cancelAnimationFrame(card.raf);
  card.raf = requestAnimationFrame(step);
}

// 更新一张思考卡：入参卡片与 bot，副作用是写标题、状态、正文。
function updateCard(card, bot) {
  const act = bot.activity || {};
  const working = Boolean(bot.working) || (demoPreview && bot.id === demoBotId);
  card.el.style.setProperty('--tone', colorOf(bot.color));
  card.el.classList.toggle('is-working', working);
  card.statusText.textContent = working ? '思考中' : '空闲';

  // 紧凑格式：轮次 · 工具 · 已跑时长 · 谁触发，保证关键信息不被省略掉
  const turn = Number.isFinite(act.turn) ? `${act.turn}轮` : '';
  const tool = act.tool && act.tool.name ? act.tool.name : '';
  const parts = [turn, tool].filter(Boolean);
  if (working && bot.workingSince) {
    parts.push(fmtDur(Date.now() - bot.workingSince));
  }
  const recv = bot.received;
  if (recv && recv.from && nameOf.get(recv.from) && Date.now() - recv.at < 30 * 60 * 1000) {
    parts.push(`←${nameOf.get(recv.from)}`);
  }
  card.meta.textContent = parts.join(' · ');

  // 本轮工具链：最近 4 次调用用箭头串起来，空白时给一句中性说明
  const recentTools = (act.recent || []).slice(-6).map((r) => r.name);
  const grouped = [];
  for (const name of recentTools) {
    const last = grouped[grouped.length - 1];
    if (last && last.name === name) last.count += 1;
    else grouped.push({ name, count: 1 });
  }
  card.tools.textContent = grouped.length
    ? grouped.map((g) => (g.count > 1 ? `${g.name} ×${g.count}` : g.name)).join(' → ')
    : '尚无工具调用';
  card.time.textContent = act.lastAt ? hms(act.lastAt) : '';

  const text = act.thinking || act.said || '';
  card.working = Boolean(bot.working);
  if (text !== card.fullText) {
    const old = card.fullText || '';
    let i = 0;
    while (i < old.length && i < text.length && old[i] === text[i]) i += 1;
    card.fullText = text;
    card.shown = Math.min(i, text.length);
    if (!text) {
      paintBody(card);          // 内部会清掉 span 并挂上 is-empty
    } else {
      card.body.classList.remove('is-empty');
      typeOn(card);
    }
  } else {
    // 文本没变：只校正光标/滚动，不重建 DOM（这是闪烁的根源）
    paintBody(card);
  }
}

// 标题栏色段带：入参 bots，副作用是重建 #think-lights 里的色段。
// 每个正在干活的成员占一段，用该成员的成员色；空闲成员不出段。
// 段按 memberOrder 固定排序（不按干活先后），位置稳定不跳动。
let lightsKey = '';
function renderThinkLights(bots) {
  const box = document.getElementById('think-lights');
  if (!box) return;
  const working = bots.filter((b) => b.working);
  // 只有"哪些人在跑"变了才重建 DOM，否则每帧重排会白白消耗
  const key = working.map((b) => b.id).sort().join(',');
  if (key !== lightsKey) {
    lightsKey = key;
    box.textContent = '';
    working.forEach((b, i) => {
      const seg = document.createElement('span');
      seg.className = 'seg';
      seg.style.setProperty('--seg-tone', colorOf(b.color));
      seg.style.setProperty('--seg-delay', `${(i * 0.18).toFixed(2)}s`);
      seg.dataset.bot = b.name;
      box.appendChild(seg);
    });
  }
  // 有没人干活决定白光要不要出现（CSS 里靠这个类控制）
  box.classList.toggle('is-live', working.length > 0);
  box.title = working.length
    ? `在跑：${working.map((b) => b.name).join('、')}`
    : '全部空闲';
}

// 渲染思考区：入参 bots，副作用是建卡、排版并更新内容。
function renderThoughts(bots) {
  if (Number(thoughts.dataset.count) !== bots.length) fitThoughtGrid(bots.length);

  // 卡片是增量渲染的：切换视角后，不在当前视角里的成员必须删掉，
  // 否则从"Bot 作战指挥室"切到"全队"时，卡片数量不会跟着变。
  const keep = new Set(bots.map((b) => b.id));
  for (const [id, card] of cards) {
    if (!keep.has(id)) {
      card.el.remove();
      cards.delete(id);
    }
  }

  // 管理员/调度员永远排第一张：它是核心节点，混在成员里要看半天才找得到。
  const orderList = bots.slice().sort((a, b) => {
    if (a.id === mainId) return -1;
    if (b.id === mainId) return 1;
    return 0;
  });

  // 思考区标题的副标：让「成员思考」这块一眼知道规模和当前状态
  const thinkSub = document.getElementById('think-sub');
  if (thinkSub) {
    const busy = bots.filter((b) => b.working).length;
    thinkSub.textContent = `${bots.length} 人 · ${busy ? `${busy} 人在思考` : '全部空闲'}`;
  }

  // 标题栏色段带：谁在干活，就亮哪一段，用他自己的成员色。
  // 段序按成员固定顺序，所以段的位置稳定，不会因为某人跑完就整体抖动。
  renderThinkLights(bots);

  orderList.forEach((bot, index) => {
    let card = cards.get(bot.id);
    if (!card) {
      const el = document.createElement('article');
      el.className = bot.id === mainId ? 'thought is-admin' : 'thought';
      el.style.animationDelay = `${index * 45}ms`;

      const head = document.createElement('div');
      head.className = 'thought-head';
      const dot = document.createElement('i');
      dot.className = 'head-dot';
      const title = document.createElement('span');
      title.className = 'title';
      title.textContent = bot.name;
      const role = document.createElement('span');
      role.className = 'role';
      // 用户要求：这里显示完整的模型 id（配置里那个），不要缩写名
      role.textContent = bot.model || bot.role || '成员';
      role.title = `${bot.role || '成员'} · ${bot.model || '未知模型'}`;
      const status = document.createElement('span');
      status.className = 'status';
      const statusText = document.createElement('span');
      const dots = document.createElement('span');
      dots.className = 'think-dots';
      for (let k = 0; k < 3; k += 1) dots.appendChild(document.createElement('i'));
      status.append(statusText, dots);
      head.append(dot, title, role, status);

      const meta = document.createElement('div');
      meta.className = 'thought-meta';
      const metaText = document.createElement('span');
      const time = document.createElement('span');
      time.className = 'thought-time';
      meta.append(metaText, time);

      const body = document.createElement('pre');
      body.className = 'thought-body';

      const tools = document.createElement('div');
      tools.className = 'thought-tools';

      el.append(head, meta, body, tools);
      thoughts.appendChild(el);
      card = {
        el, statusText, meta: metaText, body, tools, time,
        fullText: '', shown: 0, typing: false, working: false, raf: 0,
        // 用户手动滚过这张卡的正文就记下来，之后不再自动跳回顶部／底部
        userScrolled: false
      };
      // 手动滚动会被渲染循环重置，这里打标记豁免
      body.addEventListener('wheel', () => { card.userScrolled = true; }, { passive: true });
      body.addEventListener('touchmove', () => { card.userScrolled = true; }, { passive: true });
      cards.set(bot.id, card);
    }
    updateCard(card, bot);
    // 用 grid order 让管理员卡排第一，不用挪 DOM（挪了会打断逐字动画）
    card.el.style.order = bot.id === mainId ? '-1' : '';
    card.el.classList.toggle('is-admin', bot.id === mainId);

    // 左上角斜角标：卡片是增量创建的，所以每次渲染按当前 mainId 现挂/现摘
    const hasRibbon = card.el.querySelector('.admin-ribbon');
    if (bot.id === mainId && !hasRibbon) {
      const ribbon = document.createElement('span');
      ribbon.className = 'admin-ribbon';
      ribbon.textContent = 'ADMIN';
      card.el.appendChild(ribbon);
    } else if (bot.id !== mainId && hasRibbon) {
      hasRibbon.remove();
    }
  });

  const list = bots.map((b) => cards.get(b.id)).filter(Boolean);
  const span = Number(thoughts.dataset.spanLast) || 0;
  for (const card of list) card.el.style.gridColumn = '';

  // 末行空槽以前交给「最后一张卡」跨列填满。但最后一张不一定是普通成员：
  // 全队视角下恰好是「Bot 作战指挥室调度员」，于是一个管理员被拉成
  // 3 列宽、220px 高的大块，看起来像它不是普通一员（用户 2026-11-05 反馈）。
  // 改成：只有视角管理员跨列（下面统一处理），其余一律单格，
  // 末行空槽就空着——多出来的那一格是留白，比一张特殊大的卡更不抢眼。
  void span;

  // 管理员卡按两列宽排：它的正文是调度结论，比成员的短句长，
  // 只占一格时会变成又窄又高的一条，把整行网格的行高顶起来。
  // 跨两列后它依然排第一个（order:-1），其余成员照常单格。
  // 跨列必须显式指定起始列：管理员卡带 order:-1，光写 span 2 会被
  // 自动放置逻辑排到后面的空槽，看起来完全没跨（实测过）。
  // 除了视角管理员，各群自己的管理员（群调度员）也按两列排——它们同样在
  // 调度、正文同样长，只看视角管理员的话，全队视角下那几张还是窄长条。
  const cols = Number(thoughts.dataset.cols) || 1;
  for (const card of list) card.el.classList.remove('is-wide');
  // 跨两列的只有「当前视角的管理员」：
  //   全部视角 → 大管家一张；切到某个群 → 只有该群管理员一张。
  // 不是把所有群的管理员都放宽，那样全队视角下会横着三张宽卡，反而乱。
  const wideIds = new Set([mainId]);
  for (const id of wideIds) {
    const card = cards.get(id);
    if (!card) continue;
    const isMain = id === mainId;
    card.el.classList.toggle('is-wide', cols >= 2);
    if (cols < 2) {
      card.el.style.gridColumn = '';
      card.el.style.gridRow = '';
      continue;
    }
    if (isMain) {
      card.el.style.gridColumn = '1 / span 2';
      card.el.style.gridRow = '1';
    } else {
      // 非中心的管理员让自动放置处理，宽度请求两列即可
      card.el.style.gridRow = '';
      card.el.style.gridColumn = 'span 2';
    }
  }
}

/* ---------------- 工具画像 ---------------- */

const TOOL_GROUPS = [
  { match: (n) => n === 'read' || n === 'read_image', color: '#6ea8fe' },
  { match: (n) => n === 'bash', color: '#3ddc97' },
  { match: (n) => n === 'edit' || n === 'write' || n === 'update_bot', color: '#ffb547' },
  { match: (n) => n === 'grep' || n === 'glob', color: '#a78bfa' },
  { match: () => true, color: '#64748b' }
];

// 渲染工具画像：入参 bots，副作用是每人一行堆叠微条（按调用次数）。
function renderProfile(bots) {
  const el = document.getElementById('profile');
  if (!el) return;
  const rows = bots
    .map((b) => {
      const counts = (b.stats && b.stats.toolCounts) || {};
      const groups = TOOL_GROUPS.map(() => 0);
      let total = 0;
      for (const [name, n] of Object.entries(counts)) {
        const idx = TOOL_GROUPS.findIndex((g) => g.match(name));
        groups[idx < 0 ? TOOL_GROUPS.length - 1 : idx] += n;
        total += n;
      }
      return { bot: b, groups, total };
    })
    .sort((a, b) => b.total - a.total);

  el.textContent = '';
  for (const { bot, groups, total } of rows) {
    const row = document.createElement('div');
    row.className = 'pf-row';

    const name = document.createElement('span');
    name.className = 'pf-name';
    name.textContent = bot.name;

    const bar = document.createElement('div');
    bar.className = 'pf-bar';
    if (total > 0) {
      groups.forEach((n, i) => {
        if (!n) return;
        const seg = document.createElement('i');
        seg.className = 'pf-seg';
        seg.style.width = `${(n / total) * 100}%`;
        seg.style.background = TOOL_GROUPS[i].color;
        seg.title = `${TOOL_GROUPS[i].color} ${n} 次`;
        bar.appendChild(seg);
      });
    }

    const sum = document.createElement('span');
    sum.className = 'pf-total';
    sum.textContent = total ? String(total) : '—';

    row.append(name, bar, sum);
    el.appendChild(row);
  }
}

/* ---------------- ④ 统计 ---------------- */

// 按输出量渲染横向条形榜：入参 bots，副作用是建行、排序并更新长度。
function renderStats(bots) {
  const rows = bots.slice().sort((a, b) => {
    const ao = (a.stats && a.stats.outTokens) || 0;
    const bo = (b.stats && b.stats.outTokens) || 0;
    return bo - ao;
  });
  const maxOut = Math.max(1, ...rows.map((b) => (b.stats && b.stats.outTokens) || 0));

  const orderKey = rows.map((b) => b.id).join('|');
  const needReorder = orderKey !== barOrderKey;
  barOrderKey = orderKey;

  for (const bot of rows) {
    let row = statCells.get(bot.id);
    if (!row) {
      const el = document.createElement('div');
      el.className = 'bar-row';

      const name = document.createElement('span');
      name.className = 'bar-name';
      name.textContent = bot.name;

      const track = document.createElement('div');
      track.className = 'bar-track';
      const fill = document.createElement('i');
      fill.className = 'bar-fill';
      track.appendChild(fill);

      const pct = document.createElement('span');
      pct.className = 'bar-pct';

      const out = document.createElement('span');
      out.className = 'bar-out';

      const meta = document.createElement('span');
      meta.className = 'bar-meta';

      el.append(name, track, pct, out, meta);
      statsEl.appendChild(el);
      row = { el, fill, pct, out, meta };
      statCells.set(bot.id, row);
    }

    const st = bot.stats || {};
    const ratio = Math.min(1, ((st.outTokens || 0) / maxOut));
    row.el.style.setProperty('--tone', colorOf(bot.color));
    row.fill.style.width = `${Math.max(1.5, ratio * 100)}%`;
    row.fill.style.opacity = ratio >= 0.999 ? '1' : '0.85';
    row.pct.textContent = `${(ratio * 100).toFixed(1)}%`;
    row.out.textContent = `${fmt(st.outTokens)}`;
    row.meta.textContent = `入 ${fmt(st.inTokens)} · 缓存 ${fmt(st.cacheTokens)}`;
    row.el.title = `${bot.name}\n`
      + `轮次 ${st.turns || 0} 轮，工具调用 ${st.tools || 0} 次\n`
      + `输出 ${fmt(st.outTokens)} token（自己生成的文字量）\n`
      + `输入 ${fmt(st.inTokens)} token（每次带进去的上下文合计）\n`
      + `缓存 ${fmt(st.cacheTokens)} token（上下文复用，不代表实际消耗）`;
    if (needReorder) statsEl.appendChild(row.el);
  }

  renderTotals(bots);
}

// 建一位数字列：入参目标数字，返回可上下滚动的列元素。
function makeDigit(digit) {
  const col = document.createElement('span');
  col.className = 'odo-digit';
  const strip = document.createElement('span');
  strip.className = 'odo-strip';
  for (let i = 0; i < 10; i += 1) {
    const n = document.createElement('span');
    n.textContent = String(i);
    strip.appendChild(n);
  }
  strip.style.transform = `translateY(calc(var(--h) * -${digit}))`;
  col.dataset.d = String(digit);
  col.appendChild(strip);
  return col;
}

// 建一个占位槽：宽度与数字位一致但不可见，用来固定整体宽度。
function makeGap() {
  const gap = document.createElement('span');
  gap.className = 'odo-gap';
  gap.textContent = '0';
  return gap;
}

// 数字滚动：入参容器、目标文本与槽位宽度。
// 规则：只有整数部分变化才滚；小数位静默跳变；槽位固定，宽度不跳。
function setOdometer(el, text, width) {
  if (!el) return;
  const chars = [...String(text)];
  const slots = [];
  for (let i = chars.length; i < width; i += 1) slots.push(' ');
  slots.push(...chars);

  if (el.children.length !== slots.length) {
    el.textContent = '';
    for (const ch of slots) {
      if (ch === ' ') el.appendChild(makeGap());
      else if (/\d/.test(ch)) el.appendChild(makeDigit(Number(ch)));
      else {
        const sep = document.createElement('span');
        sep.className = ch === '.' ? 'odo-sep odo-dot' : 'odo-sep';
        sep.textContent = ch;
        el.appendChild(sep);
      }
    }
    el.dataset.value = text;
    return;
  }

  const prevText = el.dataset.value || '';
  const prevInt = (prevText.match(/^[0-9]+/) || [''])[0];
  const nextInt = (text.match(/^[0-9]+/) || [''])[0];
  const animate = prevInt !== nextInt;

  // 逐位更新。注意：遍历期间可能 replaceWith 换掉节点，children 是实时的，
  // 一旦某个位置换了角色（数字位 ↔ 占位/分隔符），后面的下标就整体错位，
  // 取到的 node 跟 slots[index] 对不上，node.firstChild 可能是 null，
  // 下一行给 strip.style 赋值就抛 exception，整页脚本停摆
  // （2026-11-05 实测报错：undefined is not an object (evaluating 'strip.style.transition')）。
  // 解法：宽度变化时整体重建；宽度没变时按下标取节点并校验类型，类型不符就整位重建。
  if (el.children.length !== slots.length) {
    el.textContent = '';
    for (const ch of slots) {
      if (ch === ' ') el.appendChild(makeGap());
      else if (/\d/.test(ch)) el.appendChild(makeDigit(Number(ch)));
      else {
        const sep = document.createElement('span');
        sep.className = ch === '.' ? 'odo-sep odo-dot' : 'odo-sep';
        sep.textContent = ch;
        el.appendChild(sep);
      }
    }
    el.dataset.value = text;
    return;
  }

  slots.forEach((ch, index) => {
    const node = el.children[index];
    if (!node) return;
    if (ch === ' ') {
      if (!node.classList.contains('odo-gap')) node.replaceWith(makeGap());
      return;
    }
    if (/\d/.test(ch)) {
      if (!node.classList.contains('odo-digit')) {
        node.replaceWith(makeDigit(Number(ch)));
        return;
      }
      const digit = Number(ch);
      if (node.dataset.d === String(digit)) return;
      const strip = node.firstElementChild;
      // 兜底：某位数字位的条带被清掉了就重建这位再继续，绝不让 null 走到赋值那一步。
      if (!strip) {
        node.replaceWith(makeDigit(digit));
        return;
      }
      const fromRight = slots.length - 1 - index;
      const delay = animate ? fromRight * 45 : 0;
      strip.style.transition = animate
        ? `transform 320ms cubic-bezier(0.2, 0.9, 0.25, 1) ${delay}ms`
        : 'none';
      strip.style.transform = `translateY(calc(var(--h) * -${digit}))`;
      node.dataset.d = String(digit);
      if (!animate) requestAnimationFrame(() => { strip.style.transition = ''; });
    } else if (node.textContent !== ch) {
      node.textContent = ch;
    }
  });
  el.dataset.value = text;
}

// 渲染全队合计：入参 bots，副作用是写左侧总计面板（数字逐位滚动）。
function renderTotals(bots) {
  const sum = { turns: 0, tools: 0, out: 0, in: 0, cache: 0 };
  for (const bot of bots) {
    const st = bot.stats || {};
    sum.turns += st.turns || 0;
    sum.tools += st.tools || 0;
    sum.out += st.outTokens || 0;
    sum.in += st.inTokens || 0;
    sum.cache += st.cacheTokens || 0;
  }

  if (!totalsEl.dataset.ready) {
    totalsEl.dataset.ready = '1';
    totalsEl.innerHTML = '<div class="tt-main"><span class="odo odo-xl" id="tt-out"></span></div>'
      + '<div class="tt-sub"><span>输出 token</span><span class="sep">·</span>'
      + '<span id="tt-members">全队 11</span></div>'
      + '<div class="tt-grid">'
      + '<div class="tt-cell"><span class="odo odo-md" id="tt-in"></span><span class="tt-cap">输入 token</span></div>'
      + '<div class="tt-cell"><span class="odo odo-md" id="tt-cache"></span><span class="tt-cap">缓存 token</span></div>'
      + '<div class="tt-cell"><span class="odo odo-md" id="tt-turns"></span><span class="tt-cap">轮次</span></div>'
      + '<div class="tt-cell"><span class="odo odo-md" id="tt-tools"></span><span class="tt-cap">工具调用</span></div>'
      + '</div>';
  }

  setOdometer(totalsEl.querySelector('#tt-out'), fmt(sum.out), 7);
  setOdometer(totalsEl.querySelector('#tt-in'), fmt(sum.in), 6);
  setOdometer(totalsEl.querySelector('#tt-cache'), fmt(sum.cache), 6);
  setOdometer(totalsEl.querySelector('#tt-turns'), String(sum.turns), 4);
  setOdometer(totalsEl.querySelector('#tt-tools'), String(sum.tools), 4);

  // 里程表左侧的占位槽会带来视觉缩进，按实际占位数量回收，让大数字齐左
  for (const id of ['tt-out', 'tt-in', 'tt-cache', 'tt-turns', 'tt-tools']) {
    const el = totalsEl.querySelector(`#${id}`);
    if (!el) continue;
    const gaps = el.querySelectorAll('.odo-gap').length;
    // 2026-11-04：不再用负 margin 抵消前置占位槽。
    // 原设计是 gap 占 1ch + margin-left 抵消 1ch，两者相消才落在容器左边；
    // 实测不同的数字 gaps 数不同，抵消量不一致，主数字就会和下面的小指标错位。
    // 改成：gap 不进布局（CSS display:none），margin 恒为 0，直接靠自然左对齐。
    el.style.marginLeft = '0';
  }

  const membersEl = totalsEl.querySelector('#tt-members');
  if (membersEl) membersEl.textContent = `全队 ${bots.length}`;
}

/* ---------------- 主循环 ---------------- */

// 一次刷新：拉数据并更新四块。
async function tick() {
  let data;
  try {
    const res = await fetch('/bot-stage/api/live', { cache: 'no-store' });
    data = await res.json();
    if (!data.ok) throw new Error('bad payload');
  } catch {
    return;
  }

  const allBots = data.bots || [];
  const mains = data.mainIds || [];
  botsCache = allBots;

  // 群视角：选中某个群时，整个看板只显示这个群的成员（拓扑、思考卡、统计全都跟着变）。
  // 选「全部」或「只看 Bot」时就是全队。
  const groupView = (roomFilter === 'all' || roomFilter === 'personal') ? null : roomFilter;
  const groupRoom = groupView ? (data.rooms || []).find((r) => r.id === groupView) : null;

  // 群视角下拓扑中心是这个群的管理员（比如 Neura 研发群换成了调度员），
  // 全队视角下才是全局主 Bot。不这样切，换了管理员群里看到的中心还是老的那个。
  mainId = (groupRoom && groupRoom.adminId) || mains[0] || (allBots[0] && allBots[0].id) || null;

  // 群管理员集合：每个群的 adminId + 全局主 Bot。用于思考卡跨列排版。
  adminIdSet = new Set(mains);
  for (const r of data.rooms || []) if (r.adminId) adminIdSet.add(r.adminId);

  const groupMembers = new Set((groupRoom && groupRoom.memberIds) || []);
  const bots = groupView ? allBots.filter((b) => groupMembers.has(b.id)) : allBots;

  // 与管家的消息数（供列表排序与行内数值），必须在渲染列表之前算
  const weights = new Map();
  for (const ex of data.exchanges || []) {
    if (ex.from === mainId) weights.set(ex.to, (weights.get(ex.to) || 0) + 1);
    else if (ex.to === mainId) weights.set(ex.from, (weights.get(ex.from) || 0) + 1);
  }
  // 管家自身没有「与管家的消息数」，用所有连线数之和作为它的权重
  if (mainId) weights.set(mainId, [...weights.values()].reduce((a, b) => a + b, 0));
  // 成员之间的往来（不含管家）：用于画常驻连线
  const pairCount = new Map();
  for (const ex of data.exchanges || []) {
    if (!ex.from || !ex.to) continue;
    if (ex.from === mainId || ex.to === mainId) continue;
    const k = [ex.from, ex.to].sort().join('|');
    pairCount.set(k, (pairCount.get(k) || 0) + 1);
  }
  // 成员之间所有有往来的配对都画（原先只取前 8 对，剩下的关系在图上直接消失）
  // 另外算出「最近 60 秒内真的通过信」的配对：只有这些线才点亮流动，
  // 否则"两端都在忙"会被误读成"这两个人在通信"（它们只是各自在跑）。
  const nowTs = Date.now();
  const freshPairs = new Set();
  for (const ex of data.exchanges || []) {
    if (!ex.from || !ex.to || !ex.time) continue;
    if (ex.from === mainId || ex.to === mainId) continue;
    if (nowTs - ex.time > COMM_WINDOW_MS) continue;
    freshPairs.add([ex.from, ex.to].sort().join('|'));
  }
  recentPairs = freshPairs;
  recentKeyStr = [...freshPairs].sort().join(',');
  const LINK_LIMIT = 24;   // 只是防止极端历史下糊成一片，正常远达不到
  memberLinks = [...pairCount.entries()]
    .map(([k, n]) => ({ a: k.split('|')[0], b: k.split('|')[1], n }))
    .filter((l) => l.n >= 1)
    .sort((x, y) => y.n - x.n)
    .slice(0, LINK_LIMIT);

  if (demoPreview && !demoBotId && bots.length) demoBotId = bots[0].id;
  const ordered = bots.slice().sort((a, b) => (weights.get(b.id) || 0) - (weights.get(a.id) || 0)
    || ((b.stats || {}).turns || 0) - ((a.stats || {}).turns || 0));
  renderMemberList(ordered);
  updateMemberList(bots, weights);
  if (topoMode === 'bus') drawBus(bots, ordered);
  else drawRing(bots, ordered);
  updateRingState(bots);

  // 标题行右侧的附属信息：三个模块都填，保持同一套格式（节点数 / 日志条数 / 当前值）
  const logTail = document.getElementById('log-tail');
  if (logTail) logTail.textContent = `${(data.feed || []).length} 条`;

  renderThoughts(bots);
  renderStats(bots);
  renderActivity(data.activity);
  renderAlerts(bots);
  renderTaskFlow(data.tasks);
  renderMembers(bots);
  renderProfile(bots);


  nameOf = new Map(bots.map((b) => [b.id, b.name]));
  const feed = (data.feed || []).slice().sort((a, b) => a.at - b.at);

  // 记录群列表，供筛选下拉用
  syncLogFilterOptions(data.rooms || []);

  // 按当前视角取流水：'all' 全要，'personal' 排除群消息，其余只留该群。
  // 首次加载、切换视角、增量刷新三处都必须用它，否则会漏进别的群的消息
  // （2026-11-05 实测：选 Bot 作战指挥室后，日志里还挂着 5 条 Neura 研发群）。
  const feedPass = (item) => {
    if (roomFilter === 'all') return true;
    if (roomFilter === 'personal') return item.k !== 'room';
    return item.roomId === roomFilter;
  };

  if (lastFeedAt === null) {
    // 筛选要能在完整流水里找，不能只留最近 90 条——
    // 否则切到某个较早还有消息的群，会被切没了显示空白。
    feedHistory = feed.slice(-1200);
    // 这里原来直接推最近 26 条，没过视角过滤：切群时 lastFeedAt 被置空走这条分支，
    // 于是整屏又灌回全量消息，屏幕上是「Bot 作战指挥室」但日志混着 Neura 研发群。
    for (const item of feedHistory.filter(feedPass).slice(-26)) pushFeed(item, nameOf);
    lastFeedAt = feed.length ? feed[feed.length - 1].at : 0;
    return;
  }
  const fresh = feed.filter((item) => item.at > lastFeedAt);
  // 每次都用服务端最新的完整流水覆盖，筛选项永远能找到数据
  feedHistory = feed.slice(-1200);
  for (const item of fresh) {
    // 有筛选时只放进历史、不直接追加，等用户切回来再重放
    if (feedPass(item)) {
      pushFeed(item, nameOf);
    }
    // 群消息是广播，没有明确的"发给谁"，不画点对点箭头；
    // 但让发言人在拓扑上闪一下，能看出"这个群有人在说话"。
    if (item.k === 'room' && item.bot) flashMember(item.bot, 'request');
    if (item.k === 'request' || item.k === 'reply' || item.k === 'stopped') {
      flashMember(item.bot, item.k);
      if (item.to) flashMember(item.to, item.k);
      if (ringMode && item.bot && item.to) {
        const kind = item.k === 'reply' ? 'reply' : 'request';
        if (item.bot !== mainId && item.to !== mainId) {
          // 成员之间直接通信：画弧线 + 光点，独立于环心
          flowBetween(item.bot, item.to, kind);
        } else {
          const peer = item.bot === mainId ? item.to : item.bot;
          if (peer) flowPulse(peer, kind);
        }
      }
    }
  }
  if (fresh.length) lastFeedAt = fresh[fresh.length - 1].at;
}

tick();
setInterval(tick, 1000);

// 调试用：?arrowdemo=1 时延时放一次派活与回执箭头，便于截图核对
if (new URLSearchParams(location.search).get('arrowdemo')) {
  setTimeout(() => {
    const others = botsCache.filter((b) => b.id !== mainId);
    const target = others[0];
    if (!target) return;
    flashMember(target.id, 'request');
    if (ringMode) flowPulse(target.id, 'request');
    setTimeout(() => {
      flashMember(target.id, 'reply');
      if (ringMode) flowPulse(target.id, 'reply');
    }, 900);
  }, 1200);
}

// 活跃度容器尺寸一变就立刻重绘。
// 之前只有 window resize 会触发，而"任务流转条目变多/变少"会把活跃度格子撑高撑矮，
// 那种布局变化不触发 window.resize，只能等下一个 tick（最多 3 秒）才重画——就是那"卡一两秒"。
if (activityEl && activityEl.parentElement && typeof ResizeObserver !== 'undefined') {
  const actRo = new ResizeObserver(() => {
    if (!lastActivity) return;
    const w = Math.round(activityEl.clientWidth);
    const h = Math.round(activityEl.clientHeight);
    if (w === actDrawnW && h === actDrawnH) return;
    renderActivity(lastActivity);
  });
  actRo.observe(activityEl.parentElement);
}

// 尺寸变化时重排：入参无，副作用是重算拓扑与思考卡网格。
let resizeTimer = null;
window.addEventListener('resize', () => {
  if (resizeTimer) return;
  resizeTimer = setTimeout(() => {
    resizeTimer = null;
    fitThoughtGrid(cards.size);
    structureKey = '';
    ringKey = '';
    tick();
  }, 140);
});

// 调试用：带 ?debug=1 时把关键尺寸写进标题，便于核对布局。
if (new URLSearchParams(location.search).get('debug')) {
  setTimeout(() => {
    const wrap = document.getElementById('thoughts');
    const wr = wrap.getBoundingClientRect();
    const first = document.querySelector('.thought');
    const fr = first ? first.getBoundingClientRect() : null;
    const outEl = document.getElementById('tt-out');
    const cs2 = outEl ? getComputedStyle(outEl) : null;
    const info = cs2 ? `out:${cs2.fontSize}/${Math.round(outEl.getBoundingClientRect().width)}px` : 'out:none';
    document.title = `${info} | DEBUG ${window.innerWidth}x${window.innerHeight}`
      + ` | thoughts:${Math.round(wr.width)}x${Math.round(wr.height)}`
      + ` | rows:${getComputedStyle(wrap).gridTemplateRows}`
      + ` | card:${fr ? Math.round(fr.width) + 'x' + Math.round(fr.height) : 'none'}`;
  }, 1500);
}

/* 背景已退回纯 CSS 渐变（深蓝 + 网格），不再加载 bg-stage.png，
   所以也不需要有"底图加载失败兜底"这段逻辑了。 */
