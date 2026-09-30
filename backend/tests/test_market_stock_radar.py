import unittest
from datetime import datetime, timedelta
from unittest.mock import AsyncMock, patch

from services.market_stock_radar import MarketStockRadar, fetch_market_stocks, parse_stock_rows
from services.sector_flow_realtime import CST


def raw(code: str, market: int, stamp: int, value: float) -> dict:
    return {"f12": code, "f13": market, "f14": code, "f124": stamp,
            "f62": value, "f2": 10.0, "f3": 1.0, "f6": 100_000_000}


class MarketStockRadarTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.base = datetime(2026, 9, 30, 10, 0, tzinfo=CST)
        self.stamp = int(self.base.timestamp())

    def test_parser_keeps_beijing_stocks_and_rejects_missing_flow(self):
        rows = parse_stock_rows([
            raw("920001", 0, self.stamp, 500),
            raw("600001", 1, self.stamp, 100),
            raw("920001", 0, self.stamp, 500),
            {**raw("000001", 0, self.stamp, 0), "f62": "-"},
        ])
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0]["market_name"], "北交所")

    async def test_market_fetch_rejects_missing_page(self):
        pages = {
            1: (5, [raw("000001", 0, self.stamp, 1), raw("000002", 0, self.stamp, 2)]),
            2: (5, [raw("000003", 0, self.stamp, 3), raw("000004", 0, self.stamp, 4)]),
            3: (5, [raw("000005", 0, self.stamp, 5)]),
        }
        with patch("services.market_stock_radar.PAGE_SIZE", 2), patch(
            "services.market_stock_radar.fetch_stock_page", new=AsyncMock(side_effect=pages.get)
        ):
            total, stocks = await fetch_market_stocks()  # type: ignore[misc]
            self.assertEqual((total, len(stocks)), (5, 5))
            pages[3] = None
            self.assertIsNone(await fetch_market_stocks())

    def test_radar_uses_fresh_monotonic_samples_and_expires_them(self):
        radar = MarketStockRadar()
        for offset, first, second in [(0, -500_000, 500_000),
                                      (60, 200_000, -200_000),
                                      (120, 1_200_000, -1_200_000)]:
            now = self.base + timedelta(seconds=offset)
            rows = parse_stock_rows([
                raw("600001", 1, int(now.timestamp()), first),
                raw("000001", 0, int(now.timestamp()), second),
            ])
            radar.ingest(2, rows, now)
        result = radar.data(self.base + timedelta(seconds=121))
        self.assertEqual(result["scanned_count"], 2)
        self.assertEqual(result["rising"][0]["code"], "600001")
        self.assertEqual(result["rising"][0]["change_scan"], 1_000_000)
        self.assertEqual(result["rising"][0]["window_seconds"], 60)
        self.assertEqual(result["falling"][0]["code"], "000001")
        self.assertEqual(result["turns"][0]["code"], "600001")
        radar.ingest(2, parse_stock_rows([raw("600001", 1, self.stamp, 9_000_000)]),
                     self.base + timedelta(seconds=121))
        self.assertEqual(radar.data(self.base + timedelta(seconds=121))["rising"][0]["change_scan"], 1_000_000)
        expired = radar.data(self.base + timedelta(seconds=250))
        self.assertEqual(expired["market_status"], "stale")
        self.assertEqual(expired["scanned_count"], 0)

    async def test_duplicate_identity_cannot_substitute_for_missing_stock(self):
        items = [raw(f"{index:06d}", 0, self.stamp, 1) for index in range(9)]
        items.append(items[0])
        progress = {}
        with patch("services.market_stock_radar.fetch_stock_page", new=AsyncMock(return_value=(10, items))):
            self.assertIsNone(await fetch_market_stocks(progress))
        self.assertIn("重复", progress["error"])

    async def test_scan_deadline_cancels_a_hanging_page(self):
        import asyncio
        cancelled = asyncio.Event()
        async def hanging(page):
            try:
                await asyncio.Event().wait()
            finally:
                cancelled.set()
        progress = {}
        with patch("services.market_stock_radar.SCAN_TIMEOUT_SECONDS", 0.01), patch(
            "services.market_stock_radar.fetch_stock_page", side_effect=hanging
        ):
            self.assertIsNone(await asyncio.wait_for(fetch_market_stocks(progress), 0.5))
        self.assertTrue(cancelled.is_set())
        self.assertIn("超时", progress["error"])

    async def test_only_failed_page_is_retried(self):
        calls = []
        async def page(number):
            calls.append(number)
            if number == 2 and calls.count(2) == 1:
                return None
            return (2, [raw(f"{number:06d}", 0, self.stamp, 1)])
        with patch("services.market_stock_radar.PAGE_SIZE", 1), patch(
            "services.market_stock_radar.fetch_stock_page", side_effect=page
        ):
            self.assertIsNotNone(await fetch_market_stocks())
        self.assertEqual(calls, [1, 2, 2])

    def test_mostly_stale_scan_is_not_healthy(self):
        radar = MarketStockRadar()
        items = [raw(f"{i:06d}", 0, self.stamp if i < 3 else self.stamp - 120, i) for i in range(10)]
        radar.ingest(10, parse_stock_rows(items), self.base)
        self.assertEqual(radar.status_data(self.base)["market_status"], "stale")
        self.assertIsNone(radar._source_time)

    def test_failed_scan_is_degraded_even_with_recent_saved_sample(self):
        radar = MarketStockRadar()
        radar.ingest(1, parse_stock_rows([raw("600001", 1, self.stamp, 1)]), self.base)
        radar._last_error = "缺页"
        self.assertEqual(radar.status_data(self.base)["market_status"], "stale")
        self.assertEqual(radar._last_requested_at, 0)

    def test_two_minute_gap_is_not_reported_as_one_minute(self):
        radar = MarketStockRadar()
        for offset in (0, 120):
            radar.ingest(1, parse_stock_rows([raw("600001", 1, self.stamp + offset, offset)]),
                         self.base + timedelta(seconds=offset))
        row = radar.data(self.base + timedelta(seconds=120))["rising"][0]
        self.assertEqual(row["window_seconds"], 120)
        self.assertIsNone(row["change_1m"])

    def test_invalid_first_duplicate_does_not_hide_valid_row(self):
        items = [raw("600001", 1, self.stamp, None), raw("600001", 1, self.stamp, 100)]
        self.assertEqual(len(parse_stock_rows(items)), 1)


if __name__ == "__main__":
    unittest.main()
