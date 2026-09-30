"""Shared HTTP client with retry logic, timeout, and GBK decode support."""

import asyncio
import logging
import time
from urllib.parse import urlsplit
from typing import Optional

import httpx

from config import DEFAULT_HEADERS, MAX_RETRIES, REQUEST_TIMEOUT, RETRY_DELAY

logger = logging.getLogger(__name__)

# Module-level async client (created lazily)
_client: Optional[httpx.AsyncClient] = None
_slots: asyncio.Semaphore | None = None
_endpoints: dict[str, dict] = {}
FAILURE_THRESHOLD = 3


def transport_status() -> list[dict]:
    """Only endpoint paths and counters; never expose query strings or headers."""
    now = time.monotonic()
    return [{"endpoint": key, "failures": state["failures"],
             "retry_in_seconds": round(max(0, state["until"] - now), 1),
             "last_status": state.get("status"), "skipped": state["skipped"]}
            for key, state in _endpoints.items()]


async def get_client() -> httpx.AsyncClient:
    """Get or create the shared async HTTP client."""
    global _client
    if _client is None or _client.is_closed:
        _client = httpx.AsyncClient(
            timeout=httpx.Timeout(REQUEST_TIMEOUT),
            headers=DEFAULT_HEADERS,
            follow_redirects=True,
            limits=httpx.Limits(max_connections=12, max_keepalive_connections=8),
        )
    return _client


async def close_client() -> None:
    """Close the shared async HTTP client."""
    global _client, _slots
    if _client is not None and not _client.is_closed:
        await _client.aclose()
        _client = None
    _slots = None
    _endpoints.clear()


def _decode_bytes(data: bytes) -> str:
    """
    Decode response bytes trying multiple encodings.
    Priority: gbk → utf-8 → gb2312 → gb18030 → latin-1
    """
    encodings = ["gbk", "utf-8", "gb2312", "gb18030", "latin-1"]
    for enc in encodings:
        try:
            text = data.decode(enc)
            # If the text contains Chinese characters, it's likely correct
            if any("\u4e00" <= ch <= "\u9fff" for ch in text):
                return text
        except (UnicodeDecodeError, LookupError):
            continue

    # Final fallback
    return data.decode("latin-1")


async def safe_fetch(
    url: str,
    *,
    params: Optional[dict] = None,
    headers: Optional[dict] = None,
    force_gbk: bool = False,
    timeout: float | None = None,
    max_retries: int | None = None,
) -> Optional[str]:
    """
    Fetch text from a URL with retry and timeout.

    Args:
        url: The URL to fetch.
        params: Query parameters.
        headers: Extra headers to merge with defaults.
        force_gbk: If True, try GBK decoding first.

    Returns:
        Decoded text or None on failure.
    """
    global _slots
    parts = urlsplit(url)
    key = f"{parts.scheme}://{parts.netloc}{parts.path}"
    state = _endpoints.setdefault(key, {"failures": 0, "until": 0., "probe": False, "skipped": 0})
    if time.monotonic() < state["until"] or state["probe"]:
        state["skipped"] += 1
        return None
    probing = state["failures"] >= FAILURE_THRESHOLD
    if probing:
        state["probe"] = True
    if _slots is None:
        _slots = asyncio.Semaphore(8)
    try:
        result = await _fetch_text(url, params=params, headers=headers, force_gbk=force_gbk,
                                   timeout=timeout, max_retries=max_retries, state=state)
        if result is not None:
            state.update(failures=0, until=0.)
        elif state.get("status") not in (400, 401, 403, 404):
            state["failures"] += 1
            if state["failures"] >= FAILURE_THRESHOLD:
                state["until"] = max(state["until"], time.monotonic() + min(30, 5 * 2 ** min(3, state["failures"] - FAILURE_THRESHOLD)))
        return result
    finally:
        if probing:
            state["probe"] = False


async def _fetch_text(url, *, params, headers, force_gbk, timeout, max_retries, state):
    client = await get_client()
    attempts = MAX_RETRIES if max_retries is None else max(1, max_retries)
    merged_headers = {**DEFAULT_HEADERS}
    if headers:
        merged_headers.update(headers)

    for attempt in range(1, attempts + 1):
        try:
            budget = timeout if timeout is not None else REQUEST_TIMEOUT
            # Include queueing, DNS, connection and reading in the same deadline.
            async with asyncio.timeout(budget):
                async with _slots:
                    if time.monotonic() < state["until"]:
                        return None
                    resp = await client.get(url, params=params, headers=merged_headers, timeout=budget)
            state["status"] = resp.status_code

            if resp.status_code == 200:
                if force_gbk:
                    return _decode_bytes(resp.content)
                else:
                    # Try to detect encoding from Content-Type
                    content_type = resp.headers.get("content-type", "")
                    charset = ""
                    if "charset=" in content_type:
                        charset = content_type.split("charset=")[1].strip().lower()

                    if charset in ("gbk", "gb2312", "gb18030"):
                        return _decode_bytes(resp.content)

                    # Try UTF-8 first, fallback to GBK decode chain
                    try:
                        return resp.content.decode("utf-8")
                    except UnicodeDecodeError:
                        return _decode_bytes(resp.content)

            logger.warning(
                "[http_client] HTTP %s for %s (attempt %d/%d)",
                resp.status_code, url, attempt, attempts,
            )
            if resp.status_code == 429:
                try:
                    delay = max(1, min(300, float(resp.headers.get("retry-after", "30"))))
                except ValueError:
                    delay = 30
                state["until"] = time.monotonic() + delay
                return None
            if 400 <= resp.status_code < 500 and resp.status_code != 408:
                return None

        except (httpx.HTTPError, asyncio.TimeoutError) as e:
            state["status"] = type(e).__name__
            logger.warning(
                "[http_client] Request error for %s (attempt %d/%d): %s: %s",
                url, attempt, attempts, type(e).__name__, str(e),
            )

        if attempt < attempts:
            await asyncio.sleep(RETRY_DELAY * attempt / 1000.0)

    return None


async def safe_fetch_json(
    url: str,
    *,
    params: Optional[dict] = None,
    headers: Optional[dict] = None,
) -> Optional[dict]:
    """
    Fetch JSON from a URL with retry and timeout.

    Args:
        url: The URL to fetch.
        params: Query parameters.
        headers: Extra headers to merge with defaults.

    Returns:
        Parsed JSON dict or None on failure.
    """
    text = await safe_fetch(url, params=params, headers=headers)
    if text is None:
        return None

    try:
        import json
        return json.loads(text)
    except (json.JSONDecodeError, ValueError) as e:
        logger.warning("[http_client] Failed to parse JSON: %s", str(e))
        return None
