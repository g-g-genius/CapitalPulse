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


if __name__ == "__main__":
    unittest.main()
