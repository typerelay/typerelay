# Configuration

Configure ORIGIN for the application and MCP_ORIGIN as the exact public MCP resource URL, including `/mcp`. Configure MONGODB_URI and private SESSION_SECRET_FILE/MCP_SECRET_FILE paths. Keep credentials outside Git. MCP uses the application HTTP API and shares only its private delegation secret, never MongoDB access. Documentation supports TYPERELAY_DOCS_BASE=/docs/ or `/` at build time.


The development application serves the compiled site at `http://localhost:3040/docs/`. Build it with `docker compose run --rm docs`. For a dedicated docs host, build with `docker compose run --rm -e TYPERELAY_DOCS_BASE=/ docs` and serve the output separately. Rebuild with the default base before serving it under the application again.

Start the optional MCP service with `docker compose --profile integrations up -d --build mcp`. It listens on `http://localhost:3041/mcp` locally. Its private delegation secret lives in a dedicated volume; MCP has no session-secret or database mount. API_ALLOWED_ORIGINS and MCP_ALLOWED_ORIGINS can explicitly allow additional browser origins.
