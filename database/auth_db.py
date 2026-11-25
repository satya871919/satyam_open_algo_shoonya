# database/auth_db.py

import base64
import hashlib
import os
import sys
from dataclasses import dataclass

from argon2 import PasswordHasher
from argon2.exceptions import VerifyMismatchError
from cryptography.fernet import Fernet
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from sqlalchemy import (
    Boolean,
    Column,
    DateTime,
    Index,
    Integer,
    String,
    Text,
    create_engine,
    inspect,
    text,
)
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import scoped_session, sessionmaker
from sqlalchemy.pool import NullPool
from sqlalchemy.sql import func

from utils.logging import get_logger
from utils.thread_safe_cache import MISSING, LockedTTLCache

logger = get_logger(__name__)

# Initialize Argon2 hasher
ph = PasswordHasher()

# Default database URL
DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///db/openalgo.db")

# Security: Require API_KEY_PEPPER environment variable (fail fast if missing)
_pepper_value = os.getenv("API_KEY_PEPPER")
if not _pepper_value:
    raise RuntimeError(
        "CRITICAL: API_KEY_PEPPER environment variable is not set. "
        "This is required for secure password and API key hashing. "
        'Generate one using: python -c "import secrets; print(secrets.token_hex(32))"'
    )
if len(_pepper_value) < 32:
    raise RuntimeError(
        f"CRITICAL: API_KEY_PEPPER must be at least 32 characters (got {len(_pepper_value)}). "
        'Generate a secure pepper using: python -c "import secrets; print(secrets.token_hex(32))"'
    )
PEPPER = _pepper_value


def _resolve_fernet_salt() -> bytes:
    raw = (os.getenv("FERNET_SALT") or "").strip()
    if raw and len(raw) >= 32:
        try:
            return bytes.fromhex(raw)
        except ValueError:
            pass
    if not getattr(_resolve_fernet_salt, "_warned", False):
        sys.stderr.write(
            "[auth_db] WARNING: FERNET_SALT not set or invalid; using legacy\n"
            "static salt. Run the app once via app.py so utils/env_check.py\n"
            "auto-provisions a per-install salt.\n"
        )
        _resolve_fernet_salt._warned = True  # type: ignore[attr-defined]
    return b"openalgo_static_salt"


def get_encryption_key():
    """Generate a Fernet key from PEPPER + per-install FERNET_SALT."""
    kdf = PBKDF2HMAC(
        algorithm=hashes.SHA256(),
        length=32,
        salt=_resolve_fernet_salt(),
        iterations=100000,
    )
    key = base64.urlsafe_b64encode(kdf.derive(PEPPER.encode()))
    return Fernet(key)


fernet = get_encryption_key()


def get_session_based_cache_ttl():
    """Calculate cache TTL based on daily session expiry time in .env."""
    try:
        from datetime import datetime, timedelta

        import pytz

        expiry_time = os.getenv("SESSION_EXPIRY_TIME", "03:00")
        hour, minute = map(int, expiry_time.split(":"))

        now_utc = datetime.now(pytz.timezone("UTC"))
        now_ist = now_utc.astimezone(pytz.timezone("Asia/Kolkata"))

        today_expiry = now_ist.replace(hour=hour, minute=minute, second=0, microsecond=0)
        if now_ist >= today_expiry:
            today_expiry += timedelta(days=1)

        time_until_expiry = (today_expiry - now_ist).total_seconds()
        ttl_seconds = max(300, min(time_until_expiry, 24 * 3600))

        logger.debug(
            f"Auth cache TTL set to {ttl_seconds} seconds until session expiry at {today_expiry.strftime('%H:%M IST')}"
        )
        return int(ttl_seconds)

    except Exception as e:
        logger.warning(f"Could not calculate session-based cache TTL, using 5-minute default: {e}")
        return 300


# Thread-safe TTL caches
auth_cache = LockedTTLCache(maxsize=1024, ttl=get_session_based_cache_ttl())
feed_token_cache = LockedTTLCache(maxsize=1024, ttl=get_session_based_cache_ttl())
broker_cache = LockedTTLCache(maxsize=1024, ttl=3000)
verified_api_key_cache = LockedTTLCache(maxsize=1024, ttl=36000)
invalid_api_key_cache = LockedTTLCache(maxsize=512, ttl=300)
order_mode_cache = LockedTTLCache(maxsize=128, ttl=60)


def _generation(cache):
    return getattr(cache, "generation", None)


def _fill(cache, key, value, generation) -> None:
    fill = getattr(cache, "fill", None)
    if fill is not None and generation is not None:
        fill(key, value, generation)
    else:
        cache[key] = value


