"""Public read-only full-market stock anomaly radar."""

from fastapi import APIRouter, Response

from services.market_stock_radar import market_stock_radar


router = APIRouter()


@router.get("/stock-radar")
async def stock_radar(response: Response):
    response.headers["Cache-Control"] = "no-store"
    return {"code": 200, "msg": "success", "data": market_stock_radar.data()}
