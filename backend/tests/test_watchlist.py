import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from routers import auth, watchlist
from services.auth_service import AuthService


class WatchlistTests(unittest.TestCase):
    def setUp(self):
        sqlite_only = patch.dict("os.environ", {"DATABASE_URL": ""})
        sqlite_only.start()
        self.addCleanup(sqlite_only.stop)
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        service = AuthService(Path(temporary.name) / "watchlist.sqlite3")
        service.ensure_schema()
        patched_service = patch.object(auth, "auth_service", service)
        patched_service.start()
        self.addCleanup(patched_service.stop)
        app = FastAPI()
        app.include_router(auth.router, prefix="/api")
        app.include_router(watchlist.router, prefix="/api")
        self.client = TestClient(app)
        self.addCleanup(self.client.close)

    def test_watchlist_is_persistent_and_private_to_each_account(self):
        path = "/api/watchlist/stocks"
        stock = {
            "quote_id": "1.600519", "code": "600519", "name": "贵州茅台",
            "market_name": "沪A", "pinyin": "GZMT",
        }
        self.assertEqual(self.client.get(path).status_code, 401)
        self.assertEqual(self.client.post(path, json=stock).status_code, 401)
        self.assertEqual(self.client.post("/api/auth/register", json={
            "display_name": "用户甲", "email": "first@example.com", "password": "first-password-2026",
        }).status_code, 201)
        self.assertEqual(self.client.post(path, json=stock).status_code, 201)
        self.assertEqual(self.client.post(path, json=stock).status_code, 201)
        self.assertEqual(len(self.client.get(path).json()["data"]), 1)
        self.assertEqual(self.client.post(path, json={**stock, "code": "000001"}).status_code, 422)

        self.client.post("/api/auth/logout")
        self.assertEqual(self.client.get(path).status_code, 401)
        self.assertEqual(self.client.post("/api/auth/register", json={
            "display_name": "用户乙", "email": "second@example.com", "password": "second-password-2026",
        }).status_code, 201)
        self.assertEqual(self.client.get(path).json()["data"], [])
        self.assertEqual(self.client.delete(f"{path}/1.600519").status_code, 200)
        self.client.post("/api/auth/logout")
        self.assertEqual(self.client.post("/api/auth/login", json={
            "email": "first@example.com", "password": "first-password-2026",
        }).status_code, 200)
        self.assertEqual(self.client.get(path).json()["data"][0]["name"], "贵州茅台")
        self.assertEqual(self.client.delete(f"{path}/1.600519").status_code, 200)
        self.assertEqual(self.client.get(path).json()["data"], [])


if __name__ == "__main__":
    unittest.main()
