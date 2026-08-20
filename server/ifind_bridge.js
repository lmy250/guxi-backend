// 同花顺 iFinD 数据桥（Node 内置 https，无需额外依赖）
// 作用：把小程序请求转接到同花顺 iFinD MCP 服务（https://api-mcp.51ifind.com:8643）。
// 提供 quote / kline / finance / market 方法，返回结构与 akshare_bridge.py / mock 对齐，方便 server.js 无缝切换。
//
// 依赖：server/ifind_config.json 里要有有效的 auth_token（从 iFinD MCP 官网个人中心获取）。
// 注意：免费版并发 2 req/s，这里做了串行 + 最小间隔限流。
const fs = require('fs');
const path = require('path');
const https = require('https');

let AUTH_TOKEN = process.env.IFIND_TOKEN || null;
if (!AUTH_TOKEN) {
  try {
    AUTH_TOKEN = JSON.parse(fs.readFileSync(path.join(__dirname, 'ifind_config.json'), 'utf-8')).auth_token;
  } catch (e) {
    AUTH_TOKEN = null;
  }
}

const BASE = 'https://api-mcp.51ifind.com:8643/ds-mcp-servers';
const SERVERS = {
  stock: BASE + '/hexin-ifind-ds-stock-mcp',
  index: BASE + '/hexin-ifind-ds-index-mcp',
};

const _sessions = {};
let reqId = 0;
let lastCall = 0;
let _queue = Promise.resolve();

function post(server, payload) {
  return new Promise((resolve, reject) => {
    const u = new URL(SERVERS[server]);
    const headers = {
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream',
      'Authorization': AUTH_TOKEN,
    };
    if (_sessions[server]) headers['Mcp-Session-Id'] = _sessions[server];
    const req = https.request({
      hostname: u.hostname, port: u.port, path: u.pathname,
      method: 'POST', headers, timeout: 30000,
    }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        if (!_sessions[server] && res.headers['mcp-session-id']) _sessions[server] = res.headers['mcp-session-id'];
        resolve({ status: res.statusCode, data });
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('iFinD timeout')); });
    req.write(JSON.stringify(payload));
    req.end();
  });
}

async function init(server) {
  if (_sessions[server]) return;
  await post(server, { jsonrpc: '2.0', id: ++reqId, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'stock-server', version: '1.0.0' } } });
  await post(server, { jsonrpc: '2.0', method: 'notifications/initialized' });
}

// 串行 + 最小间隔，避免超免费版 2 req/s 并发上限
function throttled(fn) {
  return function (...args) {
    const run = _queue.then(async () => {
      const wait = 600 - (Date.now() - lastCall);
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      lastCall = Date.now();
      return fn(...args);
    });
    _queue = run.catch(() => {});
    return run;
  };
}

async function callRaw(server, toolName, params) {
  if (!AUTH_TOKEN) throw new Error('iFinD token 未配置');
  await init(server);
  const { status, data } = await post(server, { jsonrpc: '2.0', id: ++reqId, method: 'tools/call', params: { name: toolName, arguments: params } });
  if (status >= 400) throw new Error('iFinD HTTP ' + status);
  const j = JSON.parse(data);
  if (j.error) throw new Error('iFinD error: ' + JSON.stringify(j.error).slice(0, 200));
  const text = j.result && j.result.content && j.result.content[0] && j.result.content[0].text;
  const resp = JSON.parse(text);
  if (resp.code !== 1 && resp.code !== '1') throw new Error('iFinD code=' + resp.code + ' ' + (resp.msg || ''));
  return unwrap(resp);
}
const call = throttled(callRaw);

function unwrap(resp) {
  if (typeof resp.data === 'string') {
    try { return JSON.parse(resp.data); } catch (e) { return { answer: resp.data }; }
  }
  return resp.data || {};
}

