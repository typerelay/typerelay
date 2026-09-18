import importlib.util
import pathlib
import unittest


class RepositoryPolicyTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        path = pathlib.Path(__file__).resolve().parents[1] / "check-repository.py"
        spec = importlib.util.spec_from_file_location("repository_policy", path)
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        cls.policy = module.RepositoryPolicy

    def test_credential_and_runtime_files_are_rejected_without_blocking_public_assets(self):
        for path in ["signing/cert.p12", "key.pem", "secret.key", ".env.production", "sync/credentials.json", "snippets/typerelay.sqlite", "id_rsa", "id_ed25519_work"]:
            self.assertTrue(self.policy.sensitive_path(path))
        for path in [".env.example", "public/id_ed25519.pub", "icons/icon.png", "Cargo.lock", "docs/secrets.md"]:
            self.assertFalse(self.policy.sensitive_path(path))
