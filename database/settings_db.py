# database/settings_db.py

import base64
import os
from typing import Any

from cryptography.fernet import Fernet, InvalidToken
from cryptography.hazmat.primitives import hashes
from cryptography.hazmat.primitives.kdf.pbkdf2 import PBKDF2HMAC
from sqlalchemy import Boolean, Column, Integer, String, Text, create_engine
from sqlalchemy.ext.declarative import declarative_base
from sqlalchemy.orm import scoped_session, sessionmaker
from sqlalchemy.pool import NullPool

from database.auth_db import PEPPER
from utils.logging import get_logger
from utils.thread_safe_cache import MISSING, LockedTTLCache

logger = get_logger(__name__)

_settings_cache = LockedTTLCache(maxsize=10, ttl=3600)

DATABASE_URL = os.getenv("DATABASE_URL", "sqlite:///db/openalgo.db")

if DATABASE_URL and "sqlite" in DATABASE_URL:
    engine = create_engine(
        DATABASE_URL,
        poolclass=NullPool,
        connect_args={"check_same_thread": False, "timeout": 30},
    )
else:
    engine = create_engine(DATABASE_URL, pool_size=50, max_overflow=100, pool_timeout=10)

db_session = scoped_session(sessionmaker(autocommit=False, autoflush=False, bind=engine))
Base: Any = declarative_base()
Base.query = db_session.query_property()


class Settings(Base):
    __tablename__ = "settings"
    id: Any = Column(Integer, primary_key=True)
    analyze_mode: Any = Column(Boolean, default=False)

    # SMTP Configuration
    smtp_server: Any = Column(String(255), nullable=True)
    smtp_port: Any = Column(Integer, nullable=True)
    smtp_username: Any = Column(String(255), nullable=True)
    smtp_password_encrypted: Any = Column(Text, nullable=True)
    smtp_use_tls: Any = Column(Boolean, default=True)
    smtp_from_email: Any = Column(String(255), nullable=True)
    smtp_helo_hostname: Any = Column(String(255), nullable=True)

    # Security Settings
    security_auto_ban_enabled: Any = Column(Boolean, default=False)
    security_404_threshold: Any = Column(Integer, default=100)
    security_404_ban_duration: Any = Column(Integer, default=0)
    security_api_threshold: Any = Column(Integer, default=100)
    security_api_ban_duration: Any = Column(Integer, default=0)
    security_repeat_offender_limit: Any = Column(Integer, default=2)


def init_db():
    """Initialize the settings database."""
    from database.db_init_helper import init_db_with_logging

    init_db_with_logging(Base, engine, "Settings DB", logger)

    try:
        if not Settings.query.first():
            logger.debug("Settings DB: Creating default configuration (Live Mode)")
            default_settings = Settings(analyze_mode=False)
            db_session.add(default_settings)
            db_session.commit()
    except Exception as e:
        db_session.rollback()
        logger.debug(f"Settings DB: Default config may already exist: {e}")


def get_analyze_mode() -> bool:
    """Get current analyze mode setting (cached for 1 hour)."""
    cache_key = "analyze_mode"

    cached = _settings_cache.get(cache_key, MISSING)
    if cached is not MISSING:
        return bool(cached)

    generation = _settings_cache.generation
    try:
        settings = Settings.query.first()
        if not settings:
            settings = Settings(analyze_mode=False)
            db_session.add(settings)
            db_session.commit()
        mode = bool(settings.analyze_mode)
    except Exception as e:
        db_session.rollback()
        logger.error(f"Error reading analyze_mode from DB, defaulting to False: {e}")
        return False

    _settings_cache.fill(cache_key, mode, generation)
    return mode


def set_analyze_mode(mode: bool):
    """Set analyze mode setting."""
    try:
        settings = Settings.query.first()
        if not settings:
            settings = Settings(analyze_mode=mode)
            db_session.add(settings)
        else:
            settings.analyze_mode = mode
        db_session.commit()
        _settings_cache.invalidate("analyze_mode")
    except Exception as e:
        db_session.rollback()
        logger.error(f"Error updating analyze_mode: {e}")
        raise


SMTP_KEY_SALT = os.getenv("SMTP_KEY_SALT", "smtp-openalgo-salt").encode()


def _get_smtp_fernet() -> Fernet:
    """Strong Fernet for the SMTP password: PBKDF2(PEPPER, SMTP_KEY_SALT)."""
    kdf = PBKDF2HMAC(
        algorithm=hashes.SHA256(),
        length=32,
        salt=SMTP_KEY_SALT,
        iterations=100000,
    )
    return Fernet(base64.urlsafe_b64encode(kdf.derive(PEPPER.encode())))


def _legacy_smtp_fernet() -> Fernet:
    """Legacy read-only key for backward-compatible decryption."""
    return Fernet(base64.urlsafe_b64encode(PEPPER.ljust(32)[:32].encode()))


_smtp_fernet = _get_smtp_fernet()


def _encrypt_password(password: str) -> str | None:
    if not password:
        return None
    return _smtp_fernet.encrypt(password.encode()).decode()


