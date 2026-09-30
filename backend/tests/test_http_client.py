import asyncio
import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, patch

from utils.http_client import safe_fetch


class HttpClientTests(unittest.IsolatedAsyncioTestCase):
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
