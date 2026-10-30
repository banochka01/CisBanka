# syntax=docker/dockerfile:1
# Стадии: base-build (компилятор), build (фронтенд + сервер), deps (только рабочие зависимости сервера), финальный образ.

FROM node:22-bookworm-slim AS base-build
# компилятор нужен, если для better-sqlite3 под эту версию Node нет готового бинарника
RUN apt-get update && apt-get install -y --no-install-recommends python3 make g++ && rm -rf /var/lib/apt/lists/*

FROM base-build AS build
WORKDIR /app
COPY package.json package-lock.json ./
COPY engine/package.json engine/
COPY web/package.json web/
COPY server/package.json server/
RUN npm ci --no-audit --no-fund
COPY engine engine
COPY web web
COPY server server
RUN npm run build -w web && npm run build -w server

FROM base-build AS deps
WORKDIR /app
COPY package.json package-lock.json ./
COPY engine/package.json engine/
COPY web/package.json web/
COPY server/package.json server/
RUN npm ci --omit=dev --no-audit --no-fund -w server

FROM node:22-bookworm-slim
ENV NODE_ENV=production \
    PORT=3000 \
    DB_PATH=/data/cisbanka.db \
    WEB_DIST=/app/web
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=build /app/server/package.json ./server/package.json
COPY --from=build /app/server/dist ./server
COPY --from=build /app/web/dist ./web
RUN mkdir -p /data && chown node:node /data
USER node
VOLUME ["/data"]
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=10s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["node", "server/index.js"]
