# Build from the repository root:  docker build -f server/Dockerfile -t fingerprint-server .
# The server has no runtime dependencies (only what ships with Node), so the final image is just Node and the build.

FROM node:22-slim AS build
WORKDIR /app
RUN npm install --no-save --no-audit --no-fund typescript@5.1.6 @types/node@22
COPY server/tsconfig.json server/tsconfig.json
COPY server/src server/src
RUN npx tsc -p server/tsconfig.json && find server/dist -name '*.test.js' -delete

FROM node:22-slim
ENV NODE_ENV=production
WORKDIR /app
COPY --from=build /app/server/dist ./dist
# The database lives in /data: mount a volume there. The configuration is mounted at /config/config.json.
RUN mkdir -p /data /config && chown node:node /data
USER node
ENV FP_CONFIG=/config/config.json
EXPOSE 8443
CMD ["node", "dist/main.js"]
