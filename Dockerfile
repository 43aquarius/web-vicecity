FROM node:20-alpine
WORKDIR /app
COPY server.js config.json package.json ./
# 分区数据放卷 /app/data（≈361 MB）
VOLUME /app/data
EXPOSE 8787
# 首次启动自动播种；healthcheck 顺带校验就绪状态
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s \
  CMD wget -qO- http://127.0.0.1:8787/healthz | grep -q '"ok":true' || exit 1
CMD ["node", "server.js"]
