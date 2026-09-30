CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    email TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL,
    account_role TEXT NOT NULL DEFAULT 'member',
    password_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS auth_sessions (
    token_hash TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_auth_sessions_expiry ON auth_sessions(expires_at);

CREATE TABLE IF NOT EXISTS watchlist_stocks (
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    quote_id TEXT NOT NULL,
    code TEXT NOT NULL,
    name TEXT NOT NULL,
    market_name TEXT NOT NULL DEFAULT '',
    pinyin TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, quote_id)
);

CREATE INDEX IF NOT EXISTS idx_watchlist_stocks_user_time
    ON watchlist_stocks(user_id, created_at);
