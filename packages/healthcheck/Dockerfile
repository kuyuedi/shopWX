FROM node:20-alpine AS base
RUN corepack enable && corepack prepare pnpm@latest --activate
# Install docker CLI for container checks
RUN apk add --no-cache docker-cli
WORKDIR /app

FROM base AS build
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/healthcheck/package.json packages/healthcheck/
RUN pnpm install --frozen-lockfile

COPY packages/shared packages/shared
COPY packages/healthcheck packages/healthcheck
RUN pnpm --filter @prediction-market/shared build
RUN pnpm --filter @prediction-market/healthcheck build

FROM base AS production
COPY --from=build /app/pnpm-lock.yaml /app/pnpm-workspace.yaml /app/package.json ./
COPY --from=build /app/packages/shared/package.json packages/shared/
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/packages/healthcheck/package.json packages/healthcheck/
COPY --from=build /app/packages/healthcheck/dist packages/healthcheck/dist

RUN pnpm install --frozen-lockfile --prod

ENV NODE_ENV=production

CMD ["node", "packages/healthcheck/dist/index.js"]
