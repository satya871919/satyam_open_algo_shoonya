import importlib
import time
from typing import Any

import pandas as pd

from database.auth_db import get_auth_token_broker
from database.token_db import get_token
from services.broker_busy import BrokerBusyError, broker_busy_result
from utils import real_threading
from utils.broker_backpressure import check_queue_wait
from utils.constants import VALID_EXCHANGES
from utils.logging import get_logger

# Initialize logger
logger = get_logger(__name__)

# Rate limiter: max 3 broker history API requests per second, evenly spaced.
#
# Each caller books the next free start time under a lock and then sleeps until
# it arrives, so concurrent callers are spaced one interval apart. The previous
# version read the time of the last call, slept, and wrote it back, all
# unlocked: callers arriving together computed their sleep from the same stale
# value, woke together, and reached the broker as a burst it rejects.
#
# The lock is a real one because the agent's tools reach this from a real OS
# thread. It guards two float operations; the sleep happens after it is released.
_MIN_HISTORY_INTERVAL = 0.35  # 350ms between calls (~3 req/sec, evenly spaced)
_next_history_slot: float = 0.0
_history_slot_lock = real_threading.Lock()


def _enforce_rate_limit(*, background: bool = False):
    """Wait for this request's turn (~3 per second).

    Raises:
        BrokerBusyError: Only under the gthread worker, when the turn would
            come later than the market-data queue ceiling. The check runs
            before the slot is booked, so a refused request delays nobody.
    """
    global _next_history_slot
    with _history_slot_lock:
        now = time.monotonic()
        slot = max(now, _next_history_slot)
        wait = slot - now
        # Historify workers are not Gunicorn request threads.  They must share
        # the booking queue (and therefore the broker's 3 req/s limit), but a
        # queued background download must be allowed to wait for its turn.
        if not background:
            check_queue_wait(wait, kind="data")
        _next_history_slot = slot + _MIN_HISTORY_INTERVAL
    if wait > 0:
        time.sleep(wait)


def validate_symbol_exchange(symbol: str, exchange: str) -> tuple[bool, str | None]:
    """
    Validate that a symbol exists for the given exchange.

    Args:
        symbol: Trading symbol
        exchange: Exchange (e.g., NSE, NFO)

    Returns:
        Tuple of (is_valid, error_message)
    """
    # Validate exchange
    exchange_upper = exchange.upper()
    if exchange_upper not in VALID_EXCHANGES:
        return False, f"Invalid exchange '{exchange}'. Must be one of: {', '.join(VALID_EXCHANGES)}"

    # Validate symbol exists in master contract
    token = get_token(symbol, exchange_upper)
    if token is None:
        return (
            False,
            f"Symbol '{symbol}' not found for exchange '{exchange}'. Please verify the symbol name and ensure master contracts are downloaded.",
        )

    return True, None


def import_broker_module(broker_name: str) -> Any | None:
    """
    Dynamically import the broker-specific data module.

    Args:
        broker_name: Name of the broker

    Returns:
        The imported module or None if import fails
    """
    try:
        module_path = f"broker.{broker_name}.api.data"
        broker_module = importlib.import_module(module_path)
        return broker_module
    except ImportError as error:
        logger.error(f"Error importing broker module '{module_path}': {error}")
        return None


_INDEX_EXCHANGES = frozenset({"NSE_INDEX", "BSE_INDEX", "MCX_INDEX", "GLOBAL_INDEX"})


def _synthetic_activity_volume(df: pd.DataFrame) -> pd.Series:
    """Compute price-range activity volume for indices lacking futures/exchange volume."""
    high = pd.to_numeric(df.get("high", 0), errors="coerce").fillna(0.0)
    low = pd.to_numeric(df.get("low", 0), errors="coerce").fillna(0.0)
    open_ = pd.to_numeric(df.get("open", 0), errors="coerce").fillna(0.0)
    close = pd.to_numeric(df.get("close", 0), errors="coerce").fillna(0.0)
    activity = ((high - low).abs() + (close - open_).abs()) * 1000.0
    return activity.round().clip(lower=100).astype(int)


