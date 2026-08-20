# 股析后端 · 公网部署包

这是「股析」股票分析产品的后端服务，可部署到 Render / Railway / 任意云服务器，为 H5 网页版提供真实 iFinD 行情。

## 目录结构

```
server/         主服务与数据桥（Node，无 npm 依赖）
  server.js        HTTP 路由 + CORS
  ifind_bridge.js  iFinD MCP 数据桥（真实行情/财务/选股/板块/龙虎榜/资金流）
  strategy_runner.py   客户 Python 策略沙箱（标准库）
  overfit/         过拟合检验（DSR/PBO/Haircut/MinTRL，需 numpy+scipy）
  stock_pool.json  全市场 5500+ 股票池
  akshare_bridge.py  备用数据源（可选，USE_REAL=1 时才用）
utils/          指标库 + mock 兜底
Dockerfile       Node + Python 一体化镜像
render.yaml      Render 一键部署配置
```

## 部署方式一：Render（推荐，免备案 + 自带 HTTPS）

1. 把本目录推到一个 **私有** GitHub 仓库（token 不要进仓库，见下）。
2. Render 新建 **Blueprint**，指向仓库，选 `render.yaml`，一键部署。
3. 在 Render 环境变量里填 `IFIND_TOKEN`（你的 iFinD MCP token）。
4. 部署完成后得到 `https://xxx.onrender.com`，`/api/health` 返回 `{"ok":true,"useIfind":true}` 即成功。

## 部署方式二：Docker（任意云服务器）

```bash
docker build -t guxi-backend .
docker run -d -p 3000:3000 -e IFIND_TOKEN=你的token guxi-backend
```

## 部署方式三：裸机（已装 Node 16+ 和 Python3 + numpy/scipy）

```bash
pip install numpy scipy
PORT=3000 PYTHON=/usr/bin/python3 IFIND_TOKEN=你的token node server/server.js
```

## 前端指向公网后端

把 `web/js/api.js` 里的默认 API 地址改为：

```js
API_BASE = 'https://xxx.onrender.com/api';
```

或让访问者打开页面后点右上角状态点，手动填入该地址。

## 重要提醒

- **token 安全**：iFinD token 不要提交到公开仓库。本目录的 `server/ifind_config.json` 已被 `.gitignore` 排除，token 请通过环境变量 `IFIND_TOKEN` 注入（代码已支持环境变量优先）。
- **HTTPS**：CloudStudio 前端是 https，后端若 http 会被浏览器拦截（混合内容）。用 Render/Railway（自带 https）即可。
- **限流**：iFinD 免费版约 2 req/s，多人并发会慢，正式使用需付费版。
- **健康检查**：`GET /api/health`。
