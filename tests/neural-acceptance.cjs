#!/usr/bin/env node
// neural.html 验收脚本：5 条断言，退出码与实际结果绑定（0 = 全过，1 = 有不通过）。
// 零第三方依赖：用 Node 标准库 + Chrome 的 CDP（与项目内既有探针同一手法）。
// 用法：$NODE tests/neural-acceptance.cjs [--url=http://127.0.0.1:18811/neural.html] [--json=<路径>]
// 注意：别接管道看退出码（| tail 会把 $? 变成 tail 的）。
'use strict';

const { spawn } = require('node:child_process');
const { rmSync, writeFileSync } = require('node:fs');
const http = require('node:http');

const CHROME = process.env.CHROME_PATH || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const VIEWPORT = { width: 1440, height: 900 };
const CDP_TIMEOUT_MS = 30000;

// 解析命令行参数：返回 { url, json }
function parseArgs(argv) {
  const opts = { url: 'http://127.0.0.1:18811/neural.html', json: null, port: 9531 };
  for (const raw of argv.slice(2)) {
    const [k, v] = raw.split('=');
    if (k === '--url' && v) opts.url = v;
    if (k === '--json' && v) opts.json = v;
    if (k === '--port' && v) opts.port = Number(v);
  }
  return opts;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 轮询 CDP 的 JSON 端点直到就绪
async function waitJson(url, tries = 80) {
  for (let i = 0; i < tries; i += 1) {
    try {
      const r = await fetch(url, { method: url.includes('/json/new') ? 'PUT' : 'GET' });
      if (r.ok) return await r.json();
    } catch { /* 未就绪 */ }
    await sleep(250);
  }
  throw new Error(`CDP 端点未就绪：${url}`);
}

// 建立 CDP 会话：返回 { send, close }
async function connect(port) {
  const profileDir = `/tmp/neural-acceptance-${port}`;
  try { rmSync(profileDir, { recursive: true, force: true }); } catch { /* 忽略 */ }
  const proc = spawn(CHROME, [
    '--headless=new', '--disable-gpu', '--no-sandbox',
    `--remote-debugging-port=${port}`, '--remote-allow-origins=*',
    `--user-data-dir=${profileDir}`, '--no-first-run',
    '--disable-extensions', '--disable-background-networking', 'about:blank',
  ], { stdio: 'ignore' });

  const base = `http://127.0.0.1:${port}`;
  await waitJson(`${base}/json/version`);
  const target = await waitJson(`${base}/json/new`);
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  let seq = 0;
  const pending = new Map();
  ws.addEventListener('message', (event) => {
    const msg = JSON.parse(event.data);
    if (pending.has(msg.id)) { pending.get(msg.id)(msg); pending.delete(msg.id); }
  });
  await new Promise((resolve) => ws.addEventListener('open', resolve));
  const send = (method, params = {}) => {
    const id = ++seq;
    ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        reject(new Error(`CDP 无响应（${method}，>${CDP_TIMEOUT_MS / 1000}s）`));
      }, CDP_TIMEOUT_MS);
      pending.set(id, (msg) => { clearTimeout(timer); resolve(msg); });
    });
  };
  const close = () => {
    try { ws.close(); } catch { /* 已关闭 */ }
    proc.kill('SIGKILL');
  };
  return { send, close };
}

// 页面求值：返回结果值
async function evaluate(cli, expression) {
  const res = await cli.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (!res || res.error) throw new Error(`CDP 返回错误：${JSON.stringify(res && res.error)}`);
  const result = res.result;
  if (!result) throw new Error('Runtime.evaluate 应答缺 result 字段');
  if (result.exceptionDetails) throw new Error(`页面内异常：${result.exceptionDetails.text}`);
  return result.result.value;
}

// 五条断言的主体：一次性从页面取回全部证据，避免多次求值时的时序漂移
const PROBE_EXPR = `(() => {
  const panels = [...document.querySelectorAll('.panel')];
  const vw = innerWidth, vh = innerHeight;
  const de = document.documentElement;

  // ① 面板无溢出：每个 .panel 的 scrollHeight 不超过 clientHeight（内部滚动容器除外）
  const over = panels.map((p) => {
    const cs = getComputedStyle(p);
    const scrollable = cs.overflowY === 'auto' || cs.overflowY === 'scroll';
    return {
      cls: p.className,
      sh: p.scrollHeight, ch: p.clientHeight,
      overflowY: cs.overflowY,
      // 允许显式声明内部滚动的容器超出；其余溢出即为布局缺陷
      spilled: !scrollable && p.scrollHeight - p.clientHeight > 2,
    };
  });

  // ② 页面无滚动
  const page = {
    scrollH: de.scrollHeight, clientH: de.clientHeight,
    bodyScrollH: document.body.scrollHeight,
  };

  // ③ 5 块新面板有 DOM：按本次新增的面板类名判定存在且非空
  const NEW_PANELS = ['p-line', 'p-radar', 'p-holo', 'p-status', 'p-rooms'];
  const fresh = NEW_PANELS.map((cls) => {
    const el = document.querySelector('.panel.' + cls);
    return { cls, exists: Boolean(el), nodes: el ? el.querySelectorAll('*').length : 0 };
  });

  // ④ JS 报错：window.__neuralErrors 由脚本前置钩子收集；同时读 console 记录
  const jsErrors = Array.isArray(window.__neuralErrors) ? window.__neuralErrors.slice(0, 5) : [];

  // ⑤ 截断项带 title：只判「真被省略号截掉」的文本元素，且只取叶子节点。
  // 判据收紧过两次：① SVG 元素（className 是 SVGAnimatedString）不是文本容器，排除；
  // ② 有子元素时子文本自己会被判，父容器再判会重复计数；③ 仅靠 textOverflow:ellipsis 声明
  // 但实际没截断（scrollWidth == clientWidth）的，不算截断。
  const truncated = [];
  for (const el of document.querySelectorAll('.panel *')) {
    if (!(el instanceof HTMLElement)) continue;              // 排除 SVG/MathML
    if (el.namespaceURI !== 'http://www.w3.org/1999/xhtml') continue;
    if (el.children.length > 0) continue;                    // 只看叶子，避免父子重复
    const text = (el.textContent || '').trim();
    if (!text) continue;
    const cs = getComputedStyle(el);
    const reallyClipped = el.scrollWidth - el.clientWidth > 2;
    const clampLines = cs.webkitLineClamp && cs.webkitLineClamp !== 'none';
    const ellipsis = cs.textOverflow === 'ellipsis' && cs.overflow !== 'visible';
    if (!(reallyClipped && (clampLines || ellipsis))) continue;
    if (!el.getAttribute('title')) {
      truncated.push((el.className || el.tagName) + ':' + text.slice(0, 20));
    }
  }

  return { panelCount: panels.length, over, page, fresh, jsErrors, truncated: truncated.slice(0, 10), truncatedTotal: truncated.length, vw, vh };
})()`;