def _invalidate(cache, key) -> bool:
    invalidate = getattr(cache, "invalidate", None)
    if invalidate is None:
        return cache.pop(key, MISSING) is not MISSING
    with cache.lock:
        held = cache.get(key, MISSING) is not MISSING
        invalidate(key)
    return held


if DATABASE_URL and "sqlite" in DATABASE_URL:
    engine = create_engine(
        DATABASE_URL,
        poolclass=NullPool,
        connect_args={"check_same_thread": False, "timeout": 30},
    )
else:
    engine = create_engine(DATABASE_URL, pool_size=50, max_overflow=100, pool_timeout=10)

db_session = scoped_session(sessionmaker(autocommit=False, autoflush=False, bind=engine))
Base = declarative_base()
Base.query = db_session.query_property()


class Auth(Base):
    __tablename__ = "auth"
    id = Column(Integer, primary_key=True)
    name = Column(String(255), unique=True, nullable=False)
    auth = Column(Text, nullable=False)
    feed_token = Column(Text, nullable=True)
    broker = Column(String(20), nullable=False, default="shoonya")
    user_id = Column(String(255), nullable=True)
    is_revoked = Column(Boolean, default=False)

    # Generic auxiliary fields
    aux_param1 = Column(Text, nullable=True)
    aux_param2 = Column(Text, nullable=True)
    aux_param3 = Column(Text, nullable=True)
    aux_param4 = Column(Text, nullable=True)

    # Auto-login settings (Shoonya session persistence)
    autologin_enabled = Column(Boolean, default=False)

    __table_args__ = (
        Index("idx_auth_broker", "broker"),
        Index("idx_auth_user_id", "user_id"),
        Index("idx_auth_is_revoked", "is_revoked"),
    )


@dataclass(frozen=True, slots=True)
class AuthRecord:
    """Immutable copy of Auth columns for thread-safe caching."""

    name: str
    auth: str | None
    feed_token: str | None
    broker: str | None
    user_id: str | None
    is_revoked: bool

    @classmethod
    def from_row(cls, row) -> "AuthRecord":
        return cls(
            name=row.name,
            auth=row.auth,
            feed_token=row.feed_token,
            broker=row.broker,
            user_id=row.user_id,
            is_revoked=bool(row.is_revoked),
        )


def _as_record(value) -> AuthRecord | None:
    if isinstance(value, AuthRecord):
        return value
    if isinstance(value, Auth):
        return AuthRecord.from_row(value)
    return None


class ApiKeys(Base):
    __tablename__ = "api_keys"
    id = Column(Integer, primary_key=True)
    user_id = Column(String, nullable=False, unique=True)
    api_key_hash = Column(Text, nullable=False)
    api_key_encrypted = Column(Text, nullable=False)
    created_at = Column(DateTime(timezone=True), default=func.now())
    order_mode = Column(String(20), default="auto")

    __table_args__ = (
        Index("idx_api_keys_order_mode", "order_mode"),
        Index("idx_api_keys_created_at", "created_at"),
    )


class ActiveSession(Base):
    """Tracks active login sessions across devices for a user."""

    __tablename__ = "active_sessions"
    id = Column(Integer, primary_key=True)
    username = Column(String(255), nullable=False, index=True)
    session_id = Column(String(64), unique=True, nullable=False)
    device_info = Column(String(500), nullable=True)
    ip_address = Column(String(45), nullable=True)
    broker = Column(String(20), nullable=True)
    login_time = Column(DateTime(timezone=True), default=func.now())
    last_seen = Column(DateTime(timezone=True), default=func.now())

    __table_args__ = (Index("idx_active_sessions_username", "username"),)


class LoginAttempt(Base):
    """Records all login attempts (successful and failed) for security auditing."""

    __tablename__ = "login_attempts"
    id = Column(Integer, primary_key=True)
    username = Column(String(255), nullable=False)
    ip_address = Column(String(45), nullable=True)
    device_info = Column(String(500), nullable=True)
    status = Column(String(20), nullable=False)
    login_type = Column(String(20), nullable=True)
    broker = Column(String(20), nullable=True)
    failure_reason = Column(String(255), nullable=True)
    timestamp = Column(DateTime(timezone=True), default=func.now())

    __table_args__ = (
        Index("idx_login_attempts_username", "username"),
        Index("idx_login_attempts_timestamp", "timestamp"),
        Index("idx_login_attempts_status", "status"),
    )


def _now_ist():
    from datetime import datetime

    import pytz

    return datetime.now(pytz.timezone("Asia/Kolkata"))


