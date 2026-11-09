// 复盘回放：把一段真实历史事件按时间重放——谁在干活、派活与回执怎么流动。
const NS = 'http://www.w3.org/2000/svg';
const ACTIVE_MS = 240000; // 事件之后这段时间内视为「在干活」（真实毫秒）

const COLORS = {
  violet: '#8b5cf6', blue: '#3b82f6', green: '#22c55e', cyan: '#06b6d4',
  orange: '#f97316', yellow: '#eab308', magenta: '#ec4899', brown: '#a16207',
  red: '#ef4444', sky: '#0ea5e9', cobalt: '#1d4ed8', gray: '#64748b'
};
const KIND_COLOR = { request: '#ffb547', reply: '#3ddc97', stopped: '#64748b' };

const stage = document.getElementById('stage');
const cardsLayer = document.getElementById('cards');
const edgesLayer = document.getElementById('edges');
const fx = document.getElementById('fx');
const conn = document.getElementById('conn');
const clockEl = document.getElementById('clock');
const stampEl = document.getElementById('stamp');
const statWorking = document.getElementById('stat-working');
const statEvents = document.getElementById('stat-events');
const playBtn = document.getElementById('play');
const scrub = document.getElementById('scrub');
const speedSel = document.getElementById('speed');
const windowSel = document.getElementById('window');
const windowLabel = document.getElementById('window-label');
const phasesEl = document.getElementById('phases');

let cards = new Map();
let edges = new Map();
let bots = [];
let mainId = null;
let from = 0;
let to = 0;
let t = 0;
let playing = true;
let speed = 60;
let merged = [];
let exchanges = [];
let evIdx = 0;
let exIdx = 0;
let drawTick = 0;
let animQueue = [];
let animRunning = false;
const botState = new Map();

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

// 颜色取值：入参颜色名，返回十六进制色值。
function colorOf(name) {
  return COLORS[name] || COLORS.gray;
}

