FROM rust:1.94-bookworm AS rust
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
COPY scripts ./scripts
RUN cargo build --release --locked --bins
RUN rustup target add wasm32-unknown-unknown && cargo build --release --locked -p typerelay-template-wasm --target wasm32-unknown-unknown

FROM node:24-bookworm-slim AS server-dependencies
RUN npm install -g pnpm@12.0.0
WORKDIR /opt/typerelay/apps/server
COPY apps/server/package.json apps/server/pnpm-lock.yaml apps/server/pnpm-workspace.yaml ./
COPY apps/server/patches ./patches
RUN pnpm install --frozen-lockfile

FROM node:24-bookworm-slim AS mcp-dependencies
RUN npm install -g pnpm@12.0.0
WORKDIR /opt/typerelay/apps/mcp
COPY apps/mcp/package.json apps/mcp/pnpm-lock.yaml apps/mcp/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile

FROM node:24-bookworm-slim AS production
ARG APP_VERSION=development
ENV APP_VERSION=${APP_VERSION}
WORKDIR /opt/typerelay/apps/server
COPY --from=server-dependencies /opt/typerelay/apps/server/node_modules ./node_modules
COPY apps/server ./
COPY --from=mcp-dependencies /opt/typerelay/apps/mcp/node_modules ../mcp/node_modules
COPY apps/mcp ../mcp
COPY docs/web/Streamient-LICENSE docs/web/Mailtwine-LICENSE docs/web/attribution.md /opt/typerelay/notices/
COPY --from=rust /src/target/release/typerelay-yaml /src/target/release/typerelay /usr/local/bin/
COPY --from=rust /src/target/wasm32-unknown-unknown/release/typerelay_template_wasm.wasm /usr/local/share/typerelay/template.wasm
RUN mkdir -p /data/editor && chown -R node:node /data
USER node
HEALTHCHECK --interval=30s --timeout=3s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3040)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["npm", "run", "start"]