def _attach_index_proxy_volume(
    df: pd.DataFrame,
    data_handler: Any,
    symbol: str,
    exchange: str,
    interval: str,
    start_date: Any,
    end_date: Any,
) -> pd.DataFrame:
    """Populate index bar volume across all index exchanges (NSE_INDEX, BSE_INDEX, MCX_INDEX, GLOBAL_INDEX).

    1. For NSE_INDEX / BSE_INDEX symbols with active futures (NIFTY, BANKNIFTY,
       FINNIFTY, MIDCPNIFTY, SENSEX, BANKEX, etc.), aligns real front-month
       futures volume by timestamp when a broker data_handler is available.
    2. For any remaining zero/missing bars (or indices without futures such as
       sectoral indices, INDIAVIX, MCX_INDEX, GLOBAL_INDEX, or DB-only reads),
       falls back to price-range activity volume so every index has non-zero volume.
    """
    exch_upper = exchange.upper()
    if exch_upper not in _INDEX_EXCHANGES or df.empty:
        return df

    existing_vol = (
        pd.to_numeric(df["volume"], errors="coerce").fillna(0)
        if "volume" in df.columns
        else pd.Series(0, index=df.index, dtype="int64")
    )
    if (existing_vol > 0).all():
        return df

    df = df.copy()
    df["volume"] = existing_vol.astype(int)

    # 1. Try real front-month futures volume for NSE_INDEX / BSE_INDEX
    if data_handler is not None and exch_upper in ("NSE_INDEX", "BSE_INDEX"):
        fut_exchange = "NFO" if exch_upper == "NSE_INDEX" else "BFO"
        try:
            from datetime import date, datetime

            from database.symbol import fno_search_symbols_db, get_distinct_expiries

            expiries = get_distinct_expiries(
                exchange=fut_exchange, underlying=symbol, instrumenttype="futures"
            )
            if expiries:
                today = date.today()
                nearest_expiry = expiries[0]
                for exp in expiries:
                    for fmt in ("%d-%b-%y", "%d-%b-%Y"):
                        try:
                            if datetime.strptime(exp, fmt).date() >= today:
                                nearest_expiry = exp
                                break
                        except ValueError:
                            continue
                    else:
                        continue
                    break

                rows = fno_search_symbols_db(
                    underlying=symbol,
                    exchange=fut_exchange,
                    expiry=nearest_expiry,
                    instrumenttype="FUT",
                    limit=1,
                )
                fut_symbol = (
                    (rows[0].get("symbol") if isinstance(rows[0], dict) else getattr(rows[0], "symbol", None))
                    if rows
                    else None
                )
                if fut_symbol:
                    fut_df = data_handler.get_history(
                        fut_symbol, fut_exchange, interval, start_date, end_date
                    )
                    if (
                        isinstance(fut_df, pd.DataFrame)
                        and not fut_df.empty
                        and "timestamp" in fut_df.columns
                        and "volume" in fut_df.columns
                        and "timestamp" in df.columns
                    ):
                        vol_map = (
                            fut_df[["timestamp", "volume"]]
                            .drop_duplicates(subset=["timestamp"])
                            .set_index("timestamp")["volume"]
                        )
                        mapped = pd.to_numeric(df["timestamp"].map(vol_map), errors="coerce").fillna(0).astype(int)
                        df["volume"] = df["volume"].where(df["volume"] > 0, mapped)
        except Exception as exc:
            logger.debug(f"Index futures proxy volume skipped for {exchange}:{symbol}: {exc}")

    # 2. Universal fallback for any index bars still at 0 (sectoral, VIX, MCX_INDEX, GLOBAL_INDEX)
    zero_mask = df["volume"] <= 0
    if zero_mask.any():
        synth = _synthetic_activity_volume(df)
        df.loc[zero_mask, "volume"] = synth.loc[zero_mask]

    return df


