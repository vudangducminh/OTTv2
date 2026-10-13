# OTTv2 arena: Node server + web client in one image.
# Node 20 matches the sandbox flags used in server/src/sandbox.js (--experimental-permission).
FROM node:20-alpine

WORKDIR /app
ENV NODE_ENV=production

# Dependencies first, so code changes don't reinstall them.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

COPY library ./library
COPY server ./server
COPY client ./client

# Match logs are written here; mount a volume to keep them.
RUN mkdir -p server/logs && chown -R node:node server/logs
USER node

ENV PORT=6767
EXPOSE 6767

HEALTHCHECK --interval=15s --timeout=3s --start-period=10s \
  CMD wget -qO- "http://127.0.0.1:${PORT}/api/health" > /dev/null || exit 1

CMD ["node", "server/server.js"]
