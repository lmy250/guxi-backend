// Mock 数据生成：行情/K线/财务/股票池。DevTools 直接可跑，无需后端。

function pad(n) {
  return String(n).padStart(2, '0');
}

// 从今天往前生成 count 个交易日的日期（跳过周末）
function genDates(count) {
  const dates = [];
  const d = new Date('2026-08-18T00:00:00');
  while (dates.length < count) {
    const day = d.getDay();
    if (day !== 0 && day !== 6) {
      dates.push(`${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`);
    }
    d.setDate(d.getDate() - 1);
  }
  return dates.reverse();
}

// 随机游走生成 K 线
function genKline(count = 120, start = 12) {
  const dates = genDates(count);
  const list = [];
  let prevClose = start;
  for (let i = 0; i < count; i++) {
    const drift = (Math.random() - 0.48) * 0.04; // 轻微上行偏向
    const open = prevClose * (1 + (Math.random() - 0.5) * 0.01);
    const close = open * (1 + drift);
    const high = Math.max(open, close) * (1 + Math.random() * 0.015);
    const low = Math.min(open, close) * (1 - Math.random() * 0.015);
    const volume = Math.round((0.8 + Math.random()) * 1e6);
    list.push({
      date: dates[i],
      open: +open.toFixed(2),
      high: +high.toFixed(2),
      low: +low.toFixed(2),
      close: +close.toFixed(2),
      volume
    });
    prevClose = close;
  }
  return list;
}

function genQuote(code, name, base) {
  const k = genKline(1, base)[0];
  const preClose = +(base * (1 + (Math.random() - 0.5) * 0.03)).toFixed(2);
  const price = +k.close.toFixed(2);
  const change = +(price - preClose).toFixed(2);
  const changePct = +(change / preClose).toFixed(4);
  return {
    code,
    name,
    price,
    preClose,
    open: k.open,
    high: k.high,
    low: k.low,
    change,
    changePct,
    volume: k.volume,
    amount: Math.round(price * k.volume),
    turnover: +(1 + Math.random() * 4).toFixed(2), // 换手率%
    pe: +(8 + Math.random() * 40).toFixed(2),
    pb: +(0.8 + Math.random() * 8).toFixed(2),
    marketCap: +(50 + Math.random() * 2000).toFixed(1) // 亿
  };
}

// 选股用的股票池（含真实知名 A 股名称 + 虚构名称，便于演示搜索/选股；行情仍为 mock 随机）
function makeStock(code, name, industry) {
  const price = +(5 + Math.random() * 95).toFixed(2);
  const changePct = +((Math.random() - 0.5) * 0.1).toFixed(4);
  const marketCap = +(30 + Math.random() * 3000).toFixed(1);
  return {
    code,
    name,
    industry,
    price,
    changePct,
    pe: +(5 + Math.random() * 60).toFixed(2),
    pb: +(0.6 + Math.random() * 9).toFixed(2),
    turnover: +(0.3 + Math.random() * 9).toFixed(2),
    marketCap
  };
}

