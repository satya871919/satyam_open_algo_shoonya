# Learned Fixes & Solutions

## Shoonya Auto-Login Session Persistence (2026-11-23)

### Problem
Users had to manually enter username, password, and TOTP every morning when running `python app.py` to log into Shoonya broker.

### Solution
Implemented **Session Persistence** that automatically restores the login session on app restart.

### How It Works

1. **Login Time** - When user logs in with Shoonya, enable auto-login in `.env`:
   ```
   SHOONYA_AUTOLOGIN=true
   ```

2. **Session Storage** - After successful login:
   - Auth token and session data are stored in the database (encrypted)
   - `autologin_enabled` flag is set to `True` in the Auth table

3. **Auto-Restore** - On app startup:
   - `initialize_session_on_startup()` checks for enabled auto-login sessions
   - If found and not revoked, session is restored automatically
   - User is logged in without needing to enter credentials

4. **Daily Expiry** - Sessions expire at 3 AM IST (Shoonya's default):
   - At 3 AM, broker tokens are invalidated
   - Next app restart requires fresh login (security)

### Files Modified

| File | Changes |
|------|---------|
| `database/auth_db.py` | Added `autologin_enabled` column to Auth table, added helper functions |
| `broker/shoonya/api/auth_api.py` | Added `initialize_session_on_startup()`, updated `authenticate_broker()` |
| `blueprints/brlogin.py` | Updated Shoonya callback to enable auto-login flag |
| `app.py` | Added startup hook to check and restore auto-login session |

### Usage Instructions

**Enable Auto-Login:**
1. Add to `.env`:
   ```
   SHOONYA_AUTOLOGIN=true
   ```

2. Login once via browser (enter password + TOTP)

3. After successful login, you can close the browser

4. Next time you run `python app.py`, session is automatically restored

**Disable Auto-Login:**
- Set `SHOONYA_AUTOLOGIN=false` in `.env` or remove the variable
- Existing auto-login sessions will be ignored until next login

### Technical Details

- **Session Validation**: Uses existing session expiry logic (3 AM IST)
- **Security**: Tokens are encrypted in database using Fernet (PEPPER + FERNET_SALT)
- **Cache Invalidation**: On token refresh, caches are properly cleared
- **WebSocket Support**: Market data stream is automatically reconnected

### Related Code Patterns

- Session persistence: `enable_autologin()`, `disable_autologin()`, `is_autologin_enabled()`
- Token retrieval: `get_broker_session()`, `get_auth_token()`
- Auto-login check: `initialize_session_on_startup()` in `broker/shoonya/api/auth_api.py`

### Security Considerations

- Auto-login sessions are marked with `autologin_enabled=True` in the database
- Sessions are automatically revoked at 3 AM IST (broker-side limitation)
- Each login with different credentials overwrites the previous session
- Manual revocation (logout) clears the auto-login flag

---

## Future Enhancements

1. **Multiple Users**: Add support for multiple auto-login profiles
2. **GUI Toggle**: Add UI option to enable/disable auto-login
3. **QR Code TOTP**: Integrate QR code scanning for TOTP input
4. **Backup Codes**: Support backup codes for TOTP

---

## Common Patterns & Solutions

### Pattern: Broker Authentication Extension
```python
# Add new broker support
# 1. Create broker/<name>/api/auth_api.py with authenticate_broker()
# 2. Update blueprints/brlogin.py callback handler
# 3. Add broker-specific startup checks
```

### Pattern: Session Persistence
```python
# Enable session storage
# 1. Add autologin_enabled column to Auth table
# 2. Create enable_autologin() / disable_autologin() functions
# 3. Call enable_autologin() after successful login
# 4. Check and restore on startup with initialize_session_on_startup()
```

### Pattern: Daily Token Expiry
```python
# Handle broker-side token expiry (e.g., Shoonya @ 3 AM IST)
# 1. Set PERMANENT_SESSION_LIFETIME to expire at 3:30 AM
# 2. On session expiry, revoke tokens and force re-login
# 3. Auto-login sessions are automatically cleared at expiry
```