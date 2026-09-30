"""Persist live signals, monitor saved stocks, and replay stored market snapshots."""

from __future__ import annotations

import asyncio
import contextlib
import logging
import sqlite3
import time
from bisect import bisect_left
from collections import defaultdict
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any

from config import env_path
from database import MysqlConnection, open_database
from services.sector_flow_realtime import (
    CST, DEFAULT_DB_PATH, MAX_FUTURE_SKEW_SECONDS, market_status_at,
)
from services.signal_engine import SignalEngine
from services.stock_flow_upstream import fetch_stock_flow_snapshots


logger = logging.getLogger(__name__)
SQLITE_SIGNAL_SCHEMA = Path(__file__).resolve().parents[1] / "sql" / "sqlite_signal_schema.sql"
EVENT_COLUMNS = (
    "id", "trade_date", "source_time", "entity_type", "entity_code", "entity_name",
    "signal_type", "main_net", "change_15s", "change_1m", "change_3m", "created_at",
)
STOCK_POLL_SECONDS = 10
MAX_SOURCE_AGE_SECONDS = 10


class SignalService:
    def __init__(self, db_path: Path | None = None) -> None:
        self.db_path = db_path or env_path("SECTOR_FLOW_DB_PATH", DEFAULT_DB_PATH)
        self._connection: sqlite3.Connection | MysqlConnection | None = None
        self._watchlist_task: asyncio.Task[None] | None = None
        self._engine = SignalEngine()
        self._pending_events: list[dict[str, Any]] = []
        self._last_stock_source: dict[str, int] = {}
        self.monitored_stocks = 0
        self.stock_poll_error: str | None = None
        self.persist_error: str | None = None

    @property
    def ready(self) -> bool:
        return self._connection is not None

    @property
    def connection(self) -> sqlite3.Connection | MysqlConnection:
        if self._connection is None:
            raise RuntimeError("signal database is not open")
        return self._connection

    async def start(self) -> None:
        if self.ready:
            return
        connection = open_database(self.db_path)
        if isinstance(connection, sqlite3.Connection):
            connection.executescript(SQLITE_SIGNAL_SCHEMA.read_text(encoding="utf-8"))
            connection.commit()
        self._connection = connection
        today = datetime.now(CST).date().isoformat()
        cooldown_rows = connection.execute(
            "SELECT entity_type, entity_code, signal_type, MAX(source_time) "
            "FROM signal_events WHERE trade_date = ? "
            "GROUP BY entity_type, entity_code, signal_type", (today,),
        ).fetchall()
        self._engine.cooldowns = {
            (str(row[0]), str(row[1]), str(row[2])): int(row[3]) for row in cooldown_rows
        }
        self._watchlist_task = asyncio.create_task(self._watchlist_loop(), name="watchlist-signal-poller")

    async def stop(self) -> None:
        if self._watchlist_task and not self._watchlist_task.done():
            self._watchlist_task.cancel()
            with contextlib.suppress(asyncio.CancelledError):
                await self._watchlist_task
        self._watchlist_task = None
        if self._connection is not None:
            self._connection.close()
            self._connection = None

    @staticmethod
    def _event(row: tuple[Any, ...]) -> dict[str, Any]:
        result = dict(zip(EVENT_COLUMNS, row))
        for key in ("id", "source_time", "created_at"):
            result[key] = int(result[key])
        for key in ("main_net", "change_15s", "change_1m", "change_3m"):
            result[key] = float(result[key]) if result[key] is not None else None
        return result

    def _persist_pending(self) -> None:
        if not self._pending_events:
            return
        try:
            for event in self._pending_events:
                self.connection.execute(
                    "INSERT INTO signal_events "
                    "(trade_date, source_time, entity_type, entity_code, entity_name, "
                    "signal_type, main_net, change_15s, change_1m, change_3m, created_at) "
                    "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) "
                    "ON CONFLICT(trade_date, entity_type, entity_code, signal_type, source_time) DO NOTHING",
                    tuple(event[column] for column in EVENT_COLUMNS[1:]),
                )
            self.connection.commit()
            self._pending_events.clear()
            self.persist_error = None
        except Exception as exc:
            self.connection.rollback()
            self.persist_error = str(exc)
            logger.exception("[signals] Could not persist signal events; will retry")

    def ingest_sector(self, flows: list[dict[str, Any]], current: datetime) -> None:
        if not self.ready or market_status_at(current) != "open":
            return
        self._persist_pending()
        for flow in flows:
            source_time = int(flow["source_time"])
            if not -MAX_FUTURE_SKEW_SECONDS <= current.timestamp() - source_time <= MAX_SOURCE_AGE_SECONDS:
                continue
            self._pending_events.extend(self._engine.evaluate(
                "sector", str(flow["sector_code"]), str(flow["sector_name"]),
                source_time, float(flow["main_net"]),
            ))
        self._stamp_and_persist()

    def ingest_stock(self, flows: list[dict[str, Any]], current: datetime) -> None:
        if not self.ready or market_status_at(current) != "open":
            return
        self._persist_pending()
        for flow in flows:
            source_time = int(flow["source_time"])
            if not -MAX_FUTURE_SKEW_SECONDS <= current.timestamp() - source_time <= MAX_SOURCE_AGE_SECONDS:
                continue
            self._pending_events.extend(self._engine.evaluate(
                "stock", str(flow["quote_id"]), str(flow["name"]),
                source_time, float(flow["main_net"]),
            ))
        self._stamp_and_persist()

    def _stamp_and_persist(self) -> None:
        created_at = int(time.time())
        for event in self._pending_events:
            event.setdefault("created_at", created_at)
        self._persist_pending()

    def recent_events(
        self, trade_date: date, user_id: int | None, *, since_id: int = 0,
        limit: int = 100,
    ) -> list[dict[str, Any]]:
        rows = self.connection.execute(
            "SELECT id, trade_date, source_time, entity_type, entity_code, entity_name, "
            "signal_type, main_net, change_15s, change_1m, change_3m, created_at "
            "FROM signal_events AS e WHERE trade_date = ? AND id > ? "
            "AND (entity_type = 'sector' OR EXISTS ("
            "SELECT 1 FROM watchlist_stocks AS w WHERE w.user_id = ? "
            "AND w.quote_id = e.entity_code)) "
            "ORDER BY id DESC LIMIT ?",
            (trade_date.isoformat(), since_id, user_id or 0, limit),
        ).fetchall()
        return [self._event(row) for row in rows]

    def watchlist_quotes(self, user_id: int) -> dict[str, Any]:
        """Return the latest saved quote and real intraday price samples for this account."""
        rows = self.connection.execute(
            "SELECT q.trade_date, q.quote_id, q.source_time, q.price, "
            "q.change_percent, q.main_net "
            "FROM watchlist_quote_snapshot AS q "
            "JOIN watchlist_stocks AS w ON w.quote_id = q.quote_id "
            "WHERE w.user_id = ? AND q.trade_date = ("
            "SELECT MAX(q2.trade_date) FROM watchlist_quote_snapshot AS q2 "
            "JOIN watchlist_stocks AS w2 ON w2.quote_id = q2.quote_id "
            "WHERE w2.user_id = ?) "
            "ORDER BY q.quote_id, q.source_time",
            (user_id, user_id),
        ).fetchall()
        quotes: dict[str, dict[str, Any]] = {}
        for trade_date, quote_id, source_time, price, change_percent, main_net in rows:
            quote = quotes.setdefault(str(quote_id), {
                "quote_id": str(quote_id), "trade_date": str(trade_date),
                "source_time": 0, "price": None, "change_percent": None,
                "main_net": None, "price_points": [],
            })
            quote["source_time"] = int(source_time)
            quote["price"] = float(price)
            quote["change_percent"] = float(change_percent)
            quote["main_net"] = float(main_net)
            quote["price_points"].append([int(source_time), float(price)])
        return {"quotes": list(quotes.values()), "poll_error": self.stock_poll_error}

    def replay(self, trade_date: date, user_id: int | None) -> dict[str, Any]:
        """Simulate the same rules on available real-time snapshots without writing alerts."""
        connection = open_database(self.db_path)
        try:
            sector_rows = connection.execute(
                "SELECT source_time, sector_code, sector_name, main_net "
                "FROM sector_flow_snapshot WHERE trade_date = ? AND granularity = 'realtime'",
                (trade_date.isoformat(),),
            ).fetchall()
            stock_rows = connection.execute(
                "SELECT s.source_time, s.quote_id, s.stock_name, s.main_net "
                "FROM stock_flow_snapshot AS s JOIN watchlist_stocks AS w "
                "ON w.quote_id = s.quote_id AND w.user_id = ? "
                "WHERE s.trade_date = ? AND s.granularity = 'realtime'",
                (user_id or 0, trade_date.isoformat()),
            ).fetchall()
        finally:
            connection.close()
        points = [
            (int(stamp), "sector", str(code), str(name), float(value))
            for stamp, code, name, value in sector_rows
        ] + [
            (int(stamp), "stock", str(code), str(name), float(value))
            for stamp, code, name, value in stock_rows
        ]
        points.sort(key=lambda item: (item[0], item[1], item[2]))
        timelines: dict[tuple[str, str], list[tuple[int, float]]] = defaultdict(list)
        engine = SignalEngine()
        events: list[dict[str, Any]] = []
        for stamp, kind, code, name, value in points:
            timelines[(kind, code)].append((stamp, value))
            events.extend(engine.evaluate(kind, code, name, stamp, value))
        for event in events:
            timeline = timelines[(event["entity_type"], event["entity_code"])]
            timestamps = [item[0] for item in timeline]
            for seconds, field in ((60, "after_1m"), (180, "after_3m")):
                target = event["source_time"] + seconds
                index = bisect_left(timestamps, target)
                event[field] = (
                    timeline[index][1] - event["main_net"]
                    if index < len(timeline) and timeline[index][0] - target <= 30 else None
                )
        events.sort(key=lambda item: item["source_time"], reverse=True)
        return {
            "trade_date": trade_date.isoformat(),
            "snapshot_count": len(points),
            "sector_count": len({code for _, kind, code, _, _ in points if kind == "sector"}),
            "stock_count": len({code for _, kind, code, _, _ in points if kind == "stock"}),
            "events": events[:200],
            "total_events": len(events),
        }

    async def _watchlist_loop(self) -> None:
        while True:
            started = time.monotonic()
            current = datetime.now(CST)
            if market_status_at(current) == "open":
                try:
                    await self._poll_watchlist_once(current)
                except asyncio.CancelledError:
                    raise
                except Exception as exc:
                    self.stock_poll_error = str(exc)
                    logger.exception("[signals] Watchlist stock poll failed")
            await asyncio.sleep(max(1, STOCK_POLL_SECONDS - (time.monotonic() - started)))

    async def _poll_watchlist_once(self, current: datetime) -> None:
        rows = self.connection.execute(
            "SELECT quote_id, MAX(name) FROM watchlist_stocks "
            "GROUP BY quote_id ORDER BY quote_id"
        ).fetchall()
        quote_ids = [str(row[0]) for row in rows]
        names = {str(row[0]): str(row[1]) for row in rows}
        self.monitored_stocks = len(quote_ids)
        if not quote_ids:
            self.stock_poll_error = None
            return
        chunks = [quote_ids[index:index + 50] for index in range(0, len(quote_ids), 50)]
        semaphore = asyncio.Semaphore(4)

        async def fetch(chunk: list[str]) -> list[dict[str, Any]] | None:
            async with semaphore:
                return await fetch_stock_flow_snapshots(chunk)

        results = await asyncio.gather(*(fetch(chunk) for chunk in chunks))
        self.stock_poll_error = "部分自选股快照请求失败" if any(batch is None for batch in results) else None
        from services.stock_flow_realtime import stock_flow_service

        received_at = datetime.now(CST).isoformat(timespec="milliseconds")
        fresh: list[dict[str, Any]] = []
        for batch in results:
            if batch is None:
                continue
            for flow in batch:
                source_time = int(flow["source_time"])
                quote_id = str(flow["quote_id"])
                if (
                    datetime.fromtimestamp(source_time, CST).date() != current.date()
                    or not -MAX_FUTURE_SKEW_SECONDS <= current.timestamp() - source_time <= MAX_SOURCE_AGE_SECONDS
                    or source_time <= self._last_stock_source.get(quote_id, 0)
                ):
                    continue
                self._last_stock_source[quote_id] = source_time
                if not flow["name"]:
                    flow["name"] = names.get(quote_id, "")
                flow["received_at"] = received_at
                price = flow.get("price")
                change_percent = flow.get("change_percent")
                if price is not None and price > 0 and change_percent is not None:
                    self.connection.execute(
                        "INSERT INTO watchlist_quote_snapshot "
                        "(trade_date, quote_id, minute_time, source_time, price, "
                        "change_percent, main_net) VALUES (?, ?, ?, ?, ?, ?, ?) "
                        "ON CONFLICT(trade_date, quote_id, minute_time) DO UPDATE SET "
                        "source_time = excluded.source_time, price = excluded.price, "
                        "change_percent = excluded.change_percent, main_net = excluded.main_net",
                        (current.date().isoformat(), quote_id, source_time // 60 * 60,
                         source_time, price, change_percent, flow["main_net"]),
                    )
                if stock_flow_service.ready:
                    stock_flow_service._persist_snapshot(current.date(), flow)
                fresh.append(flow)
        self.connection.commit()
        self.ingest_stock(fresh, current)


signal_service = SignalService()
