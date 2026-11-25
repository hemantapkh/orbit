import base64
import hashlib
import secrets
from datetime import timedelta

import jwt
from cryptography.fernet import Fernet
from pwdlib import PasswordHash

from app.core.config import get_settings
from app.core.db import utcnow

_password_hash = PasswordHash.recommended()
_JWT_ALG = "HS256"
API_KEY_PREFIX = "orb_"


def hash_password(password: str) -> str:
    return _password_hash.hash(password)


def verify_password(password: str, hashed: str) -> bool:
    return _password_hash.verify(password, hashed)


def create_session_token(user_id: int) -> str:
    settings = get_settings()
    payload = {"sub": str(user_id), "exp": utcnow() + timedelta(hours=settings.session_ttl_hours)}
    return jwt.encode(payload, settings.secret_key, algorithm=_JWT_ALG)


def decode_session_token(token: str) -> int | None:
    try:
        payload = jwt.decode(token, get_settings().secret_key, algorithms=[_JWT_ALG])
        return int(payload["sub"])
    except (jwt.PyJWTError, KeyError, ValueError):
        return None


def _fernet() -> Fernet:
    digest = hashlib.sha256(("fernet:" + get_settings().secret_key).encode()).digest()
    return Fernet(base64.urlsafe_b64encode(digest))


def encrypt_secret(value: str) -> str:
    return _fernet().encrypt(value.encode()).decode()


def decrypt_secret(value: str) -> str:
    return _fernet().decrypt(value.encode()).decode()


def generate_api_key() -> tuple[str, str, str]:
    """Return (plaintext key, sha256 hash, display prefix)."""
    key = API_KEY_PREFIX + secrets.token_urlsafe(32)
    return key, hash_api_key(key), key[: len(API_KEY_PREFIX) + 6]


def hash_api_key(key: str) -> str:
    return hashlib.sha256(key.encode()).hexdigest()
