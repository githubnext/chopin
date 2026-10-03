FROM oven/bun:1.4.2 AS bun
FROM mcr.microsoft.com/playwright:v1.62.1-noble@sha256:dcc5531e97840b9b5e794f2814476b21571c5124a3fca2267d73041f56e7580e
COPY --from=bun /usr/local/bin/bun /usr/local/bin/bun
WORKDIR /work
ARG CHOPIN_SOURCE_COMMIT
RUN bun -e 'if (!/^[0-9a-f]{40}$/.test(process.env.CHOPIN_SOURCE_COMMIT || "")) throw new Error("CHOPIN_SOURCE_COMMIT must be 40 lowercase hex characters");'
LABEL org.chopin.source-commit=$CHOPIN_SOURCE_COMMIT
ENV CI=1 PLAYWRIGHT_BROWSERS_PATH=/ms-playwright PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1
COPY package.json bun.lock tsconfig.json ./
COPY packages ./packages
COPY apps/server ./apps/server
COPY apps/web ./apps/web
COPY e2e ./e2e
COPY scripts ./scripts
COPY patches ./patches
RUN --mount=type=cache,target=/root/.bun/install/cache bun install --frozen-lockfile --registry=https://registry.npmjs.org
RUN bun run build
RUN <<'SH'
bun -e '
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { sourceHash, treeHash } from "./scripts/conversation-plan-worker.ts";
let stamp = { commit: process.env.CHOPIN_SOURCE_COMMIT,
 lockSha256: createHash("sha256").update(await readFile("/work/bun.lock")).digest("hex"),
 sourceSha256: await sourceHash("/work"),
 buildSha256: await treeHash("/work", ["apps/web/dist"], new Set()) };
await writeFile("/work/e2e/.conversation-plan-build.json", JSON.stringify(stamp) + "\n");'
SH
ENTRYPOINT ["/usr/local/bin/bun"]
CMD ["scripts/conversation-plan-worker.ts"]
