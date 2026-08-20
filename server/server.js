// 后端桥接服务（Node 内置 http，无需依赖，node server.js 即可跑）
// 作用：把小程序的请求转接到真实行情源。
//   默认返回 mock 数据，方便端到端联调。
//   接入真实数据时，把下面 TODO 处替换为实际数据源调用即可。
//
// 重要约束：
//  - 腾讯自选股(westock-mcp) 是 AI Agent 侧的数据接口，小程序无法直接调用，
//    也不能当作公开 HTTP API。要用它，需你自己在服务端用其底层接口代理（见 TODO）。
//  - 美股不在腾讯自选股覆盖内，需另接源（如 yfinance / Alpha Vantage）。
//  - A股/港股可用 AkShare（Python）：stock_zh_a_hist / stock_hk_hist / stock_financial_analysis_indicator 等。
//
// 小程序端：把 app.js 的 apiBase 改为 http://你的IP:3000/api，useMock 改为 false。
// 微信开发者工具已设 urlCheck:false，本地调试可不配合法域名。

const http = require('http');
const https = require('https');
const os = require('os');
const { URL } = require('url');
const { execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const ind = require('../utils/indicators.js');
const mock = require('../utils/mock.js');

// 财经快讯：东方财富 7x24（免费、无需 token），失败由调用方回退本地文案
function fetchNews() {
  return new Promise((resolve, reject) => {
    const url = 'https://np-listapi.eastmoney.com/comm/web/getFastNewsList?client=web&biz=web_724&fastColumn=102&sortEnd=&pageSize=8&req_trace=' + Date.now();
    const req = https.get(url, { timeout: 8000 }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          const list = (j.data && j.data.fastNewsList) || [];
          const news = list.map((n, i) => ({
            id: i,
            title: n.summary || n.title,
            time: (n.showTime || '').slice(11, 16),
            url: n.code ? 'https://finance.eastmoney.com/a/' + n.code + '.html' : ''
          })).filter((x) => x.title);
          if (!news.length) { reject(new Error('empty news')); return; }
          resolve(news);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('news timeout')); });
  });
}

// 财经快讯完整列表（含正文 summary、完整时间、来源），供资讯页使用
function fetchNewsFull(pageSize = 50) {
  return new Promise((resolve, reject) => {
    const url = 'https://np-listapi.eastmoney.com/comm/web/getFastNewsList?client=web&biz=web_724&fastColumn=102&sortEnd=&pageSize=' + pageSize + '&req_trace=' + Date.now();
    const req = https.get(url, { timeout: 10000 }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          const list = (j.data && j.data.fastNewsList) || [];
          const news = list.map((n) => ({
            code: n.code || '',
            title: n.title || n.summary || '',
            summary: n.summary || n.title || '',
            time: n.showTime || '',
            source: '东方财富 7x24',
            url: n.code ? 'https://finance.eastmoney.com/a/' + n.code + '.html' : ''
          })).filter((x) => x.title);
          resolve(news);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('news timeout')); });
  });
}

// 全市场股票池缓存（由 update_stock_pool.py 生成 stock_pool.json，约 5500 只 A 股）
let _stockPool = null;
function loadStockPool() {
  if (_stockPool) return _stockPool;
  try {
    const raw = fs.readFileSync(path.join(__dirname, 'stock_pool.json'), 'utf8');
    _stockPool = JSON.parse(raw).stocks || [];
  } catch (e) {
    _stockPool = null;
  }
  return _stockPool;
}

const PORT = process.env.PORT || 3000;
const BASE = '/api';

// 真实数据开关：USE_REAL=1 时，/search /quote /kline /finance 走 akshare_bridge.py
// （A股/港股用 akshare，美股用 yfinance）。任何失败自动回退 mock，小程序永不崩。
// 启动：USE_REAL=1 PYTHON=server/.venv/Scripts/python.exe node server.js
const USE_REAL = process.env.USE_REAL === '1';
const PYTHON = process.env.PYTHON || 'python';
const BRIDGE = path.join(__dirname, 'akshare_bridge.py');
// 注意：/search 不走 akshare（东方财富连不上会卡 20 秒超时，体验差），直接走本地股票池秒回。
const REAL_ROUTES = { '/quote': 'quote', '/kline': 'kline', '/finance': 'finance' };