def _decrypt_password(encrypted_password: str) -> str | None:
    if not encrypted_password:
        return None
    token = encrypted_password.encode()
    try:
        return _smtp_fernet.decrypt(token).decode()
    except InvalidToken:
        return _legacy_smtp_fernet().decrypt(token).decode()


def get_smtp_settings():
    """Get SMTP configuration."""
    try:
        settings = Settings.query.first()
        if not settings:
            return None

        return {
            "smtp_server": settings.smtp_server,
            "smtp_port": settings.smtp_port,
            "smtp_username": settings.smtp_username,
            "smtp_password": _decrypt_password(settings.smtp_password_encrypted)
            if settings.smtp_password_encrypted
            else None,
            "smtp_use_tls": settings.smtp_use_tls,
            "smtp_from_email": settings.smtp_from_email,
            "smtp_helo_hostname": settings.smtp_helo_hostname,
        }
    except Exception as e:
        db_session.rollback()
        logger.error(f"Error getting SMTP settings: {e}")
        return None


def set_smtp_settings(
    smtp_server=None,
    smtp_port=None,
    smtp_username=None,
    smtp_password=None,
    smtp_use_tls=True,
    smtp_from_email=None,
    smtp_helo_hostname=None,
):
    """Set SMTP configuration."""
    try:
        settings = Settings.query.first()
        if not settings:
            settings = Settings(analyze_mode=False)
            db_session.add(settings)

        if smtp_server is not None:
            settings.smtp_server = smtp_server
        if smtp_port is not None:
            settings.smtp_port = smtp_port
        if smtp_username is not None:
            settings.smtp_username = smtp_username
        if smtp_password is not None:
            settings.smtp_password_encrypted = _encrypt_password(smtp_password)
        if smtp_use_tls is not None:
            settings.smtp_use_tls = smtp_use_tls
        if smtp_from_email is not None:
            settings.smtp_from_email = smtp_from_email
        if smtp_helo_hostname is not None:
            settings.smtp_helo_hostname = smtp_helo_hostname

        db_session.commit()
        logger.info("SMTP settings updated successfully")
    except Exception as e:
        db_session.rollback()
        logger.error(f"Error updating SMTP settings: {e}")
        raise


def get_security_settings():
    """Get security configuration (cached for 1 hour)."""
    cache_key = "security_settings"

    cached = _settings_cache.get(cache_key, MISSING)
    if cached is not MISSING:
        return cached

    generation = _settings_cache.generation
    try:
        settings = Settings.query.first()
        if not settings:
            settings = Settings(
                analyze_mode=False,
                security_auto_ban_enabled=False,
                security_404_threshold=100,
                security_404_ban_duration=0,
                security_api_threshold=100,
                security_api_ban_duration=0,
                security_repeat_offender_limit=2,
            )
            db_session.add(settings)
            db_session.commit()

        result = {
            "auto_ban_enabled": bool(settings.security_auto_ban_enabled)
            if settings.security_auto_ban_enabled is not None
            else False,
            "404_threshold": settings.security_404_threshold or 100,
            "404_ban_duration": settings.security_404_ban_duration
            if settings.security_404_ban_duration is not None
            else 0,
            "api_threshold": settings.security_api_threshold or 100,
            "api_ban_duration": settings.security_api_ban_duration
            if settings.security_api_ban_duration is not None
            else 0,
            "repeat_offender_limit": settings.security_repeat_offender_limit or 2,
        }
    except Exception as e:
        db_session.rollback()
        logger.error(f"Error getting security settings, using defaults: {e}")
        return {
            "auto_ban_enabled": False,
            "404_threshold": 100,
            "404_ban_duration": 0,
            "api_threshold": 100,
            "api_ban_duration": 0,
            "repeat_offender_limit": 2,
        }

    _settings_cache.fill(cache_key, result, generation)
    return result


def set_security_settings(
    auto_ban_enabled=None,
    threshold_404=None,
    ban_duration_404=None,
    threshold_api=None,
    ban_duration_api=None,
    repeat_offender_limit=None,
):
    """Set security configuration."""
    try:
        settings = Settings.query.first()
        if not settings:
            settings = Settings(analyze_mode=False)
            db_session.add(settings)

        if auto_ban_enabled is not None:
            settings.security_auto_ban_enabled = auto_ban_enabled
        if threshold_404 is not None:
            settings.security_404_threshold = threshold_404
        if ban_duration_404 is not None:
            settings.security_404_ban_duration = ban_duration_404
        if threshold_api is not None:
            settings.security_api_threshold = threshold_api
        if ban_duration_api is not None:
            settings.security_api_ban_duration = ban_duration_api
        if repeat_offender_limit is not None:
            settings.security_repeat_offender_limit = repeat_offender_limit

        db_session.commit()
        logger.info("Security settings updated successfully")
        _settings_cache.invalidate("security_settings")
    except Exception as e:
        db_session.rollback()
        logger.error(f"Error updating security settings: {e}")
        raise


def clear_settings_cache():
    """Clear all settings caches."""
    _settings_cache.invalidate()
    logger.info("Settings cache cleared")