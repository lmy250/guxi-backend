#!/usr/bin/env python3
# 真实数据桥：A股/港股用 akshare，美股用 yfinance。
# 由 server.js 通过 child_process 调用：python akshare_bridge.py <fn> <json_params>
# 成功输出 JSON 到 stdout；失败输出错误到 stderr 并 exit(1)，由 Node 侧回退 mock。
import sys, json, os

os.environ.setdefault('TQDM_DISABLE', '1')  # 干净 JSON 输出，不打印进度条

try:
    import akshare as ak
except Exception as e:
    ak = None

try:
    import yfinance as yf
except Exception as e:
    yf = None


def parse_code(code):
    code = (code or '').strip()
    if code[:2] in ('sh', 'sz'):
        return 'a', code[2:]
    if code[:2] == 'hk':
        return 'hk', code[2:]
    # 美股：usAAPL -> AAPL；或直接给代码
    if code[:2] == 'us':
        return 'us', code[2:].upper()
    return 'us', code.upper()


def search(q):
    if ak is None:
        raise RuntimeError('akshare 未安装')
    df = ak.stock_zh_a_spot_em()
    q = (q or '').strip()
    sub = df[df['代码'].astype(str).str.contains(q) | df['名称'].astype(str).str.contains(q)].head(20)
    out = []
    for _, r in sub.iterrows():
        c = str(r['代码'])
        market = 'sh' if c.startswith('6') else 'sz'
        out.append({'code': market + c, 'name': str(r['名称']), 'type': 'stock'})
    return out


def quote(code):
    if ak is None:
        raise RuntimeError('akshare 未安装')
    kind, symbol = parse_code(code)
    if kind in ('a', 'hk'):
        df = ak.stock_hk_spot_em() if kind == 'hk' else ak.stock_zh_a_spot_em()
        col = '代码'
        row = df[df[col].astype(str).str.contains(symbol)]
        if row.empty:
            raise RuntimeError('未找到 ' + code)
        r = row.iloc[0]
        return {
            'code': code,
            'name': str(r.get('名称', code)),
            'price': float(r['最新价']),
            'preClose': float(r.get('昨收', 0) or 0),
            'open': float(r.get('今开', 0) or 0),
            'high': float(r.get('最高', 0) or 0),
            'low': float(r.get('最低', 0) or 0),
            'change': float(r.get('涨跌额', 0) or 0),
            'changePct': float(r.get('涨跌幅', 0) or 0) / 100,
            'turnover': float(r.get('换手率', 0) or 0),
            'pe': _f(r.get('市盈率-动态')),
            'pb': _f(r.get('市净率')),
            'marketCap': _f(r.get('总市值')) / 1e8 if _f(r.get('总市值')) else None,
        }
    else:
        if yf is None:
            raise RuntimeError('yfinance 未安装')
        t = yf.Ticker(symbol)
        fi = t.fast_info
        price = float(fi.last_price)
        prev = float(fi.previous_close)
        return {
            'code': code, 'name': symbol, 'price': price, 'preClose': prev,
            'open': _f(fi.open), 'high': _f(fi.day_high), 'low': _f(fi.day_low),
            'change': price - prev, 'changePct': (price - prev) / prev if prev else 0,
            'turnover': None, 'pe': _f(fi.forward_pe), 'pb': None, 'marketCap': None,
        }


def kline(code, period='day', limit=120):
    if ak is None:
        raise RuntimeError('akshare 未安装')
    kind, symbol = parse_code(code)
    pmap = {'day': 'daily', 'week': 'weekly', 'month': 'monthly'}
    akp = pmap.get(period, 'daily')
    if kind == 'a':
        df = ak.stock_zh_a_hist(symbol=symbol, period=akp, adjust='qfq')
    elif kind == 'hk':
        df = ak.stock_hk_hist(symbol=symbol, period=akp, adjust='qfq')
    else:
        if yf is None:
            raise RuntimeError('yfinance 未安装')
        t = yf.Ticker(symbol)
        df = t.history(period='2y')
        df = df.reset_index()[['Date', 'Open', 'High', 'Low', 'Close', 'Volume']].tail(limit)
        df['Date'] = df['Date'].astype(str).str[:10]
        out = [{'date': str(r['Date']), 'open': _f(r['Open']), 'high': _f(r['High']),
                'low': _f(r['Low']), 'close': _f(r['Close']), 'volume': int(r['Volume'])}
               for _, r in df.iterrows()]
        return {'code': code, 'period': period, 'list': out}
    df = df.tail(int(limit))
    out = []
    for _, r in df.iterrows():
        out.append({
            'date': str(r['日期']),
            'open': _f(r['开盘']), 'high': _f(r['最高']),
            'low': _f(r['最低']), 'close': _f(r['收盘']),
            'volume': int(r['成交量']),
        })
    return {'code': code, 'period': period, 'list': out}


def col(df, *keys):
    for k in keys:
        for c in df.columns:
            if k in c:
                return c
    return None


