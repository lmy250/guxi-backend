#!/usr/bin/env python3
"""过拟合检测执行器（skill-backtest-overfit 的落地封装）。

从 stdin 读 JSON，调用 DSR / PBO(CSCV) / Haircut Sharpe / MinTRL 四个统计量，
输出 OverfitReport JSON。只依赖 numpy + scipy，无 pandas。

输入 JSON 契约：
  {
    "returns": [ ... ],          # 被选中策略的逐期收益（非年化），必需
    "trials":  [[..],[..]],      # T x N 试验矩阵（每列一个配置/标的的逐期收益），可选；缺省 PBO 降级
    "n_trials": 200,             # 诚实申报的试验次数（多重检验数）
    "periods_per_year": 252,     # 年化期数（日频 252）
    "haircut_method": "holm"     # bonferroni | holm | bhy
  }
"""
import sys
import json
import math
import os

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import numpy as np

try:
    from deflated_sharpe import deflated_sharpe_ratio, minimum_track_record_length, sharpe_ratio, _skew_kurt
    from haircut import haircut_sharpe
    from pbo_cscv import probability_of_backtest_overfitting
    DEPS_OK = True
    IMPORT_ERR = ''
except Exception as _e:  # noqa: BLE001
    DEPS_OK = False
    IMPORT_ERR = str(_e)


def _to_float1d(x):
    a = np.asarray(x or [], dtype=float).reshape(-1)
    return a[~np.isnan(a)]


def build_report(selected_returns, n_trials, trials_matrix=None, periods_per_year=252,
                 dsr_threshold=0.95, pbo_threshold=0.5, n_blocks=16, haircut_method='holm'):
    r = _to_float1d(selected_returns)
    if r.size < 2:
        return {'ok': False, 'error': '收益样本不足（至少需要 2 个逐期收益点）'}
    ann = math.sqrt(periods_per_year)
    sr_pp = sharpe_ratio(r)
    if math.isnan(sr_pp):
        return {'ok': False, 'error': '收益序列标准差为 0 或样本不足，无法计算 Sharpe'}
    skew, kurt = _skew_kurt(r)

    all_trial_sharpes = None
    if trials_matrix is not None:
        tm = np.asarray(trials_matrix, dtype=float)
        if tm.ndim == 2 and tm.shape[1] >= 1:
            all_trial_sharpes = [sharpe_ratio(tm[:, j]) for j in range(tm.shape[1])]
            all_trial_sharpes = [s for s in all_trial_sharpes if not math.isnan(s)]
            n_trials = max(int(n_trials), len(all_trial_sharpes))

    dsr = deflated_sharpe_ratio(r, n_trials=n_trials, all_trial_sharpes=all_trial_sharpes,
                                threshold=dsr_threshold)
    hc = haircut_sharpe(sr_pp, n_obs=r.size, n_tests=int(n_trials), method=haircut_method)
    mintrl = minimum_track_record_length(sr_pp, 0.0, skew, kurt)

    pbo_block = None
    pbo_note = ''
    if trials_matrix is not None:
        tm = np.asarray(trials_matrix, dtype=float)
        if tm.ndim == 2 and tm.shape[1] >= 2:
            T, N = tm.shape
            nb = n_blocks
            if nb % 2:
                nb -= 1
            nb = max(2, min(nb, T))
            if nb < 2 or T < 2:
                pbo_note = '样本过短，无法计算 PBO'
            else:
                try:
                    pbo_block = probability_of_backtest_overfitting(tm, n_blocks=nb).summary()
                except Exception as e:  # noqa: BLE001
                    pbo_note = 'PBO 计算失败: ' + str(e)
        else:
            pbo_note = '试验矩阵列数 < 2，PBO 降级（需至少 2 个配置/标的）'
    else:
        pbo_note = '未提供试验矩阵，PBO 降级（组合回测或多策略对比时才可计算）'

    flags = []
    if dsr.deflated_sharpe_ratio < dsr_threshold:
        flags.append('DSR %.2f < %.2f' % (dsr.deflated_sharpe_ratio, dsr_threshold))
    if pbo_block is not None and pbo_block['pbo'] > pbo_threshold:
        flags.append('PBO %.2f > %.2f' % (pbo_block['pbo'], pbo_threshold))
    if hc.adjusted_sharpe * ann < 0.5:
        flags.append('Haircut Sharpe %.2f < 0.5' % (hc.adjusted_sharpe * ann))
    if mintrl > r.size:
        flags.append('MinTRL 所需样本不足（现有 %d 期）' % r.size)

    passed = len(flags) == 0
    return {
        'ok': True,
        'verdict': 'PASS' if passed else 'FAIL',
        'passed': passed,
        'fail_reasons': flags,
        'observed_sharpe_annual': round(sr_pp * ann, 4),
        'skew': round(skew, 4),
        'kurtosis': round(kurt, 4),
        'n_obs': int(r.size),
        'n_trials': int(n_trials),
        'deflated_sharpe_ratio': round(dsr.deflated_sharpe_ratio, 4),
        'psr_vs_zero': round(dsr.psr_vs_zero, 4),
        'haircut': {
            'method': hc.method,
            'adjusted_sharpe_annual': round(hc.adjusted_sharpe * ann, 4),
            'haircut_pct': round(hc.haircut, 4),
            'observed_pvalue': hc.observed_pvalue,
            'adjusted_pvalue': hc.adjusted_pvalue,
        },
        'minimum_track_record_length': round(mintrl, 1) if math.isfinite(mintrl) else None,
        'pbo': pbo_block,
        'pbo_note': pbo_note,
    }


def _sanitize(o):
    # 把 inf/-inf/nan 转成 null，避免 json.dumps 输出非标准 JSON（如 Infinity）导致 Node JSON.parse 失败
    if isinstance(o, float):
        return None if (math.isnan(o) or math.isinf(o)) else o
    if isinstance(o, dict):
        return {k: _sanitize(v) for k, v in o.items()}
    if isinstance(o, list):
        return [_sanitize(v) for v in o]
    return o


def main():
    raw = ''
    for line in sys.stdin:
        raw += line
    try:
        data = json.loads(raw or '{}')
    except Exception:  # noqa: BLE001
        data = {}

    if not DEPS_OK:
        print(json.dumps({'ok': False, 'error': '统计依赖缺失(numpy/scipy): ' + IMPORT_ERR}))
        return

    try:
        report = build_report(
            selected_returns=data.get('returns') or [],
            n_trials=int(data.get('n_trials') or 1),
            trials_matrix=data.get('trials') or None,
            periods_per_year=int(data.get('periods_per_year') or 252),
            haircut_method=data.get('haircut_method') or 'holm',
        )
        print(json.dumps(_sanitize(report)))
    except Exception as e:  # noqa: BLE001
        print(json.dumps({'ok': False, 'error': str(e)}))


if __name__ == '__main__':
    main()