// 同花顺 iFinD 桥（优先数据源）：quote/kline/finance 走 iFinD MCP，失败回退 akshare 再回退 mock。
// USE_IFIND=0 可关闭；默认开启（需 server/ifind_config.json 有有效 token）。
const ifind = require('./ifind_bridge.js');
const USE_IFIND = process.env.USE_IFIND !== '0' && ifind.hasToken();
const IFIND_ROUTES = {
  '/quote': ifind.quote,
  '/kline': ifind.kline,
  '/finance': ifind.finance,
  '/finance_history': ifind.financeHistory,
  '/screener': ifind.screener,
  '/sector': ifind.sector,
  '/lhb': ifind.lhb,
  '/fundflow': ifind.fundFlow,
  '/news': async (params) => {
    const pageSize = Math.min(Math.max(Number(params.pageSize) || 50, 10), 100);
    try {
      const list = await fetchNewsFull(pageSize);
      return { list, total: list.length };
    } catch (e) {
      return { list: mock.genNewsList(), total: 0, fallback: true };
    }
  },
  '/market': async (params) => {
    const m = await ifind.market();
    try {
      m.news = await fetchNews(); // 实时财经快讯
    } catch (e) {
      m.news = mock.genMarketOverview().news; // 快讯拉取失败回退本地文案
    }
    return m;
  }
};

function pyCall(fn, params) {
  const out = execFileSync(PYTHON, [BRIDGE, fn, JSON.stringify(params)], {
    timeout: 20000,
    encoding: 'utf8'
  });
  return JSON.parse(out);
}

// 客户自定义策略执行器（Python 沙箱）。复用项目自带 Python（server/.venv）。
// mode: 'validate'(仅校验) | 'run'(执行并返回信号)。用户代码通过 stdin 传入，超时 8s 杀进程。
const RUNNER = path.join(__dirname, 'strategy_runner.py');
function runPythonStrategy(mode, code, kline) {
  const out = execFileSync(PYTHON, [RUNNER], {
    input: JSON.stringify({ mode, code: code || '', kline: kline || [] }),
    timeout: 8000,
    maxBuffer: 10 * 1024 * 1024,
    encoding: 'utf8'
  });
  return JSON.parse(out);
}

// 过拟合检测执行器（skill-backtest-overfit）：DSR / PBO / Haircut Sharpe / MinTRL。
// 需 numpy+scipy，优先用托管 Python 环境（含全套科学计算库），回退项目 .venv 再回退系统 python。
const OVERFIT_RUNNER = path.join(__dirname, 'overfit', 'overfit_runner.py');
function findOverfitPython() {
  const cands = [
    process.env.OVERFIT_PYTHON,
    path.join(os.homedir(), '.workbuddy', 'binaries', 'python', 'envs', 'default', 'Scripts', 'python.exe'),
    path.join(__dirname, '.venv', 'Scripts', 'python.exe'),
    PYTHON
  ].filter(Boolean);
  for (const c of cands) {
    if (c === 'python') continue;
    try { if (fs.existsSync(c)) return c; } catch (e) { /* ignore */ }
  }
  return 'python';
}
function runOverfit(payload) {
  const py = findOverfitPython();
  const out = execFileSync(py, [OVERFIT_RUNNER], {
    input: JSON.stringify(payload || {}),
    timeout: 30000,
    maxBuffer: 10 * 1024 * 1024,
    encoding: 'utf8'
  });
  return JSON.parse(out);
}

// ---------------- mock 数据（与小程序一致，便于联调） ----------------
function genKline(count = 120, start = 12) {
  const list = [];
  let prev = start;
  for (let i = 0; i < count; i++) {
    const drift = (Math.random() - 0.48) * 0.04;
    const open = prev * (1 + (Math.random() - 0.5) * 0.01);
    const close = open * (1 + drift);
    const high = Math.max(open, close) * (1 + Math.random() * 0.015);
    const low = Math.min(open, close) * (1 - Math.random() * 0.015);
    list.push({
      date: `2026-08-${String(count - i).padStart(2, '0')}`,
      open: +open.toFixed(2),
      high: +high.toFixed(2),
      low: +low.toFixed(2),
      close: +close.toFixed(2),
      volume: Math.round((0.8 + Math.random()) * 1e6)
    });
    prev = close;
  }
  return list;
}

function genStockPool() {
  const names = ['云岭股份', '江海科技', '恒丰能源', '瑞祥医药', '中盛电子', '远见新材料', '华信证券', '锦城银行'];
  return names.map((name, i) => {
    const price = +(5 + Math.random() * 95).toFixed(2);
    return {
      code: 'sh' + (600000 + i * 37).toString().slice(0, 6),
      name,
      industry: ['银行', '科技', '能源', '医药', '电子', '材料', '券商', '银行'][i],
      price,
      changePct: +((Math.random() - 0.5) * 0.1).toFixed(4),
      pe: +(5 + Math.random() * 60).toFixed(2),
      pb: +(0.6 + Math.random() * 9).toFixed(2),
      turnover: +(0.3 + Math.random() * 9).toFixed(2),
      marketCap: +(30 + Math.random() * 3000).toFixed(1)
    };
  });
}

