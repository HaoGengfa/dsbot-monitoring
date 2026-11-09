// Bot 团队实时看板：读取本机 Bot 状态文件与会话日志，供浏览器大屏展示。
// 零依赖，只用 Node 标准库；只监听 127.0.0.1；不修改任何被读取的文件。
import http from 'node:http';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, 'public');
const BOT_DIR = path.join(os.homedir(), '.dsh', 'bot');
const SESSIONS_DIR = path.join(os.homedir(), '.dsh', 'sessions');
const STATE_FILE = path.join(BOT_DIR, 'state.json');

// 群消息在 state.json 里只有序号、没有时间戳，进不了按时间排序的流水。
// 这里记「首次见到这条消息的时刻」当它的时间，键是 "群id:消息序号"。
const roomSeenAt = new Map();
const INFLIGHT_FILE = path.join(BOT_DIR, 'inflight.json');
// 任务流转的「已确认」名单：只存用户点过确认的 exchange id，属本看板自有数据，
// 因此不违反「不修改任何被读取文件」——这里它写入的是自己的文件。
const TASK_CONFIRM_FILE = path.join(__dirname, 'data', 'task-confirm.json');
const PORT = Number(process.env.PORT) || 18791;

const ZSTD_MAGIC = Buffer.from([0x28, 0xb5, 0x2f, 0xfd]);
const TAIL_BYTES = 320 * 1024;
const TAIL_FRAMES = 56;
// 会话标题写在日志最前面，读头部一小段就够。
const HEAD_BYTES = 64 * 1024;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
  // 背景底图：没有这条会按 text/plain 下发，浏览器不认，图加载不出来
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp'
};