def log_login_attempt(
    username,
    ip_address=None,
    device_info=None,
    status="failed",
    login_type="password",
    broker=None,
    failure_reason=None,
):
    """Record a login attempt for audit purposes."""
    try:
        attempt = LoginAttempt(
            username=username,
            ip_address=ip_address,
            device_info=device_info[:500] if device_info else None,
            status=status,
            login_type=login_type,
            broker=broker,
            failure_reason=failure_reason,
            timestamp=_now_ist(),
        )
        db_session.add(attempt)
        db_session.commit()
    except Exception as e:
        db_session.rollback()
        logger.error(f"Error logging login attempt: {e}")


def get_login_attempts(limit=100, status_filter=None):
    """Get recent login attempts, optionally filtered by status."""
    try:
        query = LoginAttempt.query.order_by(LoginAttempt.timestamp.desc())
        if status_filter:
            query = query.filter(LoginAttempt.status == status_filter)
        attempts = query.limit(limit).all()
        return [
            {
                "username": a.username,
                "ip_address": a.ip_address,
                "device_info": a.device_info,
                "status": a.status,
                "login_type": a.login_type,
                "broker": a.broker,
                "failure_reason": a.failure_reason,
                "timestamp": a.timestamp.isoformat() if a.timestamp else None,
            }
            for a in attempts
        ]
    except Exception as e:
        logger.error(f"Error getting login attempts: {e}")
        return []


def clear_login_attempts():
    """Clear all login attempt records."""
    try:
        LoginAttempt.query.delete()
        db_session.commit()
    except Exception as e:
        db_session.rollback()
        logger.error(f"Error clearing login attempts: {e}")


MAX_SESSIONS_PER_USER = 5


def register_session(username, session_id, device_info=None, ip_address=None, broker=None):
    """Register a new active session for a user."""
    try:
        if ip_address:
            ActiveSession.query.filter_by(username=username, ip_address=ip_address).delete()

        current_count = ActiveSession.query.filter_by(username=username).count()
        if current_count >= MAX_SESSIONS_PER_USER:
            oldest = (
                ActiveSession.query.filter_by(username=username)
                .order_by(ActiveSession.login_time.asc())
                .first()
            )
            if oldest:
                db_session.delete(oldest)

        now = _now_ist()
        active = ActiveSession(
            username=username,
            session_id=session_id,
            device_info=device_info,
            ip_address=ip_address,
            broker=broker,
            login_time=now,
            last_seen=now,
        )
        db_session.add(active)
        db_session.commit()
        return True
    except Exception as e:
        db_session.rollback()
        logger.error(f"Error registering session: {e}")
        return False


def remove_session(session_id):
    """Remove a session when user logs out."""
    try:
        ActiveSession.query.filter_by(session_id=session_id).delete()
        db_session.commit()
    except Exception as e:
        db_session.rollback()
        logger.error(f"Error removing session: {e}")


def get_active_sessions(username):
    """Get all active sessions for a user."""
    try:
        sessions = (
            ActiveSession.query.filter_by(username=username)
            .order_by(ActiveSession.last_seen.desc())
            .all()
        )
        return [
            {
                "session_id": s.session_id,
                "device_info": s.device_info,
                "ip_address": s.ip_address,
                "broker": s.broker,
                "login_time": s.login_time.isoformat() if s.login_time else None,
                "last_seen": s.last_seen.isoformat() if s.last_seen else None,
            }
            for s in sessions
        ]
    except Exception as e:
        logger.error(f"Error getting active sessions: {e}")
        return []


def update_session_last_seen(session_id):
    """Update last_seen timestamp for a session."""
    try:
        active = ActiveSession.query.filter_by(session_id=session_id).first()
        if active:
            active.last_seen = _now_ist()
            db_session.commit()
    except Exception as e:
        db_session.rollback()
        logger.error(f"Error updating session last_seen: {e}")


def clear_user_sessions(username):
    """Clear all sessions for a user."""
    try:
        ActiveSession.query.filter_by(username=username).delete()
        db_session.commit()
    except Exception as e:
        db_session.rollback()
        logger.error(f"Error clearing user sessions: {e}")


def init_db():
    """Initialize the authentication database tables."""
    from database.db_init_helper import init_db_with_logging

    init_db_with_logging(Base, engine, "Auth DB", logger)

    # Migration: add autologin_enabled column to existing auth table if missing
    try:
        inspector = inspect(engine)
        if inspector.has_table("auth"):
            existing_cols = {col["name"] for col in inspector.get_columns("auth")}
            if "autologin_enabled" not in existing_cols:
                with engine.connect() as conn:
                    conn.execute(
                        text("ALTER TABLE auth ADD COLUMN autologin_enabled BOOLEAN DEFAULT 0")
                    )
                    conn.commit()
                    logger.info("Added autologin_enabled column to auth table")
    except Exception as e:
        logger.warning(f"Could not add autologin_enabled column: {e}")