def get_history_with_auth(
    auth_token: str,
    feed_token: str | None,
    broker: str,
    symbol: str,
    exchange: str,
    interval: str,
    start_date: str,
    end_date: str,
) -> tuple[bool, dict[str, Any], int]:
    """
    Get historical data for a symbol using provided auth tokens.

    Args:
        auth_token: Authentication token for the broker API
        feed_token: Feed token for market data (if required by broker)
        broker: Name of the broker
        symbol: Trading symbol
        exchange: Exchange (e.g., NSE, BSE)
        interval: Time interval (e.g., 1m, 5m, 15m, 1h, 1d)
        start_date: Start date in YYYY-MM-DD format
        end_date: End date in YYYY-MM-DD format

    Returns:
        Tuple containing:
        - Success status (bool)
        - Response data (dict)
        - HTTP status code (int)
    """
    # Validate symbol and exchange before making broker API call
    is_valid, error_msg = validate_symbol_exchange(symbol, exchange)
    if not is_valid:
        return False, {"status": "error", "message": error_msg}, 400

    broker_module = import_broker_module(broker)
    if broker_module is None:
        return False, {"status": "error", "message": "Broker-specific module not found"}, 404

    try:
        # Initialize broker's data handler based on broker's requirements
        if hasattr(broker_module.BrokerData.__init__, "__code__"):
            # Check number of parameters the broker's __init__ accepts
            param_count = broker_module.BrokerData.__init__.__code__.co_argcount
            if param_count > 2:  # More than self and auth_token
                data_handler = broker_module.BrokerData(auth_token, feed_token)
            else:
                data_handler = broker_module.BrokerData(auth_token)
        else:
            # Fallback to just auth token if we can't inspect
            data_handler = broker_module.BrokerData(auth_token)

        # Call the broker's get_history method
        df = data_handler.get_history(symbol, exchange, interval, start_date, end_date)

        if not isinstance(df, pd.DataFrame):
            raise ValueError("Invalid data format returned from broker")

        df = _attach_index_proxy_volume(
            df, data_handler, symbol, exchange, interval, start_date, end_date
        )

        # Ensure all responses include 'oi' field, set to 0 if not present
        if "oi" not in df.columns:
            df["oi"] = 0

        return True, {"status": "success", "data": df.to_dict(orient="records")}, 200
    except BrokerBusyError as e:
        return broker_busy_result(e, f"History request for {exchange}:{symbol}")
    except Exception as e:
        logger.exception(f"Error in broker_module.get_history: {e}")
        return False, {"status": "error", "message": str(e)}, 500


def get_history_from_db(
    symbol: str, exchange: str, interval: str, start_date: str, end_date: str
) -> tuple[bool, dict[str, Any], int]:
    """
    Get historical data from DuckDB/Historify database.

    Args:
        symbol: Trading symbol
        exchange: Exchange (e.g., NSE, BSE)
        interval: Time interval (e.g., 1m, 5m, 15m, 1h, D, W, M, Q, Y)
        start_date: Start date in YYYY-MM-DD format
        end_date: End date in YYYY-MM-DD format

    Returns:
        Tuple containing:
        - Success status (bool)
        - Response data (dict)
        - HTTP status code (int)
    """
    try:
        from datetime import date, datetime

        from database.historify_db import get_ohlcv

        # Convert dates to timestamps (handle both string and date objects)
        if isinstance(start_date, date):
            start_dt = datetime.combine(start_date, datetime.min.time())
        else:
            start_dt = datetime.strptime(start_date, "%Y-%m-%d")

        if isinstance(end_date, date):
            end_dt = datetime.combine(end_date, datetime.min.time())
        else:
            end_dt = datetime.strptime(end_date, "%Y-%m-%d")

        # Set end_date to end of day
        end_dt = end_dt.replace(hour=23, minute=59, second=59)

        start_timestamp = int(start_dt.timestamp())
        end_timestamp = int(end_dt.timestamp())

        # Get data from DuckDB
        df = get_ohlcv(
            symbol=symbol,
            exchange=exchange,
            interval=interval,
            start_timestamp=start_timestamp,
            end_timestamp=end_timestamp,
        )

        if df.empty:
            return (
                False,
                {
                    "status": "error",
                    "message": f"No data found for {symbol}:{exchange} interval {interval} in local database. Download data first using Historify.",
                },
                404,
            )

        # Ensure 'oi' column exists
        if "oi" not in df.columns:
            df["oi"] = 0

        df = _attach_index_proxy_volume(df, None, symbol, exchange, interval, start_date, end_date)

        # Reorder columns to match API response format
        columns = ["timestamp", "open", "high", "low", "close", "volume", "oi"]
        df = df[columns]

        return True, {"status": "success", "data": df.to_dict(orient="records")}, 200

    except Exception as e:
        logger.exception(f"Error fetching history from DB: {e}")
        return False, {"status": "error", "message": str(e)}, 500