// 读取 JSON：入参路径，返回对象；文件不在或正在写时返回 null。
async function readJson(file) {
  try {
    return JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch {
    return null;
  }
}

// 会话文件索引：会话 id → 日志绝对路径；启动时建一次，每分钟刷新。
let sessionIndex = new Map();
let sessionIndexAt = 0;
// 同一批会话按最后写入时间倒序，用于 state 里的 sessionId 过期时找回真实文件。
let sessionRecency = [];

// 重建会话索引：入参无，副作用是更新 sessionIndex 与 sessionRecency。
async function rebuildSessionIndex() {
  const next = new Map();
  const recency = [];
  let projects = [];
  try {
    projects = await fsp.readdir(SESSIONS_DIR);
  } catch {
    sessionIndex = next;
    sessionRecency = recency;
    return;
  }
  for (const proj of projects) {
    const projDir = path.join(SESSIONS_DIR, proj);
    let sessions = [];
    try {
      sessions = await fsp.readdir(projDir);
    } catch {
      continue;
    }
    for (const sess of sessions) {
      if (!sess.startsWith('session-')) continue;
      const file = path.join(projDir, sess, 'session.v4.jsonl.zstd');
      if (!fs.existsSync(file)) continue;
      next.set(sess, file);
      let mtimeMs = 0;
      try {
        mtimeMs = (await fsp.stat(file)).mtimeMs;
      } catch {
        continue;
      }
      recency.push({ sessionId: sess, file, mtimeMs, title: await readSessionTitle(file) });
    }
  }
  recency.sort((a, b) => b.mtimeMs - a.mtimeMs);
  sessionIndex = next;
  sessionRecency = recency;
  sessionIndexAt = Date.now();
}

// 读会话标题：日志开头几帧里就有 session/title（形如「大管家 · Neura 研发群」）。
// 切换工作目录后新会话文件不带成员名时，标题是最可靠的归属判据。
async function readSessionTitle(file) {
  let handle;
  try {
    handle = await fsp.open(file, 'r');
    const head = Buffer.alloc(HEAD_BYTES);
    const { bytesRead } = await handle.read(head, 0, HEAD_BYTES, 0);
    const buf = head.subarray(0, bytesRead);
    const positions = [];
    let cursor = 0;
    for (;;) {
      const at = buf.indexOf(ZSTD_MAGIC, cursor);
      if (at < 0) break;
      positions.push(at);
      cursor = at + 1;
    }
    for (let i = 0; i < positions.length; i += 1) {
      const end = i + 1 < positions.length ? positions[i + 1] : buf.length;
      let text;
      try {
        text = zlib.zstdDecompressSync(buf.subarray(positions[i], end)).toString('utf8');
      } catch {
        continue;
      }
      for (const line of text.split('\n')) {
        if (!line.includes('"session/title"')) continue;
        try {
          const title = JSON.parse(line)?.data?.title;
          if (typeof title === 'string' && title.trim()) return title.trim();
        } catch {
          // 单行坏了继续找
        }
      }
    }
  } catch {
    // 读不到就当作没有标题
  } finally {
    if (handle) await handle.close().catch(() => {});
  }
  return '';
}

// 取会话日志路径：入参会话 id，返回路径或 null。
function sessionFileOf(sessionId) {
  return sessionIndex.get(sessionId) || null;
}

// 最近写入的会话日志路径。切换工作目录后 DSH 会为新会话另起文件，
// 而 state.json 里的 sessionId 仍指向旧文件，导致日志流与思考区永远停住。
// 优先按会话标题归属（「成员名 · 群名」）匹配，匹配不到才退回按时间取最新的。
function newestSessionFile({ skipPrefixes = [], maxAgeMs = 30 * 60 * 1000, name = '' } = {}) {
  const now = Date.now();
  const usable = sessionRecency.filter((item) => {
    if (now - item.mtimeMs > maxAgeMs) return false;
    if (skipPrefixes.some((prefix) => item.sessionId.startsWith(prefix))) return false;
    return true;
  });
  // 实时监测的原则：有就有，没有就没有。
  // 早先这里没有 name 时会返回 usable[0]（最近写入的会话），等于拿别人的思考顶替自己。
  if (!name) return null;
  const owner = usable.find((item) => item.title.startsWith(`${name} ·`) || item.title === name);
  return owner || null;
}

// 解析某个 bot 实际该读的日志文件：先在索引里找 sessionId，
// 找到且近期仍在写就直接用；否则按标题归属回退到对应成员的会话。
async function resolveBotSessionFile(sessionId, { skipPrefixes = [], maxAgeMs = 30 * 60 * 1000, name = '' } = {}) {
  const direct = sessionFileOf(sessionId);
  if (direct) {
    try {
      const stat = await fsp.stat(direct);
      if (Date.now() - stat.mtimeMs <= maxAgeMs) return { file: direct, viaFallback: false };
    } catch {
      // 文件没了，走兜底
    }
  }
  const fallback = newestSessionFile({ skipPrefixes, maxAgeMs, name });
  if (fallback) return { file: fallback.file, viaFallback: true };
  return direct ? { file: direct, viaFallback: false } : null;
}

// 解压日志尾部：入参文件路径，返回事件对象数组（旧的在前）；失败返回空数组。
async function readTailEvents(file) {
  let handle;
  try {
    const stat = await fsp.stat(file);
    const start = Math.max(0, stat.size - TAIL_BYTES);
    const length = stat.size - start;
    if (length <= 0) return [];
    handle = await fsp.open(file, 'r');
    const buf = Buffer.alloc(length);
    await handle.read(buf, 0, length, start);
    await handle.close();
    handle = null;

    const positions = [];
    let cursor = 0;
    for (;;) {
      const at = buf.indexOf(ZSTD_MAGIC, cursor);
      if (at < 0) break;
      positions.push(at);
      cursor = at + 1;
    }
    // 从文件中间截取时首帧可能不完整，丢掉
    const firstUsable = start > 0 ? 1 : 0;
    const from = Math.max(firstUsable, positions.length - TAIL_FRAMES);
    const chunks = [];
    for (let i = from; i < positions.length; i += 1) {
      const end = i + 1 < positions.length ? positions[i + 1] : buf.length;
      try {
        chunks.push(zlib.zstdDecompressSync(buf.subarray(positions[i], end)));
      } catch {
        // 单帧损坏不影响其余帧
      }
    }
    const text = Buffer.concat(chunks).toString('utf8');
    const events = [];
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try {
        events.push(JSON.parse(line));
      } catch {
        // 跳过半行
      }
    }
    return events;
  } catch {
    return [];
  } finally {
    if (handle) {
      try { await handle.close(); } catch { /* 忽略 */ }
    }
  }
}

// 取文本片段：入参内容块数组与类型，返回拼接后的纯文本。
function textOf(content, type) {
  if (!Array.isArray(content)) return '';
  return content
    .filter((c) => c && c.type === type && typeof c.text === 'string')
    .map((c) => c.text)
    .join('\n')
    .trim();
}

// 工具调用的一句话说明：入参调用事件，返回短描述。
function toolDetailOf(event) {
  const raw = event?.data?.arguments;
  if (typeof raw !== 'string') return '';
  try {
    const args = JSON.parse(raw);
    const detail = args.description || args.query || args.pattern || args.file_path
      || args.path || args.command || '';
    return String(detail).replace(/\s+/g, ' ').slice(0, 90);
  } catch {
    return String(raw).replace(/\s+/g, ' ').slice(0, 90);
  }
}

// 往活动快照里追加一条流水事件：入参 snapshot 与事件，副作用是写入并限长。
function pushFeedEvent(snapshot, item) {
  if (!snapshot.feed) snapshot.feed = [];
  snapshot.feed.push(item);
  if (snapshot.feed.length > 16) snapshot.feed.shift();
}