def safe_decrypt_token(value):
    """Decrypt a Fernet-encrypted value, falling back to the raw value if plaintext."""
    if not value:
        return None
    decrypted = decrypt_token(value)
    return decrypted if decrypted is not None else value


def encrypt_token(token):
    """Encrypt auth token."""
    if not token:
        return ""
    return fernet.encrypt(token.encode()).decode()


_decrypt_failure_fingerprints = LockedTTLCache(maxsize=256, ttl=3600)


def decrypt_token(encrypted_token):
    """Decrypt auth token."""
    if not encrypted_token:
        return ""
    try:
        return fernet.decrypt(encrypted_token.encode()).decode()
    except Exception as e:
        try:
            payload = (
                encrypted_token.encode()
                if isinstance(encrypted_token, str)
                else encrypted_token
            )
            fp = hashlib.blake2s(payload, digest_size=8).hexdigest()
        except Exception:
            fp = "unknown"

        with _decrypt_failure_fingerprints.lock:
            seen = fp in _decrypt_failure_fingerprints
            if not seen:
                _decrypt_failure_fingerprints[fp] = True

        if seen:
            logger.debug(f"Repeat decrypt failure (fingerprint={fp})")
        else:
            logger.exception(
                f"Error decrypting token (fingerprint={fp}): {e}. "
                "Re-authenticate Shoonya to overwrite stale ciphertext with a fresh token."
            )
        return None


def upsert_auth(
    name,
    auth_token,
    broker="shoonya",
    feed_token=None,
    user_id=None,
    revoke=False,
    autologin_enabled=None,
):
    """Store encrypted auth token and feed token, preserving auto-login setting unless explicitly passed."""
    encrypted_token = encrypt_token(auth_token)
    encrypted_feed_token = encrypt_token(feed_token) if feed_token else None

    auth_obj = Auth.query.filter_by(name=name).first()

    token_changed = True
    if auth_obj is not None:
        try:
            prev_token = decrypt_token(auth_obj.auth) if auth_obj.auth else None
        except Exception:
            prev_token = None
        try:
            prev_feed = decrypt_token(auth_obj.feed_token) if auth_obj.feed_token else None
        except Exception:
            prev_feed = None
        token_changed = (
            prev_token != auth_token
            or prev_feed != feed_token
            or auth_obj.broker != broker
            or bool(auth_obj.is_revoked) != bool(revoke)
        )

    # Determine effective autologin_enabled flag without clobbering existing state
    if autologin_enabled is not None:
        effective_autologin = bool(autologin_enabled)
    elif auth_obj is not None:
        effective_autologin = bool(auth_obj.autologin_enabled)
    else:
        effective_autologin = broker == "shoonya"

    try:
        if auth_obj:
            auth_obj.auth = encrypted_token
            auth_obj.feed_token = encrypted_feed_token
            auth_obj.broker = broker
            if user_id is not None:
                auth_obj.user_id = user_id
            auth_obj.is_revoked = revoke
            auth_obj.autologin_enabled = effective_autologin
        else:
            auth_obj = Auth(
                name=name,
                auth=encrypted_token,
                feed_token=encrypted_feed_token,
                broker=broker,
                user_id=user_id,
                is_revoked=revoke,
                autologin_enabled=effective_autologin,
            )
            db_session.add(auth_obj)
        db_session.commit()
    except Exception:
        db_session.rollback()
        raise

    # Clear caches after commit
    auth_cache.clear()
    feed_token_cache.clear()
    broker_cache.clear()
    logger.info(f"Cleared all auth caches after token update for user: {name}")

    if not (token_changed or revoke):
        logger.info(
            f"Broker token unchanged for {name} (multi-session resume) — "
            f"preserving live WebSocket feed, skipping pool teardown"
        )
        return auth_obj.id

    try:
        from database.cache_invalidation import publish_all_cache_invalidation

        publish_all_cache_invalidation(name)
        logger.debug(f"Published cache invalidation for user: {name}")
    except Exception as e:
        logger.warning(f"Failed to publish cache invalidation for user {name}: {e}")

    try:
        from websocket_proxy.broker_factory import cleanup_pools_for_user

        cleanup_pools_for_user(name, broker_name=broker)
    except Exception as e:
        logger.warning(f"Failed to invalidate WS adapter pool for {name}/{broker}: {e}")

    try:
        from services.order_update_service import (
            start_order_update_adapter,
            stop_order_update_adapter,
        )

        if revoke:
            stop_order_update_adapter(name)
        else:
            start_order_update_adapter(name, broker)
    except Exception as e:
        logger.warning(f"Order-update adapter lifecycle failed for {name}/{broker}: {e}")

    return auth_obj.id


