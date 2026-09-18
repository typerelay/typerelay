import pathlib
import tomllib
import unittest


class ComposeLayoutTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root = pathlib.Path(__file__).resolve().parents[2]
        cls.development = (cls.root / "compose.yml").read_text()
        cls.production = (cls.root / "compose.prod.yml").read_text()
        cls.base = (cls.root / "compose.base.yml").read_text()
        cls.server_dockerfile = (cls.root / "apps" / "server" / "Dockerfile").read_text()
        cls.mcp_dockerfile = (cls.root / "apps" / "mcp" / "Dockerfile").read_text()
        cls.server_package = (cls.root / "apps" / "server" / "package.json").read_text()
        cls.mcp_package = (cls.root / "apps" / "mcp" / "package.json").read_text()
        cls.dbh = (cls.root / "compose.dbh.yml").read_text()
        cls.dbh_run = (cls.root / ".codex" / "dbh-run.toml").read_text()
        cls.dbh_run_config = tomllib.loads(cls.dbh_run)

    def test_development_uses_dbh_services_and_source_mounts(self):
        self.assertIn("DEV_TYPERELAY_MONGODB_URI", self.development)
        self.assertIn("MEMCACHED_SERVERS: ${MEMCACHED_SERVERS}", self.development)
        self.assertIn("file: ./compose.base.yml", self.development)
        self.assertNotIn("\n  mongo:\n", self.development)
        self.assertNotIn("\n  memcached:\n", self.development)
        self.assertNotIn("\n  mail:\n", self.development)
        for service in ["init", "app", "scheduler", "mcp"]:
            self.assertIn(f"\n  {service}:\n", self.development)

    def test_production_provisions_only_required_default_services(self):
        self.assertIn("ghcr.io/typerelay/typerelay:latest", self.production)
        for service in ["app", "scheduler", "mcp", "mongo", "memcached"]:
            self.assertIn(f"\n  {service}:\n", self.production)
        self.assertNotIn("\n  mail:\n", self.production)

    def test_rate_limit_defaults_cover_only_typerelay_surfaces(self):
        for source in [self.development, self.production]:
            for value in [
                'API_RATE_LIMIT_GENERAL_PER_MINUTE: "${API_RATE_LIMIT_GENERAL_PER_MINUTE:-120}"',
                'API_RATE_LIMIT_EXPENSIVE_PER_MINUTE: "${API_RATE_LIMIT_EXPENSIVE_PER_MINUTE:-60}"',
                'API_RATE_LIMIT_UPLOAD_PER_MINUTE: "${API_RATE_LIMIT_UPLOAD_PER_MINUTE:-20}"',
                'MCP_IP_FLOOD_PER_MINUTE: "${MCP_IP_FLOOD_PER_MINUTE:-300}"',
                'MCP_UNAUTH_PER_MINUTE: "${MCP_UNAUTH_PER_MINUTE:-30}"',
                'MCP_AUTH_PER_MINUTE: "${MCP_AUTH_PER_MINUTE:-120}"',
                'MCP_HEAVY_TOOL_PER_MINUTE: "${MCP_HEAVY_TOOL_PER_MINUTE:-30}"',
                'MCP_TOOL_CONCURRENCY: "${MCP_TOOL_CONCURRENCY:-3}"',
                'MCP_HEAVY_TOOL_CONCURRENCY: "${MCP_HEAVY_TOOL_CONCURRENCY:-1}"',
            ]:
                self.assertIn(value, source)
            for unused in ["API_RATE_LIMIT_OBSIDIAN_PER_MINUTE", "API_RATE_LIMIT_RAZUNA_FILES_PER_MINUTE", "MCP_SSE_OPEN_PER_MINUTE"]:
                self.assertNotIn(unused, source)

    def test_dbh_overrides_development_app_and_mcp_only(self):
        self.assertIn("-typerelay-app", self.dbh)
        self.assertIn("-typerelay-mcp", self.dbh)
        self.assertNotIn("typerelay-mail", self.dbh)

    def test_dbh_defines_required_development_environment(self):
        for name in ["DEV_TYPERELAY_MONGODB_URI", "MEMCACHED_SERVERS", "SMTP_SERVERS", "SMTP_FROM", "SESSION_SECRET", "JWT_SECRET"]:
            self.assertIn(f"{name} =", self.dbh_run)
        for value in self.dbh_run_config["environment"].values():
            value.format(profile="n", repo="typerelay")

    def test_node_dependencies_use_the_root_workspace(self):
        self.assertIn("typerelay-root-node-modules:/opt/typerelay/node_modules", self.base)
        self.assertIn("--dir, /opt/typerelay, --filter", self.development)
        for source in [self.server_dockerfile, self.mcp_dockerfile]:
            self.assertIn("COPY package.json pnpm-lock.yaml pnpm-workspace.yaml", source)
            self.assertIn("pnpm --filter", source)
            self.assertIn(" deploy --prod ", source)
            self.assertNotIn("apps/server/pnpm-lock.yaml", source)
            self.assertNotIn("apps/mcp/pnpm-lock.yaml", source)

    def test_every_backend_preloads_shared_observability(self):
        preload = "node --disable-warning=ExperimentalWarning --import @typerelay/observability/register"
        self.assertIn(preload, self.server_package)
        self.assertIn(preload, self.mcp_package)
        self.assertIn("command: [npm, run, start]", self.development)
        for source in [self.server_dockerfile, self.mcp_dockerfile]:
            self.assertIn("COPY apps/server/observability/package.json", source)
        self.assertIn("COPY apps/server/observability ./apps/server/observability", self.mcp_dockerfile)


if __name__ == "__main__":
    unittest.main()