// 把事件流压成一个活动快照：入参事件数组，返回 { turn, step, tool, thinking, incoming, said, lastAt, finished }。
function summarize(events) {
  const out = {
    turn: null,
    step: null,
    stepStartedAt: null,
    tool: null,
    toolAt: null,
    thinking: '',
    thinkingAt: null,
    incoming: '',
    incomingAt: null,
    said: '',
    lastAt: null,
    finished: false,
    recent: [],
    feed: [],
    stamps: []
  };
  for (const ev of events) {
    if (!ev || typeof ev.type !== 'string') continue;
    if (Number.isFinite(ev.time)) {
      out.lastAt = ev.time;
      out.stamps.push(ev.time);
      if (out.stamps.length > 600) out.stamps.shift();
    }
    const data = ev.data || {};
    if (ev.type === 'turn/start') {
      out.turn = data.turn ?? out.turn;
      out.step = null;
      out.finished = false;
      pushFeedEvent(out, { at: ev.time ?? 0, k: 'turn', n: data.turn ?? null });
    } else if (ev.type === 'step/start') {
      out.step = data.step ?? out.step;
      out.stepStartedAt = ev.time ?? null;
    } else if (ev.type === 'tool/call') {
      out.tool = { name: data.name || 'tool', detail: toolDetailOf(ev), at: ev.time ?? null };
      out.toolAt = ev.time ?? null;
      out.recent.push({ name: data.name || 'tool', at: ev.time ?? null });
      if (out.recent.length > 6) out.recent.shift();
      pushFeedEvent(out, { at: ev.time ?? 0, k: 'tool', n: data.name || 'tool', t: toolDetailOf(ev) });
    } else if (ev.type === 'assistant/message') {
      const content = data.message?.content;
      const reasoning = textOf(content, 'reasoning');
      const said = textOf(content, 'text');
      if (reasoning) {
        out.thinking = reasoning.slice(-700);
        out.thinkingAt = ev.time ?? null;
        pushFeedEvent(out, { at: ev.time ?? 0, k: 'think', t: reasoning.replace(/\s+/g, ' ').slice(-90) });
      }
      if (said) out.said = said.slice(-240);
    } else if (ev.type === 'user/message') {
      const text = textOf(data.content, 'text');
      const isNotice = !text || text.startsWith('[') || text.startsWith('<')
        || text.includes('system-reminder') || text.includes('time zone for this request');
      if (!isNotice) {
        out.incoming = text.slice(-160);
        out.incomingAt = ev.time ?? null;
      }
    } else if (ev.type === 'turn/end') {
      out.finished = true;
    }
  }
  return out;
}

// 合并两次快照：入参新值与前值，返回补齐后的活动对象（新值优先，缺项沿用旧值）。
function mergeActivity(fresh, prev) {
  if (!prev) return fresh;
  if (!fresh) return prev;
  return {
    ...fresh,
    turn: fresh.turn ?? prev.turn,
    step: fresh.step ?? prev.step,
    stepStartedAt: fresh.stepStartedAt ?? prev.stepStartedAt,
    tool: fresh.tool || prev.tool,
    toolAt: fresh.toolAt ?? prev.toolAt,
    thinking: fresh.thinking || prev.thinking,
    thinkingAt: fresh.thinkingAt ?? prev.thinkingAt,
    incoming: fresh.incoming || prev.incoming,
    incomingAt: fresh.incomingAt ?? prev.incomingAt,
    said: fresh.said || prev.said,
    lastAt: fresh.lastAt ?? prev.lastAt,
    stamps: fresh.stamps && fresh.stamps.length ? fresh.stamps : prev.stamps,
    recent: fresh.recent && fresh.recent.length ? fresh.recent : prev.recent
  };
}

// 活动缓存：文件路径 → { size, mtimeMs, value }；文件没变就不重复解压。
const activityCache = new Map();

// 回退取文件的排除规则：跳过其他成员已登记的 sessionId 与其历史分段，
// 避免把别人的日志当成自己的（多人同时干活时最容易串）。
function botSessionOptions(bot, botList) {
  const own = new Set([bot.sessionId || bot.id])
  for (const seg of bot.segments || []) if (seg && seg.sessionId) own.add(seg.sessionId)
  const skipPrefixes = []
  for (const other of botList) {
    if (other.id === bot.id) continue
    const ids = [other.sessionId, other.id, ...(other.segments || []).map((seg) => seg && seg.sessionId)]
    for (const id of ids) if (id) skipPrefixes.push(id)
  }
  // name 必须传：resolveBotSessionFile 靠它判断"这是不是这个成员自己的会话"。
  // 不传就会跳过归属检查、直接拿最近写入的那个会话，导致所有空闲成员显示同一个人的思考。
  return { skipPrefixes, maxAgeMs: 30 * 60 * 1000, name: bot.name || '' }
}

