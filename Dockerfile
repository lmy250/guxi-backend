# 股析后端：Node 主服务 + Python（策略沙箱 / 过拟合检验需 numpy+scipy）
FROM nikolaik/python-nodejs:python3.11-nodejs20-slim

WORKDIR /app
COPY . .

# 安装过拟合检验所需科学计算依赖
RUN pip install --no-cache-dir numpy scipy

ENV PYTHON=/usr/local/bin/python
EXPOSE 3000

CMD ["node", "server/server.js"]
