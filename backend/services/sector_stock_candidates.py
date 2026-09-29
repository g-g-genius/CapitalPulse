"""Activity-based stock watchlist for one EastMoney industry sector."""

from __future__ import annotations

import json
import math
import re
import time
from typing import Any

from config import EASTMONEY_PUSH_URL, EASTMONEY_SECTOR_URL
from utils.http_client import safe_fetch

SECTOR_CODE_PATTERN = re.compile(r"^BK\d{4}$")
STOCK_FIELDS = "f2,f3,f6,f8,f10,f12,f13,f14,f62,f124"
MIN_AMOUNT = 100_000_000
MIN_TURNOVER_RATE = 1.0
MAX_CHANGE_PERCENT = 8.0
FRESH_CACHE_SECONDS = 60
STALE_CACHE_SECONDS = 600
_candidate_cache: dict[tuple[str, int], tuple[float, dict[str, Any]]] = {}


def _number(value: Any) -> float | None:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return None
    return number if math.isfinite(number) else None


def rank_sector_stocks(items: list[Any], limit: int = 5) -> list[dict[str, Any]]:
    """Keep liquid, rising constituents with positive main inflow."""
    candidates: list[dict[str, Any]] = []
    seen: set[str] = set()
    for item in items:
        if not isinstance(item, dict):
            continue
        code = str(item.get("f12") or "").strip()
        name = str(item.get("f14") or "").strip()
        market = item.get("f13")
        if (
            len(code) != 6
            or not code.isdigit()
            or code[0] not in "036"
            or market not in (0, 1)
            or not name
            or "ST" in name.upper()
            or "退" in name
            or code in seen
        ):
            continue

        price = _number(item.get("f2"))
        change_percent = _number(item.get("f3"))
        amount = _number(item.get("f6"))
        turnover_rate = _number(item.get("f8"))
        main_net = _number(item.get("f62"))
        volume_ratio = _number(item.get("f10"))
        try:
            source_time = int(item.get("f124") or 0)
        except (TypeError, ValueError):
            source_time = 0
        if (
            price is None or price <= 0
            or change_percent is None or not 0 < change_percent <= MAX_CHANGE_PERCENT
            or amount is None or amount < MIN_AMOUNT
            or turnover_rate is None or turnover_rate < MIN_TURNOVER_RATE
            or main_net is None or main_net <= 0
            or source_time <= 0
        ):
            continue

        seen.add(code)
        candidates.append({
            "quote_id": f"{market}.{code}",
            "code": code,
            "name": name,
            "market_name": "沪A" if market == 1 else "深A",
            "pinyin": "",
            "price": price,
            "change_percent": change_percent,
            "amount": amount,
            "turnover_rate": turnover_rate,
            "main_net": main_net,
            "volume_ratio": volume_ratio if volume_ratio is not None and volume_ratio > 0 else None,
            "source_time": source_time,
        })

    candidates.sort(key=lambda stock: (
        stock["main_net"], stock["turnover_rate"], stock["amount"]
    ), reverse=True)
    return candidates[:limit]


async def fetch_sector_stock_candidates(
    sector_code: str, limit: int = 5
) -> dict[str, Any] | None:
    """Fetch a sector's constituents and return transparent short-term watch candidates."""
    if not SECTOR_CODE_PATTERN.fullmatch(sector_code):
        return None

    cache_key = (sector_code, limit)
    cached = _candidate_cache.get(cache_key)
    cache_age = time.monotonic() - cached[0] if cached else None
    if cached and cache_age is not None and cache_age < FRESH_CACHE_SECONDS:
        return {**cached[1], "stale": False}

    page_size = 20
    items: list[Any] = []
    total = 0
    for page in range(1, 31):
        params = {
            "pn": str(page),
            "pz": str(page_size),
            "po": "1",
            "np": "1",
            "fltt": "2",
            "invt": "2",
            "fid": "f6",
            "fs": f"b:{sector_code}+f:!50",
            "fields": STOCK_FIELDS,
        }
        data = None
        for url in (
            EASTMONEY_PUSH_URL,
            "https://29.push2.eastmoney.com/api/qt/clist/get",
            EASTMONEY_SECTOR_URL,
        ):
            text = await safe_fetch(
                url,
                params=params,
                headers={"Referer": "https://data.eastmoney.com/"},
            )
            if not text:
                continue
            try:
                payload = json.loads(text)
                if payload.get("rc") not in (None, 0):
                    continue
                parsed = payload.get("data")
                if isinstance(parsed, dict) and isinstance(parsed.get("diff") or [], list):
                    data = parsed
                    break
            except (ValueError, TypeError, AttributeError):
                continue
        if data is None:
            if items:
                break
            if cached and cache_age is not None and cache_age < STALE_CACHE_SECONDS:
                return {**cached[1], "stale": True}
            return None
        try:
            page_items = data.get("diff") or []
            total = int(data.get("total") or 0)
        except (ValueError, TypeError):
            return None
        items.extend(page_items)
        if (
            len(rank_sector_stocks(items, limit)) >= limit
            or len(items) >= total
            or len(page_items) < page_size
        ):
            break

    candidates = rank_sector_stocks(items, limit)
    source_times = [
        int(item.get("f124") or 0)
        for item in items if isinstance(item, dict)
        and str(item.get("f124") or "").isdigit()
    ]
    result = {
        "sector_code": sector_code,
        "as_of": max(source_times, default=None),
        "total_constituents": total,
        "scanned_constituents": len(items),
        "candidates": candidates,
        "stale": False,
    }
    _candidate_cache[cache_key] = (time.monotonic(), result)
    return result