def get_history(
    symbol: str,
    exchange: str,
    interval: str,
    start_date: str,
    end_date: str,
    api_key: str | None = None,
    auth_token: str | None = None,
    feed_token: str | None = None,
    broker: str | None = None,
    source: str = "api",
    background: bool = False,
) -> tuple[bool, dict[str, Any], int]:
    """
    Get historical data for a symbol.
    Supports both API-based authentication and direct internal calls.

    Args:
        symbol: Trading symbol
        exchange: Exchange (e.g., NSE, BSE)
        interval: Time interval (e.g., 1m, 5m, 15m, 1h, D, W, M, Q, Y)
        start_date: Start date in YYYY-MM-DD format
        end_date: End date in YYYY-MM-DD format
        api_key: OpenAlgo API key (for API-based calls)
        auth_token: Direct broker authentication token (for internal calls)
        feed_token: Direct broker feed token (for internal calls)
        broker: Direct broker name (for internal calls)
        source: Data source - 'api' (broker, default) or 'db' (DuckDB/Historify).
            Unsupported values return 400 before a provider is called.

    Returns:
        Tuple containing:
        - Success status (bool)
        - Response data (dict)
        - HTTP status code (int)

        Unsupported source values return a 400 error before either provider is called.
    """
    if not isinstance(source, str) or source not in {"api", "db"}:
        return (
            False,
            {"status": "error", "message": "Source must be either 'api' or 'db'."},
            400,
        )

    # Source: 'db' - Fetch from DuckDB/Historify database
    if source == "db":
        return get_history_from_db(
            symbol=symbol,
            exchange=exchange,
            interval=interval,
            start_date=start_date,
            end_date=end_date,
        )

    # Source: 'api' (default) - Fetch from broker API
    # Enforce 3 requests/second rate limit for broker history calls
    try:
        if background:
            _enforce_rate_limit(background=True)
        else:
            _enforce_rate_limit()
    except BrokerBusyError as e:
        return broker_busy_result(e, f"History request for {exchange}:{symbol}")

    # Case 1: API-based authentication
    if api_key and not (auth_token and broker):
        AUTH_TOKEN, FEED_TOKEN, broker_name = get_auth_token_broker(
            api_key, include_feed_token=True
        )
        if AUTH_TOKEN is None:
            return False, {"status": "error", "message": "Invalid openalgo apikey"}, 403
        return get_history_with_auth(
            AUTH_TOKEN, FEED_TOKEN, broker_name, symbol, exchange, interval, start_date, end_date
        )

    # Case 2: Direct internal call with auth_token and broker
    elif auth_token and broker:
        return get_history_with_auth(
            auth_token, feed_token, broker, symbol, exchange, interval, start_date, end_date
        )

    # Case 3: Invalid parameters
    else:
        return (
            False,
            {
                "status": "error",
                "message": "Either api_key or both auth_token and broker must be provided",
            },
            400,
        )
