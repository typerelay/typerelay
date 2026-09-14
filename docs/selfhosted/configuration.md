# Configuration

Use `compose.yml` only for development. Export `DEV_TYPERELAY_MONGODB_URI`, `SMTP_SERVERS`, `SMTP_FROM`, `SESSION_SECRET`, and `JWT_SECRET` in your Fish terminal; MongoDB and SMTP come from dbh and are not duplicated in the development stack. Start it with `docker compose up -d --build`; the app, MCP adapter and scheduler start by default.

For open-source production, export the required values from Fish and use `compose.prod.yml`:

```fish
set -x APP_URL https://typerelay.example.com
set -x MCP_BASE_URL https://mcp.typerelay.example.com
set -x SESSION_SECRET (openssl rand -hex 64)
set -x JWT_SECRET (openssl rand -hex 64)
set -x SMTP_FROM noreply@example.com
set -x SMTP_SERVERS '[{"name":"primary","host":"smtp.example.com","port":587,"secure":false,"user":"user","pass":"password","from":"noreply@example.com"}]'
docker compose -f compose.prod.yml up -d
```

`MCP_BASE_URL` is the public MCP host without `/mcp`; TypeRelay appends the resource path. `SMTP_SERVERS` accepts `name`, `host`, `port`, `secure`, `user`, `pass`, and `from`. Optional `APP_PORT` and `MCP_PORT` change the published ports from `3000` and `3002`. `API_BASE_URL` and `MONGO_URI` are wired internally by the production Compose file. Keep credentials outside Git and put both public services behind HTTPS.


The development application serves the compiled site at `http://localhost:3040/docs/`. Build it with `docker compose run --rm docs`. For a dedicated docs host, build with `docker compose run --rm -e TYPERELAY_DOCS_BASE=/ docs` and serve the output separately. Rebuild with the default base before serving it under the application again.

The development MCP service listens on `http://localhost:3041/mcp`. The production MCP service uses port `3002`. It uses `JWT_SECRET` for private API delegation and has no direct database access. `API_ALLOWED_ORIGINS` and `MCP_ALLOWED_ORIGINS` can explicitly allow additional browser origins.