// 时分秒：入参毫秒时间戳，返回 HH:MM:SS。
function hms(ts) {
  if (!Number.isFinite(ts)) return '--:--:--';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// 时分：入参毫秒时间戳，返回 HH:MM。
function hm(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}`;
}

// 创建 SVG 元素：入参标签名与属性表，返回节点。
function svgEl(tag, attrs = {}) {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

// 计算环形坐标：入参成员数组，返回 botId → { x, y, w, h }。
function computeLayout(list) {
  const W = stage.clientWidth || window.innerWidth;
  const H = stage.clientHeight || window.innerHeight - 140;
  const mainW = Math.min(340, Math.max(270, W * 0.21));
  const mainH = Math.min(230, Math.max(190, H * 0.27));
  const subW = Math.min(232, Math.max(190, W * 0.14));
  const subH = Math.min(168, Math.max(140, H * 0.19));
  const pad = 12;
  const cx = W / 2;
  const cy = H / 2;
  const rx = Math.max(100, (W - subW) / 2 - 50);
  const ry = Math.max(80, (H - subH) / 2 - 40);

  const pos = new Map();
  const others = list.filter((b) => b.id !== mainId);
  for (const bot of list) {
    if (bot.id !== mainId) continue;
    pos.set(bot.id, { x: cx - mainW / 2, y: cy - mainH / 2, w: mainW, h: mainH });
  }
  const n = Math.max(1, others.length);
  others.forEach((bot, i) => {
    const angle = -Math.PI / 2 + (i * 2 * Math.PI) / n;
    const x = cx + Math.cos(angle) * rx;
    const y = cy + Math.sin(angle) * ry;
    pos.set(bot.id, {
      x: Math.min(W - subW - pad, Math.max(pad, x - subW / 2)),
      y: Math.min(H - subH - pad, Math.max(pad, y - subH / 2)),
      w: subW,
      h: subH
    });
  });
  return pos;
}

// 建一张成员卡：入参 bot，返回 { el, refs }。
function createCard(bot) {
  const el = document.createElement('article');
  el.className = 'card';
  el.dataset.id = bot.id;
  el.style.setProperty('--tone', colorOf(bot.color));

  const head = document.createElement('div');
  head.className = 'card-head';
  const name = document.createElement('span');
  name.className = 'name';
  name.textContent = bot.name;
  const role = document.createElement('span');
  role.className = 'role';
  role.textContent = bot.role || '成员';
  const pill = document.createElement('span');
  pill.className = 'pill';
  pill.textContent = '空闲';
  head.append(name, role, pill);

  const meta = document.createElement('div');
  meta.className = 'meta-line';
  const progress = document.createElement('span');
  progress.textContent = '—';
  const tool = document.createElement('span');
  tool.className = 'tool';
  tool.textContent = '未调用工具';
  meta.append(progress, tool);

  const chips = document.createElement('div');
  chips.className = 'chips';

  const think = document.createElement('pre');
  think.className = 'think';

  const foot = document.createElement('div');
  foot.className = 'card-foot';
  const inbox = document.createElement('span');
  inbox.className = 'inbox';
  inbox.textContent = '—';
  const when = document.createElement('span');
  foot.append(inbox, when);

  el.append(head, meta, chips, think, foot);
  cardsLayer.appendChild(el);
  return { el, refs: { name, role, pill, progress, tool, chips, think, inbox, when } };
}

// 求矩形边缘点：入参矩形、朝向点与外推距离，返回 { x, y }。
function edgePoint(rect, toward, pad) {
  const cx = rect.x + rect.w / 2;
  const cy = rect.y + rect.h / 2;
  const dx = toward.x - cx;
  const dy = toward.y - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  const sx = dx === 0 ? Number.POSITIVE_INFINITY : (rect.w / 2) / Math.abs(dx);
  const sy = dy === 0 ? Number.POSITIVE_INFINITY : (rect.h / 2) / Math.abs(dy);
  const s = Math.min(sx, sy);
  const len = Math.hypot(dx, dy) || 1;
  return { x: cx + dx * s + (dx / len) * pad, y: cy + dy * s + (dy / len) * pad };
}

// 两个卡片之间的弧线：入参两端矩形与弯曲度，返回路径 d。
function arcBetween(a, b, bow) {
  const ca = { x: a.x + a.w / 2, y: a.y + a.h / 2 };
  const cb = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  const start = edgePoint(a, cb, 6);
  const end = edgePoint(b, ca, 10);
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const len = Math.hypot(dx, dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const mx = (start.x + end.x) / 2;
  const my = (start.y + end.y) / 2;
  return `M ${start.x} ${start.y} Q ${mx - uy * bow} ${my + ux * bow} ${end.x} ${end.y}`;
}

// 重画常驻连线：入参位置表，副作用是重建连线图层。
function renderEdges(pos) {
  edgesLayer.textContent = '';
  edges.clear();
  const main = pos.get(mainId);
  if (!main) return;
  for (const [id, rect] of pos) {
    if (id === mainId) continue;
    const d = arcBetween(main, rect, 32);
    const path = svgEl('path', { d, class: 'edge' });
    const flow = svgEl('path', { d, class: 'edge-flow' });
    edgesLayer.append(path, flow);
    edges.set(`${mainId}|${id}`, { path, flow, d });
    edges.set(`${id}|${mainId}`, { path, flow, d });
  }
}

// 卡片闪一下：入参 botId 与颜色，副作用是加临时 class。
function flashCard(botId, color) {
  const card = cards.get(botId);
  if (!card) return;
  card.el.style.setProperty('--hit', color);
  card.el.classList.remove('hit');
  void card.el.offsetWidth;
  card.el.classList.add('hit');
  setTimeout(() => card.el.classList.remove('hit'), 820);
}

// 沿路径播放箭头：入参 d、颜色与标签，副作用是往 fx 层加流星。
function animateAlong(d, color, labelText) {
  const trail = svgEl('path', {
    d, fill: 'none', stroke: color, 'stroke-width': 2.2,
    'stroke-opacity': 0.55, 'stroke-linecap': 'round'
  });
  const glow = svgEl('circle', { r: 13, fill: color, opacity: 0.22 });
  const dot = svgEl('circle', { r: 5, fill: '#fff' });
  const head = svgEl('polygon', { points: '0,-7.5 14,0 0,7.5', fill: color });
  const label = svgEl('text', {
    x: 0, y: 0, 'font-size': 11, fill: color, 'text-anchor': 'middle', 'font-weight': 600
  });
  label.textContent = labelText;
  fx.append(trail, glow, dot, head, label);

  const probe = document.createElementNS(NS, 'path');
  probe.setAttribute('d', d);
  const total = probe.getTotalLength();
  const t0 = performance.now();
  const dur = 900;

  function frame(now) {
    const p = Math.min(1, (now - t0) / dur);
    const eased = p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2;
    const dist = eased * total;
    const pt = probe.getPointAtLength(dist);
    const ahead = probe.getPointAtLength(Math.min(total, dist + 14));
    const angle = (Math.atan2(ahead.y - pt.y, ahead.x - pt.x) * 180) / Math.PI;
    dot.setAttribute('cx', pt.x);
    dot.setAttribute('cy', pt.y);
    glow.setAttribute('cx', pt.x);
    glow.setAttribute('cy', pt.y);
    head.setAttribute('transform', `translate(${pt.x} ${pt.y}) rotate(${angle})`);
    label.setAttribute('x', pt.x);
    label.setAttribute('y', pt.y - 14);
    trail.setAttribute('stroke-opacity', String(0.55 * (1 - p)));
    if (p < 1) {
      requestAnimationFrame(frame);
      return;
    }
    for (const node of [trail, glow, dot, head, label]) {
      if (node.parentNode === fx) fx.removeChild(node);
    }
    setTimeout(playNextArrow, 120);
  }
  requestAnimationFrame(frame);
}

// 播放下一条箭头：入参无，副作用是从队列取一条。
function playNextArrow() {
  const item = animQueue.shift();
  if (!item) {
    animRunning = false;
    return;
  }
  const color = KIND_COLOR[item.kind] || KIND_COLOR.reply;
  const label = item.kind === 'request' ? '派活' : item.kind === 'stopped' ? '中断' : '回执';
  flashCard(item.from, color);
  flashCard(item.to, color);
  const edge = edges.get(`${item.from}|${item.to}`);
  if (edge) {
    animateAlong(edge.d, color, label);
    return;
  }
  const a = cards.get(item.from);
  const b = cards.get(item.to);
  if (!a || !b) {
    setTimeout(playNextArrow, 120);
    return;
  }
  const ra = { x: a.el.offsetLeft, y: a.el.offsetTop, w: a.el.offsetWidth, h: a.el.offsetHeight };
  const rb = { x: b.el.offsetLeft, y: b.el.offsetTop, w: b.el.offsetWidth, h: b.el.offsetHeight };
  animateAlong(arcBetween(ra, rb, 20), color, label);
}

// 推入箭头队列：入参消息，副作用是排队播放。
function queueArrow(ev) {
  const kind = ev.role === 'request' ? 'request' : ev.role === 'stopped' ? 'stopped' : 'reply';
  animQueue.push({ from: ev.from, to: ev.to, kind });
  if (!animRunning) {
    animRunning = true;
    playNextArrow();
  }
}

// 标记某成员在某个时刻有动作：入参 botId 与时间戳，副作用是刷新活跃时间。
function markActivity(botId, at, isMessage) {
  const st = botState.get(botId);
  if (!st) return;
  if (at > st.lastAt) st.lastAt = at;
  if (isMessage) st.msgs = (st.msgs || 0) + 1;
}

// 应用一条成员事件：入参事件与 botId，副作用是更新该成员的回放状态。
function applyEvent(ev) {
  let st = botState.get(ev.bot);
  if (!st) {
    st = { tool: '', detail: '', think: '', turn: null, lastAt: 0, chips: [], msgs: 0 };
    botState.set(ev.bot, st);
  }
  st.lastAt = ev.at;
  if (ev.k === 'tool') {
    st.tool = ev.n;
    st.detail = ev.d || '';
    st.chips.push(ev.n);
    if (st.chips.length > 6) st.chips.shift();
  } else if (ev.k === 'think') {
    st.think = ev.t || '';
  } else if (ev.k === 'turn') {
    st.turn = ev.n;
  }
}

// 画所有卡片：入参无，副作用是写文本与状态样式。
function drawCards() {
  let working = 0;
  for (const bot of bots) {
    const card = cards.get(bot.id);
    if (!card) continue;
    const st = botState.get(bot.id) || { tool: '', detail: '', think: '', turn: null, lastAt: 0, chips: [], msgs: 0 };
    const active = t - st.lastAt <= ACTIVE_MS && st.lastAt > 0;
    if (active) working += 1;

    card.el.classList.toggle('is-working', active);
    card.refs.pill.textContent = active ? '干活中' : '空闲';

    if (st.turn !== null) {
      card.refs.progress.textContent = `第 ${st.turn} 轮`;
    } else if (st.msgs) {
      card.refs.progress.textContent = `收发 ${st.msgs} 条`;
    } else {
      card.refs.progress.textContent = st.tool ? '进行中' : '暂无记录';
    }
    card.refs.tool.textContent = st.tool
      ? `工具 ${st.tool}${st.detail ? ` · ${st.detail}` : ''}`
      : (st.msgs ? `已收发 ${st.msgs} 条消息` : '未调用工具');

    const chipKey = st.chips.join('|');
    if (card.refs.chips.dataset.key !== chipKey) {
      card.refs.chips.dataset.key = chipKey;
      card.refs.chips.textContent = '';
      for (const name of st.chips.slice(-4)) {
        const chip = document.createElement('span');
        chip.className = 'chip';
        chip.textContent = name;
        card.refs.chips.appendChild(chip);
      }
    }

    if (card.refs.think.textContent !== st.think) {
      card.refs.think.textContent = st.think;
      card.refs.think.scrollTop = card.refs.think.scrollHeight;
    }

    card.refs.when.textContent = st.lastAt ? hms(st.lastAt) : '—';
  }

  statWorking.textContent = String(working);

  // 阶段条：谁在干活就点亮谁
  for (const span of phasesEl.children) {
    const target = bots.find((b) => b.name === span.dataset.bot);
    if (!target) continue;
    const st = botState.get(target.id);
    const active = st && t - st.lastAt <= ACTIVE_MS && st.lastAt > 0;
    span.classList.toggle('active', Boolean(active));
  }
}

// 推进时间轴：入参目标时刻，副作用是消费事件与消息并触发动画。
function advanceTo(target) {
  while (evIdx < merged.length && merged[evIdx].at <= target) {
    applyEvent(merged[evIdx]);
    evIdx += 1;
  }
  while (exIdx < exchanges.length && exchanges[exIdx].time <= target) {
    const ex = exchanges[exIdx];
    // 发消息和收消息都算一次动作，这样管家派活时自己也会亮起来
    markActivity(ex.from, ex.time, true);
    markActivity(ex.to, ex.time, true);
    queueArrow(ex);
    exIdx += 1;
  }
}

// 重置回放：入参无，副作用是把时间、索引与状态归零并重画。
function resetPlayback() {
  t = from;
  evIdx = 0;
  exIdx = 0;
  animQueue = [];
  botState.clear();
  fx.textContent = '';
  for (const bot of bots) botState.set(bot.id, { tool: '', detail: '', think: '', turn: null, lastAt: 0, chips: [], msgs: 0 });
  advanceTo(t);
  drawCards();
  updateClock();
}

// 更新时间显示：入参无，副作用是写时刻、进度条与事件数。
function updateClock() {
  clockEl.textContent = hms(t);
  stampEl.textContent = hms(t);
  statEvents.textContent = String(evIdx);
  const ratio = to > from ? (t - from) / (to - from) : 0;
  scrub.value = String(Math.round(ratio * 1000));
}

// 主循环：入参时间戳，副作用是推进进度并刷新画面。
let lastFrame = performance.now();
let acc = 0;
function frame(now) {
  const dt = Math.min(0.12, (now - lastFrame) / 1000);
  lastFrame = now;
  if (playing) {
    t += dt * speed * 1000;
    if (t >= to) {
      t = to;
      playing = false;
      playBtn.textContent = '▶';
    }
  }
  advanceTo(t);
  acc += dt;
  if (acc > 0.1) {
    acc = 0;
    drawCards();
    updateClock();
  }
  requestAnimationFrame(frame);
}

// 载入一段区间：入参起止时间与标题，副作用是重建卡片与连线并开播。
async function loadWindow(fromMs, toMs, label) {
  conn.textContent = '读取中…';
  conn.className = 'conn';
  windowLabel.textContent = label;
  let data;
  try {
    const res = await fetch(`/bot-stage/api/replay?from=${fromMs}&to=${toMs}`, { cache: 'no-store' });
    data = await res.json();
    if (!data.ok) throw new Error(data.error || 'bad payload');
    conn.textContent = '已载入';
    conn.className = 'conn ok';
  } catch (err) {
    conn.textContent = '读取失败';
    conn.className = 'conn bad';
    showError(String(err.message || err));
    return;
  }

  from = data.from;
  to = data.to;
  bots = data.bots || [];
  mainId = (data.mainIds || [])[0] || (bots[0] && bots[0].id) || null;
  exchanges = data.exchanges || [];
  merged = [];
  for (const bot of bots) {
    for (const ev of bot.events || []) merged.push({ ...ev, bot: bot.id });
  }
  merged.sort((a, b) => a.at - b.at);

  cardsLayer.textContent = '';
  cards = new Map();
  for (const bot of bots) cards.set(bot.id, createCard(bot));

  const pos = computeLayout(bots);
  for (const [id, rect] of pos) {
    const card = cards.get(id);
    if (!card) continue;
    card.el.style.left = `${Math.round(rect.x)}px`;
    card.el.style.top = `${Math.round(rect.y)}px`;
    card.el.style.width = `${Math.round(rect.w)}px`;
    card.el.style.height = `${Math.round(rect.h)}px`;
  }
  renderEdges(pos);

  resetPlayback();
  playing = true;
  playBtn.textContent = '❚❚';
  lastFrame = performance.now();
}

// 把某天某时刻换算成毫秒：入参 Date 与时分，返回时间戳。
function atTime(date, h, m) {
  const d = new Date(date);
  d.setHours(h, m, 0, 0);
  return d.getTime();
}

// 按选项计算区间：入参选项名，返回 { from, to, label }。
function windowOf(kind) {
  const now = Date.now();
  const today = new Date(now);
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);
  if (kind === 'allday') {
    return { from: atTime(yesterday, 9, 0), to: atTime(yesterday, 18, 0), label: `昨天 ${hm(atTime(yesterday, 9, 0))}–${hm(atTime(yesterday, 18, 0))}` };
  }
  if (kind === 'today') {
    return { from: atTime(today, 0, 0), to: now, label: `今天 ${hm(atTime(today, 0, 0))}–${hm(now)}` };
  }
  return {
    from: atTime(yesterday, 13, 50),
    to: atTime(yesterday, 16, 50),
    label: `昨天 ${hm(atTime(yesterday, 13, 50))}–${hm(atTime(yesterday, 16, 50))} · 前端交付链路`
  };
}

playBtn.addEventListener('click', () => {
  playing = !playing;
  playBtn.textContent = playing ? '❚❚' : '▶';
  lastFrame = performance.now();
});

scrub.addEventListener('input', () => {
  const ratio = Number(scrub.value) / 1000;
  const target = from + (to - from) * ratio;
  if (target < t) {
    t = target;
    resetPlayback();
    t = target;
  }
  t = target;
  advanceTo(t);
  drawCards();
  updateClock();
});

speedSel.addEventListener('change', () => {
  speed = Number(speedSel.value) || 60;
});

windowSel.addEventListener('change', () => {
  const win = windowOf(windowSel.value);
  loadWindow(win.from, win.to, win.label);
});

let resizeTimer = null;
window.addEventListener('resize', () => {
  if (resizeTimer) return;
  resizeTimer = setTimeout(() => {
    resizeTimer = null;
    const pos = computeLayout(bots);
    for (const [id, rect] of pos) {
      const card = cards.get(id);
      if (!card) continue;
      card.el.style.left = `${Math.round(rect.x)}px`;
      card.el.style.top = `${Math.round(rect.y)}px`;
      card.el.style.width = `${Math.round(rect.w)}px`;
      card.el.style.height = `${Math.round(rect.h)}px`;
    }
    renderEdges(pos);
  }, 140);
});

// 跳到指定进度：入参 0..1，副作用是重置并推进到该时刻。
function seek(ratio) {
  const target = from + (to - from) * Math.max(0, Math.min(1, ratio));
  t = from;
  resetPlayback();
  t = target;
  advanceTo(t);
  drawCards();
  updateClock();
}
window.seekReplay = seek;

const first = windowOf(windowSel.value);
loadWindow(first.from, first.to, first.label).then(() => {
  const start = Number(new URLSearchParams(location.search).get('start'));
  if (Number.isFinite(start) && start > 0) seek(start);
});
requestAnimationFrame(frame);
