"""Password hashing and the session cookie (a signed JWT)."""
import os
import secrets
from datetime import timedelta
from functools import cache
from pathlib import Path

import bcrypt
import jwt
from fastapi import Depends, HTTPException, Request

from .db import Session, User, engine, now

COOKIE = "studio_session"
LIFETIME = timedelta(days=7)
MIN_PASSWORD = 8


@cache
def secret() -> str:
    """The key signing the sessions: SECRET_KEY, else one generated once and kept next to the
    database (so no known default ever signs anything, and restarts keep everyone signed in)."""
    if os.environ.get("SECRET_KEY"):
        return os.environ["SECRET_KEY"]
    path = Path(engine.url.database or ".").resolve().parent / "secret_key"
    if not path.exists():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(secrets.token_urlsafe(48))
        path.chmod(0o600)
    return path.read_text().strip()


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()


def check_password(password: str, hashed: str) -> bool:
    return bcrypt.checkpw(password.encode(), hashed.encode())


def valid_password(password: str):
    if len(password) < MIN_PASSWORD:
        raise HTTPException(400, f"the password needs at least {MIN_PASSWORD} characters")


# pw: a piece of the password hash, so that a new password ends the sessions opened with the old one
def make_token(user: User) -> str:
    return jwt.encode({"sub": str(user.id), "pw": user.password_hash[-12:], "exp": now() + LIFETIME}, secret(), algorithm="HS256")


def current_user(request: Request) -> User:
    token = request.cookies.get(COOKIE)
    if not token:
        raise HTTPException(401, "not signed in")
    try:
        claims = jwt.decode(token, secret(), algorithms=["HS256"])
        uid = int(claims["sub"])
    except Exception:
        raise HTTPException(401, "session expired")
    with Session() as s:
        user = s.get(User, uid)
    if not user or claims.get("pw") != user.password_hash[-12:]:
        raise HTTPException(401, "session expired")
    return user


def admin_user(user: User = Depends(current_user)) -> User:
    if user.role != "admin":
        raise HTTPException(403, "admins only")
    return user


def is_staff(user: User) -> bool:
    """Admins and managers: they run the batches, the campaigns, the users and the issues."""
    return user.role in ("admin", "manager")


def staff_user(user: User = Depends(current_user)) -> User:
    if not is_staff(user):
        raise HTTPException(403, "admins and managers only")
    return user


def seed_admin():
    """The first admin, when there are no users yet: user admin, password ADMIN_PASSWORD, else a random
    one printed once in the logs (change it on the Admin page)."""
    with Session() as s:
        if s.query(User).count():
            return
        password = os.environ.get("ADMIN_PASSWORD") or secrets.token_urlsafe(12)
        s.add(User(username="admin", password_hash=hash_password(password), role="admin"))
        s.commit()
    if not os.environ.get("ADMIN_PASSWORD"):
        print(f"Studio: first admin account created: admin / {password} (change it on the Admin page)", flush=True)
