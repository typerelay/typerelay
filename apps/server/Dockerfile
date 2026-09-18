FROM rust:1.94-bookworm AS rust
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
COPY scripts ./scripts
RUN cargo build --release --locked --bins
RUN rustup target add wasm32-unknown-unknown && cargo build --release --locked -p typerelay-template-wasm --target wasm32-unknown-unknown

FROM node:24-bookworm-slim AS workspace-dependencies
RUN npm install -g pnpm@12.0.0
WORKDIR /opt/typerelay
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml ./
COPY apps/server/package.json ./apps/server/package.json
COPY apps/server/patches ./apps/server/patches
COPY apps/server/observability/package.json ./apps/server/observability/package.json
COPY apps/mcp/package.json ./apps/mcp/package.json
COPY apps/mobile/package.json ./apps/mobile/package.json
COPY apps/desktop/package.json ./apps/desktop/package.json
COPY docs/package.json ./docs/package.json
RUN pnpm --filter @typerelay/server --filter @typerelay/mcp --filter @typerelay/mobile install --frozen-lockfile
COPY apps/server ./apps/server
COPY apps/mcp ./apps/mcp
COPY apps/mobile ./apps/mobile
RUN pnpm --filter @typerelay/server deploy --prod /opt/deploy/server && pnpm --filter @typerelay/mcp deploy --prod /opt/deploy/mcp && pnpm --filter @typerelay/mobile deploy /opt/deploy/mobile

# Development-only mobile frontend and its shared Rust storage bridge.
FROM rust AS mobile-rust
RUN cargo build --release --locked -p typerelay-mobile --features preview --bin typerelay-mobile-preview

FROM workspace-dependencies AS mobile
WORKDIR /opt/typerelay/apps/mobile
COPY --from=workspace-dependencies /opt/deploy/mobile/node_modules ./node_modules
COPY --from=workspace-dependencies /opt/deploy/server /opt/typerelay/apps/server
COPY apps/mobile ./
COPY --from=mobile-rust /src/target/release/typerelay-mobile-preview /usr/local/bin/
COPY --from=rust /src/target/wasm32-unknown-unknown/release/typerelay_template_wasm.wasm /usr/local/share/typerelay/template.wasm
ENV NODE_ENV=development
CMD ["pnpm", "exec", "vite", "--host", "0.0.0.0", "--port", "5174", "--strictPort"]

FROM node:24-bookworm-slim AS production
ARG APP_VERSION=development
ENV APP_VERSION=${APP_VERSION}
ENV NODE_OPTIONS=--disable-warning=ExperimentalWarning
COPY package.json pnpm-lock.yaml pnpm-workspace.yaml /opt/typerelay/
WORKDIR /opt/typerelay/apps/server
COPY --from=workspace-dependencies /opt/deploy/server ./
COPY --from=workspace-dependencies /opt/deploy/mcp ../mcp
COPY docs/web/Streamient-LICENSE docs/web/Mailtwine-LICENSE docs/web/attribution.md /opt/typerelay/notices/
COPY --from=rust /src/target/release/typerelay-yaml /src/target/release/typerelay /usr/local/bin/
COPY --from=rust /src/target/wasm32-unknown-unknown/release/typerelay_template_wasm.wasm /usr/local/share/typerelay/template.wasm
RUN chmod -R a+rX /opt/typerelay && mkdir -p /data/editor && chown -R node:node /data
USER node
HEALTHCHECK --interval=30s --timeout=3s --retries=3 CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3040)+'/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["npm", "run", "start"]
