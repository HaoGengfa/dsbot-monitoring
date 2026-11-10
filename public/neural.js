const stage = document.getElementById('stage');
const modeEl = document.getElementById('mode');
const clockEl = document.getElementById('clock');

// 平台按 1454×340 设计，整体等比缩进面板；页面本身改成自适应网格，不再整页缩放
function holoScale() {
  const panel = document.querySelector('.p-holo');
  const box = document.getElementById('holo-stage');
  if (!panel || !box) return 1;
  const k = Math.min(panel.clientWidth / 1454, (panel.clientHeight - 36) / 340);
  box.style.setProperty('--k', String(k));
  return k;
}
setInterval(() => {
  clockEl.textContent = new Date().toLocaleTimeString('zh-CN', { hour12: false });
}, 1000);

function fmt(n) {
  n = Number(n) || 0;
  if (n >= 1e9) return (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'k';
  return String(n);
}
function hms(ts) {
  if (!ts) return '--:--:--';
  return new Date(ts).toLocaleTimeString('zh-CN', { hour12: false });
}
function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
}
function catOf(name) {
  const n = String(name || '');
  if (/read|glob/.test(n)) return 'read';
  if (/bash|shell/.test(n)) return 'exec';
  if (/write|edit/.test(n)) return 'write';
  if (/grep|search/.test(n)) return 'search';
  return 'other';
}
const PAL = ['#3ee0ff', '#7b6bff', '#ff4fd8', '#3dffb0', '#ffd15a', '#4cc3ff'];

function normalizeLive(d) {
  const ids = {};
  const ids2 = ids;
  const bots = (d.bots || []).map((b) => {
    ids[b.id] = b.name;
    const st = b.stats || {};
    const act = b.activity || {};
    const tool = act.tool || {};
    return {
      id: b.id, name: b.name || '', role: b.role || '', model: b.model || '',
      working: Boolean(b.working),
      turns: st.turns || 0, tools: st.tools || 0,
      inTokens: st.inTokens || 0, outTokens: st.outTokens || 0,
      cacheTokens: st.cacheTokens || 0,
      toolCounts: st.toolCounts || {},
      tool: tool.name || '',
      // 下面这些是作战室在用、之前我没取的实时字段
      toolDetail: tool.detail || '',
      toolAt: tool.at || act.toolAt || 0,
      step: act.step || 0,
      turn: act.turn || 0,
      lastAt: act.lastAt || 0,
      queued: b.queued || 0,
      workingSince: b.workingSince || 0,
      toolErrors: st.toolErrors || 0,
      retries: st.retries || 0,
      failure: (st.failures && st.failures.length) ? st.failures[st.failures.length - 1] : null,
      // 效率口径：接口不给，用真实累计值相除，不编数
      failCount: (st.failures && st.failures.length) || 0,
      outPerTurn: st.turns ? (st.outTokens || 0) / st.turns : 0,
      toolsPerTurn: st.turns ? (st.tools || 0) / st.turns : 0
    };
  });
  const feed = [];
  for (const e of (d.feed || []).slice(-60)) {
    // think 是"在思考什么"，作战室有、这里之前整个丢了
    if (!['tool', 'turn', 'request', 'reply', 'think'].includes(e.k)) continue;
    const text = String(e.text || '').replace(/\s+/g, ' ').trim().slice(0, 90);
    feed.push({ at: e.at, k: e.k, name: ids[e.bot] || '', tool: e.tool || '', text });
  }
  // feed 全量（不只末 60 条）：群发言、事件类型构成、时段分布只能从这算
  const kinds = {};
  const roomEvents = {};
  const hourly = {};
  for (const e of (d.feed || [])) {
    if (!e.at) continue;
    const k = e.k || '';
    kinds[k] = (kinds[k] || 0) + 1;
    if (k === 'room' && e.room) {
      const r = roomEvents[e.room] || { events: 0, speakers: {} };
      r.events += 1;
      const who = ids[e.bot] || e.who || '—';
      r.speakers[who] = (r.speakers[who] || 0) + 1;
      r.lastAt = Math.max(r.lastAt || 0, e.at);
      roomEvents[e.room] = r;
    }
    if (k !== 'room') {
      const hh = new Date(e.at).getHours();
      hourly[hh] = (hourly[hh] || 0) + 1;
    }
  }
  // 真实交换记录：只取路由元数据（谁→谁、派活还是回执、时间），不含正文
  const exchanges = [];
  for (const e of (d.exchanges || [])) {
    const from = ids[e.from] || '';
    const to = ids[e.to] || '';
    const at = e.time || e.at || 0;
    if (!from || !to || !at) continue;
    if (at > (d.generatedAt || Date.now()) + 60000) continue;
    exchanges.push({ from, to, role: e.role === 'reply' ? 'reply' : 'request', at });
  }
  exchanges.sort((a, b) => a.at - b.at);
  const rooms = (d.rooms || []).map((r) => {
    const ids = r.memberIds || [];
    const names = r.members && Array.isArray(r.members) ? r.members : ids.map((id) => ids2[id]).filter(Boolean);
    return {
      name: r.name || '未命名群',
      adminName: ids2[r.adminId] || '',
      memberIds: ids,
      memberNames: names
    };
  });

  return {
    mode: '实时',
    generatedAt: d.generatedAt,
    rooms,
    activity: (d.activity && d.activity.buckets) || [],
    bots, feed,
    exchanges: exchanges.slice(-60),
    kinds, roomEvents, hourly,
    openWorks: d.openWorks || 0,
    taskCount: (d.tasks || []).length
  };
}

async function load() {
  try {
    // 插件内同源相对路径（插件挂在 /bot-stage 前缀下），不跨端口、不依赖 CORS
    const res = await fetch('./api/live', { cache: 'no-store' });
    if (!res.ok) throw new Error('http ' + res.status);
    return normalizeLive(await res.json());
  } catch {
    const res = await fetch('./neural-snapshot.json', { cache: 'no-store' });
    const d = await res.json();
    d.mode = '快照';
    return d;
  }
}


// ── 首屏装饰：面板依次入场 + 每块一条缓慢下扫的光带（纯装饰，不承载信息）──
const gsap = window.gsap || null;

let chromeReady = false;
function initChrome() {
  if (chromeReady) return;
  chromeReady = true;
  const panels = Array.from(document.querySelectorAll('.panel'));
  if (gsap && !reduceMotion) {
    // 面板依次上浮：靠位移和缓动，不靠发光
    gsap.from(panels, {
      opacity: 0, y: 14, duration: 0.55, ease: 'power3.out', stagger: 0.045, clearProps: 'transform'
    });
  } else {
    panels.forEach((panel, i) => {
      panel.style.animationDelay = (i * 45) + 'ms';
      panel.classList.add('in');
    });
  }
}

