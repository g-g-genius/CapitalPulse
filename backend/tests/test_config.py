import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from config import BACKEND_DIR, env_path, load_environment


class EnvironmentConfigTests(unittest.TestCase):
    def test_loads_dotenv_without_overriding_process_environment(self):
        with tempfile.TemporaryDirectory() as temp_dir:
            env_file = Path(temp_dir) / ".env"
            env_file.write_text(
                "SECTOR_FLOW_POLL_SECONDS=7\nSTOCK_FLOW_POLL_SECONDS=9\n",
                encoding="utf-8",
            )

            with patch.dict(
                os.environ,
                {"SECTOR_FLOW_POLL_SECONDS": "5"},
                clear=True,
            ):
                self.assertTrue(load_environment(env_file))
                self.assertEqual(os.environ["SECTOR_FLOW_POLL_SECONDS"], "5")
                self.assertEqual(os.environ["STOCK_FLOW_POLL_SECONDS"], "9")

    def test_resolves_relative_environment_paths_from_backend(self):
        with patch.dict(
            os.environ,
            {"SECTOR_FLOW_DB_PATH": "data/custom.sqlite3"},
        ):
            self.assertEqual(
                env_path("SECTOR_FLOW_DB_PATH", Path("unused")),
                BACKEND_DIR / "data" / "custom.sqlite3",
            )


if __name__ == "__main__":
    unittest.main()
