"""Regression tests for Shoonya same-day auto-login session persistence."""

import atexit
import os
import sys
from datetime import datetime, timedelta
from pathlib import Path
from types import SimpleNamespace

import pytest
import pytz
from flask import Flask, jsonify, session

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

TEST_DB = Path(__file__).resolve().parents[1] / "tmp" / "test_shoonya_autologin.db"
TEST_DB.parent.mkdir(parents=True, exist_ok=True)
os.environ["DATABASE_URL"] = f"sqlite:///{TEST_DB.as_posix()}"
os.environ.setdefault("APP_KEY", "a" * 64)
os.environ.setdefault("API_KEY_PEPPER", "b" * 64)
os.environ.setdefault("FERNET_SALT", "c" * 32)
atexit.register(lambda: TEST_DB.unlink(missing_ok=True))

import broker.shoonya.api.auth_api as shoonya_auth_api  # noqa: E402
import database.auth_db as auth_db  # noqa: E402
import utils.config as config_utils  # noqa: E402
import utils.session as session_utils  # noqa: E402


@pytest.fixture(autouse=True)
def reset_db(monkeypatch):
    monkeypatch.setattr(
        "database.cache_invalidation.publish_all_cache_invalidation", lambda *a, **k: None
    )
    monkeypatch.setattr(
        "websocket_proxy.broker_factory.cleanup_pools_for_user", lambda *a, **k: None
    )
    monkeypatch.setattr(
        "services.order_update_service.start_order_update_adapter", lambda *a, **k: False
    )
    monkeypatch.setattr(
        "services.order_update_service.stop_order_update_adapter", lambda *a, **k: None
    )
    auth_db.init_db()
    auth_db.Auth.query.delete()
    auth_db.ActiveSession.query.delete()
    auth_db.db_session.commit()
    auth_db.auth_cache.clear()
    auth_db.feed_token_cache.clear()
    auth_db.broker_cache.clear()
    yield
    auth_db.db_session.remove()


def test_env_flag_prefers_shoonya_autologin_and_falls_back_to_auto_login(monkeypatch):
    monkeypatch.delenv("SHOONYA_AUTOLOGIN", raising=False)
    monkeypatch.delenv("AUTO_LOGIN", raising=False)
    assert config_utils.is_shoonya_autologin_enabled() is True

    monkeypatch.setenv("SHOONYA_AUTOLOGIN", "false")
    monkeypatch.setenv("AUTO_LOGIN", "true")
    assert config_utils.is_shoonya_autologin_enabled() is False

    monkeypatch.setenv("SHOONYA_AUTOLOGIN", "true")
    monkeypatch.setenv("AUTO_LOGIN", "false")
    assert config_utils.is_shoonya_autologin_enabled() is True

    monkeypatch.delenv("SHOONYA_AUTOLOGIN", raising=False)
    monkeypatch.setenv("AUTO_LOGIN", "false")
    assert config_utils.is_shoonya_autologin_enabled() is False


def test_same_day_autologin_session_restores_and_passes_session_validity(monkeypatch):
    """After one morning login, same-day restarts restore session with valid login_time."""
    monkeypatch.setenv("SHOONYA_AUTOLOGIN", "true")

    auth_db.upsert_auth(
        "satyam",
        "shoonya-access-token",
        broker="shoonya",
        feed_token="feed-123",
        user_id="FA233802",
        autologin_enabled=True,
    )
    auth_db.register_session("satyam", "sid-today", ip_address="127.0.0.1", broker="shoonya")

    data = auth_db.get_autologin_session(broker="shoonya")
    assert data is not None
    assert data["name"] == "satyam"
    assert data["auth_token"] == "shoonya-access-token"
    assert data["session_id"] == "sid-today"
    assert data["login_time"]

    ok, msg, user = shoonya_auth_api.initialize_session_on_startup()
    assert ok is True
    assert user == "satyam"

    app = Flask(__name__)
    app.secret_key = "test-secret"
    with app.test_request_context("/dashboard"):
        session["user"] = data["name"]
        session["user_session_key"] = data["name"]
        session["broker"] = data["broker"]
        session["logged_in"] = True
        session["login_time"] = data["login_time"]
        assert session_utils.is_session_valid() is True


