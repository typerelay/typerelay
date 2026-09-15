import pathlib
import unittest


class ComposeLayoutTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root = pathlib.Path(__file__).resolve().parents[2]
        cls.development = (cls.root / "compose.yml").read_text()
        cls.production = (cls.root / "compose.prod.yml").read_text()
        cls.dbh = (cls.root / "compose.dbh.yml").read_text()

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


if __name__ == "__main__":
    unittest.main()