// 主流程
async function main() {
  const opts = parseArgs(process.argv);
  const results = [];
  const add = (id, name, actual, expected, ok, note = '') => {
    results.push({ id, name, actual, expected, ok, note });
    const mark = ok ? '✓' : '✗';
    console.log(`  ${mark} ${id} ${name}：实际 ${actual} / 期望 ${expected}${note ? `（${note}）` : ''}`);
  };

  console.log(`neural.html 验收 · ${new Date().toISOString()}`);
  console.log(`目标：${opts.url} · 视口 ${VIEWPORT.width}×${VIEWPORT.height}`);

  const cli = await connect(opts.port);
  let data = null;
  try {
    await cli.send('Page.enable');
    await cli.send('Runtime.enable');
    // 前置钩子：在页面脚本执行前挂错误收集器，才能抓到加载期异常
    await cli.send('Page.addScriptToEvaluateOnNewDocument', {
      source: 'window.__neuralErrors=[];window.addEventListener("error",e=>{window.__neuralErrors.push(String(e.message)+" @"+(e.filename||"")+":"+(e.lineno||0))});'
        + 'window.addEventListener("unhandledrejection",e=>{window.__neuralErrors.push("unhandledrejection: "+String(e.reason))});',
    });
    await cli.send('Emulation.setDeviceMetricsOverride', {
      ...VIEWPORT, deviceScaleFactor: 1, mobile: false,
    });
    await cli.send('Page.navigate', { url: opts.url });
    await sleep(3500);
    data = await evaluate(cli, PROBE_EXPR);
  } finally {
    cli.close();
  }

  console.log(`\n面板总数：${data.panelCount}`);

  // ① 面板无溢出
  const spilled = data.over.filter((p) => p.spilled);
  add('N-01', '17 个面板无溢出',
    `面板 ${data.panelCount} 个 / 溢出 ${spilled.length} 个${spilled.length ? '：' + spilled.map((p) => `${p.cls}(+${p.sh - p.ch}px)`).join(', ') : ''}`,
    '面板数 ≥ 17 且溢出 0',
    data.panelCount >= 17 && spilled.length === 0,
    spilled.length ? '溢出超过 2px 且未声明内部滚动' : '');

  // ② 页面无滚动
  add('N-02', '页面无纵向滚动',
    `documentElement ${data.page.scrollH}/${data.page.clientH} · body ${data.page.bodyScrollH}`,
    'scrollHeight === clientHeight',
    Math.abs(data.page.scrollH - data.page.clientH) <= 1,
    '');

  // ③ 5 块新面板有 DOM
  const missing = data.fresh.filter((f) => !f.exists || f.nodes === 0);
  add('N-03', '5 块新面板有 DOM 内容',
    data.fresh.map((f) => `${f.cls}:${f.exists ? f.nodes : '缺失'}`).join(' / '),
    '5 块均存在且子节点 > 0',
    missing.length === 0,
    missing.length ? '缺：' + missing.map((f) => f.cls).join(',') : '');

  // ④ 无 JS 报错
  add('N-04', '加载与渲染期无 JS 报错',
    data.jsErrors.length ? data.jsErrors.join(' | ') : '0 条',
    '0 条', data.jsErrors.length === 0);

  // ⑤ 截断项带 title
  add('N-05', '被截断文本均带 title',
    `截断 ${data.truncatedTotal} 处，缺 title ${data.truncated.length} 处${data.truncated.length ? '：' + data.truncated.join(', ') : ''}`,
    '缺 title 0 处', data.truncated.length === 0);

  const failed = results.filter((r) => !r.ok);
  console.log(`\n合计 ${results.length} 条断言：${results.length - failed.length} 通过 / ${failed.length} 不通过`);
  if (failed.length) console.log(`不通过：${failed.map((r) => r.id).join(', ')}`);
  if (opts.json) {
    writeFileSync(opts.json, JSON.stringify({ url: opts.url, viewport: VIEWPORT, results, panelCount: data.panelCount }, null, 2));
    console.log(`明细已写入 ${opts.json}`);
  }
  return failed.length ? 1 : 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(`验收脚本异常终止：${err && err.message ? err.message : err}`);
    console.error('判定未完成——这不是通过，退出码 1。');
    process.exit(1);
  });
