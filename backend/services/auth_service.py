"""Account and server-side session persistence for the web login flow."""

from __future__ import annotations

import hashlib
import secrets
import sqlite3
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any, Iterator

import pymysql
from argon2 import PasswordHasher, Type
from argon2.exceptions import InvalidHashError, VerificationError, VerifyMismatchError

from config import env_path
from database import MysqlConnection, open_database, using_mysql
from services.sector_flow_realtime import DEFAULT_DB_PATH


SESSION_SECONDS = 7 * 24 * 60 * 60
SQLITE_AUTH_SCHEMA = Path(__file__).resolve().parents[1] / "sql" / "sqlite_auth_schema.sql"
PASSWORD_HASHER = PasswordHasher(
    time_cost=2,
    memory_cost=19456,
    parallelism=1,
    hash_len=32,
    salt_len=16,
    type=Type.ID,
)
DUMMY_HASH = PASSWORD_HASHER.hash("no-account-has-this-password")


class EmailAlreadyExists(Exception):
    pass


class WatchlistFull(Exception):
    pass


MAX_WATCHLIST_STOCKS = 100


class AuthService:
    def __init__(self, db_path: Path | None = None) -> None:
        self.db_path = db_path or env_path("SECTOR_FLOW_DB_PATH", DEFAULT_DB_PATH)

    def ensure_schema(self) -> None:
        connection = open_database(self.db_path)
        try:
            if isinstance(connection, sqlite3.Connection):
                connection.executescript(SQLITE_AUTH_SCHEMA.read_text(encoding="utf-8"))
                columns = {str(row[1]) for row in connection.execute("PRAGMA table_info(users)")}
                if "account_role" not in columns:
                    connection.execute(
                        "ALTER TABLE users ADD COLUMN account_role TEXT NOT NULL DEFAULT 'member'"
                    )
            else:
                columns = {str(row[0]) for row in connection.execute("SHOW COLUMNS FROM users")}
                if "account_role" not in columns:
                    connection.execute(
                        "ALTER TABLE users ADD COLUMN account_role VARCHAR(16) "
                        "NOT NULL DEFAULT 'member'"
                    )
            connection.commit()
        finally:
            connection.close()

    @contextmanager
    def _connection(self) -> Iterator[sqlite3.Connection | MysqlConnection]:
        connection = MysqlConnection() if using_mysql() else open_database(self.db_path)
        try:
            if isinstance(connection, sqlite3.Connection):
                connection.execute("PRAGMA foreign_keys = ON")
            yield connection
            connection.commit()
        except Exception:
            connection.rollback()
            raise
        finally:
            connection.close()

    @staticmethod
    def _user(row: tuple[Any, ...]) -> dict[str, Any]:
        return {
            "id": int(row[0]),
            "email": str(row[1]),
            "display_name": str(row[2]),
            "role": str(row[3]),
        }

    def create_user(self, email: str, display_name: str, password: str) -> dict[str, Any]:
        password_hash = PASSWORD_HASHER.hash(password)
        now = int(time.time())
        try:
            with self._connection() as connection:
                connection.execute(
                    "INSERT INTO users (email, display_name, password_hash, created_at, updated_at) "
                    "VALUES (?, ?, ?, ?, ?)",
                    (email, display_name, password_hash, now, now),
                )
                row = connection.execute(
                    "SELECT id, email, display_name, account_role FROM users WHERE email = ?",
                    (email,),
                ).fetchone()
                if row is None:
                    raise RuntimeError("new account could not be loaded")
                return self._user(row)
        except (sqlite3.IntegrityError, pymysql.err.IntegrityError) as exc:
            raise EmailAlreadyExists from exc

    def create_admin(self, email: str, display_name: str, password: str) -> dict[str, Any]:
        """Create an administrator through local provisioning, never public registration."""
        password_hash = PASSWORD_HASHER.hash(password)
        now = int(time.time())
        try:
            with self._connection() as connection:
                connection.execute(
                    "INSERT INTO users (email, display_name, account_role, password_hash, "
                    "created_at, updated_at) VALUES (?, ?, 'admin', ?, ?, ?)",
                    (email, display_name, password_hash, now, now),
                )
                row = connection.execute(
                    "SELECT id, email, display_name, account_role FROM users WHERE email = ?",
                    (email,),
                ).fetchone()
                if row is None:
                    raise RuntimeError("new administrator could not be loaded")
                return self._user(row)
        except (sqlite3.IntegrityError, pymysql.err.IntegrityError) as exc:
            raise EmailAlreadyExists from exc

    def authenticate(self, email: str, password: str) -> dict[str, Any] | None:
        with self._connection() as connection:
            row = connection.execute(
                "SELECT id, email, display_name, account_role, password_hash "
                "FROM users WHERE email = ?",
                (email,),
            ).fetchone()
        stored_hash = str(row[4]) if row else DUMMY_HASH
        try:
            valid = PASSWORD_HASHER.verify(stored_hash, password)
        except (InvalidHashError, VerificationError, VerifyMismatchError):
            valid = False
        return self._user(row) if row and valid else None

    def create_session(self, user_id: int) -> str:
        token = secrets.token_urlsafe(32)
        now = int(time.time())
        with self._connection() as connection:
            connection.execute("DELETE FROM auth_sessions WHERE expires_at <= ?", (now,))
            connection.execute(
                "INSERT INTO auth_sessions (token_hash, user_id, created_at, expires_at) "
                "VALUES (?, ?, ?, ?)",
                (self._token_hash(token), user_id, now, now + SESSION_SECONDS),
            )
        return token

    def get_user_for_session(self, token: str | None) -> dict[str, Any] | None:
        if not token:
            return None
        with self._connection() as connection:
            row = connection.execute(
                "SELECT u.id, u.email, u.display_name, u.account_role "
                "FROM auth_sessions AS s JOIN users AS u ON u.id = s.user_id "
                "WHERE s.token_hash = ? AND s.expires_at > ?",
                (self._token_hash(token), int(time.time())),
            ).fetchone()
        return self._user(row) if row else None

    def revoke_session(self, token: str | None) -> None:
        if not token:
            return
        with self._connection() as connection:
            connection.execute(
                "DELETE FROM auth_sessions WHERE token_hash = ?",
                (self._token_hash(token),),
            )

    @staticmethod
    def _watchlist_stock(row: tuple[Any, ...]) -> dict[str, Any]:
        return {
            "quote_id": str(row[0]),
            "code": str(row[1]),
            "name": str(row[2]),
            "market_name": str(row[3]),
            "pinyin": str(row[4]),
            "created_at": int(row[5]),
        }

    def list_watchlist(self, user_id: int) -> list[dict[str, Any]]:
        with self._connection() as connection:
            rows = connection.execute(
                "SELECT quote_id, code, name, market_name, pinyin, created_at "
                "FROM watchlist_stocks WHERE user_id = ? "
                "ORDER BY created_at DESC, quote_id DESC",
                (user_id,),
            ).fetchall()
        return [self._watchlist_stock(row) for row in rows]

    def add_watchlist_stock(self, user_id: int, stock: dict[str, str]) -> dict[str, Any]:
        with self._connection() as connection:
            existing = connection.execute(
                "SELECT quote_id, code, name, market_name, pinyin, created_at "
                "FROM watchlist_stocks WHERE user_id = ? AND quote_id = ?",
                (user_id, stock["quote_id"]),
            ).fetchone()
            if existing:
                return self._watchlist_stock(existing)
            count = connection.execute(
                "SELECT COUNT(*) FROM watchlist_stocks WHERE user_id = ?", (user_id,)
            ).fetchone()
            if count and int(count[0]) >= MAX_WATCHLIST_STOCKS:
                raise WatchlistFull
            created_at = int(time.time() * 1000)
            connection.execute(
                "INSERT INTO watchlist_stocks "
                "(user_id, quote_id, code, name, market_name, pinyin, created_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?) "
                "ON CONFLICT(user_id, quote_id) DO NOTHING",
                (
                    user_id, stock["quote_id"], stock["code"], stock["name"],
                    stock["market_name"], stock["pinyin"], created_at,
                ),
            )
            row = connection.execute(
                "SELECT quote_id, code, name, market_name, pinyin, created_at "
                "FROM watchlist_stocks WHERE user_id = ? AND quote_id = ?",
                (user_id, stock["quote_id"]),
            ).fetchone()
            if row is None:
                raise RuntimeError("watchlist stock could not be loaded")
            return self._watchlist_stock(row)

    def remove_watchlist_stock(self, user_id: int, quote_id: str) -> None:
        with self._connection() as connection:
            connection.execute(
                "DELETE FROM watchlist_stocks WHERE user_id = ? AND quote_id = ?",
                (user_id, quote_id),
            )

    @staticmethod
    def _token_hash(token: str) -> str:
        return hashlib.sha256(token.encode("utf-8")).hexdigest()


auth_service = AuthService()
