import pathlib
import subprocess
import unittest


class ReleaseScriptTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root = pathlib.Path(__file__).resolve().parents[2]
        cls.source = (cls.root / "release.sh").read_text()

    def test_release_uses_date_tags_and_local_ghcr_by_default(self):
        self.assertIn('image_build="local"', self.source)
        self.assertIn('ghcr.io/typerelay/typerelay', self.source)
        self.assertIn("date '+%Y%m%d'", self.source)
        self.assertIn('--platform linux/amd64', self.source)
        self.assertIn('--target production', self.source)
        self.assertIn('--push', self.source)

    def test_release_help_and_syntax(self):
        subprocess.run(["bash", "-n", self.root / "release.sh"], check=True)
        help_text = subprocess.run([self.root / "release.sh", "--help"], check=True, capture_output=True, text=True).stdout
        self.assertIn("--build <local|dbh>", help_text)
        self.assertIn("RELEASE_DATE=YYYYMMDD", help_text)

    def test_github_workflows_are_removed(self):
        workflows = self.root / ".github/workflows"
        self.assertFalse(workflows.exists() and any(workflows.iterdir()))


if __name__ == "__main__":
    unittest.main()
