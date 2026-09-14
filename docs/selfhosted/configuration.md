# Configuration

Configure `APP_URL`, `MCP_BASE_URL`, `API_BASE_URL`, `MONGO_URI`, `SESSION_SECRET`, `JWT_SECRET`, `SMTP_FROM`, and `SMTP_SERVERS` through your terminal environment. `MCP_BASE_URL` is the public MCP host without `/mcp`; TypeRelay appends the resource path. `SMTP_SERVERS` uses the shared JSON array format with `name`, `host`, `port`, `secure`, `user`, `pass`, and `from`. Keep credentials outside Git. Documentation supports `TYPERELAY_DOCS_BASE=/docs/` or `/` at build time.


The development application serves the compiled site at `http://localhost:3040/docs/`. Build it with `docker compose run --rm docs`. For a dedicated docs host, build with `docker compose run --rm -e TYPERELAY_DOCS_BASE=/ docs` and serve the output separately. Rebuild with the default base before serving it under the application again.

Start the optional MCP service with `docker compose --profile integrations up -d --build mcp`. It listens on `http://localhost:3041/mcp` locally. The MCP service uses `JWT_SECRET` for private API delegation and has no session-secret or database configuration. `API_ALLOWED_ORIGINS` and `MCP_ALLOWED_ORIGINS` can explicitly allow additional browser origins.
