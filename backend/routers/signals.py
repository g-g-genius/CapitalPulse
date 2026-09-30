"""Live signal feed and read-only historical snapshot replay."""

import asyncio
from datetime import date, datetime

from fastapi import APIRouter, Cookie, Query, Response

from services.auth_service import auth_service
from services.sector_flow_realtime import CST
from services.signal_service import signal_service


router = APIRouter()


@router.get("/signals/recent")
async def recent_signals(
    response: Response,
    trade_date: date | None = Query(None),
    since_id: int = Query(0, ge=0),
    limit: int = Query(100, ge=1, le=200),
    capitalpulse_session: str | None = Cookie(default=None),
):
    response.headers["Cache-Control"] = "no-store"
    if not signal_service.ready:
        return {"code": 503, "msg": "signal service is not ready", "data": None}
    user = auth_service.get_user_for_session(capitalpulse_session)
    target = trade_date or datetime.now(CST).date()
    return {
        "code": 200, "msg": "success",
        "data": {
            "trade_date": target.isoformat(),
            "events": signal_service.recent_events(target, user["id"] if user else None,
                                                   since_id=since_id, limit=limit),
            "monitored_stocks": signal_service.monitored_stocks,
            "stock_poll_error": signal_service.stock_poll_error,
            "persist_error": signal_service.persist_error,
        },
    }


@router.get("/signals/replay")
async def replay_signals(
    response: Response,
    trade_date: date = Query(...),
    capitalpulse_session: str | None = Cookie(default=None),
):
    response.headers["Cache-Control"] = "no-store"
    if not signal_service.ready:
        return {"code": 503, "msg": "signal service is not ready", "data": None}
    user = auth_service.get_user_for_session(capitalpulse_session)
    return {
        "code": 200, "msg": "success",
        "data": await asyncio.to_thread(
            signal_service.replay, trade_date, user["id"] if user else None
        ),
    }
