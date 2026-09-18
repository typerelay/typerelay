# Configuration

Use `compose.yml` only for development. Export `DEV_TYPERELAY_MONGODB_URI`, `MEMCACHED_SERVERS`, `SMTP_SERVERS`, `SMTP_FROM`, `SESSION_SECRET`, and `JWT_SECRET` in your Fish terminal; MongoDB, Memcached and SMTP come from dbh and are not duplicated in the development stack. Start it with `docker compose up -d --build`; the app, MCP adapter and scheduler start by default.

For open-source production, export the required values from Fish and use `compose.prod.yml`:

```fish
set -x APP_URL https://typerelay.example.com
set -x MCP_BASE_URL https://mcp.typerelay.example.com
set -x SESSION_SECRET (openssl rand -hex 64)
set -x JWT_SECRET (openssl rand -hex 64)
set -x SMTP_FROM noreply@example.com
set -x SMTP_SERVERS '[{"name":"primary","host":"smtp.example.com","port":587,"secure":false,"user":"user","pass":"password","from":"noreply@example.com"}]'
set -x ENABLE_SIGNUP true
docker compose -f compose.prod.yml up -d
```

`MCP_BASE_URL` is the public MCP host without `/mcp`; TypeRelay appends the resource path. `SMTP_SERVERS` accepts `name`, `host`, `port`, `secure`, `user`, `pass`, and `from`. Set `ENABLE_SIGNUP=false` to remove the signup form and block signup requests. Optional `APP_PORT` and `MCP_PORT` change the published ports from `3000` and `3002`. `API_BASE_URL` and `MONGO_URI` are wired internally by the production Compose file. Keep credentials outside Git and put both public services behind HTTPS.

## Email delivery

Working SMTP is required for account creation, Magic Link sign-in, password recovery, email changes and team invitations. Configure at least one server in `SMTP_SERVERS` before enabling sign-up or inviting users. Multiple entries are used round-robin; each may override `from`, otherwise `SMTP_FROM` is used. Port 465 defaults to TLS; other ports default to STARTTLS-style non-implicit TLS unless `secure` is set explicitly.

TypeRelay does not provide a production mail catcher or silently treat an SMTP failure as delivery. Verify a real sign-up, Magic Link, reset and invitation after deployment. If an invitation request reports an SMTP failure, refresh **Settings → My team** and revoke any pending invitation before retrying so it does not continue consuming a seat.

Rate limiting is enabled by default. API settings are `API_RATE_LIMIT_ENABLED`, `API_RATE_LIMIT_WINDOW_MS`, `API_RATE_LIMIT_GENERAL_PER_MINUTE`, `API_RATE_LIMIT_EXPENSIVE_PER_MINUTE`, and `API_RATE_LIMIT_UPLOAD_PER_MINUTE`; defaults are `true`, `60000`, `120`, `60`, and `20`. MCP settings are `MCP_RATE_LIMIT_ENABLED`, `MCP_RATE_LIMIT_WINDOW_MS`, `MCP_IP_FLOOD_PER_MINUTE`, `MCP_UNAUTH_PER_MINUTE`, `MCP_AUTH_PER_MINUTE`, `MCP_HEAVY_TOOL_PER_MINUTE`, `MCP_TOOL_CONCURRENCY`, and `MCP_HEAVY_TOOL_CONCURRENCY`; defaults are `true`, `60000`, `300`, `30`, `120`, `30`, `3`, and `1`.

Self-hosted installations remain unrestricted. Do not set `TYPERELAY_HOSTED_EDITION=true` or `BILLING_ENABLED=true`; Stripe plans and hosted Cloudflare white-label provisioning are SaaS-only.


The development application serves the compiled site at `http://localhost:3040/docs/`. Build it with `docker compose run --rm docs`. For a dedicated docs host, build with `docker compose run --rm -e TYPERELAY_DOCS_BASE=/ docs` and serve the output separately. Rebuild with the default base before serving it under the application again.

The development MCP service listens on `http://localhost:3041/mcp`. The production MCP service uses port `3002`. It uses `JWT_SECRET` for private API delegation and MongoDB only for concurrency leases. `API_ALLOWED_ORIGINS` and `MCP_ALLOWED_ORIGINS` can explicitly allow additional browser origins.
