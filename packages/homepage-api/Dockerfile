FROM node:20-alpine AS base
RUN corepack enable && corepack prepare pnpm@latest --activate
WORKDIR /app

FROM base AS build
COPY pnpm-lock.yaml pnpm-workspace.yaml package.json tsconfig.base.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/homepage-api/package.json packages/homepage-api/
RUN pnpm install --frozen-lockfile

COPY packages/shared packages/shared
COPY packages/homepage-api packages/homepage-api
RUN pnpm --filter @prediction-market/shared build
RUN pnpm --filter @prediction-market/homepage-api build

FROM base AS production
COPY --from=build /app/pnpm-lock.yaml /app/pnpm-workspace.yaml /app/package.json ./
COPY --from=build /app/packages/shared/package.json packages/shared/
COPY --from=build /app/packages/shared/dist packages/shared/dist
COPY --from=build /app/packages/homepage-api/package.json packages/homepage-api/
COPY --from=build /app/packages/homepage-api/dist packages/homepage-api/dist

RUN pnpm install --frozen-lockfile --prod

ENV NODE_ENV=production
USER node

CMD ["node", "packages/homepage-api/dist/index.js"]
