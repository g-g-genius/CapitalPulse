"""Deterministic short-window capital-flow signals for live data and replay."""

from __future__ import annotations

from collections import deque
import math
from datetime import datetime, timedelta, timezone
from typing import Any
from utils.flow_windows import window_change


CST = timezone(timedelta(hours=8))
COOLDOWN_SECONDS = 180
MAX_SAMPLE_GAP_SECONDS = 20
WINDOW_SECONDS = 240
THRESHOLDS = {
    "sector": {"surge": 8_000_000, "turn_positive": 4_000_000},
    "stock": {"surge": 1_500_000, "turn_positive": 500_000},
}


class SignalEngine:
    def __init__(self) -> None:
        self.samples: dict[tuple[str, str], deque[tuple[int, float]]] = {}
        self.surge_streaks: dict[tuple[str, str], int] = {}
        self.cooldowns: dict[tuple[str, str, str], int] = {}

    def reset(self) -> None:
        self.samples.clear()
        self.surge_streaks.clear()
        self.cooldowns.clear()

    def evaluate(
        self,
        entity_type: str,
        entity_code: str,
        entity_name: str,
        source_time: int,
        main_net: float,
    ) -> list[dict[str, Any]]:
        if entity_type not in THRESHOLDS:
            raise ValueError("unsupported signal entity type")
        if source_time <= 0 or not math.isfinite(main_net):
            return []
        key = (entity_type, entity_code)
        samples = self.samples.setdefault(key, deque())
        if samples and source_time <= samples[-1][0]:
            return []
        if samples and source_time - samples[-1][0] > MAX_SAMPLE_GAP_SECONDS:
            samples.clear()
            self.surge_streaks.pop(key, None)
        previous = samples[-1] if samples else None
        samples.append((source_time, main_net))
        while samples and source_time - samples[0][0] > WINDOW_SECONDS:
            samples.popleft()

        def change(seconds: int) -> float | None:
            return window_change(samples, source_time, main_net, seconds)

        delta_15s = change(15)
        delta_1m = change(60)
        delta_3m = change(180)
        recent = previous is not None and source_time - previous[0] <= MAX_SAMPLE_GAP_SECONDS
        thresholds = THRESHOLDS[entity_type]
        turn = bool(
            recent and previous[1] <= 0 < main_net
            and delta_15s is not None
            and delta_15s >= thresholds["turn_positive"]
        )
        surge_candidate = bool(
            recent and delta_15s is not None
            and delta_15s >= thresholds["surge"]
            and (delta_1m is None or delta_1m > 0)
            and (delta_3m is None or delta_3m > 0)
        )
        self.surge_streaks[key] = self.surge_streaks.get(key, 0) + 1 if surge_candidate else 0

        events: list[dict[str, Any]] = []
        for signal_type, active in (
            ("turn_positive", turn),
            ("surge", self.surge_streaks[key] >= 2),
        ):
            cooldown_key = (entity_type, entity_code, signal_type)
            if not active or source_time - self.cooldowns.get(cooldown_key, 0) < COOLDOWN_SECONDS:
                continue
            self.cooldowns[cooldown_key] = source_time
            events.append({
                "trade_date": datetime.fromtimestamp(source_time, CST).date().isoformat(),
                "source_time": source_time,
                "entity_type": entity_type,
                "entity_code": entity_code,
                "entity_name": entity_name,
                "signal_type": signal_type,
                "main_net": main_net,
                "change_15s": delta_15s,
                "change_1m": delta_1m,
                "change_3m": delta_3m,
            })
        return events