function genStockPool() {
  const industries = ['银行', '白酒', '半导体', '新能源', '医药', '券商', '地产', '汽车', '化工', '通信'];
  const realStocks = [
    { code: 'sh600519', name: '贵州茅台', industry: '白酒' },
    { code: 'sz000858', name: '五粮液', industry: '白酒' },
    { code: 'sh601318', name: '中国平安', industry: '保险' },
    { code: 'sh600036', name: '招商银行', industry: '银行' },
    { code: 'sz000001', name: '平安银行', industry: '银行' },
    { code: 'sh601166', name: '兴业银行', industry: '银行' },
    { code: 'sz300750', name: '宁德时代', industry: '新能源' },
    { code: 'sz002594', name: '比亚迪', industry: '汽车' },
    { code: 'sh601012', name: '隆基绿能', industry: '新能源' },
    { code: 'sz300059', name: '东方财富', industry: '券商' },
    { code: 'sh600030', name: '中信证券', industry: '券商' },
    { code: 'sz000725', name: '京东方A', industry: '半导体' },
    { code: 'sh688981', name: '中芯国际', industry: '半导体' },
    { code: 'sh600276', name: '恒瑞医药', industry: '医药' },
    { code: 'sz300760', name: '迈瑞医疗', industry: '医药' },
    { code: 'sh603259', name: '药明康德', industry: '医药' },
    { code: 'sz000333', name: '美的集团', industry: '家电' },
    { code: 'sh600887', name: '伊利股份', industry: '饮料' },
    { code: 'sz002415', name: '海康威视', industry: '安防' },
    { code: 'sh600900', name: '长江电力', industry: '电力' },
    { code: 'sh601899', name: '紫金矿业', industry: '矿业' },
    { code: 'sz002230', name: '科大讯飞', industry: '软件' },
    { code: 'sh600585', name: '海螺水泥', industry: '建材' },
    { code: 'sz000651', name: '格力电器', industry: '家电' }
  ];
  const names = [
    '云岭股份', '江海科技', '恒丰能源', '瑞祥医药', '中盛电子', '远见新材料', '华信证券', '锦城银行',
    '九洲新能源', '泰和地产', '光启通信', '博远汽车', '昊天化工', '明德生物', '海纳半导体', '盛世白酒',
    '开拓装备', '联创软件', '安泰保险', '锐思数据', '广源水利', '鼎晖消费', '星河传媒', '正阳钢铁',
    '汇通物流', '康佳医疗', '晨光农牧', '同辉电力', '智云网络', '德邦机械', '盈科环保', '顺达纺织',
    '天工智造', '万象金融', '清流饮料', '磐石建材', '飞马航空', '绿洲旅游', '长风传媒', '远东矿业'
  ];
  const pool = realStocks.map((r) => makeStock(r.code, r.name, r.industry));
  for (let i = 0; i < names.length; i++) {
    pool.push(makeStock('sh' + (600000 + i * 37).toString().slice(0, 6), names[i], industries[i % industries.length]));
  }
  return pool;
}

function genFinance(code) {
  const base = 50 + Math.random() * 200;
  const revenue = Math.round(base * 1e8);
  const netProfit = Math.round(revenue * (0.05 + Math.random() * 0.2));
  const totalAssets = Math.round(revenue * (2 + Math.random() * 3));
  const totalLiab = Math.round(totalAssets * (0.3 + Math.random() * 0.4));
  return {
    code,
    reportDate: '2026-03-31',
    income: {
      revenue,
      netProfit,
      grossMargin: +(20 + Math.random() * 50).toFixed(1),
      yoyRevenue: +((Math.random() - 0.3) * 0.4).toFixed(4),
      yoyProfit: +((Math.random() - 0.3) * 0.6).toFixed(4)
    },
    balance: {
      totalAssets,
      totalLiab,
      equity: totalAssets - totalLiab,
      debtRatio: +((totalLiab / totalAssets) * 100).toFixed(1)
    },
    cashflow: {
      operate: Math.round(netProfit * (0.8 + Math.random() * 0.6))
    },
    ratios: {
      roe: +((netProfit / (totalAssets - totalLiab)) * 100).toFixed(1),
      roa: +((netProfit / totalAssets) * 100).toFixed(1),
      eps: +(netProfit / (1 + Math.random() * 4) / 1e8).toFixed(2)
    }
  };
}

