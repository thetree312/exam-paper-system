from fastapi import APIRouter, Depends, HTTPException
from sqlalchemy.orm import Session

from ..db import get_db
from ..models import Tenant, User
from ..schemas import AuthResponse, LoginRequest, RegisterRequest, UserOut
from ..utils.rate_limiter import rate_limit

import hashlib
import hmac
import os
from typing import Optional, Tuple


router = APIRouter(prefix="/api/auth", tags=["auth"])


_PBKDF2_PREFIX = "pbkdf2_sha256"
_PBKDF2_ITERATIONS = 390000
_PBKDF2_SALT_BYTES = 16


def _hash_password(password: str) -> str:
    salt = os.urandom(_PBKDF2_SALT_BYTES)
    derived = hashlib.pbkdf2_hmac(
        "sha256",
        password.encode("utf-8"),
        salt,
        _PBKDF2_ITERATIONS,
    )
    return f"{_PBKDF2_PREFIX}${_PBKDF2_ITERATIONS}${salt.hex()}${derived.hex()}"


def _hash_password_legacy(password: str) -> str:
    """Legacy single-round SHA256 hash (no salt) kept for verification only."""
    return hashlib.sha256(password.encode("utf-8")).hexdigest()


def _is_pbkdf2_hash(stored_hash: str) -> bool:
    return stored_hash.startswith(f"{_PBKDF2_PREFIX}$")


def _verify_password(password: str, stored_hash: str) -> Tuple[bool, bool]:
    """Return (is_valid, needs_upgrade)."""
    if _is_pbkdf2_hash(stored_hash):
        try:
            _, iter_str, salt_hex, derived_hex = stored_hash.split("$", 3)
            iterations = int(iter_str)
            salt = bytes.fromhex(salt_hex)
            expected = bytes.fromhex(derived_hex)
        except (ValueError, TypeError):
            return False, True

        computed = hashlib.pbkdf2_hmac(
            "sha256", password.encode("utf-8"), salt, iterations
        )
        is_valid = hmac.compare_digest(computed, expected)
        needs_upgrade = iterations < _PBKDF2_ITERATIONS
        return is_valid, needs_upgrade

    # Fallback to legacy SHA256 hashes so existing accounts continue工作
    legacy_hash = _hash_password_legacy(password)
    return hmac.compare_digest(legacy_hash, stored_hash), True


def _build_user_out(user: User) -> UserOut:
    return UserOut(
        id=user.id,
        tenant_id=user.tenant_id,
        email=user.email,
        display_name=user.display_name,
    )


register_rate_limit = rate_limit("auth-register", limit=5, window_seconds=60)
login_rate_limit = rate_limit("auth-login", limit=10, window_seconds=60)


@router.post("/register", response_model=AuthResponse, dependencies=[Depends(register_rate_limit)])
def register(payload: RegisterRequest, db: Session = Depends(get_db)):
    tenant = (
        db.query(Tenant)
        .filter(Tenant.code == payload.tenant_code)
        .one_or_none()
    )
    if tenant is None:
        # 开发阶段：若传入租户不存在，则自动创建
        name: str = payload.tenant_name or payload.tenant_code
        tenant = Tenant(name=name, code=payload.tenant_code, status=1)
        db.add(tenant)
        db.flush()

    existing = (
        db.query(User)
        .filter(User.tenant_id == tenant.id, User.email == payload.email)
        .one_or_none()
    )
    if existing is not None:
        raise HTTPException(status_code=400, detail="该邮箱已注册")

    display_name: str = payload.display_name or payload.email.split("@")[0]
    user = User(
        tenant_id=tenant.id,
        email=payload.email,
        password_hash=_hash_password(payload.password),
        display_name=display_name,
        role="admin" if tenant.code == "default" else "member",
        status=1,
    )
    db.add(user)
    db.commit()
    db.refresh(user)

    return AuthResponse(user=_build_user_out(user))


@router.post("/login", response_model=AuthResponse, dependencies=[Depends(login_rate_limit)])
def login(payload: LoginRequest, db: Session = Depends(get_db)):
    print(f"[DEBUG] Login attempt: tenant_code={payload.tenant_code}, email={payload.email}")

    tenant = (
        db.query(Tenant)
        .filter(Tenant.code == payload.tenant_code)
        .one_or_none()
    )
    if tenant is None:
        print(f"[DEBUG] Tenant not found: {payload.tenant_code}")
        raise HTTPException(status_code=400, detail="租户不存在")

    print(f"[DEBUG] Tenant found: id={tenant.id}, code={tenant.code}, name={tenant.name}")

    user = (
        db.query(User)
        .filter(User.tenant_id == tenant.id, User.email == payload.email)
        .one_or_none()
    )
    if user is None:
        print(f"[DEBUG] User not found: email={payload.email}, tenant_id={tenant.id}")
        raise HTTPException(status_code=400, detail="邮箱或密码错误")

    print(f"[DEBUG] User found: id={user.id}, email={user.email}, password_hash={user.password_hash[:10]}...")

    is_valid, needs_upgrade = _verify_password(payload.password, user.password_hash)
    print(f"[DEBUG] Password validation: is_valid={is_valid}, needs_upgrade={needs_upgrade}")

    if not is_valid:
        print(f"[DEBUG] Password invalid for user {user.id}")
        raise HTTPException(status_code=400, detail="邮箱或密码错误")

    if needs_upgrade:
        print(f"[DEBUG] Upgrading password hash for user {user.id}")
        user.password_hash = _hash_password(payload.password)
        db.add(user)
        db.commit()
        db.refresh(user)

    print(f"[DEBUG] Login successful for user {user.id}")
    return AuthResponse(user=_build_user_out(user))