// ── 数字滚动：只在值变化时从旧值补间到新值 ──
function tweenNumber(el, from, to, render, dur) {
  if (reduceMotion || from === to || !Number.isFinite(from) || !Number.isFinite(to)) {
    el.textContent = render(to);
    return;
  }
  if (gsap) {
    const box = { v: from };
    gsap.to(box, {
      v: to, duration: dur / 1000, ease: 'power2.out',
      onUpdate() { el.textContent = render(box.v); }
    });
    return;
  }
  const t0 = performance.now();
  const step = (now) => {
    const k = Math.min(1, (now - t0) / dur);
    const eased = 1 - Math.pow(1 - k, 3);
    el.textContent = render(from + (to - from) * eased);
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}


// ── 自绘滚动指示条：macOS 的 overlay 滚动条不受 ::-webkit-scrollbar 控制 ──
function syncScrollbars() {
  document.querySelectorAll('.sb-host').forEach((el) => {
    const bar = el.parentElement.querySelector('.sb');
    if (!bar) return;
    const ratio = el.clientHeight / Math.max(1, el.scrollHeight);
    const scrollable = ratio < 0.995;
    bar.classList.toggle('on', scrollable);
    if (!scrollable) return;
    bar.style.top = (el.offsetTop + 4) + 'px';
    bar.style.height = Math.max(0, el.clientHeight - 8) + 'px';
    const thumb = bar.firstElementChild;
    const h = Math.max(22, (el.clientHeight - 8) * ratio);
    thumb.style.height = h + 'px';
    const max = Math.max(0, el.clientHeight - 8 - h);
    const top = el.scrollHeight > el.clientHeight
      ? (el.scrollTop / (el.scrollHeight - el.clientHeight)) * max : 0;
    thumb.style.transform = `translateY(${top}px)`;
  });
}

let sbReady = false;
function initScrollbars() {
  if (sbReady) return;
  sbReady = true;
  document.querySelectorAll('.fails, .latency, .out-rank, .alerts, .log, .cards').forEach((el) => {
    el.classList.add('sb-host');
    const bar = document.createElement('i');
    bar.className = 'sb';
    bar.appendChild(document.createElement('b'));
    el.parentElement.appendChild(bar);
    el.addEventListener('scroll', syncScrollbars, { passive: true });
  });
  new ResizeObserver(syncScrollbars).observe(document.getElementById('stage'));
}

function drawBars(buckets, hourly) {
  const svg = document.getElementById('bars');
  // 按面板实际像素算 viewBox，柱宽才不会被 preserveAspectRatio="none" 拉变形
  const w = Math.max(240, Math.round(svg.clientWidth || 536));
  const h = Math.max(80, Math.round(svg.clientHeight || 208));
  const pad = 16;
  const all = buckets || [];
  const data = all.slice(-20);      // 只画最近 20 分钟：60 个桶时每根只有 8px，全挤在右边
  const max = Math.max(1, ...data);
  const bw = (w - pad * 2) / Math.max(1, data.length);
  const grid = [0.25, 0.5, 0.75, 1].map((t) => {
    const y = h - 22 - t * (h - 42);
    return `<line x1="${pad}" y1="${y.toFixed(1)}" x2="${w - pad}" y2="${y.toFixed(1)}" stroke="#1d4f74" stroke-width="1"/>`;
  }).join('');
  const parts = data.map((value, index) => {
    if (!value) return '';              // 0 值不画柱，否则 60 根小柱拼起来像一条虚线
    const bh = (value / max) * (h - 42);
    const x = pad + index * bw;
    const y = h - 22 - bh;
    return `<rect x="${(x + 1).toFixed(1)}" y="${y.toFixed(1)}" width="${Math.max(1.5, bw - 3).toFixed(1)}" height="${Math.max(2, bh).toFixed(1)}" fill="${PAL[index % PAL.length]}" opacity="0.92"/>`;
  }).join('');
  const mean = data.length ? data.reduce((s, v) => s + v, 0) / data.length : 0;
  const meanY = (h - 22) - (mean / max) * (h - 42);
  const meanLine = mean > 0
    ? `<line x1="${pad}" y1="${meanY.toFixed(1)}" x2="${w - pad}" y2="${meanY.toFixed(1)}" stroke="#7b6bff" stroke-width="1" stroke-dasharray="4 4" opacity=".8"/>` +
      `<text x="${w - pad}" y="${(meanY - 4).toFixed(1)}" text-anchor="end" fill="#9c8cff" font-size="9">均值 ${mean.toFixed(1)}</text>`
    : '';
  const baseline = `<line x1="${pad}" y1="${h - 22}" x2="${w - pad}" y2="${h - 22}" stroke="#2b6b93"/>` +
    [0, 0.5, 1].map((k) => {
      const x = pad + (w - pad * 2) * k;
      const label = k === 1 ? '现在' : '-' + Math.round(20 * (1 - k)) + 'm';
      const anchor = k === 0 ? 'start' : (k === 1 ? 'end' : 'middle');
      return `<text x="${x.toFixed(1)}" y="${h - 6}" fill="#6f92a6" font-size="9" text-anchor="${anchor}">${label}</text>`;
    }).join('');
  const glow = `<defs><filter id="barGlow" x="-40%" y="-40%" width="180%" height="180%">
      <feGaussianBlur stdDeviation="2.6" result="blur"/>
      <feMerge><feMergeNode in="blur"/><feMergeNode in="SourceGraphic"/></feMerge>
    </filter></defs>`;
  const foot = document.getElementById('bars-foot');
  if (foot) {
    const sum = data.reduce((s, v) => s + v, 0);
    const avg = data.length ? sum / data.length : 0;
    const peak = Math.max(0, ...data);
    const active = data.filter((v) => v > 0).length;
    foot.innerHTML = `<span>峰值 <b>${peak}</b></span><span>均值 <b>${avg.toFixed(1)}</b></span>` +
      `<span>合计 <b>${sum}</b></span><span>有事件 <b>${active}</b>/${data.length} 分</span>`;
  }

  // 今日时段分布：feed 全量按小时真实计数，画成带基线与数值的柱状图
  const hs = document.getElementById('hour-strip');
  if (hs) {
    const pairs = Object.keys(hourly || {}).map((h) => [Number(h), hourly[h] || 0]).sort((a, b) => a[0] - b[0]);
    if (pairs.length) {
      const map = new Map(pairs);
      const lo = pairs[0][0];
      const hi = pairs[pairs.length - 1][0];
      const hours = [];
      for (let hh = lo; hh <= hi; hh += 1) hours.push([hh, map.get(hh) || 0]);
      const hp = Math.max(1, ...hours.map((x) => x[1]));
      const peakHour = hours.reduce((m, x) => (x[1] > m[1] ? x : m), hours[0]);
      const total = hours.reduce((s2, x) => s2 + x[1], 0);
      // 柱宽按真实像素算，柱间留 2px，最窄也保证能点
      const W = Math.max(240, Math.round(hs.clientWidth - 28));
      const H = Math.max(46, Math.round(hs.clientHeight));
      const padT = 14;   // 顶部留给数值标签
      const padB = 13;   // 底部留给小时刻度
      const bh = Math.max(10, H - padT - padB);
      const bw = W / hours.length;
      const tick = Math.max(1, Math.ceil(hours.length / 12));
      const bars = hours.map(([hh, v], i) => {
        const h2 = v ? Math.max(2, (v / hp) * bh) : 0;
        const x = i * bw + 1;
        const y = padT + (bh - h2);
        const on = v === hp && v > 0;
        const fill = on ? '#ffd15a' : '#4fc3ff';
        const op = v ? (on ? '1' : '.78') : '0';
        const label = (v && (hours.length <= 14 || i % tick === 0 || on))
          ? `<text x="${(x + (bw - 2) / 2).toFixed(1)}" y="${(y - 3).toFixed(1)}" text-anchor="middle" fill="${on ? '#ffd15a' : '#7fb4d0'}" font-size="10">${v}</text>`
          : '';
        const tickLabel = (i % tick === 0 || on)
          ? `<text x="${(x + (bw - 2) / 2).toFixed(1)}" y="${(H - 2).toFixed(1)}" text-anchor="middle" fill="${on ? '#ffd15a' : '#6f92a6'}" font-size="10">${String(hh).padStart(2, '0')}</text>`
          : '';
        return `<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${Math.max(2, bw - 3).toFixed(1)}" height="${h2.toFixed(1)}" fill="${fill}" opacity="${op}" rx="1"/>` + label + tickLabel;
      }).join('');
      const base = `<line x1="0" y1="${padT + bh}" x2="${W}" y2="${padT + bh}" stroke="#2b6b93" stroke-width="1"/>`;
      hs.innerHTML = `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="width:100%;height:100%">${base}${bars}</svg>`;
      const foot = document.getElementById('hour-foot');
      if (foot) {
        foot.innerHTML = `<span>峰值 <b>${String(peakHour[0]).padStart(2, '0')}:00</b> · <b>${peakHour[1]}</b> 条</span>` +
          `<span>合计 <b>${total}</b> 条</span><span>共 <b>${hours.length}</b> 个时段</span>`;
      }
      const sub = document.getElementById('hour-sub');
      if (sub) sub.textContent = `${String(lo).padStart(2, '0')}–${String(hi).padStart(2, '0')} 时`;
    } else {
      hs.innerHTML = '';
      const foot = document.getElementById('hour-foot');
      if (foot) foot.innerHTML = '<span>暂无小时事件</span>';
    }
  }

  // 第二维度：累计事件折线（右轴），让 274px 的高度不只剩 5 根柱子
  let acc = 0;
  const cum = data.map((v) => (acc += v));
  const cumMax = Math.max(1, acc);
  const linePts = cum.map((v, i) => {
    const x = pad + i * bw + bw / 2;
    const y = (h - 26) - (v / cumMax) * (h - 52);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  }).join(' ');
  const cumLine = cum.length > 1
    ? `<polyline points="${linePts}" fill="none" stroke="#ff4fd8" stroke-width="1.6" opacity=".75"/>` +
      `<text x="${w - pad}" y="14" text-anchor="end" fill="#ff4fd8" font-size="10" opacity=".8">累计 ${cumMax}</text>`
    : '';

  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  const grow = !drawBars.played && !reduceMotion;
  drawBars.played = true;
  const body = grow
    ? data.map((value, index) => {
        if (!value) return '';
        const bh = (value / max) * (h - 42);
        const x = pad + index * bw;
        const y = h - 22 - bh;
        return `<rect class="grow" style="animation-delay:${index * 22}ms" x="${(x + 1).toFixed(1)}" y="${y.toFixed(1)}" width="${Math.max(1.5, bw - 3).toFixed(1)}" height="${Math.max(2, bh).toFixed(1)}" fill="${PAL[index % PAL.length]}" opacity="0.92"/>`;
      }).join('')
    : parts;
  svg.innerHTML = glow + grid + baseline + meanLine + `<g filter="url(#barGlow)">${body}</g>` + cumLine;
}

function drawRadar(bots) {
  const svg = document.getElementById('radar');
  const acc = { read: 0, exec: 0, write: 0, search: 0, other: 0 };
  for (const bot of bots) {
    for (const [name, count] of Object.entries(bot.toolCounts || {})) acc[catOf(name)] += count;
  }
  const labels = [['读取', acc.read], ['执行', acc.exec], ['写改', acc.write], ['搜索', acc.search], ['其他', acc.other]];

  // 按面板实际尺寸算；不能读 svg 自身的 clientWidth，那会被上一次的 viewBox 反过来撑住
  const panel = svg.closest('.p-radar');
  const w = Math.max(160, (panel ? panel.clientWidth : svg.clientWidth) - 2);
  const h = Math.max(150, (panel ? panel.clientHeight : svg.clientHeight) - 38);
  const cx = w / 2;
  const cy = h / 2;
  const radius = Math.min(w, h) * 0.32;
  const max = Math.max(1, ...labels.map((item) => item[1]));

  const circles = [0.25, 0.5, 0.75, 1].map((k) =>
    `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="${(radius * k).toFixed(1)}" fill="none" stroke="#22628b" opacity=".55"/>`).join('');

  const paths = [];
  const pts = [];
  labels.forEach(([label, count], index) => {
    const angle = -Math.PI / 2 + index * (Math.PI * 2 / labels.length);
    const ex = cx + Math.cos(angle) * radius;
    const ey = cy + Math.sin(angle) * radius;
    const rr = Math.max(radius * 0.12, radius * (count / max));
    const px = cx + Math.cos(angle) * rr;
    const py = cy + Math.sin(angle) * rr;
    pts.push([px, py]);
    paths.push(`<line x1="${cx.toFixed(1)}" y1="${cy.toFixed(1)}" x2="${ex.toFixed(1)}" y2="${ey.toFixed(1)}" stroke="#286b97" opacity=".5"/>`);
    paths.push(`<circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="4" fill="${PAL[index]}"/>`);
    // 标签带真实次数，形状再扁也能读数值
    paths.push(`<text x="${(cx + Math.cos(angle) * (radius + 30)).toFixed(1)}" y="${(cy + Math.sin(angle) * (radius + 30) + 4).toFixed(1)}" text-anchor="middle" fill="#b1d5e6" font-size="10">${label} ${count}</text>`);
  });

  const poly = pts.map((p) => `${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(' ');
  const toolTotals = {};
  bots.forEach((b) => Object.entries(b.toolCounts || {}).forEach(([k, v]) => { toolTotals[k] = (toolTotals[k] || 0) + v; }));
  const topTools = Object.entries(toolTotals).sort((a, b) => b[1] - a[1]).slice(0, 2);
  const topEl = document.getElementById('radar-top');
  if (topEl) {
    const total = Object.values(toolTotals).reduce((s, v) => s + v, 0) || 1;
    topEl.innerHTML = topTools.map(([k, v]) =>
      `<span>${escapeHtml(k)} <b>${((v / total) * 100).toFixed(0)}%</b></span>`
    ).join('') + `<span style="color:#6f92a6">共 ${Object.keys(toolTotals).length} 种</span>`;
  }

  svg.setAttribute('viewBox', `0 0 ${w.toFixed(0)} ${h.toFixed(0)}`);
  const radarIn = !drawRadar.played && !reduceMotion;
  drawRadar.played = true;
  svg.innerHTML = (radarIn ? '<g class="radar-in">' : '<g>') + circles +
    (pts.length ? `<polygon points="${poly}" fill="#2ee7ff" fill-opacity=".15" stroke="#5ce8ff" stroke-width="1.6" stroke-linejoin="round"/>` : '') +
    paths.join('') +
    `<circle cx="${cx.toFixed(1)}" cy="${cy.toFixed(1)}" r="4.5" fill="#40e5ff"/></g>`;
}

function drawLog(feed, generatedAt) {
  const box = document.getElementById('log');
  if (!box) return;
  const kind = { tool: '工具', turn: '轮次', request: '派活', reply: '回执', think: '思考' };
  const rows = (feed || []).filter((e) => e.at);

  // 按面板实际高度决定显示几行，多的从头部裁掉，永远保留最新
  const rowH = 21;
  const fit = Math.max(4, Math.floor((box.clientHeight - 8) / rowH));
  document.getElementById('log-sub').textContent = generatedAt ? hms(generatedAt) : '';

  box.innerHTML = rows.slice(-fit).map((e) => {
    const body = e.text || e.tool || '';
    return `<div data-name="${escapeHtml(e.name || "")}"><span class="t">${hms(e.at).slice(0, 8)}</span>` +
      `<span class="k">${kind[e.k] || e.k}</span>` +
      `<span class="n">${escapeHtml(e.name || '—')}</span>` +
      `<span class="x">${escapeHtml(body || (e.tool ? e.tool : ''))}</span></div>`;
  }).join('');
  box.scrollTop = box.scrollHeight;
}

function fmtDur(ms) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return s + 's';
  const m = Math.floor(s / 60);
  if (m < 60) return m + 'm' + String(s % 60).padStart(2, '0') + 's';
  return Math.floor(m / 60) + 'h' + String(m % 60).padStart(2, '0') + 'm';
}

// 派活出去到回执之前，成员在数据里没有状态；用「有 request 无 reply」补出来
function buildPending(exchanges, now) {
  const open = new Map();
  (exchanges || []).forEach((e) => {
    if (!e.at) return;
    if (e.role === 'request') open.set(e.from + '>' + e.to, e.at);
    else open.delete(e.to + '>' + e.from);
  });
  const out = {};
  open.forEach((at, key) => {
    const parts = key.split('>');
    if (!parts[1]) return;
    if (now - at > 30 * 60000) return;
    out[parts[1]] = { from: parts[0], at: at, ms: now - at };
  });
  return out;
}

const ALERT_WINDOW_MS = 30 * 60000;

function buildAlerts(bots, generatedAt) {
  const rows = [];
  const now = generatedAt || Date.now();
  const recent = (at) => at && (now - at) <= ALERT_WINDOW_MS;
  bots.forEach((b) => {
    if (b.failure && recent(b.failure.at)) {
      rows.push({
        tone: 'bad', name: b.name, at: b.failure.at,
        text: `${b.failure.code || '错误'} · ${b.failure.message || ''}`.slice(0, 48)
      });
    }
    if (b.toolErrors > 0 && recent(b.lastAt)) rows.push({ tone: 'bad', name: b.name, at: b.lastAt, text: `工具报错 ${b.toolErrors} 次` });
    if (b.queued > 0) rows.push({ tone: 'warn', name: b.name, at: b.lastAt || now, text: `排队 ${b.queued} 条未处理` });
    if (b.working && b.workingSince && (now - b.workingSince) > 20 * 60000) {
      rows.push({ tone: 'warn', name: b.name, at: b.workingSince, text: `单轮已跑 ${Math.round((now - b.workingSince) / 60000)} 分钟` });
    }
  });
  rows.sort((a, b) => (a.tone === b.tone ? (b.at || 0) - (a.at || 0) : a.tone === 'bad' ? -1 : 1));
  return rows.slice(0, 8);
}

function buildAlertSummary(data) {
  const now = data.generatedAt || Date.now();
  const ex = (data.exchanges || []).filter((e) => e.at && now - e.at <= ALERT_WINDOW_MS);
  const req = ex.filter((e) => e.role === 'request').length;
  const rep = ex.filter((e) => e.role === 'reply').length;
  const bots = data.bots || [];
  const longest = bots.reduce((m, b) => Math.max(m, b.working && b.workingSince ? now - b.workingSince : 0), 0);
  const fails = bots.reduce((s, b) => s + (b.failure && b.failure.at && now - b.failure.at <= ALERT_WINDOW_MS ? 1 : 0), 0);
  return '<div class="alert-sum">' +
    `<div><span>派活</span><b>${req}</b></div>` +
    `<div><span>回执</span><b>${rep}</b></div>` +
    `<div><span>失败</span><b>${fails}</b></div>` +
    `<div><span>最长单轮</span><b>${longest ? fmtDur(longest) : '—'}</b></div>` +
    '</div>';
}


// 30 分钟事件视图：顶部一行图例，上层精确时点，下层每 5 分钟密度柱
function flowTimeline(ex, now, w, h) {
  const span = 30 * 60000;
  const padL = 12, padR = 16;
  const legendY = 14;
  const rowReq = 38, rowRep = 56;
  const baseY = h - 26;
  const maxH = Math.max(18, baseY - 74);
  const xAt = (at) => padL + (w - padL - padR) * (1 - (now - at) / span);
  const list = (ex || []).filter((e) => e.at && now - e.at <= span);

  const dots = list.map((e) => {
    const cx = xAt(e.at);
    if (cx < padL - 1 || cx > w - padR + 1) return '';
    const cy = e.role === 'reply' ? rowRep : rowReq;
    const color = e.role === 'reply' ? '#4fc3ff' : '#ffb547';
    return `<circle cx="${cx.toFixed(1)}" cy="${cy}" r="3.2" fill="${color}"/>`;
  }).join('');

  const buckets = 6;
  const bw = (w - padL - padR) / buckets;
  const counts = Array.from({ length: buckets }, () => ({ req: 0, rep: 0 }));
  list.forEach((e) => {
    const idx = Math.min(buckets - 1, Math.max(0, Math.floor((now - e.at) / (5 * 60000))));
    const slot = buckets - 1 - idx;
    if (e.role === 'reply') counts[slot].rep += 1; else counts[slot].req += 1;
  });
  const peak = Math.max(1, ...counts.map((c) => c.req + c.rep));
  const bars = counts.map((c, i) => {
    const x = padL + i * bw;
    const total = c.req + c.rep;
    if (!total) return '';
    const hReq = (c.req / peak) * maxH;
    const hRep = (c.rep / peak) * maxH;
    return `<rect x="${(x + 3).toFixed(1)}" y="${(baseY - hReq).toFixed(1)}" width="${(bw - 6).toFixed(1)}" height="${hReq.toFixed(1)}" fill="#ffb547" opacity=".72"/>` +
      `<rect x="${(x + 3).toFixed(1)}" y="${(baseY - hReq - hRep).toFixed(1)}" width="${(bw - 6).toFixed(1)}" height="${hRep.toFixed(1)}" fill="#4fc3ff" opacity=".72"/>`;
  }).join('');

  const ticks = [0, 10, 20, 30].map((m) => {
    const cx = padL + (w - padL - padR) * (1 - m / 30);
    const label = m === 0 ? '现在' : '-' + m + 'm';
    const anchor = m === 0 ? 'end' : (m === 30 ? 'start' : 'middle');
    return `<line x1="${cx.toFixed(1)}" y1="${rowRep + 12}" x2="${cx.toFixed(1)}" y2="${baseY}" stroke="#2b6b93" stroke-dasharray="2 4" opacity=".35"/>` +
      `<text x="${cx.toFixed(1)}" y="${baseY + 15}" fill="#7e9db2" font-size="10" text-anchor="${anchor}">${label}</text>`;
  }).join('');

  const legend =
    `<circle cx="${padL + 3}" cy="${legendY - 3}" r="3.2" fill="#ffb547"/>` +
    `<text x="${padL + 11}" y="${legendY}" fill="#cfe9f7" font-size="10">派活</text>` +
    `<circle cx="${padL + 46}" cy="${legendY - 3}" r="3.2" fill="#4fc3ff"/>` +
    `<text x="${padL + 54}" y="${legendY}" fill="#cfe9f7" font-size="10">回执</text>` +
    `<text x="${padL + 92}" y="${legendY}" fill="#6f92a6" font-size="10">· 柱=每 5 分钟次数</text>`;

  return `<svg class="ftl" style="height:${h}px" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">` +
    legend + ticks +
    `<line x1="${padL}" y1="${baseY}" x2="${w - padR}" y2="${baseY}" stroke="#2b6b93" opacity=".5"/>` +
    bars + dots + `</svg>`;
}

let lastAlertSig = '';

// 事件流转：时间轴 + 四项计数
function drawFlow(exchanges, generatedAt) {
  const box = document.getElementById('flow');
  const sub = document.getElementById('flow-sub');
  if (!box) return;
  const now = generatedAt || Date.now();
  const ex = (exchanges || []).filter((e) => e.at);
  const within = ex.filter((e) => now - e.at <= ALERT_WINDOW_MS);
  if (sub) sub.textContent = `近 30 分钟 · 派活 ${within.filter((e) => e.role === 'request').length} · 回执 ${within.filter((e) => e.role === 'reply').length}`;

  const w = Math.max(220, box.clientWidth - 20);
  // 下限从 96 收到 48：面板被压扁时（插件 iframe 里常见）时间轴要能跟着缩，
  // 原来 96 的下限 + 固定 220 上限会让内容溢出 11px 且压不下去
  let h = Math.max(48, Math.min(220, (box.clientHeight || 200) - 64));
  const paint = (hh) => { box.innerHTML = `<div class="ftl-wrap">${flowTimeline(ex, now, w, hh)}</div>` + flowCounts(ex, now); };
  paint(h);
  for (let i = 0; i < 6; i += 1) {
    const over = box.scrollHeight - box.clientHeight;
    if (over <= 1) break;
    const next = Math.max(40, h - over - 4);
    if (next >= h) break;
    h = next;
    paint(h);
  }
}

function flowCounts(ex, now) {
  const within = ex.filter((e) => now - e.at <= ALERT_WINDOW_MS);
  const req = within.filter((e) => e.role === 'request').length;
  const rep = within.filter((e) => e.role === 'reply').length;
  const bots = (lastData && lastData.bots) || [];
  const longest = bots.reduce((m, b) => Math.max(m, b.working && b.workingSince ? now - b.workingSince : 0), 0);
  const works = (lastData && lastData.openWorks) || 0;
  return '<div class="alert-sum k5">' +
    `<div><span>派活</span><b>${req}</b></div>` +
    `<div><span>回执</span><b>${rep}</b></div>` +
    `<div><span>成功率</span><b>${req ? Math.round((rep / req) * 100) + '%' : '—'}</b></div>` +
    `<div><span>未结</span><b>${works}</b></div>` +
    `<div><span>最长单轮</span><b>${longest ? fmtDur(longest) : '—'}</b></div>` +
    '</div>';
}

// 事件构成：独立面板，feed 全量按 k 计数（reply / request / tool / room / turn / think / stopped）
const KIND_ORDER = [
  ['reply', '回执', '#4fc3ff'], ['request', '派活', '#ffb547'],
  ['tool', '工具', '#3ddc97'], ['room', '群消息', '#7b6bff'],
  ['turn', '轮次', '#3ee0ff'], ['think', '思考', '#ff4fd8'],
  ['stopped', '中断', '#ff6b6b']
];

function drawKind() {
  const box = document.getElementById('kind-strip');
  const sub = document.getElementById('kind-sub');
  if (!box) return;
  const kinds = (lastData && lastData.kinds) || {};
  const rows = KIND_ORDER.filter(([k]) => kinds[k]).map(([k, label, color]) => ({ k, label, color, v: kinds[k] }));
  const other = Object.keys(kinds).filter((k) => !KIND_ORDER.some(([x]) => x === k))
    .reduce((s, k) => s + kinds[k], 0);
  if (other) rows.push({ k: 'other', label: '其他', color: '#5f7f92', v: other });
  const total = rows.reduce((s, r) => s + r.v, 0);
  if (sub) sub.textContent = total ? `合计 ${total} 条` : '';
  if (!total) { box.innerHTML = '<div class="fail-empty">没有事件</div>'; return; }
  box.innerHTML = '<div class="kind-bar">' + rows.map((r) =>
    `<i style="width:${((r.v / total) * 100).toFixed(2)}%;background:${r.color}" ` +
    `title="${r.label} · ${r.v} 条 · ${((r.v / total) * 100).toFixed(1)}%"></i>`).join('') +
    '</div><div class="kind-legend">' + rows.map((r) =>
      `<span title="${r.label} · ${r.v} 条 · ${((r.v / total) * 100).toFixed(1)}%">` +
      `<i style="display:inline-block;width:6px;height:6px;border-radius:1px;background:${r.color}"></i>` +
      `<em>${r.label}</em><b>${r.v}</b></span>`).join('') + '</div>';
}

// 异常与失败：告警行（有才有）
function drawAlerts(rows, data) {
  const box = document.getElementById('alerts');
  const sub = document.getElementById('alerts-sub');
  if (!box) return;

  const sig = rows.map((r) => r.name + r.text + (r.at || 0)).join('|');
  if (sig && sig !== lastAlertSig) {
    lastAlertSig = sig;
    const panel = box.closest('.panel');
    if (panel) {
      panel.classList.add('ack');
      setTimeout(() => panel.classList.remove('ack'), 680);
    }
  } else if (!sig) {
    lastAlertSig = '';
  }

  sub.textContent = rows.length ? `${rows.length} 项` : '正常';
  box.innerHTML = rows.length
    ? rows.map((r) => `<div class="alert-row ${r.tone}"><span class="aw">` +
        `<span class="an">${escapeHtml(r.name)}</span> · ${escapeHtml(r.text)}</span>` +
        `<span class="at">${hms(r.at)}</span></div>`).join('')
    : '<div class="alert-empty">近 30 分钟没有异常</div>';
}

function buildLatency(exchanges) {
  const pending = new Map();
  const out = [];
  (exchanges || []).forEach((e) => {
    if (e.role === 'request') {
      pending.set(`${e.from}>${e.to}`, e.at);
    } else {
      const key = `${e.to}>${e.from}`;
      const start = pending.get(key);
      if (start) {
        out.push({ ms: Math.max(0, e.at - start), from: e.to, to: e.from, at: e.at });
        pending.delete(key);
      }
    }
  });
  return out.slice(-10).sort((a, b) => b.ms - a.ms);
}

function drawFails(bots) {
  const byCode = new Map();
  bots.forEach((b) => {
    const retries = b.retries || 0;
    const code = (b.failure && b.failure.code) ? b.failure.code : '';
    if (!retries && !code) return;
    const key = code || '其他';
    const row = byCode.get(key) || { code: key, members: [], retries: 0, fails: 0, lastAt: 0 };
    row.members.push(b.name);
    row.retries += retries;
    row.fails += b.failures ? b.failures.length : 0;
    row.lastAt = Math.max(row.lastAt, (b.failure && b.failure.at) || 0);
    byCode.set(key, row);
  });

  const rows = [...byCode.values()].sort((a, b) => (b.retries - a.retries) || (b.fails - a.fails));
  const box = document.getElementById('fails');
  const sub = document.getElementById('fails-sub');
  if (!box) return;

  const totalRetries = rows.reduce((s, r) => s + r.retries, 0);
  const people = new Set(rows.flatMap((r) => r.members)).size;
  if (sub) sub.textContent = rows.length ? `${people} 人 · ${rows.length} 类 · 重试 ${totalRetries} 次` : '无';

  if (!rows.length) { box.innerHTML = '<div class="fail-empty">没有重试或失败记录</div>'; return; }

  // 扇区一律用真实 retries，绝不 `|| 1` 造面积；0 重试的类不进环、不进百分比分母
  const segs = rows.map((r, i) => ({
    label: r.code,
    value: r.retries,
    text: r.retries + ' 次',
    fails: r.fails,
    color: ['#ff6b6b', '#ffb547', '#ff8a3d', '#ff4757'][i % 4]
  }));
  const drawable = segs.filter((s) => s.value > 0);
  box.classList.toggle('as-chart', drawable.length > 0);
  box.innerHTML = '<div class="chart-wrap">' +
    donutChart(drawable, { size: 84, stroke: 11, center: String(totalRetries), caption: '重试' }) +
    `<div class="dlegend">${segs.map((s) =>
      `<div class="dl-row" title="${escapeHtml(s.label)} · 重试 ${s.value} 次 · 失败 ${s.fails} 条">` +
      `<i style="background:${s.color}"></i>` +
      `<span class="dl-name">${escapeHtml(s.label)}</span><span class="dl-val">${s.text}</span>` +
      `<span class="dl-pct">${totalRetries ? ((s.value / totalRetries) * 100).toFixed(0) + '%' : '—'}</span></div>`
    ).join('')}</div></div>`;
}

// 回执时延：改成横向分布条 —— 一条总和切成四档，档内直接写「条数 + 百分比」，
// 中位/P90 收进同一条右侧的指标带，不再让两个大数字各悬一边
function drawLatency(exchanges) {
  const box = document.getElementById('latency');
  const sub = document.getElementById('line-sub');
  if (!box) return;
  const rows = buildLatency(exchanges);
  if (!rows.length) {
    box.innerHTML = '<div class="alert-empty">还没有配对成功的派活/回执</div>';
    if (sub) sub.textContent = '';
    return;
  }
  const sorted = rows.map((r) => r.ms).sort((a, b) => a - b);
  const mid = sorted[Math.floor(sorted.length / 2)];
  const p90 = sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.9))];
  const secs = (ms) => (ms >= 60000 ? (ms / 60000).toFixed(1) + 'm' : (ms / 1000).toFixed(1) + 's');
  const defs = [['<30s', '#3ddc97'], ['30s–1m', '#4fc3ff'], ['1–3m', '#ffb547'], ['>3m', '#ff6b6b']];
  const bucket = (ms) => (ms < 30000 ? 0 : ms < 60000 ? 1 : ms < 180000 ? 2 : 3);
  const counts = [0, 0, 0, 0];
  rows.forEach((r) => { counts[bucket(r.ms)] += 1; });
  const total = rows.length;
  if (sub) sub.textContent = `${total} 对`;

  // 分布条：条内只放档位名，条数与百分比放到下面的图例，避免窄段文字溢出压到邻段
  const pctOf = (n) => Math.round((n / total) * 100);
  const segs = defs.map(([label, color], i) => {
    const n = counts[i];
    if (!n) return '';
    const pct = (n / total) * 100;
    const wide = pct >= 16;
    return `<i class="${wide ? 'in' : 'out'}" style="width:${pct.toFixed(2)}%;background:${color}" ` +
      `title="${label} · ${n} 条 · ${pct.toFixed(0)}%">` +
      (wide ? `<b>${label}</b>` : '') + `</i>`;
  }).join('');

  const cells = defs.map(([label, color], i) =>
    `<div class="lx-cell${counts[i] ? '' : ' zero'}" title="${label} · ${counts[i]} 条 · ${pctOf(counts[i])}%">` +
    `<span class="lx-l"><i style="background:${color}"></i>${label}</span>` +
    `<span class="lx-v">${counts[i]}<em>条</em></span>` +
    `<span class="lx-p">${counts[i] ? pctOf(counts[i]) + '%' : '—'}</span></div>`).join('');

  box.innerHTML =
    `<div class="lx-main">` +
      `<div class="lx-bar">${segs}</div>` +
      `<div class="lx-legend">${cells}</div>` +
    `</div>` +
    `<div class="lx-kpi">` +
      `<div><span>中位</span><b>${secs(mid)}</b></div>` +
      `<div><span>P90</span><b>${secs(p90)}</b></div>` +
      `<div><span>≤1 分钟</span><b>${counts[0] + counts[1]}/${total}</b></div>` +
    `</div>`;
}
const HOLO_W = 1454;
const HOLO_H = 340;
let holoSig = '';

