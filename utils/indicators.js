// 技术指标计算（纯函数，行情页与回测共用）
// 所有输入为数字数组，输出与输入等长，前置不足周期的位置填 null

function MA(values, period) {
  const res = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) res[i] = +(sum / period).toFixed(3);
  }
  return res;
}

function EMA(values, period) {
  const res = new Array(values.length).fill(null);
  const k = 2 / (period + 1);
  let prev = null;
  for (let i = 0; i < values.length; i++) {
    if (i === 0) {
      res[i] = values[i];
      prev = values[i];
    } else {
      const e = values[i] * k + prev * (1 - k);
      res[i] = +e.toFixed(3);
      prev = e;
    }
  }
  return res;
}

function MACD(closes, fast = 12, slow = 26, signal = 9) {
  const emaFast = EMA(closes, fast);
  const emaSlow = EMA(closes, slow);
  const dif = closes.map((_, i) =>
    emaFast[i] != null && emaSlow[i] != null ? +(emaFast[i] - emaSlow[i]).toFixed(3) : null
  );
  const difArr = dif.filter((v) => v != null);
  const deaArr = EMA(difArr, signal);
  const dea = [];
  let idx = 0;
  for (let i = 0; i < closes.length; i++) {
    if (dif[i] == null) dea.push(null);
    else {
      dea.push(deaArr[idx]);
      idx++;
    }
  }
  const hist = closes.map((_, i) =>
    dif[i] != null && dea[i] != null ? +((dif[i] - dea[i]) * 2).toFixed(3) : null
  );
  return { dif, dea, hist };
}

function RSI(closes, period = 14) {
  const res = new Array(closes.length).fill(null);
  let gain = 0;
  let loss = 0;
  for (let i = 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (i <= period) {
      if (diff >= 0) gain += diff;
      else loss += -diff;
      if (i === period) {
        gain /= period;
        loss /= period;
        res[i] = loss === 0 ? 100 : +(100 - 100 / (1 + gain / loss)).toFixed(2);
      }
    } else {
      const g = diff >= 0 ? diff : 0;
      const l = diff < 0 ? -diff : 0;
      gain = (gain * (period - 1) + g) / period;
      loss = (loss * (period - 1) + l) / period;
      res[i] = loss === 0 ? 100 : +(100 - 100 / (1 + gain / loss)).toFixed(2);
    }
  }
  return res;
}

function KDJ(highs, lows, closes, n = 9) {
  const k = [];
  const d = [];
  const j = [];
  let prevK = 50;
  let prevD = 50;
  for (let i = 0; i < closes.length; i++) {
    if (i < n - 1) {
      k.push(null);
      d.push(null);
      j.push(null);
      continue;
    }
    const window = highs.slice(i - n + 1, i + 1);
    const hh = Math.max(...window);
    const ll = Math.min(...lows.slice(i - n + 1, i + 1));
    const rsv = hh === ll ? 50 : ((closes[i] - ll) / (hh - ll)) * 100;
    const K = (2 / 3) * prevK + (1 / 3) * rsv;
    const D = (2 / 3) * prevD + (1 / 3) * K;
    const J = 3 * K - 2 * D;
    k.push(+K.toFixed(2));
    d.push(+D.toFixed(2));
    j.push(+J.toFixed(2));
    prevK = K;
    prevD = D;
  }
  return { k, d, j };
}

function BOLL(closes, period = 20, k = 2) {
  const mid = MA(closes, period);
  const upper = new Array(closes.length).fill(null);
  const lower = new Array(closes.length).fill(null);
  for (let i = 0; i < closes.length; i++) {
    if (mid[i] == null) continue;
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += (closes[j] - mid[i]) * (closes[j] - mid[i]);
    const sd = Math.sqrt(sum / period);
    upper[i] = +(mid[i] + k * sd).toFixed(3);
    lower[i] = +(mid[i] - k * sd).toFixed(3);
  }
  return { mid, upper, lower };
}

// 回撤修复分析：找出每次「从峰值下跌（回撤）」后，恢复到先前峰值所需的周期数。
// values: 数值序列（如价格数组）。
// timestamps: 可选，与 values 等长的数值数组（如交易日时间戳），提供时用时差值计算时长，否则按索引差（步数/周期数）。
// 返回事件数组，每项标注回撤起点(peak)、谷底(trough)、修复完成点(recovery)：
//   { peakIndex, peakValue, troughIndex, troughValue, recoveryIndex, recoveryValue,
//     recovered, drawdown, underwaterDuration, recoveryDuration }
//   - recovered=false 表示到序列末尾仍未完全修复，recoveryIndex/recoveryValue/时长均为 null。
//   - drawdown 为最大回撤幅度（负小数，如 -0.2 表示 -20%）。
//   - underwaterDuration：峰值 → 修复 的总周期数（水下时长）。
//   - recoveryDuration：谷底 → 修复 的周期数（真正的“修复时长”）。
function drawdownRecovery(values, timestamps) {
  const events = [];
  if (!values || values.length < 2) return events;
  const n = values.length;
  const dur = (a, b) => (timestamps ? timestamps[b] - timestamps[a] : b - a);

  let peakValue = values[0];
  let peakIndex = 0;
  let inDrawdown = false;
  let troughValue = Infinity;
  let troughIndex = -1;

  for (let i = 1; i < n; i++) {
    const v = values[i];
    if (v >= peakValue) {
      // 恢复到先前峰值（或创新高）
      if (inDrawdown) {
        events.push({
          peakIndex,
          peakValue,
          troughIndex,
          troughValue,
          recoveryIndex: i,
          recoveryValue: v,
          recovered: true,
          drawdown: +((troughValue - peakValue) / peakValue).toFixed(6),
          underwaterDuration: dur(peakIndex, i),
          recoveryDuration: dur(troughIndex, i)
        });
      }
      peakValue = v;
      peakIndex = i;
      inDrawdown = false;
      troughValue = Infinity;
      troughIndex = -1;
    } else {
      // 处于峰值之下，进入/持续回撤，更新谷底
      if (v < troughValue) {
        troughValue = v;
        troughIndex = i;
      }
      inDrawdown = true;
    }
  }

  // 序列末尾仍未修复的回撤
  if (inDrawdown) {
    events.push({
      peakIndex,
      peakValue,
      troughIndex,
      troughValue,
      recoveryIndex: null,
      recoveryValue: null,
      recovered: false,
      drawdown: +((troughValue - peakValue) / peakValue).toFixed(6),
      underwaterDuration: null,
      recoveryDuration: null
    });
  }
  return events;
}

module.exports = { MA, EMA, MACD, RSI, KDJ, BOLL, drawdownRecovery };
