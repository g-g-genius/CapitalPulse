import unittest

from services.signal_engine import SignalEngine


class SignalEngineTests(unittest.TestCase):
    def test_turn_and_sustained_surge_are_deduplicated(self):
        engine = SignalEngine()
        base = 1790645400
        values = [(0, -7_000_000), (5, -5_000_000), (10, -3_000_000),
                  (15, 1_000_000), (18, 4_000_000), (21, 7_000_000),
                  (24, 9_000_000)]
        events = [event for offset, value in values
                  for event in engine.evaluate("sector", "BK0001", "测试行业", base + offset, value)]
        self.assertEqual([event["signal_type"] for event in events], ["turn_positive", "surge"])
        self.assertGreaterEqual(events[0]["change_15s"], 4_000_000)
        self.assertGreaterEqual(events[1]["change_15s"], 8_000_000)

    def test_sparse_or_duplicate_samples_do_not_create_instant_signal(self):
        engine = SignalEngine()
        base = 1790645400
        self.assertEqual(engine.evaluate("sector", "BK0001", "测试行业", base, -20_000_000), [])
        self.assertEqual(engine.evaluate("sector", "BK0001", "测试行业", base + 60, 20_000_000), [])
        self.assertEqual(engine.evaluate("sector", "BK0001", "测试行业", base + 60, 99_000_000), [])

    def test_stock_threshold_is_separate_and_gap_resets_surge_streak(self):
        engine = SignalEngine()
        base = 1790645400
        values = [(0, 100_000), (15, 1_600_000), (40, 3_500_000), (55, 5_100_000), (58, 6_800_000)]
        events = [event for offset, value in values
                  for event in engine.evaluate("stock", "1.600519", "贵州茅台", base + offset, value)]
        self.assertEqual([event["signal_type"] for event in events], ["surge"])
        self.assertEqual(events[0]["source_time"], base + 58)


if __name__ == "__main__":
    unittest.main()
