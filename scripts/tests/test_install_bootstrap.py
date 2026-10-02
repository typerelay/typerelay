import pathlib
import subprocess
import unittest


class RetiredBootstrapTests(unittest.TestCase):
    def test_old_installer_url_redirects_users_without_installing(self):
        script = pathlib.Path(__file__).resolve().parents[1] / "install.sh"
        result = subprocess.run(["/bin/sh", str(script)], capture_output=True, text=True, env={"PATH": "/nonexistent"})
        self.assertEqual(result.returncode, 1)
        self.assertIn("AppImage, deb and rpm", result.stdout)
        self.assertIn("https://typerelay.com/apps/", result.stdout)
        self.assertEqual(result.stderr, "")
