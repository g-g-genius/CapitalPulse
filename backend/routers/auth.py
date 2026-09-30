"""Registration, login, current-account, and logout API."""

from __future__ import annotations

import os
import re

from fastapi import APIRouter, Cookie, Depends, HTTPException, Response
from pydantic import BaseModel, Field

from services.auth_service import SESSION_SECONDS, EmailAlreadyExists, auth_service


router = APIRouter()
COOKIE_NAME = "capitalpulse_session"
EMAIL_PATTERN = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")


class RegisterRequest(BaseModel):
    display_name: str = Field(min_length=2, max_length=40)
    email: str = Field(min_length=3, max_length=254)
    password: str = Field(min_length=12, max_length=128)


class LoginRequest(BaseModel):
    email: str = Field(min_length=3, max_length=254)
    password: str = Field(min_length=1, max_length=128)


def _email(value: str) -> str:
    email = value.strip().casefold()
    if not EMAIL_PATTERN.fullmatch(email):
        raise HTTPException(status_code=422, detail="请输入有效的邮箱地址")
    return email


def _set_session_cookie(response: Response, token: str) -> None:
    response.set_cookie(
        key=COOKIE_NAME,
        value=token,
        max_age=SESSION_SECONDS,
        path="/",
        httponly=True,
        secure=os.getenv("COOKIE_SECURE", "false").strip().lower() in {"1", "true", "yes"},
        samesite="lax",
    )
    response.headers["Cache-Control"] = "no-store"


def require_admin(capitalpulse_session: str | None = Cookie(default=None)) -> dict:
    """Reusable server-side guard for future administrator APIs."""
    user = require_user(capitalpulse_session)
    if user["role"] != "admin":
        raise HTTPException(status_code=403, detail="需要管理员权限")
    return user


def require_user(capitalpulse_session: str | None = Cookie(default=None)) -> dict:
    user = auth_service.get_user_for_session(capitalpulse_session)
    if user is None:
        raise HTTPException(status_code=401, detail="尚未登录")
    return user


@router.post("/auth/register", status_code=201)
def register(payload: RegisterRequest, response: Response):
    email = _email(payload.email)
    display_name = payload.display_name.strip()
    if len(display_name) < 2:
        raise HTTPException(status_code=422, detail="昵称至少需要 2 个字符")
    try:
        user = auth_service.create_user(email, display_name, payload.password)
    except EmailAlreadyExists:
        raise HTTPException(status_code=409, detail="该邮箱已注册") from None
    token = auth_service.create_session(user["id"])
    _set_session_cookie(response, token)
    return {"code": 201, "msg": "registered", "data": user}


@router.post("/auth/login")
def login(payload: LoginRequest, response: Response):
    user = auth_service.authenticate(_email(payload.email), payload.password)
    if user is None:
        raise HTTPException(status_code=401, detail="邮箱或密码错误")
    token = auth_service.create_session(user["id"])
    _set_session_cookie(response, token)
    return {"code": 200, "msg": "logged in", "data": user}


@router.get("/auth/me")
def current_user(
    response: Response,
    capitalpulse_session: str | None = Cookie(default=None),
):
    user = auth_service.get_user_for_session(capitalpulse_session)
    if user is None:
        raise HTTPException(status_code=401, detail="尚未登录")
    response.headers["Cache-Control"] = "no-store"
    return {"code": 200, "msg": "success", "data": user}


@router.get("/auth/admin-check")
def admin_check(response: Response, user: dict = Depends(require_admin)):
    response.headers["Cache-Control"] = "no-store"
    return {"code": 200, "msg": "success", "data": user}


@router.post("/auth/logout")
def logout(response: Response, capitalpulse_session: str | None = Cookie(default=None)):
    auth_service.revoke_session(capitalpulse_session)
    response.delete_cookie(COOKIE_NAME, path="/")
    response.headers["Cache-Control"] = "no-store"
    return {"code": 200, "msg": "logged out", "data": None}
