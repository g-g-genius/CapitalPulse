import asyncio
import unittest
import httpx
import utils.http_client as transport
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from utils.http_client import safe_fetch


class HttpClientTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        transport._endpoints.clear()
        transport._slots = None

    async def test_default_request_also_has_total_deadline(self):
        async def hang(*args, **kwargs):
            await asyncio.Event().wait()
        client = SimpleNamespace(get=AsyncMock(side_effect=hang))
        with patch("utils.http_client.REQUEST_TIMEOUT", .01), patch(
            "utils.http_client.get_client", new=AsyncMock(return_value=client)
        ):
            self.assertIsNone(await asyncio.wait_for(safe_fetch("https://example.test/default", max_retries=1), .5))

    async def test_fault_cooldown_and_recovery_probe(self):
        client = SimpleNamespace(get=AsyncMock(side_effect=httpx.ConnectError("offline")))
        url = "https://example.test/flow"
        with patch("utils.http_client.get_client", new=AsyncMock(return_value=client)):
            for _ in range(4):
                self.assertIsNone(await safe_fetch(url, max_retries=1))
            self.assertEqual(client.get.await_count, 3)
            state = transport._endpoints[url]
            state["until"] = 0
            client.get.side_effect = None
            client.get.return_value = httpx.Response(200, text="recovered")
            self.assertEqual(await safe_fetch(url), "recovered")
            self.assertEqual(state["failures"], 0)
            self.assertFalse(state["probe"])

    async def test_rate_limit_honors_cooldown_and_404_is_not_retried(self):
        client = SimpleNamespace(get=AsyncMock(return_value=httpx.Response(429, headers={"Retry-After": "20"})))
        with patch("utils.http_client.get_client", new=AsyncMock(return_value=client)):
            await safe_fetch("https://example.test/rate")
            await safe_fetch("https://example.test/rate")
            self.assertEqual(client.get.await_count, 1)
            self.assertGreater(transport.transport_status()[0]["retry_in_seconds"], 19)
            client.get.return_value = httpx.Response(404)
            await safe_fetch("https://example.test/missing", max_retries=3)
            self.assertEqual(client.get.await_count, 2)

    async def test_shared_concurrency_is_bounded(self):
        active = peak = 0
        async def get(*args, **kwargs):
            nonlocal active, peak
            active += 1
            peak = max(peak, active)
            try:
                await asyncio.sleep(.01)
                return httpx.Response(200, text="ok")
            finally:
                active -= 1
        client = SimpleNamespace(get=get)
        with patch("utils.http_client.get_client", new=AsyncMock(return_value=client)):
            results = await asyncio.gather(*(safe_fetch("https://example.test/live") for _ in range(20)))
        self.assertEqual(results, ["ok"] * 20)
        self.assertLessEqual(peak, 8)

    async def test_live_request_has_total_timeout(self):
        async def never_returns(*args, **kwargs):
            await asyncio.Event().wait()

        client = SimpleNamespace(get=AsyncMock(side_effect=never_returns))
        with patch("utils.http_client.get_client", new=AsyncMock(return_value=client)):
            result = await asyncio.wait_for(
                safe_fetch("https://example.test/live", timeout=0.01, max_retries=1),
                timeout=0.5,
            )

        self.assertIsNone(result)
        client.get.assert_awaited_once()


if __name__ == "__main__":
    unittest.main()
