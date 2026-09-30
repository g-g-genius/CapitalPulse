"""Account-scoped stock watchlist endpoints."""

from __future__ import annotations

from fastapi import APIRouter, Depends, HTTPException, Path, Response
from pydantic import BaseModel, Field, model_validator

from routers import auth
from services.auth_service import WatchlistFull
from services.signal_service import signal_service


router = APIRouter()


class WatchlistStockRequest(BaseModel):
    quote_id: str = Field(pattern=r"^[01]\.\d{6}$")
    code: str = Field(pattern=r"^\d{6}$")
    name: str = Field(min_length=1, max_length=64)
    market_name: str = Field(default="", max_length=32)
    pinyin: str = Field(default="", max_length=64)

    @model_validator(mode="after")
    def matching_code(self) -> "WatchlistStockRequest":
        if self.quote_id.split(".", 1)[1] != self.code:
            raise ValueError("股票代码与行情标识不一致")
        self.name = self.name.strip()
        if not self.name:
            raise ValueError("股票名称不能为空")
        return self


@router.get("/watchlist/stocks")
def list_stocks(response: Response, user: dict = Depends(auth.require_user)):
    response.headers["Cache-Control"] = "no-store"
    stocks = auth.auth_service.list_watchlist(user["id"])
    return {"code": 200, "msg": "success", "data": stocks}


@router.get("/watchlist/quotes")
async def list_quotes(response: Response, user: dict = Depends(auth.require_user)):
    response.headers["Cache-Control"] = "no-store"
    data = signal_service.watchlist_quotes(user["id"]) if signal_service.ready else {
        "quotes": [], "poll_error": "行情服务暂不可用",
    }
    return {"code": 200, "msg": "success", "data": data}


@router.post("/watchlist/stocks", status_code=201)
def add_stock(
    payload: WatchlistStockRequest,
    response: Response,
    user: dict = Depends(auth.require_user),
):
    try:
        stock = auth.auth_service.add_watchlist_stock(user["id"], payload.model_dump())
    except WatchlistFull:
        raise HTTPException(status_code=409, detail="自选股最多添加 100 只") from None
    response.headers["Cache-Control"] = "no-store"
    return {"code": 201, "msg": "saved", "data": stock}


@router.delete("/watchlist/stocks/{quote_id}")
def remove_stock(
    response: Response,
    quote_id: str = Path(pattern=r"^[01]\.\d{6}$"),
    user: dict = Depends(auth.require_user),
):
    auth.auth_service.remove_watchlist_stock(user["id"], quote_id)
    response.headers["Cache-Control"] = "no-store"
    return {"code": 200, "msg": "removed", "data": None}