// ---------------- 解析工具 ----------------
function parseNum(v) {
  if (v == null) return null;
  if (typeof v === 'number') return v;
  let s = String(v).trim().replace(/,/g, '');
  if (s === '' || s === '--' || s === '\t' || s.toLowerCase() === 'nan') return null;
  let mult = 1;
  if (/万亿$/.test(s)) { mult = 1e12; s = s.slice(0, -2); }
  else if (/亿$/.test(s)) { mult = 1e8; s = s.slice(0, -1); }
  else if (/万$/.test(s)) { mult = 1e4; s = s.slice(0, -1); }
  const n = parseFloat(s);
  return Number.isNaN(n) ? null : n * mult;
}

function fmtDate(s) {
  s = String(s || '').trim();
  if (/^\d{8}$/.test(s)) return s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8);
  return s.slice(0, 10);
}

// markdown 表格 → [{列名: 值}, ...]
function parseMdTable(answer) {
  const lines = String(answer || '').split('\n').filter((l) => l.trim().startsWith('|'));
  if (lines.length < 2) return [];
  const header = lines[0].split('|').map((s) => s.trim());
  const rows = [];
  for (let i = 2; i < lines.length; i++) {
    const cells = lines[i].split('|').map((s) => s.trim());
    const row = {};
    for (let c = 1; c < header.length; c++) {
      const key = header[c];
      if (key === '' || key === '-') continue;
      row[key] = cells[c];
    }
    rows.push(row);
  }
  return rows;
}

// 按关键字模糊取列（列名可能带「（单位：元）」等后缀）
function col(row, ...keys) {
  for (const k of Object.keys(row)) {
    for (const key of keys) {
      if (k.includes(key)) return row[k];
    }
  }
  return null;
}

// ---------------- 代码转换 ----------------
function toIfindCode(code) {
  code = String(code || '').trim();
  if (/^(sh|sz|SH|SZ)/.test(code)) return code.slice(2);
  if (/^(hk|HK)/.test(code)) return code.slice(2);
  if (/^(bj|BJ)/.test(code)) return code.slice(2);
  if (/^(us|US)/i.test(code)) return code.slice(2);
  return code;
}

// iFinD 返回的 "301655.SZ" → 小程序用的 "sz301655"
function normalizeCode(c) {
  c = String(c || '').trim();
  const parts = c.split('.');
  if (parts.length === 2) {
    const suf = parts[1].toLowerCase();
    const pre = suf === 'sh' ? 'sh' : suf === 'sz' ? 'sz' : 'bj';
    return pre + parts[0];
  }
  return c;
}

// ---------------- 对外方法（与 akshare_bridge / mock 返回结构一致） ----------------

async function quote({ code }) {
  const sym = toIfindCode(code);
  const d = await call('stock', 'stock_highfreq_quotes', {
    symbols: sym,
    // 单次上限 10 个指标；换手率砍掉（非核心），成交额由 最新价*成交量 估算
    indicators: '最新价,涨跌幅,涨跌,开盘价,最高价,最低价,成交量,总市值,市盈率TTM,市净率',
    data_mode: 'real_time',
  });
  const header = (d.tables && d.tables[0]) || [];
  const row = (d.tables && d.tables[1]) || [];
  const get = (name) => row[header.indexOf(name)];
  const price = parseNum(get('最新价'));
  const change = parseNum(get('涨跌'));
  const changePctRaw = parseNum(get('涨跌幅')); // iFinD 返回百分比数值，如 -1.19
  const volHands = parseNum(get('成交量')) || 0; // 单位：手
  const volume = Math.round(volHands * 100); // 转「股」，与 kline 保持一致
  return {
    code,
    name: get('证券简称') || code,
    price: price != null ? price : 0,
    preClose: price != null && change != null ? +(price - change).toFixed(2) : 0,
    open: parseNum(get('开盘价')) || 0,
    high: parseNum(get('最高价')) || 0,
    low: parseNum(get('最低价')) || 0,
    change: change != null ? change : 0,
    changePct: changePctRaw != null ? +(changePctRaw / 100).toFixed(4) : 0,
    volume,
    amount: price != null ? Math.round(price * volume) : 0,
    turnover: null,
    pe: parseNum(get('市盈率TTM')),
    pb: parseNum(get('市净率')),
    marketCap: parseNum(get('总市值')) ? +(parseNum(get('总市值')) / 1e8).toFixed(1) : null,
  };
}

