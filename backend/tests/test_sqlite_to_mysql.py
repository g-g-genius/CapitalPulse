import sqlite3
import tempfile
import unittest
from contextlib import closing
from pathlib import Path

from scripts.migrate_sqlite_to_mysql import migrate_table, sqlite_backup


class _FakeTarget:
    def __init__(self):
        self.rows = []
        self.insert_sql = ""

    def executemany(self, sql, rows):
        self.insert_sql = sql
        self.rows.extend(rows)
        return type("Result", (), {"rowcount": len(rows)})()

    def execute(self, sql):
        return type("Result", (), {"fetchone": lambda _: (len(self.rows),)})()

    def commit(self):
        pass


class MigrationTests(unittest.TestCase):
    def test_backup_and_legacy_stock_rows_receive_granularity_default(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "flow.sqlite3"
            with closing(sqlite3.connect(path)) as source:
                source.execute(
                    "CREATE TABLE stock_flow_snapshot ("
                    "trade_date TEXT, source_time INTEGER, quote_id TEXT, "
                    "stock_code TEXT, stock_name TEXT, main_net REAL, small_net REAL, "
                    "mid_net REAL, large_net REAL, super_large_net REAL, received_at TEXT)"
                )
                source.execute(
                    "INSERT INTO stock_flow_snapshot VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                    ("2026-09-29", 123, "1.600519", "600519", "贵州茅台", 1.0,
                     2.0, 3.0, 4.0, 5.0, "2026-09-29T10:00:00+08:00"),
                )
                source.commit()
            backup = sqlite_backup(path)
            self.assertTrue(backup.is_file())
            target = _FakeTarget()
            with closing(sqlite3.connect(backup)) as source:
                self.assertEqual(migrate_table(source, target, "stock_flow_snapshot"), (1, 1))
            self.assertEqual(target.rows[0][-1], "realtime")

    def test_legacy_user_migration_defaults_to_member_role(self):
        with tempfile.TemporaryDirectory() as temporary:
            path = Path(temporary) / "users.sqlite3"
            with closing(sqlite3.connect(path)) as source:
                source.execute(
                    "CREATE TABLE users (id INTEGER PRIMARY KEY, email TEXT, display_name TEXT, "
                    "password_hash TEXT, created_at INTEGER, updated_at INTEGER)"
                )
                source.execute(
                    "INSERT INTO users VALUES (1, 'member@example.com', '会员', 'hash', 1, 1)"
                )
                source.commit()
                target = _FakeTarget()
                self.assertEqual(migrate_table(source, target, "users"), (1, 1))
            self.assertEqual(target.rows[0][3], "member")
            self.assertIn("UPDATE `id` = `id`", target.insert_sql)


if __name__ == "__main__":
    unittest.main()
