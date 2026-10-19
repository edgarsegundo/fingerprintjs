# Build from the repository root:  docker build -f server/Dockerfile -t fingerprint-server .
# SQLite comes with Node. MySQL needs the one driver, mysql2, which the server loads only when the configuration asks for
# MySQL. It is pinned to the version that the tests ran against.

FROM node:22-slim AS build
WORKDIR /app
RUN npm install --no-save --no-audit --no-fund typescript@5.1.6 @types/node@22 mysql2@3.24.5
COPY server/tsconfig.json server/tsconfig.json
COPY server/src server/src
RUN npx tsc -p server/tsconfig.json && find server/dist -name '*.test.js' -delete

FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
RUN npm install --no-save --no-audit --no-fund --omit=dev mysql2@3.24.5 && npm cache clean --force
COPY --from=build /app/server/dist ./dist
# The database lives in /data: mount a volume there. The configuration is mounted at /config/config.json.
RUN mkdir -p /data /config && chown node:node /data
USER node
ENV FP_CONFIG=/config/config.json
EXPOSE 8443
# Ready, not only alive: the storage answers and no webhook is stuck. It reads the port from the configuration.
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 CMD ["node", "dist/healthcheck.js"]
CMD ["node", "dist/main.js"]
