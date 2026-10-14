# paz-extauthz-adapter — Envoy ext_authz (gRPC) ⇄ Ping Authorize sideband bridge.
#
# Config arrives via env vars (SERVICE_URL, SECRET_HEADER_VALUE, LISTEN_PORT,
# SIDEBAND_TIMEOUT_MS, DEBUG_LOGGING) — see ../.env.example. The proto dir must
# keep its src/proto layout: the adapter resolves it relative to the .mjs file.

FROM node:22-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src ./src
USER node
EXPOSE 8082
CMD ["node", "src/paz-extauthz-adapter.mjs"]