def test_stale_previous_day_session_is_rejected_and_revoked(monkeypatch):
    """A token from before today's 03:00 IST rollover must NOT auto-attach."""
    monkeypatch.setenv("SHOONYA_AUTOLOGIN", "true")

    auth_db.upsert_auth(
        "satyam",
        "yesterday-dead-token",
        broker="shoonya",
        user_id="FA233802",
        autologin_enabled=True,
    )
    ist = pytz.timezone("Asia/Kolkata")
    stale_time = (session_utils.get_trading_session_start() - timedelta(hours=2)).astimezone(ist)
    auth_db.db_session.add(
        auth_db.ActiveSession(
            username="satyam",
            session_id="sid-yesterday",
            ip_address="127.0.0.1",
            broker="shoonya",
            login_time=stale_time,
            last_seen=stale_time,
        )
    )
    auth_db.db_session.commit()

    data = auth_db.get_autologin_session(broker="shoonya")
    assert data is None

    row = auth_db.Auth.query.filter_by(name="satyam").first()
    assert row.is_revoked is True
    assert row.autologin_enabled is True


def test_revoked_manual_logout_is_not_autologged_in(monkeypatch):
    """Manual logout revokes the DB token so auto-login stays off until next login."""
    monkeypatch.setenv("SHOONYA_AUTOLOGIN", "true")

    auth_db.upsert_auth(
        "satyam",
        "shoonya-access-token",
        broker="shoonya",
        user_id="FA233802",
        autologin_enabled=True,
    )
    auth_db.register_session("satyam", "sid-today", ip_address="127.0.0.1", broker="shoonya")
    auth_db.upsert_auth("satyam", "", broker="shoonya", revoke=True)

    assert auth_db.get_autologin_session(broker="shoonya") is None
    ok, _, user = shoonya_auth_api.initialize_session_on_startup()
    assert ok is False
    assert user is None


def test_trading_session_start_before_and_after_rollover(monkeypatch):
    monkeypatch.setenv("SESSION_EXPIRY_TIME", "03:00")
    ist = pytz.timezone("Asia/Kolkata")

    after_rollover = ist.localize(datetime(2026, 11, 25, 10, 30))
    assert session_utils.get_trading_session_start(after_rollover) == ist.localize(
        datetime(2026, 11, 25, 3, 0)
    )

    before_rollover = ist.localize(datetime(2026, 11, 26, 1, 30))
    assert session_utils.get_trading_session_start(before_rollover) == ist.localize(
        datetime(2026, 11, 25, 3, 0)
    )


def test_brlogin_skips_oauth_when_valid_token_exists_and_reauths_when_revoked(monkeypatch):
    import blueprints.brlogin as brlogin_module

    monkeypatch.setenv("BROKER_API_KEY", "FA233802:::client123")
    app = Flask(__name__)
    app.secret_key = "test-secret"
    app.register_blueprint(brlogin_module.brlogin_bp)

    app.add_url_rule("/dashboard", endpoint="dashboard_bp.dashboard", view_func=lambda: "dash")

    auth_db.upsert_auth(
        "satyam",
        "valid-token-today",
        broker="shoonya",
        user_id="FA233802",
        autologin_enabled=True,
    )

    with app.test_client() as client:
        with client.session_transaction() as sess:
            sess["user"] = "satyam"
            sess["logged_in"] = True

        resp = client.get("/shoonya/callback")
        assert resp.status_code == 302
        assert resp.location.endswith("/dashboard")

    # Now revoke token in DB -> callback must redirect to Shoonya OAuth instead of dashboard
    auth_db.upsert_auth("satyam", "", broker="shoonya", revoke=True)
    with app.test_client() as client:
        with client.session_transaction() as sess:
            sess["user"] = "satyam"
            sess["logged_in"] = True

        resp = client.get("/shoonya/callback")
        assert resp.status_code == 302
        assert "api.shoonya.com/OAuthlogin/authorize/oauth" in resp.location


def test_session_status_clears_expired_cookie(monkeypatch):
    import blueprints.auth as auth_bp_module

    app = Flask(__name__)
    app.secret_key = "test-secret"
    app.register_blueprint(auth_bp_module.auth_bp)

    monkeypatch.setattr(auth_bp_module, "is_session_valid", lambda: False)
    revoked = []
    monkeypatch.setattr(
        auth_bp_module, "revoke_user_tokens", lambda revoke_db_tokens=True: revoked.append(revoke_db_tokens)
    )

    with app.test_client() as client:
        with client.session_transaction() as sess:
            sess["user"] = "satyam"
            sess["logged_in"] = True
            sess["broker"] = "shoonya"

        resp = client.get("/auth/session-status")
        assert resp.status_code == 200
        payload = resp.get_json()
        assert payload["authenticated"] is False
        assert payload["logged_in"] is False
        assert revoked == [True]
