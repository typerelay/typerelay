FROM rust:1.94-bookworm AS rust
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY crates ./crates
COPY scripts ./scripts
RUN cargo build --release --locked --bins
RUN rustup target add wasm32-unknown-unknown && cargo build --release --locked -p typerelay-template-wasm --target wasm32-unknown-unknown

FROM node:24-bookworm-slim
RUN npm install -g pnpm@12.0.0
WORKDIR /app
COPY apps/server/package.json apps/server/pnpm-lock.yaml apps/server/pnpm-workspace.yaml ./
RUN pnpm install --frozen-lockfile
COPY apps/server ./
COPY docs/web/Streamient-LICENSE docs/web/Mailtwine-LICENSE docs/web/attribution.md ./notices/
COPY --from=rust /src/target/release/typerelay-yaml /src/target/release/typerelay /usr/local/bin/
COPY --from=rust /src/target/wasm32-unknown-unknown/release/typerelay_template_wasm.wasm /usr/local/share/typerelay/template.wasm
RUN mkdir /data /integrations && chown node:node /data /integrations
USER node
CMD ["node", "scripts/start.js"]
