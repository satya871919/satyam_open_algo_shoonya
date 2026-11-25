# blueprints/brlogin.py

import os

from flask import Blueprint, jsonify, redirect, request, session, url_for
from flask import current_app as app

from database.auth_db import enable_autologin
from limiter import limiter
from utils.auth_utils import handle_auth_failure, handle_auth_success
from utils.config import (
    get_broker_api_key,
    get_login_rate_limit_hour,
    get_login_rate_limit_min,
    is_shoonya_autologin_enabled,
)
from utils.logging import get_logger

logger = get_logger(__name__)

LOGIN_RATE_LIMIT_MIN = get_login_rate_limit_min()
LOGIN_RATE_LIMIT_HOUR = get_login_rate_limit_hour()

brlogin_bp = Blueprint("brlogin", __name__, url_prefix="/")


@brlogin_bp.errorhandler(429)
def ratelimit_handler(e):
    return jsonify(error="Rate limit exceeded"), 429


@brlogin_bp.route("/<broker>/callback", methods=["POST", "GET"])
@limiter.limit(LOGIN_RATE_LIMIT_MIN)
@limiter.limit(LOGIN_RATE_LIMIT_HOUR)
def broker_callback(broker, para=None):
    broker = (broker or "").strip().lower()
    logger.info(f"Broker callback initiated for: {broker}")

    # Only Shoonya is supported
    if broker != "shoonya":
        logger.warning(f"Unsupported broker callback requested: {broker}")
        return handle_auth_failure(
            f"Broker '{broker}' is disabled. Only Shoonya is supported.",
            forward_url="broker.html",
        )

    # Ensure OpenAlgo user is logged in before connecting broker
    if "user" not in session:
        logger.warning("User not in session for Shoonya callback, redirecting to login")
        return redirect(url_for("auth.login"))

    if session.get("logged_in"):
        from database.auth_db import get_auth_token

        if get_auth_token(session.get("user")):
            session["broker"] = "shoonya"
            return redirect(url_for("dashboard_bp.dashboard"))
        session.pop("logged_in", None)

    # Parse BROKER_API_KEY (expected format: userid:::client_id)
    full_api_key = (get_broker_api_key() or os.getenv("BROKER_API_KEY") or "").strip()
    if not full_api_key:
        return handle_auth_failure(
            "BROKER_API_KEY is not configured in .env",
            forward_url="broker.html",
        )

    parts = full_api_key.split(":::", 1)
    if len(parts) != 2 or not parts[0].strip() or not parts[1].strip():
        return handle_auth_failure(
            "BROKER_API_KEY must be in format 'userid:::client_id' (e.g., FA233802_U:::your_client_id)",
            forward_url="broker.html",
        )

    shoonya_user_id = parts[0].strip()
    shoonya_client_id = parts[1].strip()

    # Check if Shoonya OAuth returned an error
    oauth_error = request.args.get("error")
    oauth_error_desc = request.args.get("error_description")
    if oauth_error:
        msg = f"Shoonya OAuth error: {oauth_error}"
        if oauth_error_desc:
            msg = f"{msg} - {oauth_error_desc}"
        logger.error(msg)
        return handle_auth_failure(msg, forward_url="broker.html")

    code = (request.args.get("code") or request.form.get("code") or "").strip()

    # Initial visit (no code yet) -> Redirect to Shoonya OAuth login page
    if not code:
        referrer = (request.headers.get("Referer") or "").lower()
        if "shoonya.com" in referrer:
            logger.warning(
                "Shoonya OAuth redirected back without authorization code. "
                "Check REDIRECT_URL in Shoonya API portal (expected: http://127.0.0.1:5000/shoonya/callback)."
            )
            return handle_auth_failure(
                "Shoonya OAuth did not return an authorization code. "
                "Verify your Redirect URL in Shoonya API settings matches REDIRECT_URL in .env.",
                forward_url="broker.html",
            )

        logger.info("Redirecting to Shoonya OAuth login page")
        shoonya_login_url = (
            f"https://api.shoonya.com/OAuthlogin/authorize/oauth?client_id={shoonya_client_id}"
        )
        return redirect(shoonya_login_url)

    # Resolve Shoonya auth function
    broker_auth_functions = getattr(app, "broker_auth_functions", None) or {}
    auth_function = broker_auth_functions.get("shoonya_auth")
    if not auth_function:
        from broker.shoonya.api.auth_api import authenticate_broker

        auth_function = authenticate_broker

    logger.debug("Shoonya OAuth callback received with authorization code")

    try:
        auth_result = auth_function(code)
    except Exception as e:
        logger.exception(f"Shoonya authentication raised an exception: {e}")
        return handle_auth_failure(
            f"Shoonya authentication error: {str(e)}",
            forward_url="broker.html",
        )

    feed_token = None
    error_message = None

    if isinstance(auth_result, tuple):
        if len(auth_result) == 2:
            auth_token, error_message = auth_result
        elif len(auth_result) == 3:
            auth_token, feed_token, error_message = auth_result
        elif len(auth_result) >= 4:
            auth_token, feed_token, shoonya_user_id, error_message = auth_result[:4]
        else:
            auth_token = None
            error_message = "Unexpected response format from Shoonya authentication."
    else:
        auth_token = auth_result

    if not auth_token:
        return handle_auth_failure(
            error_message or "Shoonya authentication failed.",
            forward_url="broker.html",
        )

    username = session["user"]
    session["broker"] = "shoonya"
    logger.info(f"Successfully connected Shoonya broker for user: {username}")

    response = handle_auth_success(
        auth_token,
        username,
        "shoonya",
        feed_token=feed_token,
        user_id=shoonya_user_id,
    )

    # Persist auto-login preference for Shoonya across server restarts
    if is_shoonya_autologin_enabled():
        enable_autologin(username)

    return response