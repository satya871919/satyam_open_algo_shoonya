# Project Brain: satyam_open_algo_shoonya

## Project Overview
OpenAlgo is a comprehensive algorithmic trading platform for Indian markets with **Shoonya broker integration**. It supports strategy building, backtesting, live execution, charting (via openalgo-charts), and portfolio management. 

**Entry Point**: `app.py` - Flask app factory that initializes DB, registers 40+ blueprints, starts SocketIO server for real-time updates, and launches WebSocket proxy for market data streaming.

**Stack**: Flask/Flask-RestX (backend) + React SPA with Vite + TypeScript (frontend) + SQLite (multiple databases) + WebSocket proxy for real-time market data.

---

## Folder & File Map

| Folder/File | Purpose |
|-------------|---------|
| `app.py` | Main entry point - Flask app factory, DB init, blueprint registration (40+), SocketIO, WebSocket proxy startup |
| `broker/` | Broker plugins (each has `api/`, `streaming/`, `database/`, `mapping/`, `plugin.json`) |
| `broker/shoonya/` | **Shoonya-specific integration**: auth (GenAcsTok), WebSocket streaming, order/quote APIs, contract mapping |
| `services/` | 80+ core business logic services (orders, quotes, strategies, flow, portfolio, risk, historify, etc.) |
| `restx_api/` | Flask-RestX API namespaces (50+ endpoints: orders, quotes, history, options, portfolio, strategy, etc.) |
| `openscript_host/` | Engine to run `.oscript` strategies (calendar_reader, live_bars, openscript_runner) |
| `portfolio/` | Portfolio analytics: engine, holdings, attribution, rebalance, crisis, walkforward |
| `database/` | DB modules (SQLAlchemy + raw SQLite): auth, tokens, strategies, contracts, cache, settings, historify |
| `websocket_proxy/` | Real-time market data proxy: adapters, connection manager, broker factory, order adapter |
| `blueprints/` | 40+ Flask blueprints (auth, brlogin, dashboard, orders, strategy, flow, charts, etc.) |
| `frontend/` | React SPA (src/, dist/, Vite config) - UI for trading, charts, strategy builder |
| `utils/` | Shared utilities: plugin_loader, auth_utils, config, logging, event_bus, httpx_client |

---

## Shoonya Broker & Login Flow

1. **Credentials Format**: `BROKER_API_KEY=userid:::client_id` and `BROKER_API_SECRET` in `.env`
2. **Auth Flow** (`broker/shoonya/api/auth_api.py`):
   - User logs in via Shoonya web → receives `code`
   - Backend calls `authenticate_broker(code)` → SHA256(appKey + secretKey + code) checksum
   - POST to `https://api.shoonya.com/NorenWClientAPI/GenAcsTok` with `jData={code, checksum}`
   - Returns `access_token` on success
3. **Callback Handling** (`blueprints/brlogin.py`):
   - Route `POST /<broker>/callback` handles OAuth callbacks
   - Calls `app.broker_auth_functions["shoonya_auth"]` (lazy-loaded via `plugin_loader.py`)
   - On success: stores token in DB (`database/auth_db.py`), sets session, starts master contract download
4. **WebSocket Streaming** (`broker/shoonya/streaming/shoonya_websocket.py`):
   - `ShoonyaWebSocket` class handles real-time quotes, depth, orders
   - Connects to Shoonya WS endpoint with `access_token` and `user_id`
   - Integrated via `websocket_proxy/` for unified market data distribution

---

## Safe Edit Rules

**DO NOT MODIFY WITHOUT AUTHORIZATION:**
- `app.py` - Core app factory, DB initialization, blueprint registration order
- `restx_api/__init__.py` - API namespace registration and routing
- `broker/*/api/auth_api.py` - Broker authentication logic (security critical)
- `database/*_db.py` - Database schema and connection logic
- `utils/plugin_loader.py` - Broker plugin discovery and lazy loading
- `utils/auth_utils.py` - Core authentication flow and session management
- `.env` / `.venv` - NEVER delete or modify credentials directly

**Safe to Edit:**
- Service files in `services/` (business logic)
- Blueprint files in `blueprints/` (route handlers)
- API files in `restx_api/` (individual endpoint logic)
- Frontend React components in `frontend/src/`
- Strategy files in `strategies/` and `openscript_host/`