function drawHolo(bots, exchanges, generatedAt, pending) {
  pending = pending || {};
  const working = bots.filter((b) => b.working);
  const k = holoScale();
  const w = HOLO_W;
  const h = HOLO_H;
  const host = document.getElementById('sats');

  const cx = w * 0.619;
  const hubY = h * 0.276;
  const cy = h * 0.444;
  const rx = Math.min(w * 0.315, w - cx - 96);
  const ry = h * 0.30;

  const adminIndex = Math.max(0, bots.findIndex((b) => /admin/i.test(b.name)));
  const admin = bots[adminIndex];
  const members = bots.filter((_, i) => i !== adminIndex);
  const step = (Math.PI * 2) / Math.max(1, members.length);
  const startAngle = -Math.PI / 2 + step / 2;
  const pos = {};
  if (admin) pos[admin.name] = { x: cx, y: hubY };

  members.forEach((bot, index) => {
    const angle = startAngle + index * step;
    pos[bot.name] = { x: cx + Math.cos(angle) * rx, y: cy + Math.sin(angle) * ry };
  });

  const hubEl = document.getElementById('pf-hub');
  if (hubEl && admin) hubEl.title = `${admin.name} · 派活中心`;

  const events = (exchanges || []).slice(-12).filter((e) => pos[e.from] && pos[e.to]);

  // 只有「成员 / 忙闲 / 交换记录 / 缩放比」变了才重建，否则回放会每 2 秒从头开始
  const sig = members.map((b) => b.name + (b.working ? '1' : '0')).join('|')
    + '#' + events.map((e) => `${e.at}${e.from}${e.to}${e.role}`).join('|')
    + '#' + k.toFixed(3);

  if (sig !== holoSig) {
    holoSig = sig;

    const labels = members.map((bot) => {
      const q = pos[bot.name];
      return `<div class="sat${bot.working ? ' on' : (pending[bot.name] ? ' pending' : '')}" style="left:${((q.x / w) * 100).toFixed(2)}%;top:${((q.y / h) * 100).toFixed(2)}%">${escapeHtml(bot.name)}</div>`;
    });
    host.innerHTML = labels.join('');

    const flights = [];
    events.forEach((event) => {
      const a = pos[event.from];
      const b = pos[event.to];
      if (!a || !b) return;
      const mx = (a.x + b.x) / 2;
      const my = (a.y + b.y) / 2;
      const isReply = event.role === 'reply';
      const hubInvolved = admin && (event.from === admin.name || event.to === admin.name);
      let q;
      if (hubInvolved) {
        const bow = isReply ? 0.36 : 0.12;
        q = { x: mx + (cx - mx) * bow, y: my + (cy - my) * bow };
      } else {
        q = { x: mx + (mx - cx) * 0.3, y: my + (my - cy) * 0.55 };
      }
      flights.push({
        a, q, b,
        tone: isReply ? '#4fc3ff' : '#ffb547',
        role: event.role,
        at: event.at || 0,
        from: event.from,
        to: event.to
      });
    });

    const satMap = {};
    host.querySelectorAll('.sat').forEach((el) => { satMap[el.textContent] = el; });
    mountFlow(flights, w, h, k, satMap);
  }


  const sub = document.getElementById('holo-sub');
  if (events.length) {
    const last = events.reduce((m, e) => Math.max(m, e.at || 0), 0);
    const fresh = last && (Date.now() - last) <= 60000;
    sub.textContent = fresh ? `刚收到事件 · 最新 ${hms(last)}` : `无新事件 · 最后一条 ${hms(last)}`;
  } else {
    sub.textContent = '没有派活/回执记录';
  }

  // 无锁定时显示全队合计，锁定时才显示单个成员（hero 数字与全队产出对齐）
  const card = document.getElementById('hero-agent');
  const idleCount = bots.length - working.length;
  const lockedBot = typeof focusBot !== 'undefined' && focusBot
    ? bots.find((b) => b.name === focusBot)
    : null;

  if (!lockedBot) {
    // 全队合计：输出/输入 token 为全队总和，不取单人值
    const totalOut = bots.reduce((s, b) => s + (b.outTokens || 0), 0);
    const totalIn = bots.reduce((s, b) => s + (b.inTokens || 0), 0);
    const totalTurns = bots.reduce((s, b) => s + (b.turns || 0), 0);
    const totalTools = bots.reduce((s, b) => s + (b.tools || 0), 0);
    card.innerHTML = `
      <div class="hero-heading">
        <span class="dot${working.length ? ' on' : ''}"></span>
        <b>全队合计</b>
        <span class="hero-badge">${bots.length} 人</span>
      </div>
      <div class="hero-meta">
        ${working.length} 在工作中 · ${idleCount} 空闲<br>
        轮次 ${totalTurns} · 工具 ${totalTools}<br>
        输出 ${fmt(totalOut)} · 输入 ${fmt(totalIn)}
      </div>
      <div class="hero-current">${working.length ? '点击卡片可锁定单个成员' : '当前无工作中成员'}</div>
      <div class="hero-foot">全队 ${bots.length} 人 · 工作中 ${working.length} · 空闲 ${idleCount}</div>`;
    return;
  }

  // 锁定单个成员时，hero 显示该成员
  const hero = lockedBot;
  card.innerHTML = `
    <div class="hero-heading">
      <span class="dot${hero.working ? ' on' : ''}"></span>
      <b>${escapeHtml(hero.name)}</b>
      <span class="hero-badge">${hero.working ? '在工作' : '空闲'}</span>
    </div>
    <div class="hero-meta">
      ${escapeHtml(hero.role || '无角色标签')}<br>
      轮次 ${hero.turns} · 工具 ${hero.tools}<br>
      输出 ${fmt(hero.outTokens)} · 输入 ${fmt(hero.inTokens)}
    </div>
    <div class="hero-current">${hero.tool ? '最近工具 · ' + escapeHtml(hero.tool) : '本轮暂无工具调用'}</div>
    <div class="hero-foot">全队 ${bots.length} 人 · 工作中 ${working.length} · 空闲 ${idleCount}</div>`;
}


