"""Copy the existing collector history to a configured MySQL database.

Stop the backend before running this command so the SQLite backup and MySQL
copy represent one stable point in time. The source file is never modified.
"""

from __future__ import annotations

import argparse
import sqlite3
import sys
from contextlib import closing
from datetime import datetime
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND_DIR))

from config import env_path  # noqa: E402
from database import MysqlConnection, open_database, using_mysql  # noqa: E402
from services.sector_flow_realtime import DEFAULT_DB_PATH  # noqa: E402


TABLE_COLUMNS: dict[str, tuple[str, ...]] = {
    "sector_flow_selection": (
        "trade_date", "rank", "sector_code", "sector_name", "market_cap", "selected_at",
    ),
    "sector_flow_universe": (
        "trade_date", "sector_code", "sector_name", "market_cap",
    ),
    "sector_flow_snapshot": (
        "trade_date", "source_time", "sector_code", "sector_name", "main_net",
        "small_net", "mid_net", "large_net", "super_large_net", "received_at",
        "granularity",
    ),
    "sector_flow_daily": (
        "trade_date", "sector_code", "sector_name", "main_net", "super_large_net",
        "large_net", "mid_net", "small_net", "updated_at",
    ),
    "stock_flow_snapshot": (
        "trade_date", "source_time", "quote_id", "stock_code", "stock_name",
        "main_net", "small_net", "mid_net", "large_net", "super_large_net",
        "received_at", "granularity",
    ),
    "users": (
        "id", "email", "display_name", "account_role", "password_hash", "created_at", "updated_at",
    ),
    "auth_sessions": (
        "token_hash", "user_id", "created_at", "expires_at",
    ),
    "watchlist_stocks": (
        "user_id", "quote_id", "code", "name", "market_name", "pinyin", "created_at",
    ),
    "signal_events": (
        "id", "trade_date", "source_time", "entity_type", "entity_code", "entity_name",
        "signal_type", "main_net", "change_15s", "change_1m", "change_3m", "created_at",
    ),
    "watchlist_quote_snapshot": (
        "trade_date", "quote_id", "minute_time", "source_time", "price",
        "change_percent", "main_net",
    ),
}

DEFAULTS = {
    "account_role": "member",
    "granularity": "realtime",
    "super_large_net": 0.0,
    "large_net": 0.0,
    "mid_net": 0.0,
    "small_net": 0.0,
}


def sqlite_backup(source_path: Path) -> Path:
    backup_path = source_path.with_name(
        f"{source_path.name}.{datetime.now().strftime('%Y%m%d-%H%M%S-%f')}.backup"
    )
    with closing(sqlite3.connect(f"file:{source_path.as_posix()}?mode=ro", uri=True)) as source:
        with closing(sqlite3.connect(backup_path)) as backup:
            source.backup(backup)
    return backup_path


def migrate_table(source: sqlite3.Connection, target: MysqlConnection, table: str) -> tuple[int, int]:
    present = {
        str(row[1]) for row in source.execute(f"PRAGMA table_info({table})")
    }
    if not present:
        return 0, 0
    columns = TABLE_COLUMNS[table]
    missing = [column for column in columns if column not in present and column not in DEFAULTS]
    if missing:
        raise ValueError(f"{table}: missing required SQLite columns: {', '.join(missing)}")
    source_columns = tuple(column for column in columns if column in present)
    select = f"SELECT {', '.join(source_columns)} FROM {table}"
    quoted_columns = ", ".join(f"`{column}`" for column in columns)
    placeholders = ", ".join("?" for _ in columns)
    no_op_column = {
        "users": "id",
        "auth_sessions": "token_hash",
        "watchlist_stocks": "quote_id",
        "signal_events": "id",
    }.get(table, "trade_date")
    insert = (
        f"INSERT INTO {table} ({quoted_columns}) VALUES ({placeholders}) "
        f"ON DUPLICATE KEY UPDATE `{no_op_column}` = `{no_op_column}`"
    )
    count = 0
    inserted = 0
    cursor = source.execute(select)
    while batch := cursor.fetchmany(500):
        rows = []
        for item in batch:
            values = dict(zip(source_columns, item))
            rows.append(tuple(values.get(column, DEFAULTS.get(column)) for column in columns))
        inserted += target.executemany(insert, rows).rowcount
        target.commit()
        count += len(rows)
    target_count = target.execute(f"SELECT COUNT(*) FROM {table}").fetchone()
    if not target_count or int(target_count[0]) < count:
        raise RuntimeError(f"{table}: MySQL row count is below SQLite row count")
    return count, inserted


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--sqlite", type=Path, default=env_path("SECTOR_FLOW_DB_PATH", DEFAULT_DB_PATH))
    args = parser.parse_args()
    if not using_mysql():
        parser.error("set DATABASE_URL in backend/.env before migrating")
    source_path = args.sqlite.resolve()
    if not source_path.is_file():
        parser.error(f"SQLite file not found: {source_path}")

    backup_path = sqlite_backup(source_path)
    print(f"SQLite backup: {backup_path}")
    target = open_database(source_path)
    if not isinstance(target, MysqlConnection):
        raise RuntimeError("DATABASE_URL did not select MySQL")
    try:
        with closing(sqlite3.connect(backup_path)) as source:
            for table in TABLE_COLUMNS:
                source_count, inserted = migrate_table(source, target, table)
                print(f"{table}: SQLite {source_count}, inserted {inserted}")
    finally:
        target.close()
    print("Migration complete. Keep the SQLite backup until MySQL data is verified in the app.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
