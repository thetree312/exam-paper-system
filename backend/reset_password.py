#!/usr/bin/env python3
"""
重置指定用户ID的密码为新密码。
在本地开发阶段使用，用于重置忘记的密码。
"""

import sys
import os
import hashlib
import hmac
from typing import Tuple

# 添加backend路径到Python路径
backend_dir = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, backend_dir)

from app.db import SessionLocal
from app.models import User

# 复制auth.py中的哈希函数以确保兼容
_PBKDF2_PREFIX = "pbkdf2_sha256"
_PBKDF2_ITERATIONS = 390000
_PBKDF2_SALT_BYTES = 16
os.urandom(_PBKDF2_SALT_BYTES)

def _hash_password(password: str) -> str:
    salt = os.urandom(_PBKDF2_SALT_BYTES)
    derived = hashlib.pbkdf2_hmac(
        "sha256",
        password.encode("utf-8"),
        salt,
        _PBKDF2_ITERATIONS,
    )
    return f"{_PBKDF2_PREFIX}${_PBKDF2_ITERATIONS}${salt.hex()}${derived.hex()}"

def reset_password(user_id: int, new_password: str):
    try:
        session = SessionLocal()
        user = session.query(User).filter(User.id == user_id).first()

        if not user:
            print(f"用户ID {user_id} 不存在。")
            return

        # 使用PBKDF2哈希新密码
        user.password_hash = _hash_password(new_password)

        session.commit()
        session.close()

        print(f"用户ID {user_id} 的密码已重置为 '{new_password}'。")

    except Exception as e:
        print(f"重置失败: {e}")

if __name__ == "__main__":
    # 重置ID为2的用户密码为ABC12345678
    reset_password(2, "ABC12345678")
