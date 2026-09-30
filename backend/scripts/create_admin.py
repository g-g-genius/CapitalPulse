"""Provision one administrator for the configured database without printing its password."""

from __future__ import annotations

import argparse
import re
import secrets
import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(BACKEND_DIR))

from services.auth_service import AuthService, EmailAlreadyExists  # noqa: E402


DEFAULT_CREDENTIALS = BACKEND_DIR / "data" / "admin-credentials.txt"
EMAIL_PATTERN = re.compile(r"^[^\s@]+@[^\s@]+\.[^\s@]+$")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--email", default="admin@capitalpulse.local")
    parser.add_argument("--display-name", default="管理员")
    parser.add_argument("--credentials-file", type=Path, default=DEFAULT_CREDENTIALS)
    args = parser.parse_args()

    email = args.email.strip().casefold()
    display_name = args.display_name.strip()
    if not EMAIL_PATTERN.fullmatch(email):
        parser.error("--email must be a valid email address")
    if not 2 <= len(display_name) <= 40:
        parser.error("--display-name must have 2-40 characters")

    credentials_file = args.credentials_file.expanduser().resolve()
    credentials_file.parent.mkdir(parents=True, exist_ok=True)
    password = secrets.token_urlsafe(32)
    service = AuthService()
    service.ensure_schema()

    # Reserve the file first so an existing credential file cannot be overwritten.
    with credentials_file.open("x", encoding="utf-8") as output:
        output.write(f"邮箱: {email}\n密码: {password}\n")
    try:
        service.create_admin(email, display_name, password)
    except Exception:
        credentials_file.unlink(missing_ok=True)
        raise

    print(f"Administrator created: {email}")
    print(f"Credentials saved to: {credentials_file}")
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except EmailAlreadyExists:
        raise SystemExit("Administrator email already exists; no account was changed") from None
