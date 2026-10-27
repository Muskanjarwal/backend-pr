# syntax=docker/dockerfile:1.7
FROM node:22-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json tsconfig.build.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM node:22-alpine AS runtime
ENV NODE_ENV=production
WORKDIR /app
# Non-root (uid 1000, the image's built-in `node` user), read-only-friendly: only compiled JS, prod deps, SQL migrations.
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node migrations ./migrations
COPY --chown=node:node package.json ./
USER node
EXPOSE 3000 9464
HEALTHCHECK --interval=15s --timeout=3s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3000/healthz || exit 1
# Default: API. The worker uses the same image with `node dist/worker.js`; migrations with `node dist/db/migrate-cli.js`.
CMD ["node", "--import", "./dist/observability/tracing.js", "dist/server.js"]