async function kline({ code, period = 'day', limit = 120 }) {
  const sym = toIfindCode(code);
  const n = Math.min(Math.max(Number(limit) || 120, 30), 400);
  const d = await call('stock', 'get_stock_performance', {
    query: `${sym}近${n}个交易日的开盘价、收盘价、最高价、最低价、成交量`,
  });
  const rows = parseMdTable(d.answer);
  const list = rows
    .map((r) => ({
      date: fmtDate(col(r, '日期')),
      open: parseNum(col(r, '开盘价')),
      high: parseNum(col(r, '最高价')),
      low: parseNum(col(r, '最低价')),
      close: parseNum(col(r, '收盘价')),
      volume: parseNum(col(r, '成交量')),
    }))
    .filter((x) => x.date && x.close != null && (x.volume || 0) > 0) // 过滤周末/停牌等无成交的填充日
    .map((x) => ({
      date: x.date,
      open: x.open != null ? x.open : x.close,
      high: x.high != null ? x.high : x.close,
      low: x.low != null ? x.low : x.close,
      close: x.close,
      volume: Math.round(x.volume || 0),
    }))
    .reverse(); // iFinD 最新在前 → 升序（最新在后）
  const final = (period === 'week' || period === 'month') ? aggregate(list, period) : list;
  return { code, period, list: final.slice(-Math.max(Number(limit) || 120, 30)) };
}

// 周/月 K 线从日 K 聚合
function aggregate(list, period) {
  const groups = new Map();
  for (const d of list) {
    const dt = new Date(d.date + 'T00:00:00');
    const key = period === 'month' ? d.date.slice(0, 7) : isoWeekKey(dt);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(d);
  }
  const out = [];
  for (const [key, arr] of groups) {
    arr.sort((a, b) => a.date.localeCompare(b.date));
    out.push({
      date: key,
      open: arr[0].open,
      high: Math.max(...arr.map((x) => x.high)),
      low: Math.min(...arr.map((x) => x.low)),
      close: arr[arr.length - 1].close,
      volume: arr.reduce((s, x) => s + x.volume, 0),
    });
  }
  return out;
}
function isoWeekKey(d) {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y = t.getUTCFullYear();
  const start = new Date(Date.UTC(y, 0, 1));
  const week = 1 + Math.round(((t - start) / 86400000 - 3 + ((start.getUTCDay() + 6) % 7)) / 7);
  return `${y}-W${String(week).padStart(2, '0')}`;
}

async function finance({ code }) {
  const sym = toIfindCode(code);
  const d = await call('stock', 'get_stock_financials', {
    query: `${sym}最新一期的营业收入、净利润、净资产收益率ROE、资产负债率、每股收益、营业收入同比增长率、净利润同比增长率、销售毛利率`,
  });
  const rows = parseMdTable(d.answer);
  const r = rows[rows.length - 1] || {};
  const keys = Object.keys(r);
  const find = (test) => {
    for (const k of keys) if (test(k)) return r[k];
    return null;
  };
  return {
    code,
    reportDate: fmtDate(find((k) => k.includes('日期') || k.includes('报告期'))),
    income: {
      revenue: parseNum(find((k) => k.includes('营业收入') && !k.includes('同比'))) || 0,
      netProfit: parseNum(find((k) => k.includes('净利润') && !k.includes('同比'))) || 0,
      grossMargin: parseNum(find((k) => k.includes('销售毛利率'))) || 0,
      yoyRevenue: parseNum(find((k) => k.includes('营业收入') && k.includes('同比'))) || 0,
      yoyProfit: parseNum(find((k) => k.includes('净利润') && k.includes('同比'))) || 0,
    },
    balance: {
      totalAssets: null,
      totalLiab: null,
      equity: null,
      debtRatio: parseNum(find((k) => k.includes('资产负债率'))) || 0,
    },
    cashflow: { operate: null },
    ratios: {
      roe: parseNum(find((k) => k.includes('净资产收益率'))) || 0,
      roa: null,
      eps: parseNum(find((k) => k.includes('每股收益'))) || 0,
    },
  };
}

