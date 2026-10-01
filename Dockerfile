# One image, three uses on Kubernetes (Devtron):
#   migrate (once per deploy, before new pods):  node scripts/migrate.ts   → applies pending drizzle/ migrations
#   web     (default, any number of pods):       the chat, /u links, /admin (port 3000, readiness: GET /api/health)
#   sync    (daily cron):                        node scripts/sync.ts      → today's users from Redash into the database
# Secrets come from Devtron env (see README → Deploy), never from the image.

FROM node:24-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci

FROM node:24-slim AS build
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1
COPY --from=deps /app/node_modules ./node_modules
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:24-slim
WORKDIR /app
ENV NODE_ENV=production NEXT_TELEMETRY_DISABLED=1 PORT=3000 REQUIRE_DATABASE=1
COPY --from=build --chown=node:node /app/package.json /app/package-lock.json ./
COPY --from=build --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/.next ./.next
COPY --from=build --chown=node:node /app/public ./public
COPY --from=build --chown=node:node /app/config ./config
COPY --from=build --chown=node:node /app/src ./src
COPY --from=build --chown=node:node /app/scripts ./scripts
COPY --from=build --chown=node:node /app/drizzle ./drizzle
COPY --from=build --chown=node:node /app/next.config.ts /app/tsconfig.json ./
# The daily sync writes its report to out/ (the app user must own it)
RUN mkdir -p /app/out && chown node:node /app/out
USER node
EXPOSE 3000
# Next runs as the main process, so Kubernetes' SIGTERM reaches it and pods drain cleanly on rollout.
CMD ["node", "node_modules/next/dist/bin/next", "start", "-p", "3000"]
