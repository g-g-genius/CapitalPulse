import unittest
from datetime import date, datetime, timezone
from services.sector_flow_realtime import CST, SectorFlowRealtimeService, market_status_at
from utils.trading_calendar import calendar_status, is_trading_day


class TradingCalendarTests(unittest.TestCase):
    def test_holidays_and_make_up_weekends_are_closed(self):
        for day in (date(2026, 10, 1), date(2026, 10, 7), date(2026, 10, 10),
                    date(2026, 2, 23), date(2026, 9, 25)):
            self.assertFalse(is_trading_day(day))
            self.assertEqual(market_status_at(datetime.combine(day, datetime.min.time(), CST).replace(hour=10)), "closed")
        self.assertTrue(is_trading_day(date(2026, 10, 8)))

    def test_daily_cache_target_skips_holiday_and_market_normalizes_timezone(self):
        now = datetime(2026, 10, 7, 10, 0, tzinfo=CST)
        self.assertEqual(SectorFlowRealtimeService._expected_daily_trade_date(now.date(), now), date(2026, 9, 30))
        self.assertEqual(market_status_at(datetime(2026, 9, 30, 2, 0, tzinfo=timezone.utc)), "open")

    def test_unknown_year_is_visible_in_health(self):
        self.assertTrue(calendar_status(date(2026, 1, 1))["verified"])
        self.assertFalse(calendar_status(date(2027, 1, 1))["verified"])
        self.assertTrue(calendar_status(date(2027, 1, 1))["warning"])