// 取某会话的最近活动：入参会话 id，返回活动快照或 null。
// 会先解析出真实文件（状态里的 sessionId 可能已过期），再用该文件读尾部事件。
async function activityOf(sessionId, options = {}) {
  const resolved = await resolveBotSessionFile(sessionId, options);
  if (!resolved) return null;
  const file = resolved.file;
  let stat;
  try {
    stat = await fsp.stat(file);
  } catch {
    return null;
  }
  const cached = activityCache.get(file);
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
    return cached.value;
  }
  const events = await readTailEvents(file);
  const fresh = events.length ? summarize(events) : null;
  const value = mergeActivity(fresh, cached ? cached.value : null);
  activityCache.set(file, { size: stat.size, mtimeMs: stat.mtimeMs, value });
  return value;
}

// 读取整个会话日志并按时间窗过滤：入参文件、起止时间，返回精简事件数组。
// 只保留时间、类型、工具名与短文本，正文不整段返回。
async function readWindowEvents(file, from, to) {
  const buf = await fsp.readFile(file);
  const positions = [];
  let cursor = 0;
  for (;;) {
    const at = buf.indexOf(ZSTD_MAGIC, cursor);
    if (at < 0) break;
    positions.push(at);
    cursor = at + 1;
  }
  const chunks = [];
  for (let i = 0; i < positions.length; i += 1) {
    const end = i + 1 < positions.length ? positions[i + 1] : buf.length;
    try {
      chunks.push(zlib.zstdDecompressSync(buf.subarray(positions[i], end)));
    } catch {
      // 单帧损坏跳过
    }
  }
  const text = Buffer.concat(chunks).toString('utf8');
  const out = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (!Number.isFinite(ev.time) || ev.time < from || ev.time > to) continue;
    const data = ev.data || {};
    if (ev.type === 'tool/call') {
      out.push({ at: ev.time, k: 'tool', n: String(data.name || 'tool'), d: toolDetailOf(ev) });
    } else if (ev.type === 'assistant/message') {
      const content = data.message?.content;
      const text2 = textOf(content, 'reasoning') || textOf(content, 'text');
      if (text2) out.push({ at: ev.time, k: 'think', t: text2.replace(/\s+/g, ' ').slice(0, 220) });
    } else if (ev.type === 'turn/start') {
      out.push({ at: ev.time, k: 'turn', n: data.turn ?? null });
    }
  }
  out.sort((a, b) => a.at - b.at);
  // 每台机器最多保留 600 条，超出等距抽样，保证整段过程都在
  if (out.length > 600) {
    const step = out.length / 600;
    const sampled = [];
    for (let i = 0; i < 600; i += 1) sampled.push(out[Math.floor(i * step)]);
    return sampled;
  }
  return out;
}

// 回放缓存：文件 + 时间窗 → 事件数组。
const replayCache = new Map();

// 取某会话在时间窗内的事件：入参会话 id、起止时间，返回精简事件数组。
async function windowEventsOf(sessionId, from, to) {
  const file = sessionFileOf(sessionId);
  if (!file) return [];
  let stat;
  try {
    stat = await fsp.stat(file);
  } catch {
    return [];
  }
  const key = `${file}|${from}|${to}`;
  const cached = replayCache.get(key);
  if (cached && cached.size === stat.size) return cached.events;
  const events = await readWindowEvents(file, from, to);
  replayCache.set(key, { size: stat.size, events });
  return events;
}

// 组装回放数据：入参起止时间，返回 { bots, exchanges, from, to }。
async function buildReplay(from, to) {
  const state = await readJson(STATE_FILE);
  const bots = Object.values((state && state.bots) || {});
  const nameOf = new Map(bots.map((b) => [b.id, b.name]));

  const exchanges = ((state && state.exchanges) || [])
    .filter((e) => e && Number.isFinite(e.time) && e.time >= from && e.time <= to)
    .map((e) => ({ from: e.from, to: e.to, role: e.role || '', time: e.time }))
    .sort((a, b) => a.time - b.time);

  const withEvents = await Promise.all(bots.map(async (bot) => {
    const sessionId = bot.sessionId || bot.id;
    const events = await windowEventsOf(sessionId, from, to);
    return {
      id: bot.id,
      name: bot.name || bot.id,
      role: bot.role || '',
      color: bot.color || 'gray',
      events
    };
  }));

  return {
    ok: true,
    from,
    to,
    mainIds: (state && state.mainBotIds) || [],
    bots: withEvents,
    exchanges,
    names: Object.fromEntries(nameOf)
  };
}


// 清洗失败信息：入参原始 message，返回可读短句。
// 先按 JSON 字段取值（有的上游返回的是被截断的 JSON，不能直接解析），再退回原文。
function cleanFailure(raw) {
  const text = String(raw || '');
  const field = text.match(/"(?:msg|message|gateway_hint|error)"\s*:\s*"([^"]+)"/);
  if (field) return field[1].replace(/\\[nrt]/g, ' ').replace(/\s+/g, ' ').slice(0, 70);
  const brace = text.indexOf('{');
  if (brace >= 0) {
    try {
      const obj = JSON.parse(text.slice(brace));
      const pick = obj.msg || obj.message || obj.gateway_hint || obj.code || '';
      if (pick) return String(pick).replace(/\s+/g, ' ').slice(0, 70);
    } catch {
      // 截断的 JSON 解析不了，走下面的原文分支
    }
  }
  return text.replace(/\s+/g, ' ').slice(0, 70);
}

