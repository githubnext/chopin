# syntax=docker/dockerfile:1

ARG BUN_VERSION=1.4.4
# The image that runs now, so this build keeps the hashed files of the builds before it and a
# tab left open across a deploy still finds its chunks. Without one, only this build's are served.
ARG PREVIOUS_IMAGE=no-previous

FROM oven/bun:${BUN_VERSION} AS manifests
WORKDIR /app

# node-pty, which the connector's sandbox library depends on, compiles a native module when it
# installs. These tools stay in the install stages; the runtime image starts from a clean base.
RUN apt-get update \
	&& apt-get install -y --no-install-recommends python3 make g++ \
	&& rm -rf /var/lib/apt/lists/*

COPY package.json bun.lock ./
COPY patches ./patches
COPY apps/connector/package.json ./apps/connector/package.json
COPY apps/server/package.json ./apps/server/package.json
COPY apps/web/package.json ./apps/web/package.json
COPY packages/agent-link/package.json ./packages/agent-link/package.json
COPY packages/dialect/package.json ./packages/dialect/package.json
COPY packages/diagrams/package.json ./packages/diagrams/package.json
COPY packages/draft/package.json ./packages/draft/package.json
COPY packages/editor/package.json ./packages/editor/package.json
COPY packages/experiment/package.json ./packages/experiment/package.json
COPY packages/icons/package.json ./packages/icons/package.json
COPY packages/protocol/package.json ./packages/protocol/package.json
COPY packages/question/package.json ./packages/question/package.json
COPY packages/viewport/package.json ./packages/viewport/package.json
COPY packages/visuals/package.json ./packages/visuals/package.json

FROM manifests AS build-dependencies
RUN bun install --frozen-lockfile

FROM build-dependencies AS build
COPY apps ./apps
COPY packages ./packages
COPY tsconfig.json ./tsconfig.json
RUN bun run build

FROM oven/bun:${BUN_VERSION} AS no-previous
RUN mkdir -p /app/apps/web/dist/assets /app/apps/web/kept-assets/assets

FROM ${PREVIOUS_IMAGE} AS previous
# An image built before kept assets has no kept-assets directory. Making an empty one here keeps the
# copy below working on Docker's classic builder, which Azure Container Registry builds use and which,
# unlike BuildKit, fails a COPY whose wildcard matches nothing.
USER root
RUN mkdir -p /app/apps/web/kept-assets/assets

FROM oven/bun:${BUN_VERSION} AS kept-assets
WORKDIR /keep
COPY scripts/keep-assets.ts ./
COPY --from=previous /app/apps/web/dist/assets/ ./previous/
COPY --from=previous /app/apps/web/kept-assets/ ./kept/
COPY --from=build /app/apps/web/dist/assets/ ./current/
RUN bun keep-assets.ts --previous previous --kept kept --current current --out out

FROM manifests AS production-dependencies
RUN bun install --frozen-lockfile --production --filter '*'

FROM oven/bun:${BUN_VERSION} AS runtime
WORKDIR /app

RUN apt-get update \
	&& apt-get install -y --no-install-recommends ca-certificates \
	&& rm -rf /var/lib/apt/lists/* \
	&& install -d -o bun -g bun -m 0700 /var/lib/chopin

# The atomic Planner's per-document directories and workflow journal live under
# $XDG_STATE_HOME/chopin; mount a volume at /var/lib/chopin to keep them.
ENV NODE_ENV=production \
	PORT=8787 \
	SERVER_HOST=0.0.0.0 \
	XDG_STATE_HOME=/var/lib/chopin

COPY --from=production-dependencies --chown=bun:bun /app/node_modules ./node_modules
COPY --from=production-dependencies --chown=bun:bun /app/apps/server/node_modules ./apps/server/node_modules
COPY --from=production-dependencies --chown=bun:bun /app/packages/agent-link/node_modules ./packages/agent-link/node_modules
COPY --from=production-dependencies --chown=bun:bun /app/packages/dialect/node_modules ./packages/dialect/node_modules
COPY --from=production-dependencies --chown=bun:bun /app/packages/draft/node_modules ./packages/draft/node_modules
COPY --from=production-dependencies --chown=bun:bun /app/packages/experiment/node_modules ./packages/experiment/node_modules
COPY --from=production-dependencies --chown=bun:bun /app/packages/question/node_modules ./packages/question/node_modules
COPY --chown=bun:bun package.json bun.lock ./
COPY --chown=bun:bun apps/server ./apps/server
COPY --from=build --chown=bun:bun /app/apps/web/dist ./apps/web/dist
COPY --from=kept-assets --chown=bun:bun /keep/out ./apps/web/kept-assets
COPY --from=build --chown=bun:bun /app/apps/connector/dist ./apps/connector/dist
COPY --chown=bun:bun apps/connector/package.json ./apps/connector/package.json
COPY --chown=bun:bun apps/web/package.json ./apps/web/package.json
COPY --chown=bun:bun packages ./packages

USER bun
EXPOSE 8787

# A process waiting in standby for the writer lease holds every other request, so the check asks
# the liveness endpoint, which answers in standby too.
HEALTHCHECK --interval=10s --timeout=3s --start-period=10s --retries=3 \
	CMD ["bun", "-e", "let r=await fetch('http://127.0.0.1:8787/api/health/live');process.exit(r.ok?0:1)"]

CMD ["sh", "-c", "bun apps/server/src/storage/migrate.ts && exec bun apps/server/src/main.ts"]
