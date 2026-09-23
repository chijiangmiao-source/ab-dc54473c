FROM node:20-alpine

WORKDIR /app

# 零第三方依赖：仅拷贝应用源码与测试
COPY package.json ./
COPY public ./public
COPY server ./server
COPY scripts ./scripts
COPY test ./test

ENV HOST=0.0.0.0
ENV PORT=8080
EXPOSE 8080

HEALTHCHECK --interval=10s --timeout=3s --start-period=2s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/healthz').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "server/index.js"]
