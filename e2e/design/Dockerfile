FROM oven/bun:1.4.2 AS bun
FROM mcr.microsoft.com/playwright:v1.62.1-noble@sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /work
COPY package.json bun.lock tsconfig.json ./
COPY patches ./patches
COPY packages ./packages
COPY apps/web ./apps/web
COPY apps/server/package.json ./apps/server/package.json
COPY e2e/design ./e2e/design
COPY e2e/tsconfig.json ./e2e/tsconfig.json
RUN --mount=type=cache,target=/root/.bun/install/cache bun install --frozen-lockfile --registry=https://registry.npmjs.org
ENV CI=1
CMD ["bun", "run", "design:test"]
