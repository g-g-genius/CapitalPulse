import unittest
from types import SimpleNamespace
from unittest.mock import AsyncMock, Mock, patch

import main


class LifecycleTests(unittest.IsolatedAsyncioTestCase):
    async def test_partial_startup_failure_cleans_already_started_services(self):
        sector = SimpleNamespace(start=AsyncMock(), stop=AsyncMock())
        stock = SimpleNamespace(start=AsyncMock(side_effect=RuntimeError("startup failed")), stop=AsyncMock())
        signals = SimpleNamespace(start=AsyncMock(), stop=AsyncMock())
        close = AsyncMock()
        with patch.multiple(main, sector_flow_service=sector, stock_flow_service=stock,
                            signal_service=signals, auth_service=SimpleNamespace(ensure_schema=Mock()),
                            close_client=close, close_candidate_requests=AsyncMock()):
            with self.assertRaisesRegex(RuntimeError, "startup failed"):
                async with main.lifespan(main.app):
                    self.fail("must not serve after failed startup")
        sector.stop.assert_awaited_once()
        stock.stop.assert_awaited_once()
        signals.start.assert_not_awaited()
        close.assert_awaited_once()
