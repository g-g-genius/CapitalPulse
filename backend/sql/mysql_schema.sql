CREATE TABLE IF NOT EXISTS sector_flow_selection (
    trade_date VARCHAR(10) NOT NULL,
    `rank` INT NOT NULL,
    sector_code VARCHAR(32) NOT NULL,
    sector_name VARCHAR(255) NOT NULL,
    market_cap DOUBLE NOT NULL,
    selected_at VARCHAR(40) NOT NULL,
    PRIMARY KEY (trade_date, sector_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sector_flow_universe (
    trade_date VARCHAR(10) NOT NULL,
    sector_code VARCHAR(32) NOT NULL,
    sector_name VARCHAR(255) NOT NULL,
    market_cap DOUBLE NOT NULL,
    PRIMARY KEY (trade_date, sector_code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sector_flow_snapshot (
    trade_date VARCHAR(10) NOT NULL,
    source_time BIGINT NOT NULL,
    sector_code VARCHAR(32) NOT NULL,
    sector_name VARCHAR(255) NOT NULL,
    main_net DOUBLE NOT NULL,
    small_net DOUBLE NOT NULL,
    mid_net DOUBLE NOT NULL,
    large_net DOUBLE NOT NULL,
    super_large_net DOUBLE NOT NULL,
    received_at VARCHAR(40) NOT NULL,
    granularity VARCHAR(32) NOT NULL DEFAULT 'realtime',
    PRIMARY KEY (trade_date, source_time, sector_code),
    KEY idx_sector_flow_snapshot_time (trade_date, source_time),
    KEY idx_sector_flow_snapshot_sector (trade_date, sector_code, source_time)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS sector_flow_daily (
    trade_date VARCHAR(10) NOT NULL,
    sector_code VARCHAR(32) NOT NULL,
    sector_name VARCHAR(255) NOT NULL,
    main_net DOUBLE NOT NULL,
    super_large_net DOUBLE NOT NULL DEFAULT 0,
    large_net DOUBLE NOT NULL DEFAULT 0,
    mid_net DOUBLE NOT NULL DEFAULT 0,
    small_net DOUBLE NOT NULL DEFAULT 0,
    updated_at VARCHAR(40) NOT NULL,
    PRIMARY KEY (trade_date, sector_code),
    KEY idx_sector_flow_daily_sector_date (sector_code, trade_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS stock_flow_snapshot (
    trade_date VARCHAR(10) NOT NULL,
    source_time BIGINT NOT NULL,
    quote_id VARCHAR(32) NOT NULL,
    stock_code VARCHAR(32) NOT NULL,
    stock_name VARCHAR(255) NOT NULL,
    main_net DOUBLE NOT NULL,
    small_net DOUBLE NOT NULL,
    mid_net DOUBLE NOT NULL,
    large_net DOUBLE NOT NULL,
    super_large_net DOUBLE NOT NULL,
    received_at VARCHAR(40) NOT NULL,
    granularity VARCHAR(32) NOT NULL DEFAULT 'realtime',
    PRIMARY KEY (trade_date, source_time, quote_id),
    KEY idx_stock_flow_snapshot_quote_time (trade_date, quote_id, source_time)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS users (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    email VARCHAR(254) NOT NULL,
    display_name VARCHAR(64) NOT NULL,
    account_role VARCHAR(16) NOT NULL DEFAULT 'member',
    password_hash VARCHAR(255) NOT NULL,
    created_at BIGINT NOT NULL,
    updated_at BIGINT NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_users_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS auth_sessions (
    token_hash CHAR(64) NOT NULL,
    user_id BIGINT UNSIGNED NOT NULL,
    created_at BIGINT NOT NULL,
    expires_at BIGINT NOT NULL,
    PRIMARY KEY (token_hash),
    KEY idx_auth_sessions_user (user_id),
    KEY idx_auth_sessions_expiry (expires_at),
    CONSTRAINT fk_auth_sessions_user FOREIGN KEY (user_id) REFERENCES users (id)
        ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS watchlist_stocks (
    user_id BIGINT UNSIGNED NOT NULL,
    quote_id VARCHAR(8) NOT NULL,
    code VARCHAR(6) NOT NULL,
    name VARCHAR(64) NOT NULL,
    market_name VARCHAR(32) NOT NULL DEFAULT '',
    pinyin VARCHAR(64) NOT NULL DEFAULT '',
    created_at BIGINT NOT NULL,
    PRIMARY KEY (user_id, quote_id),
    KEY idx_watchlist_stocks_user_time (user_id, created_at),
    CONSTRAINT fk_watchlist_stocks_user FOREIGN KEY (user_id) REFERENCES users (id)
        ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS signal_events (
    id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
    trade_date VARCHAR(10) NOT NULL,
    source_time BIGINT NOT NULL,
    entity_type VARCHAR(16) NOT NULL,
    entity_code VARCHAR(32) NOT NULL,
    entity_name VARCHAR(255) NOT NULL,
    signal_type VARCHAR(32) NOT NULL,
    main_net DOUBLE NOT NULL,
    change_15s DOUBLE NULL,
    change_1m DOUBLE NULL,
    change_3m DOUBLE NULL,
    created_at BIGINT NOT NULL,
    PRIMARY KEY (id),
    UNIQUE KEY uq_signal_event (trade_date, entity_type, entity_code, signal_type, source_time),
    KEY idx_signal_events_date_id (trade_date, id),
    KEY idx_signal_events_entity_date (entity_type, entity_code, trade_date)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS watchlist_quote_snapshot (
    trade_date VARCHAR(10) NOT NULL,
    quote_id VARCHAR(8) NOT NULL,
    minute_time BIGINT NOT NULL,
    source_time BIGINT NOT NULL,
    price DOUBLE NOT NULL,
    change_percent DOUBLE NOT NULL,
    main_net DOUBLE NOT NULL,
    PRIMARY KEY (trade_date, quote_id, minute_time),
    KEY idx_watchlist_quote_date (trade_date, quote_id, source_time)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