// ── 全息环 HUD 盘：自己画，不依赖外部素材 ─────────────────────
// 三层同心椭圆 + 刻点 + 外圈点位 + 十字准线，中心留白给「管理员」。
function buildPlate() {
  const svg = document.getElementById('plate');
  if (!svg) return;
  const cx = 900, cy = 170;

  const ring = (rx, ry, stroke, w, opacity, dash) =>
    `<ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" fill="none" stroke="${stroke}" stroke-width="${w}"` +
    `${opacity ? ` opacity="${opacity}"` : ''}${dash ? ` stroke-dasharray="${dash}"` : ''}/>`;

  // 外圈点位：60 个，点位就落在成员标签那一圈上
  const dots = [];
  for (let i = 0; i < 60; i += 1) {
    const a = (i / 60) * Math.PI * 2;
    const x = cx + Math.cos(a) * 500;
    const y = cy + Math.sin(a) * 112;
    const on = i % 5 === 0;
    dots.push(`<circle cx="${x.toFixed(1)}" cy="${y.toFixed(1)}" r="${on ? 2.2 : 1.2}" fill="${on ? '#9defff' : '#4f9fc9'}" opacity="${on ? 0.95 : 0.55}"/>`);
  }

  // 中圈刻度：48 根短线
  const ticks = [];
  for (let i = 0; i < 48; i += 1) {
    const a = (i / 48) * Math.PI * 2;
    const x1 = cx + Math.cos(a) * 340;
    const y1 = cy + Math.sin(a) * 76;
    const len = i % 4 === 0 ? 10 : 5;
    const x2 = cx + Math.cos(a) * (340 + len);
    const y2 = cy + Math.sin(a) * (76 + len * 0.22);
    ticks.push(`<line x1="${x1.toFixed(1)}" y1="${y1.toFixed(1)}" x2="${x2.toFixed(1)}" y2="${y2.toFixed(1)}" stroke="#5cc8f0" stroke-width="1" opacity="${i % 4 === 0 ? 0.8 : 0.4}"/>`);
  }

  // 十字准线：四个方向的短针
  const cross = [
    [cx, cy - 170, cx, cy - 205],
    [cx, cy + 40, cx, cy + 66],
    [cx - 520, cy, cx - 556, cy],
    [cx + 520, cy, cx + 556, cy]
  ].map(([x1, y1, x2, y2]) =>
    `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#7fe6ff" stroke-width="1.6" opacity="0.55"/>`).join('');

  svg.innerHTML = `
    <defs>
      <radialGradient id="plateGlow" cx="50%" cy="50%" r="50%">
        <stop offset="0%" stop-color="#8ff6ff" stop-opacity=".5"/>
        <stop offset="45%" stop-color="#1a8bff" stop-opacity=".12"/>
        <stop offset="100%" stop-color="#03101f" stop-opacity="0"/>
      </radialGradient>
      <linearGradient id="plateArc" x1="0" y1="0" x2="1" y2="0">
        <stop offset="0%" stop-color="#ff4fd8" stop-opacity="0"/>
        <stop offset="35%" stop-color="#ff4fd8"/>
        <stop offset="65%" stop-color="#7ff4ff"/>
        <stop offset="100%" stop-color="#2ee7ff" stop-opacity="0"/>
      </linearGradient>
    </defs>
    <ellipse cx="${cx}" cy="${cy}" rx="560" ry="150" fill="url(#plateGlow)"/>
    ${ring(500, 112, '#3f9dff', 1.1, 0.5)}
    ${dots.join('')}
    ${ring(440, 98, '#4fc3ff', 1, 0.35, '2 8')}
    ${ring(340, 76, '#5cd6ff', 1.4, 0.55)}
    ${ticks.join('')}
    ${ring(240, 54, '#ff4fd8', 1.3, 0.45)}
    ${ring(176, 40, 'url(#plateArc)', 2, 0.8)}
    ${ring(120, 27, '#9df6ff', 1.6, 0.9)}
    ${ring(64, 15, '#d8feff', 1.2, 0.7)}
    ${cross}`;
}