// 近 5 期财务（趋势图用）。返回结构对齐 mock.genFinanceHistory，升序（旧→新）。
async function financeHistory({ code }) {
  const sym = toIfindCode(code);
  const d = await call('stock', 'get_stock_financials', {
    query: `${sym}近5个报告期的营业收入、净利润、净资产收益率ROE、资产负债率、销售毛利率`,
  });
  const rows = parseMdTable(d.answer);
  const list = rows
    .map((r) => {
      const keys = Object.keys(r);
      const find = (test) => {
        for (const k of keys) if (test(k)) return r[k];
        return null;
      };
      return {
        reportDate: fmtDate(find((k) => k.includes('日期'))),
        revenue: parseNum(find((k) => k.includes('营业收入') && !k.includes('同比') && !k.includes('单季度'))) || 0,
        netProfit: parseNum(find((k) => k.includes('净利润') && !k.includes('同比') && !k.includes('归属于') && !k.includes('单季度'))) || 0,
        grossMargin: parseNum(find((k) => k.includes('销售毛利率'))) || 0,
        roe: parseNum(find((k) => k.includes('净资产收益率'))) || 0,
        debtRatio: parseNum(find((k) => k.includes('资产负债率'))) || 0,
        yoyRevenue: parseNum(find((k) => k.includes('营业收入') && k.includes('同比'))) / 100 || 0,
        yoyProfit: parseNum(find((k) => k.includes('净利润') && k.includes('同比'))) / 100 || 0,
      };
    })
    .filter((x) => x.reportDate)
    .reverse(); // 最新在前 → 升序（旧→新）
  return { code, list };
}