// 每个成员的历史用量缓存：文件路径 → { frames, turns, tools, inTokens, outTokens, cacheTokens }。
const statsCache = new Map();

// 增量扫描会话日志：入参文件路径，返回累计 { turns, tools, inTokens, outTokens, cacheTokens }。
// 只解压上次之后新增的帧，失败的那一帧留到下次重试。
async function scanSessionStats(file) {
  const cached = statsCache.get(file) || {
    frames: 0, turns: 0, tools: 0, inTokens: 0, outTokens: 0, cacheTokens: 0,
    retries: 0, toolErrors: 0, failures: [], toolCounts: {}
  };
  let buf;
  try {
    buf = await fsp.readFile(file);
  } catch {
    return cached;
  }
  const positions = [];
  let cursor = 0;
  for (;;) {
    const at = buf.indexOf(ZSTD_MAGIC, cursor);
    if (at < 0) break;
    positions.push(at);
    cursor = at + 1;
  }
  if (positions.length <= cached.frames) return cached;

  const next = { ...cached, failures: [...(cached.failures || [])], toolCounts: { ...(cached.toolCounts || {}) } };
  let processed = cached.frames;
  for (let i = cached.frames; i < positions.length; i += 1) {
    const end = i + 1 < positions.length ? positions[i + 1] : buf.length;
    let text;
    try {
      text = zlib.zstdDecompressSync(buf.subarray(positions[i], end)).toString('utf8');
    } catch {
      // 帧还没写完，下次再扫
      break;
    }
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      if (ev.type === 'turn/start') next.turns += 1;
      else if (ev.type === 'tool/call') {
        next.tools += 1;
        const toolName = ev.data && ev.data.name;
        if (toolName) {
          next.toolCounts[toolName] = (next.toolCounts[toolName] || 0) + 1;
        }
      }
      else if (ev.type === 'tool/result') {
        if (ev.data && ev.data.isError) next.toolErrors = (next.toolErrors || 0) + 1;
      } else if (ev.type === 'llm/retry') {
        next.retries = (next.retries || 0) + 1;
        const f = (ev.data && ev.data.failure) || {};
        next.failures.push({
          at: ev.time,
          code: String(f.code || (ev.data && ev.data.provider) || 'RETRY'),
          message: cleanFailure(f.message || 'retry')
        });
      } else if (ev.type === 'assistant/attempt') {
        const fr = ev.data && ev.data.finish && ev.data.finish.reason;
        const f = fr && fr.failure;
        if (f) {
          next.failures.push({
            at: ev.time,
            code: String(f.code || fr.kind || 'FAILED'),
            message: cleanFailure(f.message || 'failed')
          });
        }
      }
      else if (ev.type === 'assistant/message' && ev.data && ev.data.usage) {
        const u = ev.data.usage;
        next.inTokens += Number(u.inputTokens) || 0;
        next.outTokens += Number(u.outputTokens) || 0;
        next.cacheTokens += Number(u.cacheReadTokens) || 0;
      }
    }
    processed = i + 1;
  }
  if (next.failures.length > 5) next.failures = next.failures.slice(-5);
  next.frames = processed;
  statsCache.set(file, next);
  return next;
}

// 汇总实时数据：入参无，返回给前端的大屏快照。
// 读「已确认」名单：返回 Set<exchangeId>。
async function readConfirmed() {
  const data = await readJson(TASK_CONFIRM_FILE);
  const arr = data && Array.isArray(data.confirmed) ? data.confirmed : [];
  return new Set(arr);
}