// ═══ 事件流光：独立 canvas + 加色叠加，做拖尾与命中闪光 ═══
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const glowCache = {};
function glowSprite(color) {
  if (glowCache[color]) return glowCache[color];
  const size = 128;
  const cv = document.createElement('canvas');
  cv.width = cv.height = size;
  const ctx = cv.getContext('2d');
  const grd = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  grd.addColorStop(0, color);
  grd.addColorStop(0.2, color);
  grd.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, size, size);
  glowCache[color] = cv;
  return cv;
}

// 事件流光：只播"真实到达"的事件，不循环历史记录。
// 没有新事件就完全静止——这是这条流有没有意义的分界线。
const FLOW_TRAVEL = 1150;   // 单条飞行时长
const FLOW_HIT = 420;       // 命中闪光时长
const FLOW_FRESH_MS = 60000; // 超过 1 分钟的历史记录不补播

const flow = {
  ctx: null, w: 0, h: 0, k: 1,
  flights: [], seen: new Set(), live: [],
  satMap: {}, activeKey: '', nowText: ''
};
let flowRAF = 0;

function mountFlow(flights, w, h, k, satMap) {
  const cv = document.getElementById('flowcv');
  if (!cv) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const ratio = dpr * (k || 1);
  cv.width = Math.max(1, Math.round(w * ratio));
  cv.height = Math.max(1, Math.round(h * ratio));
  const ctx = cv.getContext('2d');
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);

  flow.ctx = ctx;
  flow.w = w;
  flow.h = h;
  flow.k = k || 1;
  flow.flights = flights;
  flow.satMap = satMap || {};

  // 首次挂载把历史记录直接标记为"看过"，不再补播；之后新到的事件才排队
  const nowReal = Date.now();
  const base = performance.now();
  let delay = 0;
  flights.forEach((f) => {
    const key = `${f.at}|${f.from}>${f.to}>${f.role}`;
    if (flow.seen.has(key)) return;
    flow.seen.add(key);
    if (!f.at || nowReal - f.at > FLOW_FRESH_MS) return;
    flow.live.push({ f, start: base + 200 + delay });
    delay += 280;
  });

  if (reduceMotion) {
    ctx.clearRect(0, 0, w, h);
    setNow(null, true);
    return;
  }
  if (!flowRAF) flowRAF = requestAnimationFrame(tickFlow);
}

