"""Password hashing and the session cookie (a signed JWT)."""
import os
from datetime import timedelta

import bcrypt
import jwt
from fastapi import Depends, HTTPException, Request

from .db import Session, User, now

SECRET = os.environ.get("SECRET_KEY", "change-me-in-production")
COOKIE = "studio_session"
LIFETIME = timedelta(days=7)


def hash_password(password: str) -> str:
    return bcrypt.hashpw(password.encode(), bcrypt.gensalt()).decode()


def check_password(password: str, hashed: str) -> bool:
    return bcrypt.checkpw(password.encode(), hashed.encode())


def make_token(user: User) -> str:
    return jwt.encode({"sub": str(user.id), "exp": now() + LIFETIME}, SECRET, algorithm="HS256")


def current_user(request: Request) -> User:
    token = request.cookies.get(COOKIE)
    if not token:
        raise HTTPException(401, "not signed in")
    try:
        uid = int(jwt.decode(token, SECRET, algorithms=["HS256"])["sub"])
    except Exception:
        raise HTTPException(401, "session expired")
    with Session() as s:
        user = s.get(User, uid)
    if not user:
        raise HTTPException(401, "unknown user")
    return user


def admin_user(user: User = Depends(current_user)) -> User:
    if user.role != "admin":
        raise HTTPException(403, "admins only")
    return user


def is_staff(user: User) -> bool:
    """Admins and managers: they run the datasets, the users and the issues."""
    return user.role in ("admin", "manager")


def staff_user(user: User = Depends(current_user)) -> User:
    if not is_staff(user):
        raise HTTPException(403, "admins and managers only")
    return user


def seed_admin():
    """Create the default admin (admin / admin) when there are no users yet."""
    with Session() as s:
        if not s.query(User).count():
            s.add(User(username="admin", password_hash=hash_password("admin"), role="admin"))
            s.commit()
