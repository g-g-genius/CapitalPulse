"""FastAPI application entry point."""

import logging
import os
import sys
from contextlib import asynccontextmanager

import uvicorn
from fastapi import FastAPI, WebSocket
from fastapi.middleware.cors import CORSMiddleware

from config import HOST, PORT
from routers import auth, sector_flow_realtime, signals, stock_flow_realtime, watchlist
from services.auth_service import auth_service
from services.sector_flow_realtime import sector_flow_service
from services.signal_service import signal_service
from services.stock_flow_realtime import stock_flow_service
from utils.http_client import close_client

# Configure logging
logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s [%(levelname)s] %(name)s: %(message)s",
    stream=sys.stdout,
)
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """Application lifespan: startup and shutdown."""
    logger.info("backend starting up...")
    auth_service.ensure_schema()
    await sector_flow_service.start()
    await stock_flow_service.start()
    await signal_service.start()
    yield
    logger.info("backend shutting down...")
    await signal_service.stop()
    await stock_flow_service.stop()
    await sector_flow_service.stop()
    await close_client()


# Create FastAPI app
app = FastAPI(
    title="Vane Sector Flow API",
    description="Real-time A-share sector capital-flow dashboard API.",
    version="1.0.0",
    lifespan=lifespan,
)

# The browser normally uses the same-origin Next.js API proxy.
app.add_middleware(
    CORSMiddleware,
    allow_origins=[
        origin.strip()
        for origin in os.getenv(
            "CORS_ORIGINS", "http://localhost:3000,http://127.0.0.1:3000"
        ).split(",")
        if origin.strip()
    ],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(sector_flow_realtime.router, prefix="/api", tags=["Real-time Sector Flow"])
app.include_router(stock_flow_realtime.router, prefix="/api", tags=["Real-time Stock Flow"])
app.include_router(auth.router, prefix="/api", tags=["Account"])
app.include_router(watchlist.router, prefix="/api", tags=["Watchlist"])
app.include_router(signals.router, prefix="/api", tags=["Signals"])


# Health check endpoint
@app.get("/api/health")
async def health_check():
    """Health check endpoint."""
    return {"code": 200, "msg": "ok", "data": {"status": "healthy"}}


@app.websocket("/ws/sector-flow")
async def ws_sector_flow(websocket: WebSocket):
    """WebSocket endpoint for persistent sector-flow snapshots."""
    await sector_flow_service.websocket_handler(websocket)


@app.websocket("/ws/stock-flow")
async def stock_flow_ws(
    websocket: WebSocket,
    quote_id: str,
    code: str = "",
    name: str = "",
):
    """Subscribe to one stock's persistent second-level fund-flow snapshots."""
    await stock_flow_service.websocket_handler(websocket, quote_id, code, name)


if __name__ == "__main__":
    uvicorn.run(
        "main:app",
        host=HOST,
        port=PORT,
        log_level="info",
        reload=False,
    )
