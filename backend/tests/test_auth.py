import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path
from unittest.mock import patch

from fastapi import FastAPI
from fastapi.testclient import TestClient

from routers import auth as auth_router
from services.auth_service import AuthService


class AuthFlowTests(unittest.TestCase):
    def setUp(self):
        sqlite_only = patch.dict("os.environ", {"DATABASE_URL": ""})
        sqlite_only.start()
        self.addCleanup(sqlite_only.stop)
        self.temporary = tempfile.TemporaryDirectory()
        self.addCleanup(self.temporary.cleanup)
        self.path = Path(self.temporary.name) / "accounts.sqlite3"
        service = AuthService(self.path)
        service.ensure_schema()
        self.service = service
        patched_service = patch.object(auth_router, "auth_service", service)
        patched_service.start()
        self.addCleanup(patched_service.stop)
        app = FastAPI()
        app.include_router(auth_router.router, prefix="/api")
        self.client = TestClient(app)
        self.addCleanup(self.client.close)

    def test_register_login_me_logout_and_hashed_session(self):
        registration = self.client.post("/api/auth/register", json={
            "display_name": "研究员", "email": " Trader@Example.com ",
            "password": "correct-horse-2026",
        })
        self.assertEqual(registration.status_code, 201)
        self.assertEqual(registration.json()["data"]["email"], "trader@example.com")
        self.assertEqual(registration.json()["data"]["role"], "member")
        self.assertIn("httponly", registration.headers["set-cookie"].lower())
        self.assertIn("samesite=lax", registration.headers["set-cookie"].lower())
        self.assertEqual(self.client.get("/api/auth/me").json()["data"]["display_name"], "研究员")

        with closing(sqlite3.connect(self.path)) as connection:
            password_hash = connection.execute("SELECT password_hash FROM users").fetchone()[0]
            token_hash = connection.execute("SELECT token_hash FROM auth_sessions").fetchone()[0]
        self.assertNotIn("correct-horse-2026", password_hash)
        self.assertEqual(len(token_hash), 64)
        self.assertNotEqual(token_hash, self.client.cookies[auth_router.COOKIE_NAME])

        self.assertEqual(self.client.post("/api/auth/logout").status_code, 200)
        self.assertEqual(self.client.get("/api/auth/me").status_code, 401)
        self.assertEqual(self.client.post("/api/auth/login", json={
            "email": "trader@example.com", "password": "wrong-password",
        }).status_code, 401)
        self.assertEqual(self.client.post("/api/auth/login", json={
            "email": "trader@example.com", "password": "correct-horse-2026",
        }).status_code, 200)
        self.assertEqual(self.client.get("/api/auth/me").status_code, 200)

    def test_duplicate_email_and_short_password_are_rejected(self):
        payload = {
            "display_name": "研究员", "email": "trader@example.com",
            "password": "correct-horse-2026",
        }
        self.assertEqual(self.client.post("/api/auth/register", json=payload).status_code, 201)
        self.assertEqual(self.client.post("/api/auth/register", json=payload).status_code, 409)
        self.assertEqual(self.client.post("/api/auth/register", json={
            **payload, "email": "other@example.com", "password": "short",
        }).status_code, 422)

    def test_admin_is_provisioned_locally_and_checked_by_server(self):
        self.assertEqual(self.client.get("/api/auth/admin-check").status_code, 401)
        registered = self.client.post("/api/auth/register", json={
            "display_name": "普通用户", "email": "member@example.com",
            "password": "member-password-2026", "role": "admin",
        })
        self.assertEqual(registered.json()["data"]["role"], "member")
        self.assertEqual(self.client.get("/api/auth/admin-check").status_code, 403)

        admin = self.service.create_admin("admin@example.com", "管理员", "admin-password-2026")
        self.assertEqual(admin["role"], "admin")
        self.assertEqual(self.client.post("/api/auth/login", json={
            "email": "admin@example.com", "password": "admin-password-2026",
        }).json()["data"]["role"], "admin")
        self.assertEqual(self.client.get("/api/auth/admin-check").status_code, 200)

    def test_existing_user_table_gets_member_role(self):
        legacy_path = Path(self.temporary.name) / "legacy.sqlite3"
        with closing(sqlite3.connect(legacy_path)) as connection:
            connection.execute(
                "CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, "
                "display_name TEXT NOT NULL, password_hash TEXT NOT NULL, "
                "created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)"
            )
            connection.execute(
                "INSERT INTO users VALUES (1, 'old@example.com', '旧账号', 'hash', 1, 1)"
            )
            connection.commit()
        AuthService(legacy_path).ensure_schema()
        with closing(sqlite3.connect(legacy_path)) as connection:
            role = connection.execute(
                "SELECT account_role FROM users WHERE email = 'old@example.com'"
            ).fetchone()[0]
        self.assertEqual(role, "member")


if __name__ == "__main__":
    unittest.main()
