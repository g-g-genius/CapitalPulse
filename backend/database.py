"""Database connection helpers for the existing SQLite and MySQL stores."""

from __future__ import annotations

import os
import re
import sqlite3
from pathlib import Path
from typing import Any, Iterable

import pymysql
from sqlalchemy.engine import make_url


MYSQL_SCHEMA = Path(__file__).resolve().parent / "sql" / "mysql_schema.sql"


def using_mysql() -> bool:
    """Select MySQL only when an explicit connection URL is configured."""
    return bool(os.getenv("DATABASE_URL", "").strip())


def _mysql_options() -> dict[str, Any]:
    raw_url = os.getenv("DATABASE_URL", "").strip()
    url = make_url(raw_url)
    if url.drivername not in {"mysql", "mysql+pymysql"}:
        raise ValueError("DATABASE_URL must use mysql+pymysql://")
    if not url.database:
        raise ValueError("DATABASE_URL must include a database name")
    return {
        "host": url.host or "localhost",
        "port": url.port or 3306,
        "user": url.username or "",
        "password": url.password or "",
        "database": url.database,
        "charset": "utf8mb4",
        "autocommit": False,
        "connect_timeout": 5,
        "read_timeout": 15,
        "write_timeout": 15,
    }


def _mysql_sql(sql: str) -> str:
    """Translate the small set of SQLite statements used by the collectors."""
    sql = sql.replace("?", "%s")
    sql = sql.replace("CAST(source_time / 60 AS INTEGER)", "FLOOR(source_time / 60)")
    sql = re.sub(r"(?<!`)\brank\b(?!`)", "`rank`", sql)
    if re.search(r"\bON CONFLICT\s*\([^)]*\)\s*DO NOTHING\b", sql, re.I):
        sql = re.sub(r"\bINSERT\s+INTO\b", "INSERT IGNORE INTO", sql, count=1, flags=re.I)
        return re.sub(r"\bON CONFLICT\s*\([^)]*\)\s*DO NOTHING\b", "", sql, flags=re.I)
    sql = re.sub(
        r"\bON CONFLICT\s*\([^)]*\)\s*DO UPDATE SET\b",
        "ON DUPLICATE KEY UPDATE",
        sql,
        flags=re.I,
    )
    return re.sub(r"\bexcluded\.(`?[A-Za-z_][A-Za-z_0-9]*`?)", r"VALUES(\1)", sql, flags=re.I)


class MysqlResult:
    def __init__(self, rows: tuple[tuple[Any, ...], ...], rowcount: int):
        self._rows = rows
        self.rowcount = rowcount

    def fetchall(self) -> list[tuple[Any, ...]]:
        return list(self._rows)

    def fetchone(self) -> tuple[Any, ...] | None:
        return self._rows[0] if self._rows else None

    def __iter__(self):
        return iter(self._rows)


class MysqlConnection:
    """Provide the narrow connection interface used by the two collectors."""

    def __init__(self) -> None:
        self._connection = pymysql.connect(**_mysql_options())
        self.total_changes = 0
        self._dirty = False

    def _ping(self) -> None:
        try:
            self._connection.ping(reconnect=False)
        except Exception:
            if self._dirty:
                raise RuntimeError("MySQL connection dropped before the transaction was committed")
            self._connection.ping(reconnect=True)

    def execute(self, sql: str, parameters: tuple[Any, ...] = ()) -> MysqlResult:
        self._ping()
        with self._connection.cursor() as cursor:
            cursor.execute(_mysql_sql(sql), parameters)
            has_result = cursor.description is not None
            rows = tuple(cursor.fetchall()) if has_result else ()
            changed = max(0, cursor.rowcount)
        if not has_result:
            self._dirty = True
            self.total_changes += changed
        return MysqlResult(rows, changed)

    def executemany(self, sql: str, rows: Iterable[tuple[Any, ...]]) -> MysqlResult:
        self._ping()
        with self._connection.cursor() as cursor:
            changed = max(0, cursor.executemany(_mysql_sql(sql), list(rows)))
        self._dirty = True
        self.total_changes += changed
        return MysqlResult((), changed)

    def commit(self) -> None:
        self._connection.commit()
        self._dirty = False

    def rollback(self) -> None:
        self._connection.rollback()
        self._dirty = False

    def close(self) -> None:
        self._connection.close()


def open_database(sqlite_path: Path) -> sqlite3.Connection | MysqlConnection:
    if using_mysql():
        connection = MysqlConnection()
        try:
            for statement in MYSQL_SCHEMA.read_text(encoding="utf-8").split(";"):
                if statement.strip():
                    connection.execute(statement)
            connection.commit()
        except Exception:
            connection.close()
            raise
        return connection
    sqlite_path.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(sqlite_path, check_same_thread=False)
    connection.execute("PRAGMA journal_mode=WAL")
    connection.execute("PRAGMA busy_timeout=5000")
    return connection