// 选股筛选：用 iFinD 智能选股（search_stocks）按条件真实全市场筛选。
// 筛选条件与前端 screener.js 对齐：changePctMin/Max、peMax、turnoverMin、marketCapMax、
// industry、maBull、macdGold、volBreak、fundFlowMin（主力净流入占比 %）。
async function screener(filters) {
  // 原始 query 参数是字符串（'false'、''、数字字符串），先归一化：'false'→false、''→null、数字→number
  const raw = filters || {};
  const num = (v) => {
    if (v == null || v === '') return null;
    const n = Number(v);
    return Number.isNaN(n) ? null : n;
  };
  const bool = (v) => v === true || v === 'true' || v === '1';
  const f = {
    changePctMin: num(raw.changePctMin),
    changePctMax: num(raw.changePctMax),
    peMax: num(raw.peMax),
    turnoverMin: num(raw.turnoverMin),
    marketCapMax: num(raw.marketCapMax),
    industry: raw.industry || null,
    maBull: bool(raw.maBull),
    macdGold: bool(raw.macdGold),
    volBreak: bool(raw.volBreak),
    fundFlowMin: num(raw.fundFlowMin),
  };
  const conds = [];
  if (f.peMax != null && f.peMax > 0) conds.push(`市盈率大于0且小于${f.peMax}`);
  if (f.changePctMin != null) conds.push(`今日涨幅大于${f.changePctMin}%`);
  if (f.changePctMax != null) conds.push(`今日涨幅小于${f.changePctMax}%`);
  if (f.turnoverMin != null) conds.push(`换手率大于${f.turnoverMin}%`);
  if (f.marketCapMax != null) conds.push(`总市值小于${f.marketCapMax}亿元`);
  if (f.industry) conds.push(`${f.industry}行业`);
  if (f.maBull) conds.push('均线多头排列');
  if (f.macdGold) conds.push('MACD金叉');
  if (f.volBreak) conds.push('放量突破');
  if (f.fundFlowMin != null && f.fundFlowMin > 0) conds.push(`主力净流入占比大于${f.fundFlowMin}%`);

  const base = conds.length ? conds.join('且') + '的A股' : '今日涨幅排名靠前的A股';
  const query = `${base}，包含最新价、市盈率、换手率、总市值、涨跌幅、所属行业、主力净流入占比，取前50只`;

  const d = await call('stock', 'search_stocks', { query });
  const rows = parseMdTable(d.answer);
  const out = rows
    .map((r) => {
      const keys = Object.keys(r);
      const find = (test) => {
        for (const k of keys) if (test(k)) return r[k];
        return null;
      };
      const chg = parseNum(find((k) => k.includes('涨跌幅')));
      const price = parseNum(find((k) => k.includes('收盘价') || k.includes('最新价')));
      const marketCapRaw = parseNum(find((k) => k.includes('总市值') || k.includes('市值')));
      const industryFull = find((k) => k.includes('所属行业') || k.includes('行业'));
      const fundFlow = parseNum(find((k) => k.includes('主力') && (k.includes('占比') || k.includes('增仓'))));
      return {
        code: normalizeCode(find((k) => k.includes('股票代码') || k.includes('代码'))),
        name: find((k) => k.includes('股票简称') || k.includes('名称')),
        industry: industryShort(industryFull),
        price: price || 0,
        pe: parseNum(find((k) => k.includes('市盈率'))) || 0,
        changePct: chg != null ? +(chg / 100).toFixed(4) : 0,
        turnover: parseNum(find((k) => k.includes('换手率'))) || 0,
        marketCap: marketCapRaw ? +(marketCapRaw / 1e8).toFixed(1) : null,
        fundFlow: fundFlow || 0,
        maBull: !!f.maBull,
        macdGold: !!f.macdGold,
        volBreak: !!f.volBreak,
      };
    })
    .filter((x) => x.code && x.name);
  return out;
}

// "食品饮料-白酒-白酒Ⅲ" → 取二级分类 "白酒"（更直观）
function industryShort(full) {
  if (!full) return null;
  const parts = String(full).split('-').filter(Boolean);
  return parts.length >= 2 ? parts[1] : parts[0];
}

// 市场概览：指数行情 + 涨跌家数 + 涨幅榜（要闻由 server.js 用本地文案补齐）
async function market() {
  // 指数 + 涨跌家数（一次 index 调用，最多 10 个 symbols）
  const d = await call('index', 'index_highfreq_quotes', {
    symbols: '000001.SH,399001.SZ,399006.SZ',
    indicators: '最新价,涨跌幅,上涨家数,下跌家数',
    data_mode: 'real_time',
  });
  const header = (d.tables && d.tables[0]) || [];
  const rows = (d.tables || []).slice(1);
  const indices = rows.map((r) => {
    const get = (n) => r[header.indexOf(n)];
    const chg = parseNum(get('涨跌幅'));
    return {
      name: get('证券简称'),
      value: parseNum(get('最新价')),
      changePct: chg != null ? +(chg / 100).toFixed(4) : 0,
    };
  });
  // 涨跌家数：上证(沪市) + 深证成指(深市) 求和，创业板指是深市子集不重复计入
  const up = rows.slice(0, 2).reduce((s, r) => s + (parseNum(r[header.indexOf('上涨家数')]) || 0), 0);
  const down = rows.slice(0, 2).reduce((s, r) => s + (parseNum(r[header.indexOf('下跌家数')]) || 0), 0);

  // 涨幅榜（一次 stock 智能选股）
  const hotResp = await call('stock', 'search_stocks', { query: '今日涨幅排名前8的股票' });
  const hotRows = parseMdTable(hotResp.answer);
  const hot = hotRows.slice(0, 8).map((r) => {
    const chg = parseNum(col(r, '涨跌幅'));
    return {
      code: normalizeCode(col(r, '股票代码') || col(r, '代码')),
      name: col(r, '股票简称') || col(r, '名称'),
      price: null,
      changePct: chg != null ? +(chg / 100).toFixed(4) : 0,
    };
  });

  return { indices, sentiment: { up, flat: 0, down }, hot, news: [] };
}

