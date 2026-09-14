FROM node:24-bookworm-slim
RUN npm install -g pnpm@12.0.0
WORKDIR /repo/apps/mcp
COPY apps/mcp/package.json apps/mcp/pnpm-lock.yaml ./
RUN pnpm install --frozen-lockfile
COPY apps/mcp ./
COPY apps/server/api/catalog.js apps/server/api/openapi.js /repo/apps/server/api/
COPY docs/web/Mailtwine-LICENSE docs/web/attribution.md /repo/notices/
USER node
CMD ["node", "server.js"]