function setNow(flight, force) {
  const text = document.getElementById('now-text');
  const box = document.getElementById('holo-now');
  if (!text || !box) return;
  const next = flight
    ? `${flight.from} → ${flight.to} ${flight.role === 'reply' ? '回执' : '派活'}`
    : '待命中 · 没有新事件';
  if (!force && next === flow.nowText) return;
  flow.nowText = next;
  text.textContent = next;
  box.style.color = flight ? flight.tone : '#5d7f93';
}

function applyActive(names) {
  const key = names ? Array.from(names).sort().join('|') : '';
  if (key === flow.activeKey) return;
  flow.activeKey = key;
  Object.entries(flow.satMap).forEach(([name, el]) => {
    el.classList.toggle('dim', Boolean(names) && !names.has(name));
  });
}

function bez(a, q, b, t) {
  const u = 1 - t;
  return {
    x: u * u * a.x + 2 * u * t * q.x + t * t * b.x,
    y: u * u * a.y + 2 * u * t * q.y + t * t * b.y
  };
}

function drawComet(ctx, f, p) {
  const tail = 0.26;
  const steps = 10;
  for (let s = 0; s < steps; s += 1) {
    const t1 = p - tail * (s / steps);
    const t2 = p - tail * ((s + 1) / steps);
    if (t2 < 0) break;
    const p1 = bez(f.a, f.q, f.b, Math.max(0, t1));
    const p2 = bez(f.a, f.q, f.b, Math.max(0, t2));
    const fade = 1 - s / steps;
    ctx.globalAlpha = 0.85 * fade;
    ctx.strokeStyle = f.tone;
    ctx.lineWidth = 1 + fade * 4.5;
    ctx.lineCap = 'round';
    ctx.beginPath();
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
    ctx.stroke();
  }
  const head = bez(f.a, f.q, f.b, p);
  ctx.globalAlpha = 0.95;
  ctx.drawImage(glowSprite(f.tone), head.x - 46, head.y - 46, 92, 92);
  ctx.globalAlpha = 1;
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(head.x, head.y, 4.6, 0, Math.PI * 2);
  ctx.fill();
}

function drawHit(ctx, f, k) {
  const target = f.b;
  ctx.globalAlpha = (1 - k) * 0.85;
  ctx.strokeStyle = f.tone;
  ctx.lineWidth = 3 * (1 - k) + 0.8;
  ctx.beginPath();
  ctx.arc(target.x, target.y, 7 + k * 30, 0, Math.PI * 2);
  ctx.stroke();
  ctx.globalAlpha = (1 - k) * 0.6;
  ctx.drawImage(glowSprite(f.tone), target.x - 40, target.y - 40, 80, 80);
  ctx.globalAlpha = (1 - k) * 0.8;
  ctx.strokeStyle = f.tone;
  ctx.lineWidth = 2;
  for (let s = 0; s < 4; s += 1) {
    const ang = Math.PI / 4 + s * Math.PI / 2;
    const r1 = 10 + k * 22;
    const r2 = r1 + 8 * (1 - k);
    ctx.beginPath();
    ctx.moveTo(target.x + Math.cos(ang) * r1, target.y + Math.sin(ang) * r1);
    ctx.lineTo(target.x + Math.cos(ang) * r2, target.y + Math.sin(ang) * r2);
    ctx.stroke();
  }
}

function tickFlow(now) {
  const { ctx, w, h } = flow;
  if (ctx) {
    ctx.clearRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'lighter';

    const alive = [];
    const involved = new Set();
    let active = null;

    flow.live.forEach((item) => {
      const local = now - item.start;
      if (local < 0) { alive.push(item); return; }
      if (local > FLOW_TRAVEL + FLOW_HIT) return;   // 播完就丢，不重播

      const f = item.f;
      involved.add(f.from);
      involved.add(f.to);

      if (!active) {
        ctx.globalAlpha = 0.4;
        ctx.strokeStyle = f.tone;
        ctx.lineWidth = 1.4;
        ctx.beginPath();
        ctx.moveTo(f.a.x, f.a.y);
        ctx.quadraticCurveTo(f.q.x, f.q.y, f.b.x, f.b.y);
        ctx.stroke();
      }

      if (local <= FLOW_TRAVEL) {
        drawComet(ctx, f, local / FLOW_TRAVEL);
        if (!active) active = f;
      } else {
        const k = (local - FLOW_TRAVEL) / FLOW_HIT;
        drawHit(ctx, f, k);
        if (!item.fired) {
          item.fired = true;
          const el = flow.satMap[f.to];
          if (el) {
            el.classList.add('hit');
            setTimeout(() => el.classList.remove('hit'), 380);
          }
          const panelEl = document.querySelector('.p-holo');
          if (panelEl) {
            panelEl.classList.add('ack');
            setTimeout(() => panelEl.classList.remove('ack'), 660);
          }
        }
        if (!active) active = f;
      }
      alive.push(item);
    });

    flow.live = alive;
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';

    applyActive(involved.size ? involved : null);
    setNow(active, false);
  }
  flowRAF = requestAnimationFrame(tickFlow);
}


// 环形图：扇区用 dasharray 画，悬停加粗并显示原生 tooltip
function donutChart(rows, opts) {
  const o = opts || {};
  const size = o.size || 148;
  const stroke = o.stroke || 17;
  const r = (size - stroke) / 2 - 2;
  const C = 2 * Math.PI * r;
  const total = rows.reduce((s, x) => s + x.value, 0) || 1;
  let acc = 0;
  const segs = rows.map((x) => {
    const len = Math.max(0, (x.value / total) * C - 2);
    const dash = `${len.toFixed(2)} ${(C - len).toFixed(2)}`;
    const off = (-acc).toFixed(2);
    acc += (x.value / total) * C;
    const pct = ((x.value / total) * 100).toFixed(0);
    return `<circle class="dseg" cx="${size / 2}" cy="${size / 2}" r="${r.toFixed(1)}" fill="none" ` +
      `stroke="${x.color}" stroke-width="${stroke}" stroke-dasharray="${dash}" stroke-dashoffset="${off}" ` +
      `transform="rotate(-90 ${size / 2} ${size / 2})">` +
      `<title>${escapeHtml(x.label)} · ${x.text || x.value} · ${pct}%</title></circle>`;
  }).join('');
  return `<svg class="donut" viewBox="0 0 ${size} ${size}" style="width:${size}px;height:${size}px">` +
    segs +
    `<text x="${size / 2}" y="${size / 2 - 2}" text-anchor="middle" class="dtotal">${o.center || ''}</text>` +
    `<text x="${size / 2}" y="${size / 2 + 14}" text-anchor="middle" class="dcap">${o.caption || ''}</text>` +
    `</svg>`;
}

function legend(rows) {
  const total = rows.reduce((s, x) => s + x.value, 0) || 1;
  return '<div class="dlegend">' + rows.map((x) =>
    `<div class="dl-row" title="${escapeHtml(x.label)}"><i style="background:${x.color}"></i>` +
    `<span class="dl-name">${escapeHtml(x.label)}</span>` +
    `<span class="dl-val">${x.text || x.value}</span>` +
    `<span class="dl-pct">${((x.value / total) * 100).toFixed(0)}%</span></div>`
  ).join('') + '</div>';
}

function shortModel(m) {
  if (!m) return '—';
  const tail = String(m).split('/').pop();
  return tail.replace(/^cn:/, '').replace('deepseek-', '').replace('workbuddy-pool', '');
}

function drawCards(bots, pending) {
  pending = pending || {};
  const box = document.getElementById('cards');
  if (!box) return;

  const ordered = bots.slice().sort((a, b) => b.outTokens - a.outTokens);
  const total = Math.max(1, ordered.reduce((s, b) => s + b.outTokens, 0));
  const tone = (bot, i) => (bot.working ? '#3dffc0' : (pending[bot.name] ? '#ffb547' : PAL[i % PAL.length]));

  const segs = ordered.map((b, i) => {
    const pct = (b.outTokens / total) * 100;
    if (pct < 0.4) return '';
    return `<i style="width:${pct.toFixed(2)}%;background:${tone(b, i)}" ` +
      `title="${escapeHtml(b.name)} · ${fmt(b.outTokens)} · ${pct.toFixed(1)}%"></i>`;
  }).join('');

  const top = ordered.slice(0, 6);
  const legend = top.map((b, i) =>
    `<div class="sl-row" title="${escapeHtml(b.name)} · 轮次 ${b.turns} · 工具 ${b.tools}">` +
    `<i style="background:${tone(b, i)}"></i>` +
    `<span class="sl-name">${escapeHtml(b.name)}</span>` +
    `<span class="sl-mini"><i style="width:${((b.outTokens / Math.max(1, ordered[0].outTokens)) * 100).toFixed(1)}%;background:${tone(b, i)}"></i></span>` +
    `<span class="sl-val">${fmt(b.outTokens)}</span></div>`
  ).join('') + (ordered.length > top.length
    ? `<div class="sl-row"><i style="background:#2b4a63"></i><span class="sl-name">其余 ${ordered.length - top.length} 人</span>` +
      `<span class="sl-val">${fmt(ordered.slice(6).reduce((s, b) => s + b.outTokens, 0))}</span></div>`
    : '');

  box.innerHTML = `<div class="share-bar">${segs}</div><div class="share-legend">${legend}</div>`;

  const cardsSub = document.getElementById('cards-sub');
  if (cardsSub) cardsSub.textContent = `${bots.length} 人`;
}