def get_auth_token(name, bypass_cache: bool = False):
    """Get decrypted auth token."""
    if not name:
        logger.debug("get_auth_token called with empty/None name, returning None")
        return None

    cache_key = f"auth-{name}"

    if bypass_cache:
        logger.debug(f"Bypassing cache for user: {name} (fresh token requested)")
        auth_cache.pop(cache_key, None)
        generation = _generation(auth_cache)
        auth_obj = get_auth_token_dbquery(name)
        if isinstance(auth_obj, Auth) and auth_obj.is_revoked is not True:
            record = AuthRecord.from_row(auth_obj)
            _fill(auth_cache, cache_key, record, generation)
            return decrypt_token(record.auth)
        return None

    cached = auth_cache.get(cache_key, MISSING)
    if cached is not MISSING and cached is not None:
        record = _as_record(cached)
        if record is not None and record.is_revoked is not True:
            return decrypt_token(record.auth)
        auth_cache.pop(cache_key, None)
        return None

    generation = _generation(auth_cache)
    auth_obj = get_auth_token_dbquery(name)
    if isinstance(auth_obj, Auth) and auth_obj.is_revoked is not True:
        record = AuthRecord.from_row(auth_obj)
        _fill(auth_cache, cache_key, record, generation)
        return decrypt_token(record.auth)
    return None


def get_auth_token_fresh(name):
    """Get fresh auth token directly from database, bypassing cache."""
    return get_auth_token(name, bypass_cache=True)


def get_auth_token_dbquery(name):
    """Fetch the auth token record directly from the database."""
    try:
        if not name:
            logger.debug("get_auth_token_dbquery called with empty/None name")
            return None

        auth_obj = Auth.query.filter_by(name=name).first()
        if auth_obj and not auth_obj.is_revoked:
            return auth_obj
        if name:
            logger.warning(f"No valid auth token found for name '{name}'.")
        return None
    except Exception as e:
        logger.exception(f"Error while querying the database for auth token: {e}")
        return None


def get_feed_token(name):
    """Get the feed token for a user."""
    if not name:
        logger.debug("get_feed_token called with empty/None name, returning None")
        return None

    cache_key = f"feed-{name}"
    cached = feed_token_cache.get(cache_key, MISSING)
    if cached is not MISSING and cached is not None:
        record = _as_record(cached)
        if record is not None and record.is_revoked is not True:
            return decrypt_token(record.feed_token) if record.feed_token else None
        feed_token_cache.pop(cache_key, None)
        return None

    generation = _generation(feed_token_cache)
    auth_obj = get_feed_token_dbquery(name)
    if isinstance(auth_obj, Auth) and auth_obj.is_revoked is not True:
        record = AuthRecord.from_row(auth_obj)
        _fill(feed_token_cache, cache_key, record, generation)
        return decrypt_token(record.feed_token) if record.feed_token else None
    return None


def get_feed_token_dbquery(name):
    """Fetch the feed token record directly from the database."""
    try:
        if not name:
            logger.debug("get_feed_token_dbquery called with empty/None name")
            return None

        auth_obj = Auth.query.filter_by(name=name).first()
        if auth_obj is None or auth_obj.is_revoked is True:
            if name:
                logger.warning(f"No valid feed token found for name '{name}'.")
            return None
        return auth_obj
    except Exception as e:
        logger.exception(f"Error while querying the database for feed token: {e}")
        return None


def get_user_id(name):
    """Get the stored Shoonya user_id for a user."""
    try:
        if not name:
            logger.debug("get_user_id called with empty/None name")
            return None

        auth_obj = Auth.query.filter_by(name=name).first()
        if auth_obj is None or auth_obj.is_revoked is True:
            if name:
                logger.warning(f"No valid user_id found for name '{name}'.")
            return None
        return auth_obj.user_id
    except Exception as e:
        logger.exception(f"Error while querying the database for user_id: {e}")
        return None


def invalidate_user_cache(user_id):
    """Invalidate all cached data for a user when their credentials change."""
    auth_cache.clear()
    broker_cache.clear()
    feed_token_cache.clear()
    verified_api_key_cache.clear()
    invalid_api_key_cache.clear()
    order_mode_cache.clear()
    logger.info(f"Cleared all caches for user_id: {user_id}")