// ---------------- 批量技术扫描辅助 ----------------
function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function genKlineSeeded(code, count = 120) {
  const rng = mulberry32(hashStr(code));
  const list = [];
  let prev = 10 + rng() * 40;
  for (let i = 0; i < count; i++) {
    const drift = (rng() - 0.48) * 0.04;
    const open = prev * (1 + (rng() - 0.5) * 0.01);
    const close = open * (1 + drift);
    const high = Math.max(open, close) * (1 + rng() * 0.015);
    const low = Math.min(open, close) * (1 - rng() * 0.015);
    let volume = Math.round((0.8 + rng()) * 1e6);
    if (rng() < 0.1) volume *= 2.5 + rng() * 3;
    list.push({
      date: `2026-08-${String(count - i).padStart(2, '0')}`,
      open: +open.toFixed(2), high: +high.toFixed(2), low: +low.toFixed(2),
      close: +close.toFixed(2), volume
    });
    prev = close;
  }
  return list;
}

// 由K线计算技术形态标签
function computeTech(kline) {
  const closes = kline.map((d) => d.close);
  const vols = kline.map((d) => d.volume);
  const n = closes.length;
  if (n < 21) return { maBull: false, macdGold: false, volBreak: false, fundFlow: 0 };
  const ma5 = ind.MA(closes, 5);
  const ma10 = ind.MA(closes, 10);
  const ma20 = ind.MA(closes, 20);
  const maBull = ma5[n - 1] != null && ma5[n - 1] > ma10[n - 1] && ma10[n - 1] > ma20[n - 1];
  const macd = ind.MACD(closes);
  let macdGold = false;
  for (let i = Math.max(1, n - 6); i < n; i++) {
    if (macd.dif[i - 1] != null && macd.dea[i - 1] != null && macd.dif[i] != null && macd.dea[i] != null) {
      if (macd.dif[i - 1] <= macd.dea[i - 1] && macd.dif[i] > macd.dea[i]) macdGold = true;
    }
  }
  const avgVol = vols.slice(-21, -1).reduce((a, b) => a + b, 0) / 20;
  const volBreak = vols[n - 1] > 2 * avgVol;
  // 主力净流入代理：近5日 价量方向 加权（真实场景应接资金流接口，此处为K线代理）
  const recent = vols.slice(-5);
  let ff = 0;
  for (let i = n - 5; i < n; i++) ff += (closes[i] >= kline[i].open ? 1 : -1) * vols[i];
  const fundFlow = +((ff / (recent.reduce((a, b) => a + b, 0) || 1)) * 10).toFixed(1);
  return { maBull, macdGold, volBreak, fundFlow };
}

function applyTechFilters(item, f) {
  if (f.maBull && !item.maBull) return false;
  if (f.macdGold && !item.macdGold) return false;
  if (f.volBreak && !item.volBreak) return false;
  if (f.fundFlowMin != null && item.fundFlow < f.fundFlowMin) return false;
  return true;
}

// mock 扫描：本地稳定K线 + 技术过滤
function filterCandidates(candidates, f) {
  return candidates.filter((s) => {
    if (f.changePctMin != null && s.changePct < f.changePctMin) return false;
    if (f.changePctMax != null && s.changePct > f.changePctMax) return false;
    if (f.peMax != null && s.pe > f.peMax) return false;
    if (f.turnoverMin != null && s.turnover < f.turnoverMin) return false;
    if (f.marketCapMax != null && s.marketCap > f.marketCapMax) return false;
    if (f.industry && s.industry !== f.industry) return false;
    const tech = computeTech(s.kline);
    s.maBull = tech.maBull; s.macdGold = tech.macdGold; s.volBreak = tech.volBreak; s.fundFlow = tech.fundFlow;
    return applyTechFilters(s, f);
  });
}