// 右侧效率榜：字/轮 与 工具/轮 全部由真实累计值相除，接口没有现成字段
function drawEff(bots) {
  const box = document.getElementById('eff');
  const sub = document.getElementById('eff-sub');
  if (!box) return;
  const perTurn = (b) => (Number.isFinite(b.outPerTurn) ? b.outPerTurn : (b.turns ? (b.outTokens || 0) / b.turns : 0));
  const rows = bots.filter((b) => b.turns > 0).slice().sort((a, b) => perTurn(b) - perTurn(a));
  if (!rows.length) { box.innerHTML = '<div class="eff-head"><span>单轮效率</span></div>'; return; }
  const max = Math.max(1, ...rows.map(perTurn));
  const fit = Math.max(3, Math.floor((box.clientHeight - 14 - 7 - 44) / 21));
  const top = rows.slice(0, fit);
  const worst = rows[rows.length - 1];
  // 兜底：快照模式下的旧数据没有 outPerTurn / toolsPerTurn，缺字段一律按 0 显示，不要让整页抛错
  const opt = perTurn;
  const tpt = (b) => (Number.isFinite(b.toolsPerTurn) ? b.toolsPerTurn : (b.turns ? (b.tools || 0) / b.turns : 0));
  const maxTools = rows.reduce((m, b) => (tpt(b) > tpt(m) ? b : m), rows[0]);
  const bar = (v, m, color) => `<span class="eb"><i style="width:${Math.max(3, (v / Math.max(1, m)) * 100).toFixed(1)}%;background:${color}"></i></span>`;
  if (sub) sub.textContent = `${rows.length} 人 · 字/轮`;
  const body = top.map((b) =>
    `<div class="eff-row" title="${escapeHtml(b.name)} · ${Math.round(opt(b))} 字/轮 · ${tpt(b).toFixed(1)} 工具/轮 · ${b.turns} 轮">` +
    `<span class="en">${escapeHtml(b.name)}</span>` +
    bar(opt(b), max, b.working ? '#3dffc0' : '#4fc3ff') +
    `<span class="ev">${fmt(Math.round(opt(b)))}</span></div>`).join('');
  box.innerHTML = body +
    '<div class="eff-sep"></div>' +
    `<div class="eff-row" title="${escapeHtml(worst.name)} · 最低 ${Math.round(opt(worst))} 字/轮">` +
    `<span class="en">最低 ${escapeHtml(worst.name)}</span>` + bar(opt(worst), max, '#ff8a3d') +
    `<span class="ev">${fmt(Math.round(opt(worst)))}</span></div>` +
    `<div class="eff-row" title="${escapeHtml(maxTools.name)} · ${tpt(maxTools).toFixed(2)} 工具/轮">` +
    `<span class="en">最多 ${escapeHtml(maxTools.name)}</span>` +
    bar(tpt(maxTools), tpt(maxTools), '#ffd15a') +
    `<span class="ev">${tpt(maxTools).toFixed(1)}</span></div>`;
}

// 当前步进：activity.turn / activity.step 是接口直给的真实数，不用推导
function drawSteps(bots) {
  const box = document.getElementById('steps');
  const sub = document.getElementById('step-sub');
  if (!box) return;
  if (sub) sub.textContent = `工作 ${bots.filter((b) => b.working).length} 人`;
  const work = bots.filter((b) => b.working);
  const idle = bots.filter((b) => !b.working);
  const pick = work.concat(idle);
  if (!pick.length) { box.innerHTML = '<div class="fail-empty">没有成员</div>'; return; }
  const maxStep = Math.max(1, ...pick.map((b) => b.step || 0));
  const fit = Math.max(3, Math.floor((box.clientHeight - 14) / 22));
  const shown = pick.slice(0, fit);
  if (sub) sub.textContent = `工作 ${work.length} · 共 ${pick.length} 人`;
  const row = (b) =>
    `<div class="step-row${b.working ? ' on' : ''}" title="${escapeHtml(b.name)} · 第 ${b.turn || 0} 轮第 ${b.step || 0} 步 · ${b.tool || '无工具'}${b.toolDetail ? ' · ' + escapeHtml(b.toolDetail) : ''}">` +
    `<span class="sn">${escapeHtml(b.name)}</span>` +
    `<span class="sp"><i style="width:${Math.max(6, ((b.step || 0) / maxStep) * 100).toFixed(1)}%"></i></span>` +
    `<span class="st">${escapeHtml(b.tool || (b.working ? '思考中' : '空闲'))}</span>` +
    `<span class="sv">${b.turn || 0}/<b>${b.step || 0}</b></span></div>`;
  const w = work.slice(0, fit).map(row).join('');
  const rest = fit - work.slice(0, fit).length;
  const i = rest > 0 ? idle.slice(0, rest).map(row).join('') : '';
  box.innerHTML = w + (rest > 0 && idle.length ? '<div class="step-sep"></div>' + i : '');
}

function rankRows(rows, total, unit) {
  const max = Math.max(1, ...rows.map((r) => r[1]));
  const box = { h: 0 };
  return rows.map(([name, v], i) =>
    `<div class="rk-row" title="${escapeHtml(name)} · ${v}${unit} · ${((v / Math.max(1, total)) * 100).toFixed(0)}%">` +
    `<span class="rk-name">${escapeHtml(name)}</span>` +
    `<span class="rk-bar"><i style="width:${Math.max(2, (v / max) * 100).toFixed(1)}%;background:${PAL[i % PAL.length]}"></i></span>` +
    `<span class="rk-val">${v}</span></div>`).join('');
}

function drawTools(bots) {
  const box = document.getElementById('tools');
  const sub = document.getElementById('tools-sub');
  if (!box) return;
  const totals = {};
  bots.forEach((b) => Object.entries(b.toolCounts || {}).forEach(([k, v]) => { totals[k] = (totals[k] || 0) + v; }));
  const rows = Object.entries(totals).sort((a, b) => b[1] - a[1]);
  const sum = rows.reduce((s, r) => s + r[1], 0) || 1;
  // 长尾（单种占比 <1%）与真实报错率放进标题，不另开一块
  const tail = rows.filter((r) => r[1] / sum < 0.01);
  const errs = bots.reduce((s, b) => s + (b.toolErrors || 0), 0);
  // 标题栏只有 253px，长尾与报错放进 title，正文只留最短可读口径
  if (sub) {
    sub.textContent = `${rows.length} 种 · ${fmt(sum)} 次`;
    sub.title = `长尾 ${tail.length} 种（各占比 <1%）· 报错 ${errs} 次`;
  }
  const fit = Math.max(6, Math.floor((box.clientHeight - 8) / 24));
  box.innerHTML = rankRows(rows.slice(0, fit), sum, ' 次');
}

function drawRoles(bots) {
  const box = document.getElementById('roles');
  const sub = document.getElementById('roles-sub');
  if (!box) return;
  const by = new Map();
  bots.forEach((b) => {
    const k = (b.role || '').trim() || '未标注';
    by.set(k, (by.get(k) || 0) + 1);
  });
  const rows = [...by.entries()].sort((a, b) => b[1] - a[1]);
  if (sub) sub.textContent = `${rows.length} 种 · ${bots.length} 人`;
  const fit = Math.max(5, Math.floor((box.clientHeight - 8) / 24));
  box.innerHTML = rankRows(rows.slice(0, fit), bots.length, ' 人');
}

function drawStatus(bots, pending) {
  const box = document.getElementById('status');
  const sub = document.getElementById('status-sub');
  if (!box) return;
  const working = bots.filter((b) => b.working).length;
  // 只统计真实存在的成员：buildPending 只看 exchanges，改名/卸载后可能残留旧名字，
  // 残留进来会让 working+pend 超过总人数、图例合计 >100%
  const names = new Set(bots.map((b) => b.name));
  const pend = Object.keys(pending || {}).filter((n) => names.has(n)).length;
  const idle = Math.max(0, bots.length - working - pend);

  const totalTurns = bots.reduce((s, b) => s + (b.turns || 0), 0);
  const totalTools = bots.reduce((s, b) => s + (b.tools || 0), 0);
  const totalErr = bots.reduce((s, b) => s + (b.toolErrors || 0), 0);
  const maxRun = bots.reduce((m, b) => Math.max(m, b.working && b.workingSince ? Date.now() - b.workingSince : 0), 0);
  const errRate = totalTools > 0 ? (totalErr / totalTools) * 100 : 0;
  if (sub) sub.textContent = `${working} 工作中`;

  const segs = [
    { label: '工作中', value: working, text: working + ' 人', color: '#3dffc0' },
    { label: '待回执', value: pend, text: pend + ' 人', color: '#ffb547' },
    { label: '空闲', value: idle, text: idle + ' 人', color: '#4f9fc9' }
  ];

  const legendRows = segs.map((s) =>
    `<div class="dl-row"><i style="background:${s.color}"></i>` +
    `<span class="dl-name">${s.label}</span>` +
    `<span class="dl-val">${s.text}</span>` +
    `<span class="dl-pct">${((s.value / Math.max(1, bots.length)) * 100).toFixed(0)}%</span></div>`
  ).join('');

  box.innerHTML = '<div class="chart-wrap">' +
    donutChart(segs, { size: 76, stroke: 11, center: String(bots.length), caption: '成员' }) +
    `<div class="dlegend">${legendRows}` +
      `<div class="st-kv"><span>平均轮次</span><b>${Math.round(totalTurns / Math.max(1, bots.length))}</b></div>` +
      `<div class="st-kv"><span>人均输出</span><b>${fmt(Math.round(bots.reduce((s, b) => s + (b.outTokens || 0), 0) / Math.max(1, bots.length)))}</b></div>` +
      `<div class="st-kv"><span>最长单轮</span><b>${maxRun ? fmtDur(maxRun) : '—'}</b></div>` +
      `<div class="st-kv"><span>错误率</span><b>${errRate.toFixed(2)}%</b></div>` +
    `</div></div>`;
}

