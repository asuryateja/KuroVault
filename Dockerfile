# Kurovault — production image. All state lives in /data (mount a persistent volume there).
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --ignore-scripts
COPY client ./client
RUN npm run build

FROM node:22-alpine
# The platform's PORT is honoured (Railway, Render); TDC_PORT overrides it. Default 8640.
ENV NODE_ENV=production TDC_HOST=0.0.0.0 TDC_DATA_DIR=/data
RUN apk add --no-cache su-exec
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force
COPY server ./server
COPY --from=build /app/client/dist ./client/dist
COPY docker-entrypoint.sh /usr/local/bin/kurovault-entrypoint
# Survive uploads that strip the executable bit or add Windows line endings.
RUN sed -i 's/\r$//' /usr/local/bin/kurovault-entrypoint && chmod 755 /usr/local/bin/kurovault-entrypoint
RUN mkdir -p /data && chown node:node /data
VOLUME ["/data"]
EXPOSE 8640
HEALTHCHECK --interval=30s --timeout=5s CMD sh -c 'wget -qO- "http://127.0.0.1:${TDC_PORT:-${PORT:-8640}}/api/public/status" >/dev/null' || exit 1
ENTRYPOINT ["/bin/sh", "/usr/local/bin/kurovault-entrypoint"]
CMD ["node", "--disable-warning=ExperimentalWarning", "server/index.js"]
