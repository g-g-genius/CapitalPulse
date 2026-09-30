CREATE TABLE IF NOT EXISTS signal_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    trade_date TEXT NOT NULL,
    source_time INTEGER NOT NULL,
    entity_type TEXT NOT NULL,
    entity_code TEXT NOT NULL,
    entity_name TEXT NOT NULL,
    signal_type TEXT NOT NULL,
    main_net REAL NOT NULL,
    change_15s REAL,
    change_1m REAL,
    change_3m REAL,
    created_at INTEGER NOT NULL,
    UNIQUE (trade_date, entity_type, entity_code, signal_type, source_time)
);

CREATE INDEX IF NOT EXISTS idx_signal_events_date_id
    ON signal_events (trade_date, id);
CREATE INDEX IF NOT EXISTS idx_signal_events_entity_date
    ON signal_events (entity_type, entity_code, trade_date);

CREATE TABLE IF NOT EXISTS watchlist_quote_snapshot (
    trade_date TEXT NOT NULL,
    quote_id TEXT NOT NULL,
    minute_time INTEGER NOT NULL,
    source_time INTEGER NOT NULL,
    price REAL NOT NULL,
    change_percent REAL NOT NULL,
    main_net REAL NOT NULL,
    PRIMARY KEY (trade_date, quote_id, minute_time)
);

CREATE INDEX IF NOT EXISTS idx_watchlist_quote_date
    ON watchlist_quote_snapshot (trade_date, quote_id, source_time);