function drawRooms(rooms, bots, pending, roomEvents) {
  const box = document.getElementById('rooms');
  const sub = document.getElementById('rooms-sub');
  if (!box) return;
  const byName = {};
  bots.forEach((b) => { byName[b.name] = b; });
  pending = pending || {};
  roomEvents = roomEvents || {};
  const now = Date.now();

  const rows = (rooms || []).map((r) => {
    const members = (r.memberNames || []).map((n) => byName[n]).filter(Boolean);
    const working = members.filter((b) => b.working).length;
    const pend = members.filter((b) => pending[b.name]).length;
    const out = members.reduce((s, b) => s + (b.outTokens || 0), 0);
    const lastAt = members.reduce((m, b) => Math.max(m, b.lastAt || 0), 0);
    // 群内发言数来自 feed 的 room 事件，exchanges 没有群 id，这是唯一能归属到群的真实计数
    const ev = roomEvents[r.name] || null;
    const msgs = ev ? ev.events : 0;
    let topSpeaker = '';
    if (ev && ev.speakers) {
      const sorted = Object.entries(ev.speakers).sort((a, b) => b[1] - a[1]);
      if (sorted.length) topSpeaker = sorted[0][0] + ' ' + sorted[0][1];
    }
    return { name: r.name, count: members.length, working, pend, out, lastAt, msgs, topSpeaker };
  }).sort((a, b) => b.msgs - a.msgs || b.out - a.out);

  const totalOut = rows.reduce((s, r) => s + r.out, 0);
  const totalMsgs = rows.reduce((s, r) => s + r.msgs, 0);
  if (sub) {
    const seen = new Map();
    (rooms || []).forEach((r) => (r.memberIds || []).forEach((id) => seen.set(id, (seen.get(id) || 0) + 1)));
    const overlapped = [...seen.values()].filter((n) => n > 1).length;
    sub.textContent = `${rows.length} 群 · 群消息 ${totalMsgs} · ${seen.size} 人 · 跨群 ${overlapped}`;
  }

  if (!rows.length) { box.innerHTML = '<div class="fail-empty">没有群数据</div>'; return; }

  const segs = rows.map((r, i) => ({
    label: r.name,
    value: r.out,
    text: fmt(r.out),
    color: PAL[i % PAL.length]
  }));

  const legendRows = rows.map((r, i) => {
    const ago = r.lastAt ? Math.max(0, Math.round((now - r.lastAt) / 60000)) + 'm' : '—';
    const tip = `${r.name} · ${r.count} 人 · 工作中 ${r.working} · 待回执 ${r.pend}` +
      ` · 群消息 ${r.msgs} 条${r.topSpeaker ? '（最多 ' + r.topSpeaker + '）' : ''} · 最后 ${ago}`;
    return `<div class="dl-row" title="${escapeHtml(tip)}">` +
      `<i style="background:${PAL[i % PAL.length]}"></i>` +
      `<span class="dl-name">${escapeHtml(r.name)}</span>` +
      `<span class="dl-val">${r.count}人 · <b>${r.msgs}</b>条</span>` +
      `<span class="dl-pct">${((r.out / Math.max(1, totalOut)) * 100).toFixed(0)}%</span></div>`;
  }).join('');

  box.innerHTML = '<div class="chart-wrap">' +
    donutChart(segs, { size: 92, stroke: 12, center: fmt(totalOut), caption: '群产出' }) +
    `<div class="dlegend">${legendRows}` +
      `<div class="st-kv"><span>群消息合计</span><b>${totalMsgs} 条</b></div>` +
    `</div></div>`;
}

function drawNums(bots, generatedAt, pending) {
  pending = pending || {};
  const sum = (k) => bots.reduce((s, b) => s + (b[k] || 0), 0);
  const totalOut = sum('outTokens');
  const totalIn = sum('inTokens');
  const totalCache = sum('cacheTokens');
  const totalTurns = sum('turns');
  const totalTools = sum('tools');

  const heroEl = document.getElementById('out-total');
  const prevOut = drawNums.prevOut;
  if (prevOut === undefined) heroEl.textContent = fmt(totalOut);
  else tweenNumber(heroEl, prevOut, totalOut, (x) => fmt(Math.round(x)), 520);
  drawNums.prevOut = totalOut;

  const cacheRate = totalCache + totalIn > 0 ? (totalCache / (totalCache + totalIn) * 100) : 0;
  const perTurn = totalTurns > 0 ? totalOut / totalTurns : 0;
  const outInRate = totalIn > 0 ? (totalOut / totalIn * 100) : 0;
  const idleN = bots.filter((b) => !b.working).length;
  document.getElementById('out-stats').innerHTML = [
    ['输入', fmt(totalIn)], ['缓存', fmt(totalCache)],
    ['轮次', String(totalTurns)], ['工具', fmt(totalTools)],
    ['缓存占比', cacheRate.toFixed(1) + '%'], ['单轮均产', fmt(Math.round(perTurn))],
    ['输出/输入', outInRate.toFixed(1) + '%'], ['空闲', String(idleN) + ' 人']
  ].map(([k, v]) => `<div><span>${k}</span><b>${v}</b></div>`).join('');

  // 模型分布环形图
  const byModel = new Map();
  bots.forEach((b) => {
    const key = shortModel(b.model);
    const row = byModel.get(key) || { model: key, members: 0, out: 0 };
    row.members += 1;
    row.out += b.outTokens || 0;
    byModel.set(key, row);
  });
  const modelRows = [...byModel.values()].sort((a, b) => b.out - a.out)
    .map((r, i) => ({ label: r.model, value: r.out, text: fmt(r.out) + ' · ' + r.members + ' 人', color: PAL[i % PAL.length] }));
  const box = document.getElementById('out-bars');
  box.classList.add('as-chart');
  box.innerHTML = '<div class="chart-wrap">' +
    donutChart(modelRows, { size: 120, stroke: 14, center: fmt(totalOut), caption: '输出' }) +
    legend(modelRows) + '</div>';

  const models = new Set(bots.map((b) => b.model).filter(Boolean));
  const workingN = bots.filter((b) => b.working).length;
  const pendingN = Object.keys(pending).length;
  const numSub = document.getElementById('num-sub');
  if (numSub) numSub.textContent = `工作中 ${workingN} · 待回执 ${pendingN} · ${models.size} 种模型`;
}

let lastData = null;


// ── 点击锁定：点成员卡片或环上标签，把它的派活/回执、日志一起锁定；Esc 或点空白退出 ──
let focusBot = null;

function setFocusBot(name) {
  focusBot = (name && name !== focusBot) ? name : null;
  applyFocus();
}

function applyFocus() {
  const on = Boolean(focusBot);
  const pill = document.getElementById('focus-pill');
  if (pill) {
    if (on) {
      pill.hidden = false;
      pill.innerHTML = `已锁定 <b>${escapeHtml(focusBot)}</b><em>Esc 退出</em>`;
    } else {
      pill.hidden = true;
    }
  }
  document.querySelectorAll('.mt-row').forEach((el) => {
    const mine = el.dataset.bot === focusBot;
    el.classList.toggle('focused', on && mine);
    el.classList.toggle('dim', on && !mine);
  });
  document.querySelectorAll('.sat').forEach((el) => {
    const mine = el.textContent === focusBot;
    el.classList.toggle('focused', on && mine);
    el.classList.toggle('dim', on && !mine);
  });
  document.querySelectorAll('#log div').forEach((el) => {
    const mine = el.dataset.name === focusBot;
    el.classList.toggle('focused', on && mine);
    el.classList.toggle('dim', on && !mine);
  });
  document.querySelectorAll('.flow-row').forEach((el) => {
    const mine = el.dataset.from === focusBot || el.dataset.to === focusBot;
    el.classList.toggle('focused', on && mine);
    el.classList.toggle('dim', on && !mine);
  });
}

function initFailsExpand() {
  const box = document.getElementById('fails');
  if (!box) return;
  box.addEventListener('click', (ev) => {
    const row = ev.target.closest('.fail-row');
    if (!row) return;
    const who = row.querySelector('.fwho');
    if (!who || !row.dataset.members) return;
    const full = row.classList.toggle('open');
    who.textContent = full ? row.dataset.members : who.dataset.short;
  });
}

function initFocus() {
  document.getElementById('cards')?.addEventListener('click', (ev) => {
    const card = ev.target.closest('.mt-row');
    if (card && card.dataset.bot) setFocusBot(card.dataset.bot);
  });
  document.getElementById('sats')?.addEventListener('click', (ev) => {
    const sat = ev.target.closest('.sat');
    if (sat) setFocusBot(sat.textContent.trim());
  });
  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && focusBot) setFocusBot(null);
  });
  document.getElementById('stage')?.addEventListener('click', (ev) => {
    if (!focusBot) return;
    if (ev.target.closest('.mt-row, .sat, .log, .alerts')) return;
    setFocusBot(null);
  });
}

function render(data) {
  lastData = data;
  window.__neuralData = data;
  modeEl.textContent = data.mode || '快照';
  modeEl.style.color = data.mode === '实时' ? '#3dffc0' : '#ffd15a';
  const bots = data.bots || [];
  const stamp = hms(data.generatedAt || Date.now());
  const barsSub = document.getElementById('bars-sub');
  if (barsSub) barsSub.textContent = `近 20 分钟 · ${stamp} 更新`;
  const radarSub = document.getElementById('radar-sub');
  if (radarSub) radarSub.textContent = `工具分布 · ${stamp}`;
  drawBars(data.activity, data.hourly);
  drawLatency(data.exchanges);
  drawRadar(bots);
  drawLog(data.feed, data.generatedAt);
  drawFlow(data.exchanges, data.generatedAt);
  drawKind();
  drawAlerts(buildAlerts(bots, data.generatedAt), data);
  drawFails(bots);
  const pending = buildPending(data.exchanges, data.generatedAt || Date.now());
  drawHolo(bots, data.exchanges, data.generatedAt, pending);
  drawCards(bots, pending);
  drawEff(bots);
  drawSteps(bots);
  drawNums(bots, data.generatedAt, pending);
  drawTools(bots);
  drawRoles(bots);
  drawStatus(bots, pending);
  drawRooms(data.rooms, bots, pending, data.roomEvents);
  applyFocus();
  if (typeof syncScrollbars === 'function') requestAnimationFrame(syncScrollbars);
}

// 调试钩子：只读暴露当前数据与渲染入口，方便模拟事件到达，不参与业务逻辑
window.__neuralData = null;
window.__renderNeural = (d) => render(d);

let live = false;
async function tick() {
  const data = await load();
  live = data.mode === '实时';
  render(data);
}
await tick();
initChrome();
initFocus();
initFailsExpand();
initScrollbars();
syncScrollbars();
// 首屏可能在布局完成前渲染（面板尺寸为 0），延时再画一次兜底
setTimeout(() => { if (lastData) render(lastData); }, 260);
setInterval(tick, 2000);   // 快照模式也重画，避免首屏尺寸为 0 时留下空图

// 窗口尺寸变了：重新算平台缩放并整体重绘（签名里带缩放比，会强制重建）
let resizeTimer = 0;
window.addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(() => {
    holoScale();
    if (lastData) render(lastData);
  }, 120);
});

document.getElementById('fs-btn')?.addEventListener('click', () => {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen().catch(() => {});
});