def invalidate_user_auth_cache(name) -> list[str]:
    """Drop one user's cached broker and feed tokens."""
    cleared = []
    try:
        if _invalidate(auth_cache, f"auth-{name}"):
            cleared.append("auth_cache")
        if _invalidate(feed_token_cache, f"feed-{name}"):
            cleared.append("feed_token_cache")
    except Exception:
        logger.exception(f"Could not clear the cached broker session for {name}")
    return cleared


def upsert_api_key(user_id, api_key):
    """Store both hashed and encrypted API key."""
    peppered_key = api_key + PEPPER
    hashed_key = ph.hash(peppered_key)
    encrypted_key = encrypt_token(api_key)

    try:
        api_key_obj = ApiKeys.query.filter_by(user_id=user_id).first()
        if api_key_obj:
            api_key_obj.api_key_hash = hashed_key
            api_key_obj.api_key_encrypted = encrypted_key
        else:
            api_key_obj = ApiKeys(
                user_id=user_id, api_key_hash=hashed_key, api_key_encrypted=encrypted_key
            )
            db_session.add(api_key_obj)
        db_session.commit()
    except Exception:
        db_session.rollback()
        raise

    invalidate_user_cache(user_id)
    return api_key_obj.id


def get_api_key(user_id):
    """Check if user has an API key."""
    try:
        api_key_obj = ApiKeys.query.filter_by(user_id=user_id).first()
        return api_key_obj is not None
    except Exception as e:
        logger.exception(f"Error while querying the database for API key: {e}")
        return None


def get_api_key_for_tradingview(user_id):
    """Get decrypted API key for TradingView configuration."""
    try:
        api_key_obj = ApiKeys.query.filter_by(user_id=user_id).first()
        if api_key_obj and api_key_obj.api_key_encrypted:
            return decrypt_token(api_key_obj.api_key_encrypted)
        return None
    except Exception as e:
        logger.exception(f"Error while querying the database for API key: {e}")
        return None


def get_first_available_api_key():
    """Get the first available decrypted API key for a user with an active session."""
    try:
        api_keys = ApiKeys.query.all()
        for api_key_obj in api_keys:
            if not api_key_obj.api_key_encrypted:
                continue
            auth_obj = Auth.query.filter_by(name=api_key_obj.user_id).first()
            if auth_obj and not auth_obj.is_revoked and auth_obj.broker:
                return decrypt_token(api_key_obj.api_key_encrypted)
        return None
    except Exception as e:
        logger.exception(f"Error getting first available API key: {e}")
        return None


def verify_api_key(provided_api_key):
    """Verify an API key using Argon2 with caching."""
    from flask import has_request_context

    from database.traffic_db import InvalidAPIKeyTracker
    from utils.ip_helper import get_real_ip

    cache_key = hashlib.sha256(provided_api_key.encode()).hexdigest()

    if invalid_api_key_cache.get(cache_key, MISSING) is not MISSING:
        logger.debug("API key rejected from invalid cache")
        return None

    cached_user_id = verified_api_key_cache.get(cache_key, MISSING)
    if cached_user_id is not MISSING:
        logger.debug(f"API key verified from cache for user_id: {cached_user_id}")
        return cached_user_id

    verified_generation = _generation(verified_api_key_cache)
    invalid_generation = _generation(invalid_api_key_cache)
    peppered_key = provided_api_key + PEPPER
    try:
        api_keys = ApiKeys.query.all()
        for api_key_obj in api_keys:
            try:
                ph.verify(api_key_obj.api_key_hash, peppered_key)
                _fill(verified_api_key_cache, cache_key, api_key_obj.user_id, verified_generation)
                logger.debug(f"API key verified and cached for user_id: {api_key_obj.user_id}")
                return api_key_obj.user_id
            except VerifyMismatchError:
                continue

        _fill(invalid_api_key_cache, cache_key, True, invalid_generation)
        logger.debug("Invalid API key cached")

        try:
            client_ip = get_real_ip() if has_request_context() else "127.0.0.1"
            api_key_hash = hashlib.sha256(provided_api_key.encode()).hexdigest()[:16]
            InvalidAPIKeyTracker.track_invalid_api_key(client_ip, api_key_hash)
        except Exception as track_error:
            logger.warning(f"Could not track invalid API key attempt: {track_error}")

        return None
    except Exception as e:
        logger.exception(f"Error verifying API key: {e}")
        return None


def get_username_by_apikey(provided_api_key):
    """Get username for a given API key."""
    return verify_api_key(provided_api_key)


