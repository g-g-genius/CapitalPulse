import asyncio
import tempfile
import unittest
from datetime import date, datetime
from pathlib import Path
from unittest.mock import AsyncMock, patch

from services.auth_service import AuthService
from services.sector_flow_realtime import CST
from services.signal_service import SignalService


class SignalServiceTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        sqlite_only = patch.dict("os.environ", {"DATABASE_URL": ""})
        sqlite_only.start()
        self.addCleanup(sqlite_only.stop)
        temporary = tempfile.TemporaryDirectory()
        self.addCleanup(temporary.cleanup)
        self.path = Path(temporary.name) / "signals.sqlite3"
        self.auth = AuthService(self.path)
        self.auth.ensure_schema()
        self.service = SignalService(self.path)
        with patch.object(self.service, "_watchlist_loop", new_callable=AsyncMock):
            await self.service.start()
        self.addAsyncCleanup(self.service.stop)
        self.trade_date = date(2026, 9, 29)
        self.base = int(datetime(2026, 9, 29, 10, 0, tzinfo=CST).timestamp())

    async def test_sector_live_events_persist_and_replay_has_follow_through(self):
        self.service.connection.execute(
            "CREATE TABLE sector_flow_snapshot (trade_date TEXT, source_time INTEGER, "
            "sector_code TEXT, sector_name TEXT, main_net REAL, granularity TEXT)"
        )
        self.service.connection.execute(
            "CREATE TABLE stock_flow_snapshot (trade_date TEXT, source_time INTEGER, "
            "quote_id TEXT, stock_name TEXT, main_net REAL, granularity TEXT)"
        )
        values = [(0, -7_000_000), (5, -5_000_000), (10, -3_000_000),
                  (15, 1_000_000), (18, 4_000_000), (21, 7_000_000),
                  (24, 9_000_000), (75, 11_000_000), (195, 14_000_000)]
        for offset, value in values:
            stamp = self.base + offset
            flow = {"source_time": stamp, "sector_code": "BK0001",
                    "sector_name": "测试行业", "main_net": value}
            self.service.connection.execute(
                "INSERT INTO sector_flow_snapshot VALUES (?, ?, ?, ?, ?, 'realtime')",
                (self.trade_date.isoformat(), stamp, "BK0001", "测试行业", value),
            )
            self.service.ingest_sector([flow], datetime.fromtimestamp(stamp, CST))
        self.service.connection.commit()
        live = self.service.recent_events(self.trade_date, None)
        self.assertEqual({event["signal_type"] for event in live}, {"turn_positive", "surge"})
        replay = self.service.replay(self.trade_date, None)
        self.assertEqual(replay["snapshot_count"], len(values))
        self.assertEqual({event["signal_type"] for event in replay["events"]},
                         {"turn_positive", "surge"})
        self.assertTrue(any(event["after_1m"] is not None for event in replay["events"]))

    async def test_stock_events_are_visible_only_to_current_watchlist_owner(self):
        first = self.auth.create_user("first@example.com", "用户甲", "first-password-2026")
        second = self.auth.create_user("second@example.com", "用户乙", "second-password-2026")
        self.auth.add_watchlist_stock(first["id"], {
            "quote_id": "1.600519", "code": "600519", "name": "贵州茅台",
            "market_name": "沪A", "pinyin": "GZMT",
        })
        for offset, value in [(0, 100_000), (5, 200_000), (10, 400_000),
                              (15, 1_800_000), (18, 3_400_000)]:
            stamp = self.base + offset
            self.service.ingest_stock([{
                "quote_id": "1.600519", "name": "贵州茅台",
                "source_time": stamp, "main_net": value,
            }], datetime.fromtimestamp(stamp, CST))
        self.assertTrue(self.service.recent_events(self.trade_date, first["id"]))
        self.assertEqual(self.service.recent_events(self.trade_date, second["id"]), [])
        self.assertEqual(self.service.recent_events(self.trade_date, None), [])

    async def test_batch_poller_fetches_each_unique_saved_stock_once(self):
        first = self.auth.create_user("first@example.com", "用户甲", "first-password-2026")
        second = self.auth.create_user("second@example.com", "用户乙", "second-password-2026")
        stock = {"quote_id": "1.600519", "code": "600519", "name": "贵州茅台",
                 "market_name": "沪A", "pinyin": "GZMT"}
        self.auth.add_watchlist_stock(first["id"], stock)
        self.auth.add_watchlist_stock(second["id"], stock)
        fetch = AsyncMock(return_value=[{
            **stock, "source_time": self.base, "main_net": 100_000,
            "price": 101.25, "change_percent": 1.25,
            "super_large_net": 0, "large_net": 0, "mid_net": 0, "small_net": 0,
        }])
        with patch("services.signal_service.fetch_stock_flow_snapshots", fetch), patch(
            "services.stock_flow_realtime.stock_flow_service"
        ) as stock_service:
            stock_service.ready = False
            await self.service._poll_watchlist_once(datetime.fromtimestamp(self.base, CST))
        self.assertEqual(fetch.await_args.args[0], ["1.600519"])
        self.assertEqual(self.service.monitored_stocks, 1)
        quotes = self.service.watchlist_quotes(first["id"])["quotes"]
        self.assertEqual(len(quotes), 1)
        self.assertEqual(quotes[0]["price"], 101.25)
        self.assertEqual(quotes[0]["change_percent"], 1.25)
        self.assertEqual(quotes[0]["price_points"], [[self.base, 101.25]])

        # Both accounts share one upstream fetch, but quote reads stay account-scoped.
        third = self.auth.create_user("third@example.com", "用户丙", "third-password-2026")
        self.assertEqual(self.service.watchlist_quotes(third["id"])["quotes"], [])

    async def test_incremental_event_pages_do_not_skip_backlog(self):
        for index in range(6):
            self.service.connection.execute(
                "INSERT INTO signal_events (trade_date, source_time, entity_type, entity_code, entity_name, "
                "signal_type, main_net, created_at) VALUES (?, ?, 'sector', ?, '测试', 'surge', 1, ?)",
                (self.trade_date.isoformat(), self.base + index, f"BK{index:04d}", self.base),
            )
        self.service.connection.commit()
        initial = self.service.recent_events(self.trade_date, None, limit=2)
        self.assertEqual([row["id"] for row in initial], [6, 5])
        first = self.service.recent_events(self.trade_date, None, since_id=1, limit=2)
        second = self.service.recent_events(self.trade_date, None, since_id=first[-1]["id"], limit=2)
        self.assertEqual([row["id"] for row in first + second], [2, 3, 4, 5])


if __name__ == "__main__":
    unittest.main()
