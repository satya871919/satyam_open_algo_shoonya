import hashlib
import json
import os

from utils.httpx_client import get_httpx_client
from utils.logging import get_logger

logger = get_logger(__name__)


def initialize_session_on_startup():
    """
    Initialize broker session on app startup for same-day auto-login persistence.
    Restores the persisted session if auto-login is enabled and the session was
    authenticated in the current trading day (after the daily 03:00 IST rollover).

    Returns:
        tuple: (success: bool, message: str, user_id: str or None)
    """
    try:
        from database.auth_db import get_autologin_session
        from utils.config import is_shoonya_autologin_enabled

        if not is_shoonya_autologin_enabled():
            logger.info("Shoonya auto-login is disabled in environment configuration.")
            return False, "Auto-login disabled", None

        logger.info("Checking for same-day Shoonya auto-login session...")
        session_info = get_autologin_session(broker="shoonya")
        if session_info and session_info.get("name"):
            username = session_info["name"]
            logger.info(f"Found valid same-day auto-login session for user: {username}")
            return True, "Auto-login session restored", username

        logger.info("No active same-day auto-login session found. Proceeding to manual login.")
        return False, "No auto-login session available", None

    except Exception as e:
        logger.exception(f"Error initializing auto-login session: {e}")
        return False, f"Error: {str(e)}", None


def authenticate_broker(code):
    """
    Authenticate with Shoonya using the new GenAcsTok flow.
    Exchanges the code for an access token.
    
    Returns:
        tuple: (auth_token, user_id, error_message)
               - On success: (access_token, user_id, None)
               - On failure: (None, None, error_message)
    """
    try:
        # BROKER_API_KEY format: userid:::client_id
        full_api_key = os.getenv("BROKER_API_KEY")
        if not full_api_key or ":::" not in full_api_key:
            return None, None, "BROKER_API_KEY must be in format userid:::client_id"
        client_id = full_api_key.split(":::")[1]  # appKey / client_id
        secret_key = os.getenv("BROKER_API_SECRET")
        if not secret_key:
            return None, None, "BROKER_API_SECRET is required"

        # Get the shared httpx client
        client = get_httpx_client()

        # Shoonya GenAcsTok endpoint
        url = "https://api.shoonya.com/NorenWClientAPI/GenAcsTok"

        # Compute checksum: SHA-256(appKey + secretKey + code)
        checksum_input = f"{client_id}{secret_key}{code}"
        checksum = hashlib.sha256(checksum_input.encode()).hexdigest()

        # Prepare token exchange payload
        payload = {
            "code": code,
            "checksum": checksum,
        }

        # Convert payload to jData format
        payload_str = "jData=" + json.dumps(payload)

        # Set headers
        headers = {"Content-Type": "text/plain"}

        logger.debug(f"Shoonya GenAcsTok request to {url}")

        # Send the POST request
        response = client.post(url, content=payload_str, headers=headers)

        # Handle the response
        if response.status_code == 200:
            data = response.json()
            if data.get("stat") == "Ok" and "access_token" in data:
                logger.info("Shoonya authentication successful")
                # Get user_id (actid) from BROKER_API_KEY
                full_api_key = os.getenv("BROKER_API_KEY")
                if full_api_key and ":::" in full_api_key:
                    user_id = full_api_key.split(":::")[0]  # userid is the first part
                else:
                    user_id = None
                return data["access_token"], user_id, None
            else:
                error_msg = data.get("emsg", "Authentication failed. Please try again.")
                logger.error(f"Shoonya auth error: {error_msg}")
                return None, None, error_msg
        else:
            error_msg = f"Error: {response.status_code}, {response.text}"
            logger.error(f"Shoonya HTTP error: {error_msg}")
            return None, None, error_msg

    except Exception as e:
        logger.error(f"Shoonya auth exception: {e}")
        return None, None, str(e)
