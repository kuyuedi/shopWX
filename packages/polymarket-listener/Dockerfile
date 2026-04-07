FROM node:20-alpine AS base
RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /app

FROM base AS build
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/polymarket-listener/package.json packages/polymarket-listener/
RUN pnpm install --frozen-lockfile

COPY packages/shared packages/shared
COPY packages/polymarket-listener packages/polymarket-listener
RUN pnpm --filter @prediction-market/shared build
RUN pnpm --filter @prediction-market/polymarket-listener build

FROM base AS production
COPY --from=build /app/pnpm-lock.yaml /app/pnpm-workspace.yaml /app/package.json ./
COPY --from=build /app/packages/shared/package.json packages/shared/
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/packages/polymarket-listener/package.json packages/polymarket-listener/
COPY --from=build /app/packages/polymarket-listener/dist packages/polymarket-listener/dist

RUN pnpm install --frozen-lockfile --prod

ENV NODE_ENV=production
USER node

CMD ["node", "packages/polymarket-listener/dist/index.js"]
