# Stage 1: build the React UI
FROM node:24-alpine AS web
WORKDIR /web
COPY web/package.json web/package-lock.json* ./
RUN npm install --no-audit --no-fund
COPY web/ ./
RUN npm run build

# Stage 2: API server serving the built UI. node:sqlite is built in, so no native compile step.
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production DATA_DIR=/data PORT=3102
# ffmpeg encodes natural-voice audio to MP3; su-exec drops root after fixing data folder ownership.
RUN apk add --no-cache ffmpeg su-exec
COPY server/package.json server/package-lock.json* ./
RUN npm install --omit=dev --no-audit --no-fund && npm cache clean --force
COPY server/server.js ./
COPY server/lib ./lib
COPY server/routes ./routes
COPY --from=web /web/dist ./public
COPY docker-entrypoint.sh /usr/local/bin/
RUN chmod +x /usr/local/bin/docker-entrypoint.sh && mkdir -p /data
EXPOSE 3102
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:3102/healthz >/dev/null || exit 1
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "--no-warnings=ExperimentalWarning", "server.js"]
