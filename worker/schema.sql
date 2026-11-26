-- 付费阅读数据库结构（Cloudflare D1 / SQLite）
-- 执行方式见 README：「初始化 D1」

CREATE TABLE IF NOT EXISTS articles (
  slug        TEXT PRIMARY KEY,
  title       TEXT NOT NULL,
  html        TEXT NOT NULL,
  price       REAL DEFAULT 0,
  updated_at  TEXT NOT NULL
);

-- 兑换码：scope=article 只解锁指定文章，scope=all 解锁全部（年卡/全站卡）
CREATE TABLE IF NOT EXISTS codes (
  code        TEXT PRIMARY KEY,
  scope       TEXT NOT NULL DEFAULT 'article',
  slug        TEXT,
  max_uses    INTEGER DEFAULT 1,
  used_count  INTEGER DEFAULT 0,
  expires_at  TEXT,
  note        TEXT,
  created_at  TEXT NOT NULL,
  revoked     INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_codes_slug ON codes (slug);

-- 只记录失败尝试用于限流，不存兑换码明文
CREATE TABLE IF NOT EXISTS attempts (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  ip_hash     TEXT NOT NULL,
  ok          INTEGER NOT NULL,
  created_at  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_attempts_ip ON attempts (ip_hash, created_at);

-- 支付宝当面付订单
CREATE TABLE IF NOT EXISTS orders (
  out_trade_no TEXT PRIMARY KEY,
  slug         TEXT NOT NULL,
  amount       REAL NOT NULL,
  status       TEXT NOT NULL DEFAULT 'pending',
  trade_no     TEXT,
  token        TEXT,
  created_at   TEXT NOT NULL,
  paid_at      TEXT,
  checked_at   TEXT
);

CREATE INDEX IF NOT EXISTS idx_orders_slug ON orders (slug, created_at);