// 派活正文取第一行做标题，去掉 markdown 记号，过长截断。
function briefTitle(text) {
  const first = String(text || '')
    .split('\n')
    .map((line) => line.replace(/[*#`>]/g, '').trim())
    .filter(Boolean)[0];
  const title = first || '（无标题）';
  return title.length > 34 ? `${title.slice(0, 34)}…` : title;
}

// 任务流转：从 state.exchanges 推导「派发 → 处理 → 回执 → 待确认」。
// request 是派发；reply 用 replyTo 指回对应的 request。
// 规则：大管家派出 + 已有回执 + 用户还没点确认 → 进「需要你处理」；确认过就消失。
function buildTasks(state, inflight) {
  const list = Array.isArray(state && state.exchanges) ? state.exchanges : [];
  const botMap = (state && state.bots) || {};
  const mainIds = new Set((state && state.mainBotIds) || []);
  const nameOf = (id) => (botMap[id] && botMap[id].name) || '成员';
  const replies = new Map();
  for (const e of list) {
    if (e && e.role === 'reply' && e.replyTo) replies.set(e.replyTo, e);
  }
  // 真正在跑的成员，以及这一轮是什么时候开始的：
  // 只判「该成员在跑」还不够——他可能正在跑另一件事，
  // 一条几十小时前、没有回执的旧派发会被误判成「处理中」。
  const runningSince = new Map();
  for (const turn of Object.values((inflight && inflight.turns) || {})) {
    if (turn && turn.botId && Number.isFinite(turn.since)) {
      const prev = runningSince.get(turn.botId);
      if (prev === undefined || turn.since < prev) runningSince.set(turn.botId, turn.since);
    }
  }
  const out = [];
  for (const e of list) {
    if (!e || e.role !== 'request' || !mainIds.has(e.from)) continue;
    const reply = replies.get(e.id);
    // 刚回执的：先展示几秒「谁回了」，让用户看到回执方，然后再消失。
    if (reply) {
      if (Number.isFinite(reply.time) && Date.now() - reply.time < 8000) {
        out.push({
          id: e.id,
          to: nameOf(e.to),
          acker: nameOf(reply.from),
          title: briefTitle(e.text),
          dispatchedAt: e.time,
          ackedAt: reply.time,
          state: 'done'
        });
      }
      continue;
    }
    // 没有回执的派发，满足两点才算「处理中」：
    // ① 该成员现在确实在跑；② 派发时间在最近 30 分钟内。
    // 不能用「派发时间 ≥ 本轮开始」判断——Bot 正在跑别的活时新任务会排队，
    // 要等当前任务结束才开新一轮，那样排队中的任务会被误判成历史遗留而消失。
    if (!runningSince.has(e.to)) continue;
    if (!Number.isFinite(e.time)) continue;
    if (Date.now() - e.time > 30 * 60 * 1000) continue;
    out.push({
      id: e.id,
      to: nameOf(e.to),
      title: briefTitle(e.text),
      dispatchedAt: e.time,
      ackedAt: null,
      state: 'working'
    });
  }
  // 在跑的最前，其次是刚回执的
  out.sort((a, b) => {
    const rank = (t) => (t.state === 'working' ? 0 : 1);
    if (rank(a) !== rank(b)) return rank(a) - rank(b);
    return (b.ackedAt || b.dispatchedAt) - (a.ackedAt || a.dispatchedAt);
  });
  return out.slice(0, 30);
}

async function buildLive() {
  const state = await readJson(STATE_FILE);
  const inflight = await readJson(INFLIGHT_FILE);
  const now = Date.now();

  if (now - sessionIndexAt > 60_000) await rebuildSessionIndex();

  const turns = (inflight && inflight.turns) || {};
  const queued = (inflight && inflight.queued) || {};
  const turnList = Object.values(turns).filter(Boolean);
  const queuedItems = Object.values(queued).filter(Array.isArray).flat().filter(Boolean);

  const workingSinceOf = (botId) => {
    const turn = turnList.find((t) => t.botId === botId && Number.isFinite(t.since));
    return turn ? turn.since : null;
  };
  const queuedOf = (botId) => queuedItems.filter((q) => q.args && q.args.toId === botId).length;

  const botList = Object.values((state && state.bots) || {});

  // 最近一条发给该成员的消息：直接取消息流水，语义比会话日志里的系统提示可靠。
  const allExchanges = ((state && state.exchanges) || [])
    .filter((e) => e && Number.isFinite(e.time))
    .sort((a, b) => a.time - b.time);
  const lastIncoming = new Map();
  for (const ex of allExchanges) {
    if (!ex.to) continue;
    const clean = String(ex.text || '').replace(/\s+/g, ' ').trim();
    lastIncoming.set(ex.to, {
      from: ex.from,
      role: ex.role || '',
      at: ex.time,
      text: clean.slice(0, 120)
    });
  }

  const bots = await Promise.all(botList.map(async (bot) => {
    const since = workingSinceOf(bot.id);
    const sessionId = bot.sessionId || bot.id;
    const activity = await activityOf(sessionId, botSessionOptions(bot, botList));
    const statsFile = sessionFileOf(sessionId);
    const raw = statsFile ? await scanSessionStats(statsFile) : null;
    const stats = raw ? {
      turns: raw.turns,
      tools: raw.tools,
      inTokens: raw.inTokens,
      outTokens: raw.outTokens,
      cacheTokens: raw.cacheTokens,
      retries: raw.retries || 0,
      toolErrors: raw.toolErrors || 0,
      toolCounts: raw.toolCounts || {},
      failures: (raw.failures || []).slice(-3)
    } : null;
    return {
      id: bot.id,
      name: bot.name || bot.id,
      role: bot.role || '',
      color: bot.color || 'gray',
      model: bot.model || '',
      working: since !== null,
      workingSince: since,
      queued: queuedOf(bot.id),
      sessionId,
      activity,
      stats,
      received: lastIncoming.get(bot.id) || null
    };
  }));

  // 统一流水：派活/回执 + 各成员的思考、工具调用、轮次
  const feed = [];
  for (const ex of allExchanges) {
    feed.push({
      at: ex.time,
      k: ex.role === 'request' ? 'request' : ex.role === 'stopped' ? 'stopped' : 'reply',
      bot: ex.from,
      to: ex.to,
      text: String(ex.text || '').replace(/\s+/g, ' ').trim().slice(0, 120)
    });
  }
  for (const bot of bots) {
    for (const item of (bot.activity && bot.activity.feed) || []) {
      feed.push({
        at: item.at,
        k: item.k,
        bot: bot.id,
        tool: item.n || '',
        text: item.k === 'turn' ? `第 ${item.n ?? '?'} 轮开始` : (item.t || '')
      });
    }
  }

  // ── 群消息 ────────────────────────────────────────────────
  // rooms[].log 里是各群的聊天记录，但只有 seq 序号、没有时间戳，
  // 所以进不了按时间排序的流水。这里按「首次见到它的时刻」补一个时间：
  // 第一次加载时把历史消息按序号往前铺（每条隔 15 秒），之后新消息就用当前时间。
  // 代价是历史消息的时间是推算的，新消息是准确的——对"看清此刻发生了什么"够用。
  const roomNameById = new Map();
  for (const r of Object.values((state && state.rooms) || {})) {
    const logs = Array.isArray(r.log) ? r.log : [];
    const roomName = r.name || '群聊';
    roomNameById.set(r.id, roomName);
    const seen = new Set();
    logs.forEach((m, idx) => {
      if (!m || !m.text) return;
      const seqKey = `${r.id}:${m.seq ?? idx}`;
      seen.add(seqKey);
      let at = roomSeenAt.get(seqKey);
      if (!at) {
        at = now - (logs.length - idx) * 15000;
        roomSeenAt.set(seqKey, at);
      }
      feed.push({
        at,
        k: 'room',
        room: roomName,
        roomId: r.id,
        bot: m.botId || '',
        who: m.who || '',
        text: String(m.text).replace(/\s+/g, ' ').trim().slice(0, 120)
      });
    });
    // 只保留该群当前仍存在的条目，防止映射无限增长
    for (const key of roomSeenAt.keys()) {
      if (key.startsWith(`${r.id}:`) && !seen.has(key)) roomSeenAt.delete(key);
    }
  }

  feed.sort((a, b) => a.at - b.at);

  // 活跃度曲线：把最近事件按分钟聚合，窗口 60 分钟
  const WINDOW_MIN = 60;
  const nowMin = Math.floor(now / 60000);
  const buckets = new Array(WINDOW_MIN).fill(0);
  const pushStamp = (t) => {
    if (!Number.isFinite(t)) return;
    const idx = WINDOW_MIN - 1 - (nowMin - Math.floor(t / 60000));
    if (idx >= 0 && idx < WINDOW_MIN) buckets[idx] += 1;
  };
  for (const bot of bots) {
    for (const t of (bot.activity && bot.activity.stamps) || []) pushStamp(t);
  }
  for (const ex of allExchanges) pushStamp(ex.time);
  const activity = {
    windowMin: WINDOW_MIN,
    buckets,
    max: Math.max(1, ...buckets),
    total: buckets.reduce((a, b) => a + b, 0)
  };

  const mainIds = (state && state.mainBotIds) || [];
  const exchanges = allExchanges.slice(-200).map((e) => ({
    id: e.id || '',
    from: e.from,
    to: e.to,
    role: e.role || '',
    time: e.time,
    // 日志流要显示派活与回执说了什么；只截断，不加工
    text: String(e.text || '').replace(/\s+/g, ' ').trim().slice(0, 200)
  }));

  const rooms = Object.values((state && state.rooms) || {}).map((r) => ({
    id: r.id,
    name: r.name || '群聊',
    members: Array.isArray(r.members) ? r.members.length : 0,
    // 成员 id 列表：前端切到"群视角"时用它过滤拓扑、卡片、统计
    memberIds: Array.isArray(r.members) ? r.members.filter((m) => typeof m === 'string') : [],
    // 这个群的管理员：群视角下拓扑中心应该显示它，而不是全局主 Bot
    adminId: r.admin || ''
  }));

  const works = Object.values((state && state.works) || {});

  return {
    ok: true,
    tasks: buildTasks(state, inflight),
    generatedAt: now,
    mainIds,
    bots,
    exchanges,
    rooms,
    feed: feed.slice(-1200),   // 240 太小：一个群跑一轮就把另一个群的消息挤出窗口
    activity,
    openWorks: works.filter((w) => w && w.open).length
  };
}

// 发送 JSON：入参 res 与 body，副作用为写响应，禁止缓存。
function sendJson(res, body) {
  const text = JSON.stringify(body);
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(text),
    'Cache-Control': 'no-store'
  });
  res.end(text);
}

// 提供静态文件：入参 res 与 pathname，副作用为写响应；越界路径一律拒绝。
async function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
  const target = path.resolve(PUBLIC_DIR, rel);
  if (target !== PUBLIC_DIR && !target.startsWith(PUBLIC_DIR + path.sep)) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('forbidden');
    return;
  }
  try {
    const data = await fsp.readFile(target);
    const type = MIME[path.extname(target).toLowerCase()] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': data.length, 'Cache-Control': 'no-store' });
    res.end(data);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('not found');
  }
}