def finance(code):
    if ak is None:
        raise RuntimeError('akshare 未安装')
    kind, symbol = parse_code(code)
    if kind != 'a':
        raise RuntimeError('财务数据暂仅支持A股')
    prefix = 'SH' if code[:2] == 'sh' else 'SZ'
    sym = prefix + symbol
    out = None
    # 优先用三大报表（绝对值：营收/净利/总资产/负债/现金流）
    try:
        inc = ak.stock_profit_sheet_by_report_em(symbol=sym)
        bal = ak.stock_balance_sheet_by_report_em(symbol=sym)
        cf = ak.stock_cash_flow_sheet_by_report_em(symbol=sym)
        if not inc.empty:
            r = inc.iloc[-1]
            rb = bal.iloc[-1] if not bal.empty else None
            rc = cf.iloc[-1] if not cf.empty else None
            out = {
                'code': code,
                'reportDate': str(r.get('报告期', '')),
                'income': {
                    'revenue': _f(r.get(col(inc, '营业总收'))),
                    'netProfit': _f(r.get(col(inc, '净利润'))),
                    'grossMargin': _f(r.get(col(inc, '销售毛利'))),
                    'yoyRevenue': _f(r.get(col(inc, '营业总收入同比')) or r.get(col(inc, '营业收入同比'))),
                    'yoyProfit': _f(r.get(col(inc, '净利润同比'))),
                },
                'balance': {
                    'totalAssets': _f(rb.get(col(bal, '资产总计'))) if rb is not None else None,
                    'totalLiab': _f(rb.get(col(bal, '负债合计'))) if rb is not None else None,
                    'equity': _f(rb.get(col(bal, '所有者权益合计')) or rb.get(col(bal, '净资产'))) if rb is not None else None,
                    'debtRatio': _f(rb.get(col(bal, '资产负债率'))) if rb is not None else None,
                },
                'cashflow': {
                    'operate': _f(rc.get(col(cf, '经营活动产生的现金流量净额'))) if rc is not None else None
                },
                'ratios': {
                    'roe': _f(r.get(col(inc, '净资产收益率'))),
                    'roa': _f(r.get(col(inc, '总资产净利润率')) or r.get(col(inc, '总资产报酬率'))),
                    'eps': _f(r.get(col(inc, '基本每股收益')) or r.get(col(inc, '每股收益'))),
                },
            }
    except Exception as e:
        sys.stderr.write('sheets failed: ' + str(e) + '\n')
    # 回退：财务指标（比率）
    if out is None:
        df = ak.stock_financial_analysis_indicator(symbol=symbol)
        if df.empty:
            raise RuntimeError('无财务数据 ' + code)
        r = df.iloc[-1]
        out = {
            'code': code,
            'reportDate': str(r.get('日期', '')),
            'income': {
                'revenue': None, 'netProfit': None,
                'grossMargin': _f(r.get(col(df, '销售毛利率'))),
                'yoyRevenue': _f(r.get(col(df, '主营业务收入增长率'))),
                'yoyProfit': _f(r.get(col(df, '净利润增长率'))),
            },
            'balance': {
                'totalAssets': None, 'totalLiab': None, 'equity': None,
                'debtRatio': _f(r.get(col(df, '资产负债率'))),
            },
            'cashflow': {'operate': None},
            'ratios': {
                'roe': _f(r.get(col(df, '净资产收益率'))),
                'roa': _f(r.get(col(df, '总资产净利润率')) or r.get(col(df, '资产报酬率'))),
                'eps': _f(r.get(col(df, '摊薄每股收益'))),
            },
        }
    return out


def stocklist():
    # 全市场 A股 代码列表（用于批量扫描）。单线程、单次调用即可拿到全部。
    if ak is None:
        raise RuntimeError('akshare 未安装')
    df = ak.stock_info_a_code_name()
    out = []
    for _, r in df.iterrows():
        c = str(r['代码'])
        market = 'sh' if c.startswith('6') else 'sz'
        out.append({'code': market + c, 'name': str(r['名称'])})
    return out


def spot():
    # 全市场实时快照（一次拿到全部，用于批量扫描的基础过滤，避免逐只拉行情）。
    if ak is None:
        raise RuntimeError('akshare 未安装')
    df = ak.stock_zh_a_spot_em()
    out = []
    for _, r in df.iterrows():
        c = str(r['代码'])
        market = 'sh' if c.startswith('6') else 'sz'
        chg = _f(r.get('涨跌幅'))
        out.append({
            'code': market + c,
            'name': str(r['名称']),
            'price': _f(r.get('最新价')),
            'changePct': (chg / 100) if chg is not None else None,
            'pe': _f(r.get('市盈率-动态')),
            'turnover': _f(r.get('换手率')),
            'marketCap': (_f(r.get('总市值')) / 1e8) if _f(r.get('总市值')) else None,
        })
    return out


def _f(v):
    try:
        if v is None or v == '' or str(v).lower() in ('none', 'nan'):
            return None
        return float(v)
    except Exception:
        return None


def main():
    if len(sys.argv) < 3:
        sys.stderr.write('usage: akshare_bridge.py <fn> <json_params>\n')
        sys.exit(1)
    fn = sys.argv[1]
    params = json.loads(sys.argv[2]) if len(sys.argv) > 2 else {}
    func = {'search': search, 'quote': quote, 'kline': kline, 'finance': finance, 'stocklist': stocklist, 'spot': spot}.get(fn)
    if not func:
        sys.stderr.write('unknown fn ' + fn + '\n')
        sys.exit(1)
    try:
        result = func(**params)
        sys.stdout.write(json.dumps(result, ensure_ascii=False))
    except Exception as e:
        sys.stderr.write('bridge error: ' + str(e) + '\n')
        sys.exit(1)


if __name__ == '__main__':
    main()
