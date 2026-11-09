// 看板前端：星形拓扑——管家居中，成员环绕，常驻连线；派活与回执沿连线飞箭头。
const NS = 'http://www.w3.org/2000/svg';
const POLL_MS = 1000;
const ANIM_MS = 1050;
const ANIM_GAP_MS = 160;

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
const statWorking = document.getElementById('stat-working');
const statQueued = document.getElementById('stat-queued');
const statTotal = document.getElementById('stat-total');
const statEvents = document.getElementById('stat-events');

const cards = new Map(); // botId -> { el, refs }
const edges = new Map(); // "a|b" -> { path, flow, d }
let botsCache = [];
let mainId = null;
let lastEventTime = null;
let lastOrderKey = '';
let animQueue = [];
let animRunning = false;
let demoPlayed = false;
const demoParam = new URLSearchParams(location.search).get('demo');

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

// 时间文案：入参毫秒时间戳，返回 HH:MM:SS。
function clock(ts) {
  if (!Number.isFinite(ts)) return '—';
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

// 相对时长：入参毫秒差，返回 12s / 3m / 2h。
function span(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.round(m / 60)}h`;
}

// 创建 SVG 元素：入参标签名与属性表，返回节点。
function svgEl(tag, attrs = {}) {
  const node = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

// 计算环形坐标：入参成员数组，返回 botId → { x, y, w, h }。
function computeLayout(bots) {
  const W = stage.clientWidth || window.innerWidth;
  const H = stage.clientHeight || window.innerHeight - 60;
  const mainW = Math.min(350, Math.max(280, W * 0.22));
  const mainH = Math.min(250, Math.max(206, H * 0.28));
  const subW = Math.min(236, Math.max(196, W * 0.145));
  const subH = Math.min(176, Math.max(146, H * 0.2));

  const pad = 14;
  const cx = W / 2;
  const cy = H / 2;
  const rx = Math.max(100, (W - subW) / 2 - 56);
  const ry = Math.max(80, (H - subH) / 2 - 44);

  const pos = new Map();
  const others = bots.filter((b) => b.id !== mainId);

  for (const bot of bots) {
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

// 建一张成员卡：入参 bot，返回 { el, refs }；只建一次。
function createCard(bot) {
  const el = document.createElement('article');
  el.className = 'card';
  el.dataset.id = bot.id;
  el.style.setProperty('--tone', colorOf(bot.color));

  const head = document.createElement('div');
  head.className = 'card-head';
  const name = document.createElement('span');
  name.className = 'name';
  const role = document.createElement('span');
  role.className = 'role';
  const pill = document.createElement('span');
  pill.className = 'pill';
  head.append(name, role, pill);

  const meta = document.createElement('div');
  meta.className = 'meta-line';
  const progress = document.createElement('span');
  const tool = document.createElement('span');
  tool.className = 'tool';
  meta.append(progress, tool);

  const chips = document.createElement('div');
  chips.className = 'chips';

  const think = document.createElement('pre');
  think.className = 'think';

  const foot = document.createElement('div');
  foot.className = 'card-foot';
  const inbox = document.createElement('span');
  inbox.className = 'inbox';
  const when = document.createElement('span');
  foot.append(inbox, when);

  el.append(head, meta, chips, think, foot);
  cardsLayer.appendChild(el);
  setTimeout(() => el.classList.add('entered'), 520);
  return { el, refs: { name, role, pill, progress, tool, chips, think, inbox, when } };
}

// 更新卡片内容：入参卡片与 bot，副作用是写文本、定位与状态样式。
function updateCard(card, bot, pos) {
  const { refs } = card;
  const act = bot.activity || {};
  const elapsed = bot.working ? span(Date.now() - (bot.workingSince || Date.now())) : '';

  if (pos) {
    card.el.style.left = `${Math.round(pos.x)}px`;
    card.el.style.top = `${Math.round(pos.y)}px`;
    card.el.style.width = `${Math.round(pos.w)}px`;
    card.el.style.height = `${Math.round(pos.h)}px`;
  }

  if (refs.name.textContent !== bot.name) refs.name.textContent = bot.name;
  if (refs.role.textContent !== (bot.role || '成员')) refs.role.textContent = bot.role || '成员';
  card.el.style.setProperty('--tone', colorOf(bot.color));

  let pillText = '空闲';
  if (bot.working) pillText = `进行中 ${elapsed}`;
  else if (bot.queued) pillText = `排队 ${bot.queued}`;
  if (refs.pill.textContent !== pillText) refs.pill.textContent = pillText;

  card.el.classList.toggle('is-working', Boolean(bot.working));

  const turn = Number.isFinite(act.turn) ? act.turn : null;
  const step = Number.isFinite(act.step) ? act.step : null;
  let progressText = '暂无记录';
  if (turn !== null) progressText = `第 ${turn} 轮${step === null ? '' : ` · 第 ${step} 步`}`;
  else if (step !== null) progressText = `第 ${step} 步`;
  else if (bot.working) progressText = '进行中';
  if (refs.progress.textContent !== progressText) refs.progress.textContent = progressText;

  const toolName = act.tool && act.tool.name ? act.tool.name : '';
  const toolDetail = act.tool && act.tool.detail ? act.tool.detail : '';
  const toolText = toolName ? `工具 ${toolName}${toolDetail ? ` · ${toolDetail}` : ''}` : '未调用工具';
  if (refs.tool.textContent !== toolText) refs.tool.textContent = toolText;

  const recent = Array.isArray(act.recent) ? act.recent.slice(-4) : [];
  const merged = [];
  for (const item of recent) {
    const last = merged[merged.length - 1];
    if (last && last.name === item.name) last.count += 1;
    else merged.push({ name: item.name, count: 1 });
  }
  const chipKey = merged.map((r) => `${r.name}x${r.count}`).join('|');
  if (refs.chips.dataset.key !== chipKey) {
    refs.chips.dataset.key = chipKey;
    refs.chips.textContent = '';
    for (const item of merged) {
      const chip = document.createElement('span');
      chip.className = 'chip';
      chip.textContent = item.count > 1 ? `${item.name} ×${item.count}` : item.name;
      refs.chips.appendChild(chip);
    }
  }

  const thinking = act.thinking || act.said || '';
  if (refs.think.textContent !== thinking) {
    refs.think.textContent = thinking;
    refs.think.scrollTop = refs.think.scrollHeight;
  }

  const recv = bot.received || null;
  const inboxText = recv && recv.text ? `收到：${recv.text.slice(0, 44)}` : '暂无收到消息';
  if (refs.inbox.textContent !== inboxText) refs.inbox.textContent = inboxText;

  const whenText = act.lastAt ? clock(act.lastAt) : '—';
  if (refs.when.textContent !== whenText) refs.when.textContent = whenText;
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
  const cx = mx - uy * bow;
  const cy = my + ux * bow;
  return `M ${start.x} ${start.y} Q ${cx} ${cy} ${end.x} ${end.y}`;
}

// 重画常驻连线：入参位置表与往来记录，副作用是重建 edges 图层。
function renderEdges(pos, pairs) {
  edgesLayer.textContent = '';
  edges.clear();
  const main = pos.get(mainId);
  if (!main) return;

  for (const [id, rect] of pos) {
    if (id === mainId) continue;
    const d = arcBetween(main, rect, 34);
    const path = svgEl('path', { d, class: 'edge' });
    const flow = svgEl('path', { d, class: 'edge-flow' });
    edgesLayer.append(path, flow);
    edges.set(`${mainId}|${id}`, { path, flow, d });
    edges.set(`${id}|${mainId}`, { path, flow, d });
  }

  // 成员之间真的互相发过消息的，补一条淡虚线，表示这条协作线存在
  for (const [key, d] of pairs) {
    const [a, b] = key.split('|');
    if (!pos.has(a) || !pos.has(b)) continue;
    if (a === mainId || b === mainId) continue;
    if (edges.has(`${a}|${b}`)) continue;
    const path = svgEl('path', { d, class: 'edge mate' });
    edgesLayer.append(path);
    edges.set(`${a}|${b}`, { path, flow: path, d });
    edges.set(`${b}|${a}`, { path, flow: path, d });
  }
}

// 让某条链路高亮：入参 botId 与是否忙碌，副作用是切换 class。
function highlightEdge(botId, busy) {
  const edge = edges.get(`${mainId}|${botId}`);
  if (!edge) return;
  edge.path.classList.toggle('busy', Boolean(busy));
  edge.flow.style.opacity = busy ? '0.9' : '0.45';
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

  function frame(now) {
    const p = Math.min(1, (now - t0) / ANIM_MS);
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
    setTimeout(playNext, ANIM_GAP_MS);
  }
  requestAnimationFrame(frame);
}

// 播放下一条：入参无，副作用是从队列取一条并沿对应链路飞行。
function playNext() {
  const item = animQueue.shift();
  if (!item) {
    animRunning = false;
    return;
  }
  const color = KIND_COLOR[item.kind] || KIND_COLOR.reply;
  const label = item.kind === 'request' ? '派活' : item.kind === 'stopped' ? '中断' : '回执';
  flashCard(item.from, color);
  flashCard(item.to, color);

  const pairEdge = edges.get(`${item.from}|${item.to}`);
  if (pairEdge) {
    animateAlong(pairEdge.d, color, label);
    return;
  }
  const a = cards.get(item.from);
  const b = cards.get(item.to);
  if (!a || !b) {
    setTimeout(playNext, ANIM_GAP_MS);
    return;
  }
  const rectA = { x: a.el.offsetLeft, y: a.el.offsetTop, w: a.el.offsetWidth, h: a.el.offsetHeight };
  const rectB = { x: b.el.offsetLeft, y: b.el.offsetTop, w: b.el.offsetWidth, h: b.el.offsetHeight };
  animateAlong(arcBetween(rectA, rectB, 22), color, label);
}

// 推入动画队列：入参事件，副作用是排队开播。
function queueArrow(event) {
  const kind = event.role === 'request' ? 'request' : event.role === 'stopped' ? 'stopped' : 'reply';
  animQueue.push({ from: event.from, to: event.to, kind });
  if (!animRunning) {
    animRunning = true;
    playNext();
  }
}

// 数值跳动提示：入参元素，副作用是短暂高亮。
function bump(el) {
  el.classList.remove('bump');
  void el.offsetWidth;
  el.classList.add('bump');
  setTimeout(() => el.classList.remove('bump'), 420);
}

// 一次刷新：拉快照，更新卡片位置与内容，处理新事件动画。
async function tick() {
  let data;
  try {
    const res = await fetch('/bot-stage/api/live', { cache: 'no-store' });
    data = await res.json();
    if (!data.ok) throw new Error(data.error || 'bad payload');
    conn.textContent = '实时';
    conn.className = 'conn ok';
  } catch {
    conn.textContent = '连不上';
    conn.className = 'conn bad';
    return;
  }

  const bots = data.bots || [];
  const mains = data.mainIds || [];
  mainId = mains[0] || (bots[0] && bots[0].id) || null;
  botsCache = bots;

  for (const bot of bots) {
    if (!cards.has(bot.id)) cards.set(bot.id, createCard(bot));
  }

  const pos = computeLayout(bots);

  // 成员之间真实发生过的往来，画成淡虚线
  const matePairs = new Map();
  const seenPair = new Set();
  for (const ex of data.exchanges || []) {
    if (!ex.from || !ex.to) continue;
    if (ex.from === mainId || ex.to === mainId) continue;
    if (!pos.has(ex.from) || !pos.has(ex.to)) continue;
    const key = [ex.from, ex.to].sort().join('|');
    if (seenPair.has(key)) continue;
    seenPair.add(key);
    matePairs.set(key, arcBetween(pos.get(ex.from), pos.get(ex.to), 26));
  }

  for (const bot of bots) {
    const card = cards.get(bot.id);
    if (!card) continue;
    updateCard(card, bot, pos.get(bot.id));
    highlightEdge(bot.id, bot.working);
  }
  renderEdges(pos, matePairs);

  const working = bots.filter((b) => b.working).length;
  const queued = bots.reduce((sum, b) => sum + (b.queued || 0), 0);
  if (statWorking.textContent !== String(working)) { statWorking.textContent = String(working); if (working) bump(statWorking); }
  if (statQueued.textContent !== String(queued)) statQueued.textContent = String(queued);
  if (statTotal.textContent !== String(bots.length)) statTotal.textContent = String(bots.length);
  const evCount = (data.exchanges || []).length;
  if (statEvents.textContent !== String(evCount)) { statEvents.textContent = String(evCount); bump(statEvents); }

  const exchanges = (data.exchanges || []).slice().sort((a, b) => a.time - b.time);
  if (lastEventTime === null) {
    lastEventTime = exchanges.length ? exchanges[exchanges.length - 1].time : 0;
    if (demoParam && !demoPlayed) {
      demoPlayed = true;
      const lastReq = [...exchanges].reverse().find((e) => e.role === 'request');
      const lastRep = [...exchanges].reverse().find((e) => e.role === 'reply');
      if (lastReq && demoParam !== 'reply') queueArrow(lastReq);
      if (lastRep && demoParam !== 'request') queueArrow(lastRep);
    }
    return;
  }

  const fresh = exchanges.filter((e) => e.time > lastEventTime);
  for (const ev of fresh) queueArrow(ev);
  if (fresh.length) lastEventTime = fresh[fresh.length - 1].time;
}

// 尺寸变化时重排：入参无，副作用是重算卡片位置与连线。
let resizeTimer = null;
window.addEventListener('resize', () => {
  if (resizeTimer) return;
  resizeTimer = setTimeout(() => {
    resizeTimer = null;
    const pos = computeLayout(botsCache);
    for (const bot of botsCache) {
      const card = cards.get(bot.id);
      if (card) updateCard(card, bot, pos.get(bot.id));
    }
    renderEdges(pos, new Map());
  }, 140);
});

tick();
setInterval(tick, POLL_MS);