// 智能选股返回的涨跌幅单位不统一（百分数 2.82 / 基点 282 / 小数 0.0282），归一化到小数
function normPct(v) {
  if (v == null) return 0;
  const a = Math.abs(v);
  if (a >= 100) return +(v / 10000).toFixed(4);
  if (a >= 1) return +(v / 100).toFixed(4);
  return +Number(v).toFixed(4);
}

// 板块轮动：行业板块涨跌幅排行（智能选股问板块，失败由调用方回退 mock）
async function sector() {
  const d = await call('stock', 'search_stocks', { query: '今日涨幅居前的行业板块，包含板块名称、涨跌幅' });
  const rows = parseMdTable(d.answer);
  const list = rows
    .map((r) => {
      const find = (test) => { for (const k of Object.keys(r)) if (test(k)) return r[k]; return null; };
      const chg = parseNum(find((k) => k.includes('涨跌幅') || k.includes('涨幅')));
      return {
        name: find((k) => k.includes('板块') || k.includes('行业') || k.includes('名称')),
        changePct: normPct(chg)
      };
    })
    .filter((x) => x.name);
  if (!list.length) throw new Error('板块数据为空');
  return { list: list.slice(0, 20) };
}

// 龙虎榜：异动股 + 上榜原因 + 净买入
async function lhb() {
  const d = await call('stock', 'search_stocks', { query: '今日龙虎榜上榜的A股，包含股票代码、股票简称、上榜原因、龙虎榜净买入额、涨跌幅' });
  const rows = parseMdTable(d.answer);
  const list = rows
    .map((r) => {
      const find = (test) => { for (const k of Object.keys(r)) if (test(k)) return r[k]; return null; };
      const chg = parseNum(find((k) => k.includes('涨跌幅')));
      return {
        code: normalizeCode(find((k) => k.includes('股票代码') || k.includes('代码'))),
        name: find((k) => k.includes('股票简称') || k.includes('名称')),
        reason: find((k) => k.includes('原因') || k.includes('上榜') || k.includes('席位') || k.includes('类型')),
        netBuy: parseNum(find((k) => k.includes('净买入') || k.includes('净买额') || k.includes('净额') || k.includes('净流入'))),
        changePct: normPct(chg)
      };
    })
    .filter((x) => x.code && x.name);
  if (!list.length) throw new Error('龙虎榜数据为空');
  return { list: list.slice(0, 20) };
}

// 资金流向：主力净流入排行
async function fundFlow() {
  const d = await call('stock', 'search_stocks', { query: '今日主力资金净流入排名前20的A股，包含股票代码、股票简称、主力净流入额、涨跌幅' });
  const rows = parseMdTable(d.answer);
  const list = rows
    .map((r) => {
      const find = (test) => { for (const k of Object.keys(r)) if (test(k)) return r[k]; return null; };
      const chg = parseNum(find((k) => k.includes('涨跌幅')));
      return {
        code: normalizeCode(find((k) => k.includes('股票代码') || k.includes('代码'))),
        name: find((k) => k.includes('股票简称') || k.includes('名称')),
        mainNetInflow: parseNum(find((k) => k.includes('主力') && (k.includes('净流入') || k.includes('净额')))),
        changePct: normPct(chg)
      };
    })
    .filter((x) => x.code && x.name);
  if (!list.length) throw new Error('资金流向数据为空');
  return { list: list.slice(0, 20) };
}

module.exports = { quote, kline, finance, financeHistory, screener, market, sector, lhb, fundFlow, hasToken: () => !!AUTH_TOKEN };
