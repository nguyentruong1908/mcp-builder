# Build context: repository root.  docker build -f apps/api/Dockerfile .
FROM node:24-bookworm-slim AS base
# git: Codex inspects workspaces; openssl: Prisma; bubblewrap: Codex Linux sandbox.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates git openssl bubblewrap \
 && rm -rf /var/lib/apt/lists/* \
 && npm install -g pnpm@9.15.4
WORKDIR /app

FROM base AS build
# prisma generate (postinstall) needs a syntactically valid URL; nothing connects during the build.
ENV DATABASE_URL=postgresql://build:build@localhost:5432/build
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json ./
COPY packages/shared/package.json packages/shared/
COPY apps/api/package.json apps/api/prisma.config.ts apps/api/
COPY apps/api/prisma apps/api/prisma
RUN pnpm install --frozen-lockfile --filter api...
COPY packages/shared packages/shared
COPY apps/api apps/api
RUN pnpm --filter api build

FROM base AS run
ENV NODE_ENV=production PORT=4000 DATA_DIR=/data
COPY --from=build /app /app
COPY templates /app/templates
RUN mkdir -p /data && chown -R node:node /data
USER node
WORKDIR /app/apps/api
VOLUME ["/data"]
EXPOSE 4000
CMD ["sh", "-c", "node_modules/.bin/prisma migrate deploy && exec node dist/main.js"]
