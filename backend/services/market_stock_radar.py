"""Scan the complete A-share list for short-window stock fund-flow changes."""

from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import math
import time
from collections import deque
from datetime import date, datetime
from typing import Any

from config import EASTMONEY_PUSH_URL, EASTMONEY_SECTOR_URL, LIVE_REQUEST_TIMEOUT_SECONDS
from services.sector_flow_realtime import CST, MAX_FUTURE_SKEW_SECONDS, market_status_at
from utils.http_client import safe_fetch


logger = logging.getLogger(__name__)
POLL_SECONDS = 60
PAGE_SIZE = 100
MAX_PAGES = 70
SOURCE_AGE_SECONDS = 75
SAMPLE_GAP_SECONDS = 150
WINDOW_SECONDS = 300
MARKET_FILTER = "m:0+t:6,m:0+t:80,m:1+t:2,m:1+t:23,m:0+t:81+s:2048"
FIELDS = "f2,f3,f6,f12,f13,f14,f62,f124"


def _number(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def parse_stock_rows(items: list[Any]) -> list[dict[str, Any]]:
    """Keep A-share rows with an actual source timestamp and flow value."""
    rows: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in items:
        if not isinstance(item, dict):
            continue
        code = str(item.get("f12") or "")
        name = str(item.get("f14") or "").strip()
        market = item.get("f13")
        if len(code) != 6 or not code.isdigit() or market not in (0, 1) or not name:
            continue
        quote_id = f"{market}.{code}"
        if quote_id in seen:
            continue
        seen.add(quote_id)
        try:
            source_time = int(item.get("f124") or 0)
        except (TypeError, ValueError):
            source_time = 0
        main_net = _number(item.get("f62"))
        if source_time <= 0 or main_net is None:
            continue
        rows.append({
            "quote_id": quote_id,
            "code": code,
            "name": name,
            "market_name": "沪A" if market == 1 else "北交所" if code.startswith(("4", "8", "9")) else "深A",
            "source_time": source_time,
            "main_net": main_net,
            "price": _number(item.get("f2")),
            "change_percent": _number(item.get("f3")),
            "amount": _number(item.get("f6")),
        })
    return rows


async def fetch_stock_page(page: int) -> tuple[int, list[Any]] | None:
    params = {
        "pn": str(page), "pz": str(PAGE_SIZE), "po": "1", "np": "1",
        "fltt": "2", "invt": "2", "fid": "f12", "fs": MARKET_FILTER,
        "fields": FIELDS, "ut": "7eea3edcaed734bea9telecast",
        "_": str(int(time.time() * 1000)),
    }
    for url, attempts in ((EASTMONEY_PUSH_URL, 2), (EASTMONEY_SECTOR_URL, 1)):
        text = await safe_fetch(
            url, params=params, timeout=LIVE_REQUEST_TIMEOUT_SECONDS,
            max_retries=attempts,
        )
        if not text:
            continue
        try:
            payload = json.loads(text)
            data = payload.get("data") or {}
            total = int(data.get("total") or 0)
            items = data.get("diff")
        except (AttributeError, TypeError, ValueError):
            continue
        if payload.get("rc") in (None, 0) and total > 0 and isinstance(items, list):
            return total, items
    return None


async def fetch_market_stocks() -> tuple[int, list[dict[str, Any]]] | None:
    """Reject missing pages; never silently present a partial list as all-market."""
    started = time.monotonic()
    first = await fetch_stock_page(1)
    if first is None:
        return None
    total, first_items = first
    page_count = math.ceil(total / PAGE_SIZE)
    if page_count > MAX_PAGES:
        return None
    semaphore = asyncio.Semaphore(3)

    async def fetch(page: int) -> tuple[int, list[Any]] | None:
        async with semaphore:
            return await fetch_stock_page(page)

    items = list(first_items)
    for start in range(2, page_count + 1, 3):
        if time.monotonic() - started > 45:
            return None
        batch = await asyncio.gather(*(
            fetch(page) for page in range(start, min(start + 3, page_count + 1))
        ))
        if any(page is None or page[0] != total for page in batch):
            return None
        items.extend(item for page in batch if page for item in page[1])
    rows = parse_stock_rows(items)
    if len(items) < total or len(rows) < total * 0.9:
        return None
    return total, rows


class MarketStockRadar:
    def __init__(self) -> None:
        self._task: asyncio.Task[None] | None = None
        self._trade_date: date | None = None
        self._samples: dict[str, deque[tuple[int, float]]] = {}
        self._turns: dict[str, int] = {}
        self._latest: dict[str, dict[str, Any]] = {}
        self._total = 0
        self._source_time: int | None = None
        self._last_error: str | None = None
        self._last_requested_at = 0.0

    async def start(self) -> None:
        if self._task is None or self._task.done():
            self._task = asyncio.create_task(self._loop(), name="market-stock-radar")

    async def stop(self) -> None:
        if self._task is not None:
            self._task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._task
            self._task = None

    async def _loop(self) -> None:
        while True:
            started = time.monotonic()
            current = datetime.now(CST)
            active = started - self._last_requested_at < 90
            if active and market_status_at(current) == "open":
                try:
                    batch = await fetch_market_stocks()
                    if batch is None:
                        self._last_error = "全市场股票快照不完整或请求失败"
                    else:
                        self.ingest(*batch, datetime.now(CST))
                except asyncio.CancelledError:
                    raise
                except Exception:
                    self._last_error = "全市场股票快照采集失败"
                    logger.exception("[stock-radar] Market scan failed")
            await asyncio.sleep(
                max(1, POLL_SECONDS - (time.monotonic() - started)) if active else 5
            )

    def ingest(self, total: int, rows: list[dict[str, Any]], current: datetime) -> None:
        if self._trade_date != current.date():
            self._samples.clear()
            self._turns.clear()
            self._latest.clear()
            self._trade_date = current.date()
            self._source_time = None
        fresh = [
            row for row in rows
            if datetime.fromtimestamp(row["source_time"], CST).date() == current.date()
            and -MAX_FUTURE_SKEW_SECONDS <= current.timestamp() - row["source_time"] <= SOURCE_AGE_SECONDS
        ]
        # An old response must not replace an already fresher scan.
        if not fresh or len(fresh) < len(rows) * 0.2:
            self._last_error = "股票源时间滞后，异动扫描已暂停"
            return
        latest_source_time = max(row["source_time"] for row in fresh)
        if self._source_time is not None and latest_source_time < self._source_time:
            self._last_error = "股票快照时间倒退，异动扫描已暂停"
            return
        for row in fresh:
            code = row["quote_id"]
            stamp = row["source_time"]
            samples = self._samples.setdefault(code, deque())
            if samples and stamp <= samples[-1][0]:
                continue
            previous = samples[-1] if samples else None
            if previous and stamp - previous[0] > WINDOW_SECONDS:
                samples.clear()
                previous = None
            if (previous and stamp - previous[0] <= SAMPLE_GAP_SECONDS
                    and previous[1] <= 0 < row["main_net"]):
                self._turns[code] = stamp
            samples.append((stamp, row["main_net"]))
            while samples and stamp - samples[0][0] > WINDOW_SECONDS:
                samples.popleft()
            self._latest[code] = row
        self._total = total
        self._source_time = latest_source_time
        self._last_error = None

    def data(self, current: datetime | None = None) -> dict[str, Any]:
        self._last_requested_at = time.monotonic()
        now = current or datetime.now(CST)
        status = market_status_at(now)
        if status == "open" and (
            self._source_time is None or now.timestamp() - self._source_time > SOURCE_AGE_SECONDS
        ):
            status = "stale"
        candidates: list[dict[str, Any]] = []
        if self._trade_date == now.date():
            for code, row in self._latest.items():
                stamp = row["source_time"]
                if now.timestamp() - stamp > SOURCE_AGE_SECONDS:
                    continue
                samples = self._samples[code]

                def change(seconds: int) -> float | None:
                    reference = next((value for time_, value in reversed(samples)
                                      if time_ <= stamp - seconds), None)
                    return row["main_net"] - reference if reference is not None else None

                previous = samples[-2] if len(samples) >= 2 else None
                scan_gap = stamp - previous[0] if previous else None
                scan_change = (
                    row["main_net"] - previous[1]
                    if scan_gap is not None and scan_gap <= SAMPLE_GAP_SECONDS else None
                )

                candidates.append({
                    **row,
                    "change_scan": scan_change,
                    "window_seconds": scan_gap if scan_change is not None else None,
                    "change_1m": change(60),
                    "change_3m": change(180),
                    "turned_positive": row["main_net"] > 0
                    and stamp - self._turns.get(code, 0) <= 300,
                    "turn_time": self._turns.get(code),
                    "points": list(samples),
                })
        with_change = [row for row in candidates if row["change_scan"] is not None]
        turns = sorted((row for row in candidates if row["turned_positive"]),
                       key=lambda row: row["turn_time"], reverse=True)[:10]
        rising = sorted((row for row in with_change if row["change_scan"] > 0),
                        key=lambda row: row["change_scan"], reverse=True)[:15]
        falling = sorted((row for row in with_change if row["change_scan"] < 0),
                         key=lambda row: row["change_scan"])[:15]
        return {
            "market_status": status, "source_time": self._source_time,
            "universe_count": self._total, "scanned_count": len(candidates),
            "poll_seconds": POLL_SECONDS, "last_error": self._last_error,
            "turns": turns, "rising": rising, "falling": falling,
        }


market_stock_radar = MarketStockRadar()
