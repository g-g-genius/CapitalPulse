import json
import unittest
from unittest.mock import AsyncMock, patch

import services.sector_stock_candidates as candidate_service
from services.sector_stock_candidates import (
    fetch_sector_stock_candidates,
    rank_sector_stocks,
)


def quote(code="000001", name="平安银行", **changes):
    item = {
        "f2": 12.34, "f3": 3.2, "f6": 220_000_000, "f8": 2.4,
        "f10": 1.5, "f12": code, "f13": 0, "f14": name,
        "f62": 30_000_000, "f124": 1780123456,
    }
    item.update(changes)
    return item


class SectorStockCandidateTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        candidate_service._candidate_cache.clear()

    def test_only_liquid_positive_inflow_constituents_are_ranked(self):
        items = [
            quote("000001", f62=10_000_000),
            quote("600001", "活跃股份", f13=1, f62=40_000_000),
            quote("000002", "ST观察", f62=90_000_000),
            quote("000003", "低成交", f6=50_000_000),
            quote("000004", "资金流出", f62=-1),
            quote("000005", "涨幅过高", f3=10),
            quote("600001", "重复记录", f13=1, f62=40_000_000),
        ]
        result = rank_sector_stocks(items)
        self.assertEqual([stock["code"] for stock in result], ["600001", "000001"])
        self.assertEqual(result[0]["quote_id"], "1.600001")

    async def test_fetch_uses_exact_sector_members_and_reports_source_time(self):
        payload = json.dumps({"data": {"total": 2, "diff": [quote(), quote("600001", f13=1)]}})
        with patch("services.sector_stock_candidates.safe_fetch", new=AsyncMock(return_value=payload)) as fetch:
            result = await fetch_sector_stock_candidates("BK1033")
        self.assertEqual(result["total_constituents"], 2)
        self.assertEqual(result["as_of"], 1780123456)
        self.assertEqual(len(result["candidates"]), 2)
        self.assertEqual(fetch.await_args.kwargs["params"]["fs"], "b:BK1033+f:!50")
        self.assertEqual(fetch.await_args.kwargs["params"]["fid"], "f6")
        self.assertEqual(fetch.await_args.kwargs["params"]["pz"], "20")
        self.assertEqual(result["scanned_constituents"], 2)

    async def test_recent_success_is_used_if_upstream_temporarily_fails(self):
        payload = json.dumps({"data": {"total": 1, "diff": [quote()]}})
        with patch("services.sector_stock_candidates.safe_fetch", new=AsyncMock(return_value=payload)):
            await fetch_sector_stock_candidates("BK1033")
        created, data = candidate_service._candidate_cache[("BK1033", 5)]
        candidate_service._candidate_cache[("BK1033", 5)] = (created - 11, data)
        with patch("services.sector_stock_candidates.safe_fetch", new=AsyncMock(return_value=None)):
            result = await fetch_sector_stock_candidates("BK1033")
        self.assertTrue(result["stale"])
        self.assertEqual(result["candidates"][0]["code"], "000001")

    async def test_invalid_sector_code_does_not_call_upstream(self):
        with patch("services.sector_stock_candidates.safe_fetch", new=AsyncMock()) as fetch:
            result = await fetch_sector_stock_candidates("BK1033&evil=1")
        self.assertIsNone(result)
        fetch.assert_not_awaited()

    async def test_concurrent_readers_share_one_refresh_and_keep_stale_label(self):
        import asyncio
        payload = json.dumps({"data": {"total": 1, "diff": [quote()]}})
        async def delayed(*args, **kwargs):
            await asyncio.sleep(0.01)
            return payload
        with patch("services.sector_stock_candidates.safe_fetch", new=AsyncMock(side_effect=delayed)) as fetch:
            results = await asyncio.gather(*(fetch_sector_stock_candidates("BK1033") for _ in range(8)))
            cached = await fetch_sector_stock_candidates("BK1033")
        self.assertEqual(fetch.await_count, 1)
        self.assertTrue(all(result["stale"] for result in results))
        self.assertTrue(cached["stale"])

    async def test_hanging_refresh_uses_recent_cache_with_deadline(self):
        import asyncio
        payload = json.dumps({"data": {"total": 1, "diff": [quote()]}})
        with patch("services.sector_stock_candidates.safe_fetch", new=AsyncMock(return_value=payload)):
            await fetch_sector_stock_candidates("BK1033")
        created, result = candidate_service._candidate_cache[("BK1033", 5)]
        candidate_service._candidate_cache[("BK1033", 5)] = (created - 11, result)
        async def hanging(*args, **kwargs):
            await asyncio.Event().wait()
        with patch("services.sector_stock_candidates.FETCH_TIMEOUT_SECONDS", 0.01), patch(
            "services.sector_stock_candidates.safe_fetch", side_effect=hanging
        ):
            result = await asyncio.wait_for(fetch_sector_stock_candidates("BK1033"), 0.5)
        self.assertTrue(result["stale"])

    async def test_failed_later_page_is_labelled_partial(self):
        items = [quote(f"{i:06d}", f62=-1) for i in range(20)]
        payload = json.dumps({"data": {"total": 40, "diff": items}})
        with patch("services.sector_stock_candidates.safe_fetch", new=AsyncMock(side_effect=[payload, None, None, None])):
            result = await fetch_sector_stock_candidates("BK1033")
        self.assertTrue(result["partial"])
        self.assertTrue(result["stale"])
        self.assertFalse(result["complete"])