// 挂载前缀：DSH 的 webServer 把插件路由挂在同一台监听上，用一个前缀隔开，
// 避免和其他插件的路径撞车（重复的 (kind, path) 会直接抛错）。
const MOUNT = '/bot-stage';

// 统一入口：剥掉挂载前缀后按剩余路径分发。
// webServer 的 route.handler 就是标准 Node (req, res) 语义。
async function handle(req, res) {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  let pathname = url.pathname;
  if (pathname === MOUNT) pathname = '/';
  else if (pathname.startsWith(MOUNT + '/')) pathname = pathname.slice(MOUNT.length);

  if (pathname === '/api/replay') {
    const from = Number(url.searchParams.get('from'));
    const to = Number(url.searchParams.get('to'));
    if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) {
      sendJson(res, { ok: false, error: 'from/to 不合法' });
      return;
    }
    buildReplay(from, to)
      .then((data) => sendJson(res, data))
      .catch((err) => sendJson(res, { ok: false, error: String(err.message || err) }));
    return;
  }

  if (pathname === '/api/live') {
    buildLive()
      .then((data) => sendJson(res, data))
      .catch((err) => sendJson(res, { ok: false, error: String(err.message || err) }));
    return;
  }
  // 确认任务：只写本看板自己的 data/task-confirm.json，不碰被读取的 Bot 状态文件
  if (req.method === 'POST' && pathname === '/api/tasks/confirm') {
    let raw = '';
    req.on('data', (chunk) => { raw += chunk; });
    req.on('end', async () => {
      try {
        const parsed = JSON.parse(raw || '{}');
        const id = String(parsed.id || '');
        if (!id) {
          sendJson(res, { ok: false, error: 'missing id' });
          return;
        }
        const data = (await readJson(TASK_CONFIRM_FILE)) || {};
        const list = Array.isArray(data.confirmed) ? data.confirmed : [];
        if (!list.includes(id)) list.push(id);
        await fsp.mkdir(path.dirname(TASK_CONFIRM_FILE), { recursive: true });
        await fsp.writeFile(TASK_CONFIRM_FILE, `${JSON.stringify({ confirmed: list }, null, 2)}\n`, 'utf8');
        sendJson(res, { ok: true, id, total: list.length });
      } catch (err) {
        sendJson(res, { ok: false, error: String(err.message || err) });
      }
    });
    return;
  }
  if (req.method !== 'GET') {
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('method not allowed');
    return;
  }
  serveStatic(res, pathname);
}

