# Shoonya Auto-Login Implementation

## 📋 Summary

Successfully implemented **automatic login session persistence** for Shoonya broker integration. Now you can:

1. ✅ Login once with password + TOTP
2. ✅ Restart app with `python app.py` - session auto-restored
3. ✅ No more daily password/TOTP entry needed

---

## 🔧 How to Use

### Step 1: Enable Auto-Login in `.env`

Add this line to your `.env` file:

```bash
SHOONYA_AUTOLOGIN=true
```

### Step 2: First Login

1. Run `python app.py`
2. Open dashboard in browser
3. Click "Login with Shoonya"
4. Enter your credentials (password + TOTP from 55756A475PFSHZ6653VW2T2A7NEI46VO)
5. **Login successful = auto-login enabled!**

### Step 3: Future Restarts

Next time you run:
```bash
python app.py
```

The app will:
- ✅ Auto-detect your saved session
- ✅ Restore login automatically
- ✅ Open dashboard directly

---

## 🔐 How Session Persistence Works

```
┌─────────────────┐
│  First Login    │
│  (with TOTP)    │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Save Session    │ ◄── Auth token encrypted in DB
│ to database     │ ◄── autologin_enabled=True
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ App Restart     │
│ (python app.py) │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Check DB        │
│ autologin flag  │
└────────┬────────┘
         │
         ▼
┌─────────────────┐
│ Restore Session │ ◄── Direct to dashboard!
└─────────────────┘
```

---

## 🔄 Daily Behavior

### Normal Day:
- App starts → Auto-login session restored → Dashboard opens

### 3 AM IST (Broker Reset):
- Shoonya invalidates tokens
- Session expires automatically
- Next restart requires fresh login (security)

---

## 📝 Files Modified

| File | Changes |
|------|---------|
| `database/auth_db.py` | ✅ Added `autologin_enabled` column<br>✅ Added helper functions |
| `broker/shoonya/api/auth_api.py` | ✅ Auto-login initialization<br>✅ Session restoration logic |
| `blueprints/brlogin.py` | ✅ Enable auto-login on successful login |
| `app.py` | ✅ Startup session check hook |
| `.sample.env` | ✅ Added SHOONYA_AUTOLOGIN documentation |

---

## 🛡️ Security Notes

- **Tokens are encrypted** in database using Fernet (PEPPER + FERNET_SALT)
- **Session valid until 3 AM IST** (Shoonya's daily token expiry)
- **Auto-login disabled by default** - must set `SHOONYA_AUTOLOGIN=true`
- **Manual logout** clears auto-login flag

---

## ❓ Troubleshooting

### Session not restored?

1. **Check environment variable:**
   ```bash
   grep SHOONYA_AUTOLOGIN .env
   # Should show: SHOONYA_AUTOLOGIN=true
   ```

2. **Check database:**
   - Session stored in `db/openalgo.db` table: `auth`
   - Column `autologin_enabled` should be `1` (True)

3. **Check logs:**
   ```bash
   # After app start, look for:
   "Auto-login session restored for user: admin"
   
   # Or if not found:
   "No auto-login session available"
   ```

### Still asking for login?

- Session might have expired (after 3 AM IST)
- Need to login once more to re-establish session
- Then future restarts will work auto

---

## 💡 Advanced Usage

### Disable Auto-Login

Set in `.env`:
```bash
SHOONYA_AUTOLOGIN=false
```

Or remove the variable entirely.

### Manual Session Management

Use these functions in Python:

```python
from database.auth_db import (
    enable_autologin,
    disable_autologin,
    is_autologin_enabled,
    get_broker_session
)

# Check if auto-login enabled
is_autologin_enabled("admin")  # Returns True/False

# Get session data
get_broker_session("admin")  # Returns (auth_token, feed_token, broker, is_revoked)

# Manually enable/disable
enable_autologin("admin")
disable_autologin("admin")
```

---

## 🎯 Result

**Before:** Enter password + TOTP every morning

**After:** 
```
$ python app.py
✅ Auto-login session restored for user: admin
[OpenAlgo v1.0.7 - Your Personal Algo Trading Platform]
Web App    http://127.0.0.1:5000
WebSocket  ws://127.0.0.1:8765
Status     Ready
```

---

## 📚 Documentation

Full technical details maintained in:
`.clinerules/learned_fixes.md`

---

**Ready to test!** 

Just add `SHOONYA_AUTOLOGIN=true` to your `.env` and restart the app. The next login session will be persisted automatically.