// 真实扫描：codes 定向 或 scanAll 全市场（先快照基础过滤再逐只拉K线算技术）
function realScan(f, codesParam, scanAll, limit) {
  let base = [];
  if (codesParam && codesParam.length) {
    const codes = codesParam.split(',').map((c) => c.trim()).filter(Boolean).slice(0, limit);
    base = codes.map((code) => {
      try {
        const q = pyCall('quote', { code });
        return { code, name: q.name, price: q.price, changePct: q.changePct, pe: q.pe, turnover: q.turnover, marketCap: q.marketCap };
      } catch (e) {
        return { code, name: code };
      }
    });
  } else {
    const spot = pyCall('spot', {});
    let pool = spot;
    if (f.changePctMin != null) pool = pool.filter((s) => s.changePct != null && s.changePct >= f.changePctMin);
    if (f.changePctMax != null) pool = pool.filter((s) => s.changePct != null && s.changePct <= f.changePctMax);
    if (f.peMax != null) pool = pool.filter((s) => s.pe != null && s.pe <= f.peMax);
    if (f.turnoverMin != null) pool = pool.filter((s) => s.turnover != null && s.turnover >= f.turnoverMin);
    if (f.marketCapMax != null) pool = pool.filter((s) => s.marketCap != null && s.marketCap <= f.marketCapMax);
    base = pool.slice(0, limit);
  }
  const out = [];
  for (const b of base) {
    try {
      const kres = pyCall('kline', { code: b.code, period: 'day', limit: 120 });
      const item = Object.assign({}, b, computeTech(kres.list));
      if (!applyTechFilters(item, f)) continue;
      out.push(item);
    } catch (e) {
      console.warn('[real screener] 跳过', b.code, e.message);
    }
  }
  return out.sort((a, b) => (b.changePct || 0) - (a.changePct || 0));
}

// ---------------- 路由 ----------------
const routes = {
  '/health'() {
    return { ok: true, useReal: USE_REAL, useIfind: USE_IFIND, time: Date.now() };
  },
  '/market'() {
    return mock.genMarketOverview();
  },
  '/search'(q) {
    // 全市场股票池（约 5500 只），本地 JSON 秒回；无池则回退内置 64 只
    const pool = loadStockPool() || mock.genStockPool();
    const kw = (q.get('q') || '').trim();
    const list = kw
      ? pool.filter((s) => s.name.includes(kw) || s.code.includes(kw))
      : pool.slice(0, 10);
    return list.slice(0, 20).map((s) => ({ code: s.code, name: s.name, type: 'stock' }));
  },
  '/quote'(q) {
    const code = q.get('code') || 'sh600000';
    const r = mock.genQuote(code, code, 10 + Math.random() * 40);
    return r;
  },
  '/kline'(q) {
    const code = q.get('code') || 'sh600000';
    const limit = Number(q.get('limit') || 120);
    // USE_REAL=1 时由 akshare_bridge.py 返回真实K线（A股/港股 akshare，美股 yfinance）
    return { code, period: q.get('period') || 'day', list: mock.genKline(limit, 12) };
  },
  '/finance'(q) {
    const code = q.get('code') || 'sh600000';
    // USE_REAL=1 时由 akshare_bridge.py 返回真实财务（A股）
    return mock.genFinance(code);
  },
  '/finance_history'(q) {
    const code = q.get('code') || 'sh600000';
    return { code, list: mock.genFinanceHistory(code) };
  },
  '/screener'(q) {
    // 空字符串/无效值统一按 null 处理，避免 Number('')=0 拼出「涨幅>0%且<0%」这种矛盾条件
    const num = (key) => {
      const v = q.get(key);
      if (v == null || v === '') return null;
      const n = Number(v);
      return Number.isNaN(n) ? null : n;
    };
    const f = {
      changePctMin: num('changePctMin'),
      changePctMax: num('changePctMax'),
      peMax: num('peMax'),
      turnoverMin: num('turnoverMin'),
      marketCapMax: num('marketCapMax'),
      industry: q.get('industry') || null,
      maBull: q.get('maBull') === 'true' || q.get('maBull') === '1',
      macdGold: q.get('macdGold') === 'true' || q.get('macdGold') === '1',
      volBreak: q.get('volBreak') === 'true' || q.get('volBreak') === '1',
      fundFlowMin: num('fundFlowMin')
    };
    // 真实筛选已由 iFinD（IFIND_ROUTES['/screener']）处理；此处仅 mock 兜底（64 只真实龙头+虚构）
    const pool = mock.genStockPool();
    const candidates = pool.map((s) => Object.assign({}, s, { kline: genKlineSeeded(s.code, 120) }));
    return filterCandidates(candidates, f).sort((a, b) => b.changePct - a.changePct);
  },
  '/sector'(q) {
    return mock.genSector();
  },
  '/lhb'(q) {
    return mock.genLhb();
  },
  '/fundflow'(q) {
    return mock.genFundFlow();
  },
  '/news'(q) {
    return { list: mock.genNewsList(), total: 0, fallback: true };
  },
  '/backtest'(q) {
    // TODO: 接入真实历史K线后做回测
    const k = genKline(200, 12);
    const closes = k.map((x) => x.close);
    const capital = Number(q.get('capital') || 100000);
    let cash = capital;
    let shares = 0;
    const equity = [];
    let peak = capital;
    let maxDD = 0;
    for (let i = 1; i < closes.length; i++) {
      const ma5 = closes.slice(i - 5, i).reduce((a, b) => a + b, 0) / 5;
      const ma20 = closes.slice(i - 20, i).reduce((a, b) => a + b, 0) / 20;
      const prevMa5 = closes.slice(i - 6, i - 1).reduce((a, b) => a + b, 0) / 5;
      const prevMa20 = closes.slice(i - 21, i - 1).reduce((a, b) => a + b, 0) / 20;
      if (prevMa5 <= prevMa20 && ma5 > ma20 && cash > 0) {
        shares = Math.floor(cash / closes[i]);
        cash -= shares * closes[i];
      } else if (prevMa5 >= prevMa20 && ma5 < ma20 && shares > 0) {
        cash += shares * closes[i];
        shares = 0;
      }
      const v = cash + shares * closes[i];
      equity.push({ date: k[i].date, value: +v.toFixed(2) });
      if (v > peak) peak = v;
      const dd = (v - peak) / peak;
      if (dd < maxDD) maxDD = dd;
    }
    const final = equity[equity.length - 1].value;
    return {
      summary: { capital, finalEquity: +final.toFixed(2), totalReturn: +(final / capital - 1).toFixed(4), maxDrawdown: +maxDD.toFixed(4), tradeCount: 0 },
      equity,
      trades: []
    };
  }
};