// ── cordis 插件出口 ──────────────────────────────────────────
export const name = 'dsbot-monitoring';
export const inject = ['webServer'];

export function apply(ctx) {
  // 会话索引：首次建一次，之后每分钟刷新
  ctx.effect(() => {
    void rebuildSessionIndex().catch((err) => ctx.logger?.warn?.(err));
    const timer = setInterval(() => {
      void rebuildSessionIndex().catch(() => {});
    }, 60_000);
    timer.unref?.();
    return () => clearInterval(timer);
  }, 'dsbot-monitoring: session index');

  // 用量预热：后台先扫一遍，别让第一屏等太久
  ctx.effect(() => {
    const timer = setTimeout(() => {
      void warmStats().catch(() => {});
    }, 200);
    timer.unref?.();
    return () => clearTimeout(timer);
  }, 'dsbot-monitoring: warmup');

  // 只注册一条前缀路由，整棵 /bot-stage 子树都由 handle 分派。
  //
  // 为什么不额外注册三个 exact（api/live、api/replay、api/tasks/confirm）：
  // webServer 的匹配是「先查 exact，未命中再按最长前缀匹配」，而 prefix 已经
  // 覆盖了这三个路径。多注册 exact 不会让请求更快，只会让它们变成永远不会
  // 单独生效的死配置——将来有人改了 handle 里的分派却忘了同步 exact，
  // 就会出现「改了却不生效」而且不报错。一条路由，一处真相。
  ctx.effect(
    () => ctx.webServer.register({ kind: 'prefix', path: MOUNT, handler: handle }),
    `dsbot-monitoring: ${MOUNT}`
  );
}