// 按代码稳定的随机K线（同一股票每次结果一致，便于选股形态筛选）
function hashStr(s) {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function genKlineSeeded(code, count = 120) {
  const rng = mulberry32(hashStr(code));
  const dates = genDates(count);
  const list = [];
  let prev = 10 + rng() * 40;
  for (let i = 0; i < count; i++) {
    const drift = (rng() - 0.48) * 0.04;
    const open = prev * (1 + (rng() - 0.5) * 0.01);
    const close = open * (1 + drift);
    const high = Math.max(open, close) * (1 + rng() * 0.015);
    const low = Math.min(open, close) * (1 - rng() * 0.015);
    let volume = (0.8 + rng()) * 1e6;
    if (rng() < 0.1) volume *= 2.5 + rng() * 3; // 偶发放量，便于演示放量突破
    const volumeR = Math.round(volume);
    list.push({
      date: dates[i],
      open: +open.toFixed(2),
      high: +high.toFixed(2),
      low: +low.toFixed(2),
      close: +close.toFixed(2),
      volume: volumeR
    });
    prev = close;
  }
  return list;
}

// 市场概览:指数 / 涨跌家数 / 热门榜 / 要闻
function genMarketOverview() {
  const pool = genStockPool();
  const idx = (name, base) => {
    const changePct = +((Math.random() - 0.45) * 0.02).toFixed(4);
    const value = +(base * (1 + changePct)).toFixed(2);
    return { name, value, change: +(value - base).toFixed(2), changePct };
  };
  const indices = [idx('上证指数', 3086), idx('深证成指', 9642), idx('创业板指', 1875)];
  const up = pool.filter((s) => s.changePct > 0).length;
  const down = pool.filter((s) => s.changePct < 0).length;
  const flat = pool.length - up - down;
  const hot = pool
    .slice()
    .sort((a, b) => b.changePct - a.changePct)
    .slice(0, 8)
    .map((s) => ({ code: s.code, name: s.name, price: s.price, changePct: s.changePct }));
  const news = [
    '央行开展 3000 亿元逆回购,维护季末流动性合理充裕',
    '两市成交额连续第五日突破万亿,北向资金净流入',
    '半导体设备板块走强,国产替代逻辑持续发酵',
    '白酒龙头提价预期升温,板块高开高走',
    '新能源车 8 月销量创新高,产业链景气度回升'
  ].map((t, i) => ({ id: i, title: t, time: ['09:31', '10:05', '11:20', '13:45', '15:02'][i] }));
  return { indices, sentiment: { up, flat, down }, hot, news };
}

// 五档盘口(模拟)
function genOrderBook(price) {
  const asks = [];
  const bids = [];
  for (let i = 5; i >= 1; i--) {
    asks.push({
      price: +(price * (1 + 0.0012 * i + Math.random() * 0.0008)).toFixed(2),
      volume: Math.round(50 + Math.random() * 850)
    });
  }
  for (let i = 1; i <= 5; i++) {
    bids.push({
      price: +(price * (1 - 0.0012 * i - Math.random() * 0.0008)).toFixed(2),
      volume: Math.round(50 + Math.random() * 850)
    });
  }
  return { asks, bids };
}

// 近 5 期财务(按代码稳定,同股票结果一致)
function genFinanceHistory(code) {
  const rng = mulberry32(hashStr(code + '_fin'));
  const quarters = ['2025-03-31', '2025-06-30', '2025-09-30', '2025-12-31', '2026-03-31'];
  let revenue = 40 + rng() * 160;
  const list = [];
  for (const q of quarters) {
    revenue *= 1 + (rng() - 0.3) * 0.15;
    const margin = 0.08 + rng() * 0.2;
    const netProfit = revenue * margin;
    list.push({
      reportDate: q,
      revenue: Math.round(revenue * 1e8),
      netProfit: Math.round(netProfit * 1e8),
      grossMargin: +(20 + rng() * 40).toFixed(1),
      roe: +(6 + rng() * 18).toFixed(1),
      debtRatio: +(30 + rng() * 35).toFixed(1),
      yoyRevenue: +((rng() - 0.25) * 0.5).toFixed(4),
      yoyProfit: +((rng() - 0.2) * 0.7).toFixed(4)
    });
  }
  return list;
}

// 板块轮动（行业板块涨跌幅排行，固定种子稳定）
function genSector() {
  const rng = mulberry32(20260820);
  const names = ['半导体', '白酒', '新能源', '医药', '券商', '银行', '地产', '汽车', '军工', '光伏', 'AI算力', '有色金属', '通信', '家电', '煤炭', '钢铁'];
  const list = names.map((n) => ({ name: n, changePct: +((rng() - 0.42) * 0.08).toFixed(4) }));
  list.sort((a, b) => b.changePct - a.changePct);
  return { list };
}

// 龙虎榜（异动股 + 上榜原因 + 净买入）
function genLhb() {
  const rng = mulberry32(20260821);
  const names = ['中际旭创', '浪潮信息', '东方财富', '宁德时代', '北方华创', '赛力斯', '中芯国际', '紫金矿业'];
  const reasons = ['机构专用', '游资博弈', '深股通', '沪股通', '机构净买入', '知名游资', '量化席位', '机构+游资'];
  const list = names.map((n, i) => ({
    code: 'sz' + (300000 + i * 137),
    name: n,
    reason: reasons[i % reasons.length],
    netBuy: Math.round((rng() - 0.25) * 3e8),
    changePct: +((rng() - 0.3) * 0.15).toFixed(4)
  }));
  list.sort((a, b) => b.netBuy - a.netBuy);
  return { list };
}

// 资金流向（主力净流入排行）
function genFundFlow() {
  const rng = mulberry32(20260822);
  const names = ['贵州茅台', '宁德时代', '中芯国际', '东方财富', '比亚迪', '北方华创', '隆基绿能', '中国平安'];
  const list = names.map((n, i) => ({
    code: 'sh' + (600000 + i * 37),
    name: n,
    mainNetInflow: Math.round((rng() - 0.2) * 5e8),
    changePct: +((rng() - 0.35) * 0.1).toFixed(4)
  }));
  list.sort((a, b) => b.mainNetInflow - a.mainNetInflow);
  return { list };
}

// 财经资讯列表（mock，供资讯页）
function genNewsList() {
  const items = [
    { title: '央行开展3000亿元逆回购，维护流动性合理充裕', summary: '央行今日以固定利率、数量招标方式开展3000亿元7天期逆回购操作，中标利率维持不变，向市场投放流动性，缓解季末资金面压力。', time: '2026-08-20 15:30:00' },
    { title: '两市成交额连续五日突破万亿，北向资金净流入', summary: '沪深两市今日成交额达1.2万亿元，连续第五个交易日突破万亿大关，北向资金全天净买入超80亿元，市场情绪回暖。', time: '2026-08-20 15:05:00' },
    { title: '半导体设备板块走强，国产替代逻辑持续发酵', summary: '受国产替代预期升温带动，半导体设备板块今日集体走强，多只个股涨停，机构认为产业链景气度有望延续。', time: '2026-08-20 14:20:00' },
    { title: '白酒龙头提价预期升温，板块高开高走', summary: '多家机构上调白酒龙头盈利预测，市场对提价预期升温，白酒板块今日高开高走，领涨大消费。', time: '2026-08-20 13:45:00' },
    { title: '新能源车8月销量创新高，产业链景气度回升', summary: '8月新能源乘用车零售销量同比增长，创同期新高，动力电池、零部件等产业链环节景气度持续回升。', time: '2026-08-20 11:20:00' },
    { title: '美股三大指数收涨，科技股领涨', summary: '隔夜美股三大指数集体收涨，纳斯达克指数涨幅居前，大型科技股普遍走强，中概股多数上涨。', time: '2026-08-20 09:00:00' },
    { title: '多家券商发布策略：8月修复行情可期', summary: '多家头部券商发布周度策略，认为前期调整基本结束，8月市场修复可期，建议关注科技与高端制造方向。', time: '2026-08-19 22:30:00' },
    { title: 'OPEC+同意上调日产量18.8万桶', summary: '据消息人士透露，OPEC+已原则上同意将日产量上调18.8万桶，国际油价短线波动。', time: '2026-08-19 21:00:00' }
  ];
  return items.map((n, i) => ({ code: 'mock_' + i, title: n.title, summary: n.summary, time: n.time, source: '东方财富 7x24', url: '' }));
}

module.exports = { genKline, genQuote, genStockPool, genFinance, genKlineSeeded, genMarketOverview, genOrderBook, genFinanceHistory, genSector, genLhb, genFundFlow, genNewsList };