def get_broker_name(provided_api_key):
    """Get the broker name for a valid API key with caching."""
    cached_broker = broker_cache.get(provided_api_key, MISSING)
    if cached_broker is not MISSING:
        return cached_broker

    generation = _generation(broker_cache)
    user_id = verify_api_key(provided_api_key)

    if user_id:
        try:
            auth_obj = Auth.query.filter_by(name=user_id).first()
            if auth_obj and not auth_obj.is_revoked:
                _fill(broker_cache, provided_api_key, auth_obj.broker, generation)
                return auth_obj.broker
            logger.warning(f"No valid broker found for user_id '{user_id}'.")
            return None
        except Exception as e:
            logger.exception(f"Error while querying the database for broker name: {e}")
            return None
    return None


def get_auth_token_broker(provided_api_key, include_feed_token=False):
    """Get auth token, feed token (optional), and broker for a valid API key."""
    cache_key = f"{hashlib.sha256(provided_api_key.encode()).hexdigest()}_{include_feed_token}"

    cached_result = auth_cache.get(cache_key)
    if cached_result is not None:
        user_id = verify_api_key(provided_api_key)
        if user_id:
            try:
                auth_obj = Auth.query.filter_by(name=user_id).first()
                if auth_obj and auth_obj.is_revoked:
                    auth_cache.pop(cache_key, None)
                    logger.warning(f"Cached auth token was revoked for user_id '{user_id}'.")
                    return (None, None, None) if include_feed_token else (None, None)
                logger.debug(f"Auth token retrieved from cache for user_id: {user_id}")
                return cached_result
            except Exception as e:
                logger.exception(f"Error checking revocation status: {e}")
                auth_cache.pop(cache_key, None)

    generation = _generation(auth_cache)
    user_id = verify_api_key(provided_api_key)

    if user_id:
        try:
            auth_obj = Auth.query.filter_by(name=user_id).first()
            if auth_obj and not auth_obj.is_revoked:
                decrypted_token = decrypt_token(auth_obj.auth)
                if include_feed_token:
                    decrypted_feed_token = (
                        decrypt_token(auth_obj.feed_token) if auth_obj.feed_token else None
                    )
                    result = (decrypted_token, decrypted_feed_token, auth_obj.broker)
                else:
                    result = (decrypted_token, auth_obj.broker)

                _fill(auth_cache, cache_key, result, generation)
                logger.debug(f"Auth token cached for user_id: {user_id}")
                return result

            negative_result = (None, None, None) if include_feed_token else (None, None)
            _fill(auth_cache, cache_key, negative_result, generation)
            logger.warning(
                f"No valid auth token or broker found for user_id '{user_id}'. Cached negative result."
            )
            return negative_result
        except Exception as e:
            logger.exception(f"Error while querying the database for auth token and broker: {e}")
            return (None, None, None) if include_feed_token else (None, None)
    return (None, None, None) if include_feed_token else (None, None)


def get_order_mode(user_id):
    """Get the order mode for a user ('auto' or 'semi_auto')."""
    cached_mode = order_mode_cache.get(user_id)
    if cached_mode is not None:
        return cached_mode

    generation = _generation(order_mode_cache)
    try:
        api_key_obj = ApiKeys.query.filter_by(user_id=user_id).first()
        mode = api_key_obj.order_mode if api_key_obj and api_key_obj.order_mode else "auto"
        _fill(order_mode_cache, user_id, mode, generation)
        return mode
    except Exception as e:
        logger.exception(f"Error getting order mode for user {user_id}: {e}")
        return "auto"


def update_order_mode(user_id, mode):
    """Update the order mode for a user."""
    try:
        if mode not in ["auto", "semi_auto"]:
            logger.error(f"Invalid order mode: {mode}")
            return False

        api_key_obj = ApiKeys.query.filter_by(user_id=user_id).first()
        if api_key_obj:
            api_key_obj.order_mode = mode
            db_session.commit()
            invalidate_user_cache(user_id)
            logger.info(f"Order mode updated to '{mode}' for user: {user_id}")
            return True

        logger.error(f"No API key found for user: {user_id}")
        return False
    except Exception as e:
        logger.exception(f"Error updating order mode: {e}")
        db_session.rollback()
        return False


# ============================================================================
# Auto-login Session Persistence Functions (Shoonya)
# ============================================================================


