FROM node:24-bookworm-slim AS workspace-dependencies
RUN npm install -g pnpm@12.0.0
WORKDIR /repo
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json ./apps/server/package.json
COPY apps/server/patches ./apps/server/patches
COPY apps/server/observability/package.json ./apps/server/observability/package.json
COPY apps/mcp/package.json ./apps/mcp/package.json
COPY apps/mobile/package.json ./apps/mobile/package.json
COPY apps/desktop/package.json ./apps/desktop/package.json
COPY docs/package.json ./docs/package.json
RUN pnpm --filter @typerelay/mcp install --frozen-lockfile
COPY apps/mcp ./apps/mcp
COPY apps/server/observability ./apps/server/observability
RUN pnpm --filter @typerelay/mcp deploy --prod /opt/deploy/mcp

FROM node:24-bookworm-slim
WORKDIR /repo/apps/mcp
COPY --from=workspace-dependencies /opt/deploy/mcp ./
COPY apps/server/api/catalog.js apps/server/api/openapi.js /repo/apps/server/api/
COPY apps/server/rate_limit_support.js /repo/apps/server/
COPY docs/web/Mailtwine-LICENSE docs/web/attribution.md /repo/notices/
RUN chmod -R a+rX /repo
USER node
CMD ["node", "server.js"]
