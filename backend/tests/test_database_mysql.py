import unittest
from unittest.mock import patch

from database import MYSQL_SCHEMA, MysqlConnection, _mysql_options, _mysql_sql


class MysqlSqlTests(unittest.TestCase):
    def test_mysql_url_parses_encoded_credentials(self):
        with patch.dict("os.environ", {"DATABASE_URL": "mysql+pymysql://user:p%40ss@localhost:3307/capitalpulse"}):
            options = _mysql_options()
        self.assertEqual(options["password"], "p@ss")
        self.assertEqual(options["port"], 3307)
        self.assertEqual(options["charset"], "utf8mb4")

    def test_upsert_and_backfill_sql_are_translated(self):
        upsert = _mysql_sql(
            "INSERT INTO sector_flow_selection (rank, sector_code) VALUES (?, ?) "
            "ON CONFLICT (trade_date, sector_code) DO UPDATE SET rank = excluded.rank"
        )
        self.assertIn("(`rank`, sector_code) VALUES (%s, %s)", upsert)
        self.assertIn("ON DUPLICATE KEY UPDATE `rank` = VALUES(`rank`)", upsert)
        self.assertNotIn("ON CONFLICT", upsert)
        self.assertEqual(_mysql_sql("SELECT `rank` FROM sector_flow_selection"), "SELECT `rank` FROM sector_flow_selection")
        ignored = _mysql_sql("INSERT INTO stock_flow_snapshot VALUES (?) ON CONFLICT (a) DO NOTHING")
        self.assertIn("INSERT IGNORE INTO", ignored)
        self.assertNotIn("ON CONFLICT", ignored)
        self.assertIn("FLOOR(source_time / 60)", _mysql_sql("SELECT CAST(source_time / 60 AS INTEGER)"))

    def test_schema_has_all_collector_tables(self):
        schema = MYSQL_SCHEMA.read_text(encoding="utf-8")
        for table in (
            "sector_flow_selection", "sector_flow_universe", "sector_flow_snapshot",
            "sector_flow_daily", "stock_flow_snapshot",
        ):
            self.assertIn(f"CREATE TABLE IF NOT EXISTS {table}", schema)
        self.assertIn("utf8mb4", schema)


class _FakeCursor:
    description = None
    rowcount = 0

    def __init__(self, raw):
        self.raw = raw

    def __enter__(self):
        return self

    def __exit__(self, *_):
        pass

    def execute(self, sql, parameters):
        self.raw.queries.append((sql, parameters))
        self.description = (("value",),) if sql.startswith("SELECT") else None
        self.rowcount = 1

    def executemany(self, sql, rows):
        self.raw.queries.append((sql, rows))
        self.rowcount = len(rows)
        return self.rowcount

    def fetchall(self):
        return ((42,),)


class _FakeRawConnection:
    def __init__(self):
        self.queries = []
        self.commits = 0

    def cursor(self):
        return _FakeCursor(self)

    def ping(self, reconnect=True):
        pass

    def commit(self):
        self.commits += 1

    def close(self):
        pass


class MysqlConnectionTests(unittest.TestCase):
    def test_connection_keeps_collector_result_interface(self):
        raw = _FakeRawConnection()
        with patch.dict("os.environ", {"DATABASE_URL": "mysql+pymysql://user:password@localhost/capitalpulse"}), patch("database.pymysql.connect", return_value=raw):
            connection = MysqlConnection()
        self.assertEqual(connection.execute("SELECT ?", (42,)).fetchone(), (42,))
        self.assertEqual(connection.executemany("INSERT INTO x VALUES (?)", [(1,), (2,)]).rowcount, 2)
        self.assertEqual(connection.total_changes, 2)
        connection.commit()
        self.assertEqual(raw.commits, 1)
        self.assertEqual(raw.queries[0], ("SELECT %s", (42,)))


if __name__ == "__main__":
    unittest.main()