def enable_autologin(name):
    """Enable Shoonya auto-login session persistence for a user."""
    try:
        auth_obj = Auth.query.filter_by(name=name).first()
        if auth_obj and auth_obj.is_revoked is not True:
            auth_obj.autologin_enabled = True
            db_session.commit()
            logger.info(f"Shoonya auto-login enabled for user: {name}")
            return True
        logger.warning(f"Cannot enable auto-login: no valid auth record for user: {name}")
        return False
    except Exception as e:
        db_session.rollback()
        logger.exception(f"Error enabling auto-login for {name}: {e}")
        return False


def disable_autologin(name):
    """Disable Shoonya auto-login session persistence for a user."""
    try:
        auth_obj = Auth.query.filter_by(name=name).first()
        if auth_obj:
            auth_obj.autologin_enabled = False
            db_session.commit()
            logger.info(f"Shoonya auto-login disabled for user: {name}")
            return True
        return False
    except Exception as e:
        db_session.rollback()
        logger.exception(f"Error disabling auto-login for {name}: {e}")
        return False


def is_autologin_enabled(name):
    """Check if auto-login is enabled for a user."""
    try:
        if not name:
            return False
        auth_obj = Auth.query.filter_by(name=name).first()
        if auth_obj is None or auth_obj.is_revoked is True:
            return False
        return auth_obj.autologin_enabled is True
    except Exception as e:
        logger.exception(f"Error checking auto-login status for {name}: {e}")
        return False


def get_broker_session(name):
    """Get broker session details for auto-login: (auth_token, feed_token, broker, is_revoked)."""
    try:
        if not name:
            return None

        auth_obj = Auth.query.filter_by(name=name).first()
        if auth_obj is None or auth_obj.is_revoked is True:
            return None

        decrypted_token = decrypt_token(auth_obj.auth) if auth_obj.auth else None
        decrypted_feed = decrypt_token(auth_obj.feed_token) if auth_obj.feed_token else None
        return (decrypted_token, decrypted_feed, auth_obj.broker, False)
    except Exception as e:
        logger.exception(f"Error getting broker session for {name}: {e}")
        return None


def _get_active_trading_session_details(name):
    """Return (login_dt_ist, session_id) for the newest active session in the current trading day.

    Returns None when the user has no active session since the latest daily
    rollover (default 03:00 IST), which means any stored broker token belongs to
    a previous trading day and has expired on the broker side.
    """
    from datetime import datetime

    import pytz

    from utils.session import get_trading_session_start, is_session_expiry_disabled

    ist = pytz.timezone("Asia/Kolkata")
    sessions = (
        ActiveSession.query.filter_by(username=name)
        .order_by(ActiveSession.login_time.desc())
        .all()
    )

    if is_session_expiry_disabled():
        if sessions and sessions[0].login_time:
            dt = sessions[0].login_time
            if dt.tzinfo is None:
                dt = ist.localize(dt)
            return dt, sessions[0].session_id
        return _now_ist(), None

    session_start = get_trading_session_start()
    for sess in sessions:
        raw = sess.login_time
        if not raw:
            continue
        login_dt = datetime.fromisoformat(raw) if isinstance(raw, str) else raw
        if login_dt.tzinfo is None:
            login_dt = ist.localize(login_dt)
        if login_dt >= session_start:
            return login_dt, sess.session_id

    return None


def get_autologin_session(broker="shoonya"):
    """Find the active, non-revoked session with autologin_enabled=True for the current trading day."""
    try:
        auth_obj = (
            Auth.query.filter_by(broker=broker, is_revoked=False, autologin_enabled=True)
            .order_by(Auth.id.desc())
            .first()
        )
        if not auth_obj or not auth_obj.auth:
            return None

        decrypted_token = decrypt_token(auth_obj.auth)
        if not decrypted_token:
            return None

        active_info = _get_active_trading_session_details(auth_obj.name)
        if active_info is None:
            logger.info(
                f"Stored {broker} auto-login session for '{auth_obj.name}' is from a previous "
                "trading day (expired at daily rollover); revoking stale session"
            )
            try:
                upsert_auth(auth_obj.name, "", broker=broker, revoke=True)
                clear_user_sessions(auth_obj.name)
            except Exception as revoke_err:
                logger.warning(f"Could not revoke stale auto-login session: {revoke_err}")
            return None

        login_dt, session_id = active_info

        return {
            "name": auth_obj.name,
            "user_id": auth_obj.user_id,
            "broker": auth_obj.broker,
            "auth_token": decrypted_token,
            "feed_token": decrypt_token(auth_obj.feed_token) if auth_obj.feed_token else None,
            "login_time": login_dt.isoformat(),
            "session_id": session_id,
        }
    except Exception as e:
        logger.exception(f"Error fetching auto-login session for broker '{broker}': {e}")
        return None