// ---------------- 客户自定义策略（POST 路由） ----------------
async function handlePost(pathname, body) {
  if (pathname === '/strategy/validate') {
    return runPythonStrategy('validate', body.code || '', null);
  }
  if (pathname === '/strategy/run') {
    return runPythonStrategy('run', body.code || '', body.kline || []);
  }
  if (pathname === '/overfit') {
    return runOverfit({
      returns: body.returns || [],
      trials: body.trials || null,
      n_trials: body.n_trials,
      periods_per_year: body.periods_per_year || 252,
      haircut_method: body.haircut_method || 'holm'
    });
  }
  return { valid: false, errors: ['未知策略接口: ' + pathname] };
}

const server = http.createServer(async (req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname.replace(BASE, '') || '/search';

  // CORS 预检：跨域 POST(application/json) 会先发 OPTIONS，必须返回允许方法与头，否则浏览器报 Failed to fetch
  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '86400');
    res.end();
    return;
  }

  // POST：客户策略校验/执行（body 为 JSON，限长 512KB）
  if (req.method === 'POST') {
    let body = '';
    req.on('data', (c) => {
      body += c;
      if (body.length > 512 * 1024) {
        res.statusCode = 413;
        res.end(JSON.stringify({ valid: false, errors: ['策略内容过大'] }));
        req.destroy();
      }
    });
    req.on('end', async () => {
      let json = {};
      try { json = JSON.parse(body || '{}'); } catch (e) { json = {}; }
      try {
        res.end(JSON.stringify(await handlePost(path, json)));
      } catch (e) {
        res.statusCode = 500;
        res.end(JSON.stringify({ valid: false, errors: [String((e && e.message) || e)] }));
      }
    });
    return;
  }

  const handler = routes[path];
  if (!handler) {
    res.statusCode = 404;
    res.end(JSON.stringify({ error: 'not found' }));
    return;
  }
  try {
    const params = Object.fromEntries(url.searchParams);
    // 1) 同花顺 iFinD 优先（真实行情/K线/财务）
    if (USE_IFIND && IFIND_ROUTES[path]) {
      try {
        res.end(JSON.stringify(await IFIND_ROUTES[path](params)));
        return;
      } catch (e) {
        console.warn('[ifind] 失败，回退:', path, e.message);
      }
    }
    // 2) akshare（东方财富/yfinance）兜底
    if (USE_REAL && REAL_ROUTES[path]) {
      try {
        res.end(JSON.stringify(pyCall(REAL_ROUTES[path], params)));
        return;
      } catch (e) {
        console.warn('[real] 失败，回退 mock:', path, e.message);
      }
    }
    // 3) mock（永不白屏）
    res.end(JSON.stringify(handler(url.searchParams)));
  } catch (e) {
    res.statusCode = 500;
    res.end(JSON.stringify({ error: String(e) }));
  }
});

server.listen(PORT, () => {
  console.log(`股票分析后端桥接已启动: http://localhost:${PORT}${BASE}`);
});
